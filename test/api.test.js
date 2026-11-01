const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

// Matches the market-data router's own day key so quota rows seeded here are "today".
const today = () => new Date().toISOString().slice(0, 10);

// Boots the real app against a throwaway database with network calls stubbed.
async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northstar-api-test-'));
  const { app, db } = createApp({ dataDir, ...overrides });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    return { status: response.status, payload };
  };
  return {
    request,
    db,
    close: () => new Promise((resolve) => { db.close(); server.close(resolve); }),
  };
}

async function seedAccountAndAsset(request) {
  const account = await request('accounts', { method: 'POST', body: { name: 'Brokerage', currency: 'EUR' } });
  assert.equal(account.status, 200);
  const asset = await request('assets', { method: 'POST', body: { name: 'Index Fund', type: 'ETF', currency: 'EUR' } });
  assert.equal(asset.status, 200);
  return { accountId: account.payload.id, assetId: asset.payload.id };
}

test('server rejects selling more shares than are held', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  const buy = (quantity) => request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity, unit_price: 10, fees: 0, currency: 'EUR' } });
  const sell = (quantity, date) => request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'sell', date, quantity, unit_price: 12, fees: 0, currency: 'EUR' } });

  assert.equal((await buy(10)).status, 200);
  const oversold = await sell(15, '2024-02-01');
  assert.equal(oversold.status, 400);
  assert.match(oversold.payload.error, /exceeds shares held/i);
  assert.equal((await sell(10, '2024-02-01')).status, 200);
  assert.equal((await sell(0.0001, '2024-02-02')).status, 400, 'selling after the position is closed must fail');
});

test('editing a transaction cannot create an oversold sale', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  const sale = await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'sell', date: '2024-02-01', quantity: 5, unit_price: 12, currency: 'EUR' } });
  assert.equal(sale.status, 200);
  const edit = await request(`transactions/${sale.payload.id}`, { method: 'PUT', body: { quantity: 11 } });
  assert.equal(edit.status, 400);
  assert.match(edit.payload.error, /exceeds shares held/i);
});

test('latest price prefers the manual entry when two share the same date', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { assetId } = await seedAccountAndAsset(request);
  await request('transactions', { method: 'POST', body: { account_id: 1, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  await request('prices', { method: 'POST', body: { asset_id: assetId, date: '2024-03-01', price: 9, currency: 'EUR', source: 'Marketstack · end-of-day' } });
  await request('prices', { method: 'POST', body: { asset_id: assetId, date: '2024-03-01', price: 11, currency: 'EUR', source: 'Manual' } });
  await request('prices', { method: 'POST', body: { asset_id: assetId, date: '2024-02-01', price: 100, currency: 'EUR', source: 'Manual' } });

  const summary = await request('summary');
  assert.equal(summary.status, 200);
  const holding = summary.payload.summary.holdings.find((h) => h.id === assetId);
  assert.equal(holding.price, 11, 'newest date wins, and Manual wins the same-date tie');
  assert.equal(holding.price_source, 'Manual');
});

test('account cash balance contributes to portfolio value without creating a transaction', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId } = await seedAccountAndAsset(request);
  const saved = await request('cash_balances', { method: 'POST', body: { account_id: accountId, date: '2024-03-01', balance: 1250, currency: 'EUR', notes: 'Cash account value' } });
  assert.equal(saved.status, 200, saved.payload?.error);

  const summary = (await request('summary')).payload;
  assert.equal(summary.transactions.length, 0, 'cash snapshots do not create buy/sell activity');
  assert.equal(summary.summary.valueByCurrency.EUR, 1250);
  const cash = summary.summary.holdings.find((holding) => holding.is_cash_balance);
  assert.equal(cash.current_value, 1250);
  assert.equal(cash.price_source, 'Manual cash balance');
});

test('cash asset snapshots are supported and cannot be mixed with account-level balances', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId } = await seedAccountAndAsset(request);
  const cashAsset = await request('assets', { method: 'POST', body: { name: 'USD cash', type: 'Cash', currency: 'USD' } });
  const saved = await request('cash_balances', { method: 'POST', body: { account_id: accountId, asset_id: cashAsset.payload.id, date: '2024-03-01', balance: 800, currency: 'USD' } });
  assert.equal(saved.status, 200, saved.payload?.error);
  const mixed = await request('cash_balances', { method: 'POST', body: { account_id: accountId, date: '2024-04-01', balance: 500, currency: 'EUR' } });
  assert.equal(mixed.status, 400);
  assert.match(mixed.payload.error, /cash as an asset/i);
});

test('physical assets, valuations, and linked loan balance history are backed up locally', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const home = await request('physical_assets', { method: 'POST', body: { name: 'Home', type: 'Property', purchase_date: '2020-01-01', purchase_price: 250000, currency: 'EUR', notes: '' } });
  assert.equal(home.status, 200, home.payload?.error);
  const valuation = await request('physical_valuations', { method: 'POST', body: { physical_asset_id: home.payload.id, date: '2024-01-01', value: 300000, currency: 'EUR', source: 'Manual estimate' } });
  assert.equal(valuation.status, 200, valuation.payload?.error);
  const wrongCurrency = await request('physical_valuations', { method: 'POST', body: { physical_asset_id: home.payload.id, date: '2024-02-01', value: 310000, currency: 'USD', source: 'Manual estimate' } });
  assert.equal(wrongCurrency.status, 400);
  const loan = await request('liabilities', { method: 'POST', body: { name: 'Mortgage', type: 'Mortgage', physical_asset_id: home.payload.id, original_amount: 200000, currency: 'EUR', interest_rate: 3.5, notes: '' } });
  assert.equal(loan.status, 200, loan.payload?.error);
  const balance = await request('liability_balances', { method: 'POST', body: { liability_id: loan.payload.id, date: '2024-01-01', balance: 180000, notes: '' } });
  assert.equal(balance.status, 200, balance.payload?.error);
  const backup = await request('backup');
  assert.equal(backup.payload.data.physical_assets.length, 1);
  assert.equal(backup.payload.data.physical_valuations.length, 1);
  assert.equal(backup.payload.data.liabilities.length, 1);
  assert.equal(backup.payload.data.liability_balances.length, 1);
});

test('FX sync refreshes provider rates on re-sync but never overwrites Manual rows', async (t) => {
  let rates = [{ date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.1 }];
  const { request, close } = await startServer({ fetchFxRates: async () => rates.map((row) => ({ ...row })) });
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });

  assert.equal((await request('fx/sync', { method: 'POST', body: { provider: 'frankfurter' } })).status, 200);
  let stored = (await request('fx_rates')).payload;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].rate, 1.1);

  // Provider revises the rate; a second sync must apply it (previously it was skipped).
  rates = [{ date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 }];
  const resync = await request('fx/sync', { method: 'POST', body: { provider: 'frankfurter' } });
  assert.equal(resync.status, 200);
  assert.equal(resync.payload.stored, 1);
  stored = (await request('fx_rates')).payload;
  assert.equal(stored[0].rate, 1.2, 'revised provider rate is refreshed');

  // A row flipped to Manual is sacred.
  await request(`fx_rates/${stored[0].id}`, { method: 'PUT', body: { source: 'Manual', rate: 9.9 } });
  rates = [{ date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.3 }];
  const thirdSync = await request('fx/sync', { method: 'POST', body: { provider: 'frankfurter' } });
  assert.equal(thirdSync.payload.stored, 0, 'manual rates are never overwritten');
  const afterManual = (await request('fx_rates')).payload;
  assert.equal(afterManual[0].rate, 9.9);
});

test('Alpha Vantage quota counters survive a stale client settings round-trip', async (t) => {
  const { request, db, close } = await startServer();
  t.after(close);
  // Model a price sync that consumed quota while the page sat open.
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('alphavantage_usage', JSON.stringify({ date: today(), count: 5 }));

  const stored = (await request('settings')).payload;
  assert.equal(stored.alphavantage_usage, undefined, 'quota counters are not exposed to the browser');

  // The old client spread every loaded setting back into its PUT; server-owned keys must be ignored.
  const staleWrite = await request('settings', { method: 'PUT', body: { homeCurrency: 'SEK', alphavantage_usage: { date: today(), count: 0 }, alphavantage_last_request_at: 0 } });
  assert.equal(staleWrite.status, 200);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alphavantage_usage'").get().value).count, 5, 'quota is not reset by a stale settings write');
  assert.equal((await request('settings')).payload.homeCurrency, 'SEK', 'normal settings still save');
});

test('account currency cannot be changed once the account has history', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  const blocked = await request(`accounts/${accountId}`, { method: 'PUT', body: { currency: 'SEK' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.payload.error, /Currency cannot be changed/i);

  // Cash balances pin the currency too (they must match the account).
  const savings = await request('accounts', { method: 'POST', body: { name: 'Savings', currency: 'EUR' } });
  await request('cash_balances', { method: 'POST', body: { account_id: savings.payload.id, date: '2024-03-01', balance: 100, currency: 'EUR' } });
  assert.equal((await request(`accounts/${savings.payload.id}`, { method: 'PUT', body: { currency: 'USD' } })).status, 400);

  // Accounts without history remain editable.
  const fresh = await request('accounts', { method: 'POST', body: { name: 'Empty', currency: 'EUR' } });
  assert.equal((await request(`accounts/${fresh.payload.id}`, { method: 'PUT', body: { currency: 'USD' } })).status, 200);
});

test('dividend currency must match the asset currency', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  const mismatch = await request('dividends', { method: 'POST', body: { asset_id: assetId, account_id: accountId, date: '2024-04-01', amount: 12, currency: 'USD' } });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.payload.error, /must match the asset currency/i);

  const saved = await request('dividends', { method: 'POST', body: { asset_id: assetId, account_id: accountId, date: '2024-04-01', amount: 12, currency: 'EUR' } });
  assert.equal(saved.status, 200, saved.payload?.error);
  assert.equal((await request(`dividends/${saved.payload.id}`, { method: 'PUT', body: { currency: 'BRL' } })).status, 400, 'editing cannot introduce a mismatch either');
  assert.equal((await request(`dividends/${saved.payload.id}`, { method: 'PUT', body: { notes: 'restated' } })).status, 200, 'unrelated edits still work');
});

test('foreign keys are explicitly enabled on every connection', async (t) => {
  const { db, close } = await startServer();
  t.after(close);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('price sync refreshes only assets with open positions', async (t) => {
  const previousKey = process.env.ALPHA_VANTAGE_API_KEY;
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';
  t.after(() => { if (previousKey === undefined) delete process.env.ALPHA_VANTAGE_API_KEY; else process.env.ALPHA_VANTAGE_API_KEY = previousKey; });
  const fetched = [];
  const { request, db, close } = await startServer({ fetchLatestAlphaPrice: async (symbol) => { fetched.push(symbol); return { symbol, date: '2024-05-01', close: 12.5 }; } });
  t.after(close);
  const account = await request('accounts', { method: 'POST', body: { name: 'Brokerage', currency: 'EUR' } });
  const open = await request('assets', { method: 'POST', body: { name: 'Keeper', type: 'ETF', currency: 'EUR', alphavantage_symbol: 'KEEP', alphavantage_currency: 'EUR' } });
  const closed = await request('assets', { method: 'POST', body: { name: 'Exited', type: 'ETF', currency: 'EUR', alphavantage_symbol: 'EXIT', alphavantage_currency: 'EUR' } });
  const buy = (assetId) => request('transactions', { method: 'POST', body: { account_id: account.payload.id, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  await buy(open.payload.id);
  await buy(closed.payload.id);
  await request('transactions', { method: 'POST', body: { account_id: account.payload.id, asset_id: closed.payload.id, kind: 'sell', date: '2024-04-01', quantity: 10, unit_price: 12, currency: 'EUR' } });

  const sync = await request('prices/sync', { method: 'POST', body: {} });
  assert.equal(sync.status, 200, sync.payload?.error);
  assert.deepEqual(fetched, ['KEEP'], 'fully sold assets must not consume provider quota');
  assert.equal(sync.payload.stored, 1);
  assert.equal(sync.payload.skippedNoPosition, 1);
  assert.match(sync.payload.message, /no open position/i);

  // Explicitly selected ids are the escape hatch: a sold asset can still be force-refreshed.
  fetched.length = 0;
  db.prepare("DELETE FROM settings WHERE key='alphavantage_last_request_at'").run(); // skip the 12s pacing wait
  const forced = await request('prices/sync', { method: 'POST', body: { assetIds: [closed.payload.id] } });
  assert.equal(forced.status, 200, forced.payload?.error);
  assert.deepEqual(fetched, ['EXIT']);
  assert.equal(forced.payload.skippedNoPosition, 0);
});

test('dated quote fetch can fill past prices for assets that are no longer held', async (t) => {
  const previousKey = process.env.ALPHA_VANTAGE_API_KEY;
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';
  t.after(() => { if (previousKey === undefined) delete process.env.ALPHA_VANTAGE_API_KEY; else process.env.ALPHA_VANTAGE_API_KEY = previousKey; });
  const calls = [];
  const { request, close } = await startServer({
    fetchAlphaPriceOnDate: async (symbol, date, key, { gate } = {}) => {
      calls.push({ symbol, date });
      if (gate && !gate()) throw Object.assign(new Error('limit reached'), { status: 429 });
      return { symbol, close: 11.5, date: '2024-03-15', exact: true };
    },
  });
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  await request(`assets/${assetId}`, { method: 'PUT', body: { alphavantage_symbol: 'EXIT', alphavantage_currency: 'EUR' } });
  // Open and close the position: today's sync skips this asset, but a dated fetch must still work.
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'sell', date: '2024-04-01', quantity: 10, unit_price: 12, currency: 'EUR' } });

  const quote = await request(`market-data/quote?assetId=${assetId}&date=2024-03-20`);
  assert.equal(quote.status, 200, quote.payload?.error);
  assert.deepEqual(calls, [{ symbol: 'EXIT', date: '2024-03-20' }]);
  assert.equal(quote.payload.price, 11.5);
  assert.equal(quote.payload.date, '2024-03-15', 'the actual trading day fetched is reported');
  assert.equal(quote.payload.exact, true);
  assert.equal(quote.payload.requestsRemaining, 24, 'the fetcher consumes quota through the router gate');
  assert.equal((await request('prices')).payload.length, 0, 'the quote endpoint is read-only; saving stays with the form');

  assert.equal((await request(`market-data/quote?assetId=${assetId}&date=2099-01-01`)).status, 400, 'future dates are rejected');
  assert.equal((await request('market-data/quote?assetId=999&date=2024-03-20')).status, 404);
});

test('fund NAV import upserts dated prices and never touches manual entries', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { assetId } = await seedAccountAndAsset(request);
  await request('prices', { method: 'POST', body: { asset_id: assetId, date: '2026-01-02', price: 111, currency: 'EUR', source: 'Manual' } });

  const result = await request('prices/import', { method: 'POST', body: { assetId, prices: [
    { date: '2026-01-02', price: 999 }, // same date as the manual entry: must be kept out
    { date: '2026-01-05', price: 125 },
    { date: 'not-a-date', price: 1 },
    { date: '2026-01-06', price: -5 },
  ] } });
  assert.equal(result.status, 200, result.payload?.error);
  assert.deepEqual(
    { stored: result.payload.stored, manualKept: result.payload.manualKept, rejected: result.payload.rejected },
    { stored: 1, manualKept: 1, rejected: 2 },
  );

  const prices = (await request('prices')).payload;
  assert.equal(prices.find((p) => p.date === '2026-01-02').price, 111, 'manual price survives the import');
  const imported = prices.find((p) => p.date === '2026-01-05');
  assert.equal(imported.price, 125);
  assert.equal(imported.currency, 'EUR', 'imports adopt the asset currency regardless of the file');
  assert.match(imported.source, /Avanza/);

  assert.equal((await request('prices/import', { method: 'POST', body: { assetId: 999, prices: [{ date: '2026-01-05', price: 1 }] } })).status, 404);
});

test('backup and restore round-trips without foreign key errors', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  await request('cash_balances', { method: 'POST', body: { account_id: accountId, date: '2024-03-01', balance: 50, currency: 'EUR' } });
  const backup = (await request('backup')).payload;
  assert.equal(backup.data.transactions.length, 1);
  assert.equal(backup.data.cash_balances.length, 1);

  const restored = await request('restore', { method: 'POST', body: backup });
  assert.equal(restored.status, 200, restored.payload?.error);
  const summary = await request('summary');
  assert.equal(summary.payload.transactions.length, 1);
  assert.equal(summary.payload.cash_balances.length, 1);
  assert.equal(summary.payload.summary.holdings.find((h) => h.id === assetId).quantity, 10);
});
