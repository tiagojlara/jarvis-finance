const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

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

test('backup and restore round-trips without foreign key errors', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const { accountId, assetId } = await seedAccountAndAsset(request);
  await request('transactions', { method: 'POST', body: { account_id: accountId, asset_id: assetId, kind: 'buy', date: '2024-01-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  const backup = (await request('backup')).payload;
  assert.equal(backup.data.transactions.length, 1);

  const restored = await request('restore', { method: 'POST', body: backup });
  assert.equal(restored.status, 200, restored.payload?.error);
  const summary = await request('summary');
  assert.equal(summary.payload.transactions.length, 1);
  assert.equal(summary.payload.summary.holdings.find((h) => h.id === assetId).quantity, 10);
});
