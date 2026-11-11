const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

// Boots the real app (MCP router included) against a throwaway database and speaks
// JSON-RPC to /mcp the way an MCP client would: initialize, then initialized, then calls.
async function startMcp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-mcp-test-'));
  const { app, db } = createApp({ dataDir });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = { sessionId: null, nextId: 1 };

  // The Streamable HTTP transport requires POST clients to accept both JSON and SSE,
  // and may answer in either framing; notifications answer with an empty 202.
  const parseBody = async (response) => {
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) return response.json();
    if (type.includes('text/event-stream')) {
      const messages = (await response.text()).split(/\r?\n\r?\n/).flatMap((chunk) => chunk
        .split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim())));
      return messages.find((message) => message?.id !== undefined) ?? messages[0] ?? null;
    }
    return null;
  };

  const send = async (body) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (state.sessionId) headers['mcp-session-id'] = state.sessionId;
    return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  const rpc = async (method, params) => {
    const response = await send({ jsonrpc: '2.0', id: state.nextId++, method, params });
    const payload = await parseBody(response);
    return { status: response.status, payload, headers: response.headers };
  };

  const initialize = async () => {
    const { status, payload, headers } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tamandua-test', version: '1.0' },
    });
    assert.equal(status, 200, JSON.stringify(payload));
    state.sessionId = headers.get('mcp-session-id');
    assert.ok(state.sessionId, 'expected an mcp-session-id header');
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);
    return payload;
  };

  // Calls a tool and returns the parsed JSON payload from its text content.
  const callTool = async (name, args = {}) => {
    const { payload } = await rpc('tools/call', { name, arguments: args });
    const text = payload?.result?.content?.[0]?.text ?? JSON.stringify(payload);
    assert.ok(!payload?.result?.isError, `tool ${name} failed: ${text}`);
    return JSON.parse(text);
  };

  const expectToolError = async (name, args = {}) => {
    const { payload } = await rpc('tools/call', { name, arguments: args });
    assert.equal(payload?.result?.isError, true, `expected ${name} to report an error`);
    return payload.result.content[0].text;
  };

  const listTools = async () => {
    const { payload } = await rpc('tools/list', {});
    return payload.result.tools.map((tool) => tool.name);
  };

  // Regular HTTP still works next to the MCP router (body-parser ordering check).
  const api = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON */ }
    return { status: response.status, payload };
  };

  return {
    rpc, initialize, callTool, expectToolError, listTools, api, db, base,
    close: () => new Promise((resolve) => { db.close(); server.close(resolve); }),
  };
}

async function seedAsset(client, name = 'Index Fund') {
  const account = await client.api('accounts', { method: 'POST', body: { name: 'Brokerage', currency: 'EUR' } });
  assert.equal(account.status, 200);
  const asset = await client.api('assets', { method: 'POST', body: { name, type: 'ETF', currency: 'EUR' } });
  assert.equal(asset.status, 200);
  return asset.payload;
}

test('MCP handshake lists read and write tools', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  const init = await client.initialize();
  assert.equal(init.result.serverInfo.name, 'tamandua');
  const names = await client.listTools();
  for (const expected of [
    'get_summary', 'list_assets', 'list_transactions', 'list_prices', 'list_fx_rates', 'get_net_worth', 'save_price', 'save_fx_rate', 'save_dividend',
    'list_cash_flow_categories', 'list_cash_flow_transactions', 'get_cash_flow_summary',
    'save_cash_flow_entry', 'update_cash_flow_entry', 'delete_cash_flow_entry', 'save_cash_flow_category', 'update_cash_flow_category',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(names.length, 20, 'the tool list should grow only with an intentional surface change');
});

test('save_price records and replaces only Manual rows', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  await client.initialize();
  const asset = await seedAsset(client);

  const saved = await client.callTool('save_price', { asset_id: asset.id, date: '2026-11-04', price: 12.5 });
  assert.equal(saved.action, 'inserted');
  assert.equal(saved.price.currency, 'EUR'); // defaults to the asset currency
  assert.equal(saved.price.source, 'Manual');

  const again = await client.callTool('save_price', { asset_id: asset.id, date: '2026-11-04', price: 13 });
  assert.equal(again.action, 'updated');
  const rows = client.db.prepare("SELECT * FROM prices WHERE asset_id=? AND date='2026-11-04'").all(asset.id);
  assert.equal(rows.length, 1, 'a Manual row for the same day must be replaced, not duplicated');
  assert.equal(rows[0].price, 13);

  // Provider rows for the same day must survive untouched.
  client.db.prepare("INSERT INTO prices(asset_id, date, price, currency, source) VALUES(?,?,9.9,'EUR','Alpha Vantage')")
    .run(asset.id, '2026-10-30');
  await client.callTool('save_price', { asset_id: asset.id, date: '2026-10-30', price: 10 });
  const octRows = client.db.prepare("SELECT * FROM prices WHERE asset_id=? AND date='2026-10-30' ORDER BY id").all(asset.id);
  assert.equal(octRows.length, 2, 'manual saves must not overwrite provider rows');
  assert.equal(octRows[0].source, 'Alpha Vantage');

  const message = await client.expectToolError('save_price', { asset_id: asset.id, date: '2026-11-04', price: 10, currency: 'USD' });
  assert.match(message, /must match the asset currency/);
  await client.expectToolError('save_price', { asset_id: 9999, date: '2026-11-04', price: 10 });

  const summary = await client.callTool('get_summary');
  const row = summary.holdings.find((h) => h.id === asset.id);
  assert.equal(row.price, 13, 'latest Manual price should surface in get_summary');
});

test('save_fx_rate upserts one row per date and pair', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  await client.initialize();

  const first = await client.callTool('save_fx_rate', { date: '2026-11-03', base: 'EUR', quote: 'USD', rate: 1.15 });
  assert.equal(first.fx_rate.rate, 1.15);
  assert.equal(first.fx_rate.source, 'Manual');
  const second = await client.callTool('save_fx_rate', { date: '2026-11-03', base: 'EUR', quote: 'USD', rate: 1.16 });
  assert.equal(second.fx_rate.id, first.fx_rate.id, 'same date and pair must update in place');

  const rates = await client.callTool('list_fx_rates', { base: 'EUR', quote: 'USD' });
  assert.equal(rates.length, 1);
  assert.equal(rates[0].rate, 1.16);

  const message = await client.expectToolError('save_fx_rate', { date: '2026-11-03', base: 'EUR', quote: 'EUR', rate: 1 });
  assert.match(message, /different currencies/);
});

test('save_dividend records payments, is idempotent, and refuses silent overwrites', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  await client.initialize();
  const asset = await seedAsset(client);
  const accountId = (await client.api('accounts')).payload[0].id;

  const saved = await client.callTool('save_dividend', { asset_id: asset.id, date: '2026-11-04', amount: 12.5, account_id: accountId, notes: 'Nordnet settlement' });
  assert.equal(saved.action, 'inserted');
  assert.equal(saved.dividend.currency, 'EUR'); // defaults to the asset currency
  assert.equal(saved.dividend.notes, 'Nordnet settlement');

  const again = await client.callTool('save_dividend', { asset_id: asset.id, date: '2026-11-04', amount: 12.5 });
  assert.equal(again.action, 'exists');
  assert.equal(again.dividend.id, saved.dividend.id);
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM dividends').get().n, 1, 're-saving the same payment must not duplicate it');

  // A different amount for the same asset + date needs explicit confirmation...
  const conflict = await client.expectToolError('save_dividend', { asset_id: asset.id, date: '2026-11-04', amount: 99 });
  assert.match(conflict, /replace=true/);
  const replaced = await client.callTool('save_dividend', { asset_id: asset.id, date: '2026-11-04', amount: 99, replace: true });
  assert.equal(replaced.action, 'replaced');
  assert.equal(replaced.dividend.amount, 99);
  assert.equal(replaced.dividend.notes, 'Nordnet settlement', 'replace keeps untouched fields');
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM dividends').get().n, 1, 'a correction updates the row in place');

  const wrongCurrency = await client.expectToolError('save_dividend', { asset_id: asset.id, date: '2026-11-05', amount: 1, currency: 'USD' });
  assert.match(wrongCurrency, /must match the asset currency/);
  await client.expectToolError('save_dividend', { asset_id: 9999, date: '2026-11-05', amount: 1 });
  await client.expectToolError('save_dividend', { asset_id: asset.id, date: '2026-11-05', amount: 1, account_id: 9999 });

  const listed = await client.callTool('list_dividends', { asset_id: asset.id });
  assert.equal(listed.length, 1);
  const summary = await client.callTool('get_summary');
  assert.equal(summary.dividendIncomeByCurrency.EUR, 99, 'the corrected dividend surfaces in the summary');
});

test('cash-flow MCP tools cover the whole ledger with the UI validation rules', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  await client.initialize();
  await seedAsset(client); // creates the shared 'Brokerage' EUR account
  const account = (await client.api('accounts')).payload[0];
  const categories = await client.callTool('list_cash_flow_categories', { active_only: true });
  const salary = categories.find((c) => c.name === 'Salary').id;
  const food = categories.find((c) => c.name === 'Food').id;
  const summaryBefore = JSON.stringify(await client.callTool('get_summary'));

  // Entries take the currency of their account automatically.
  const income = await client.callTool('save_cash_flow_entry', { account_id: account.id, category_id: salary, kind: 'income', date: '2026-11-01', amount: 2400, payee: 'Employer' });
  assert.equal(income.action, 'inserted');
  assert.equal(income.entry.currency, 'EUR');
  const coffee = await client.callTool('save_cash_flow_entry', { account_id: account.id, category_id: food, kind: 'expense', date: '2026-11-03', amount: 4.5 });
  const coffeeAgain = await client.callTool('save_cash_flow_entry', { account_id: account.id, category_id: food, kind: 'expense', date: '2026-11-03', amount: 4.5 });
  assert.notEqual(coffeeAgain.entry.id, coffee.entry.id, 'same-day repeats are legitimate and always insert a new row');

  // The same guards the REST routes enforce: unknown account, category kind mismatch.
  await client.expectToolError('save_cash_flow_entry', { account_id: 9999, category_id: food, kind: 'expense', date: '2026-11-04', amount: 10 });
  const wrongKind = await client.expectToolError('save_cash_flow_entry', { account_id: account.id, category_id: food, kind: 'income', date: '2026-11-04', amount: 10 });
  assert.match(wrongKind, /records expense/);

  // Monthly summary: per-currency totals and per-category breakdown.
  const month = await client.callTool('get_cash_flow_summary', { month: '2026-11' });
  assert.equal(month.entries, 3);
  assert.deepEqual(month.totals_by_currency, { EUR: { income: 2400, expense: 9, net: 2391 } });
  assert.equal(month.spending_by_category[0].name, 'Food');
  assert.equal(month.spending_by_category[0].total, 9);
  assert.equal(month.spending_by_category[0].entries, 2);
  const emptyMonth = await client.callTool('get_cash_flow_summary', { month: '2026-10' });
  assert.deepEqual(emptyMonth.totals_by_currency, {});

  // Filtering, partial edits, and re-validation of the merged row.
  const expenses = await client.callTool('list_cash_flow_transactions', { kind: 'expense', date_from: '2026-11-03' });
  assert.equal(expenses.length, 2);
  const edited = await client.callTool('update_cash_flow_entry', { id: coffee.entry.id, amount: 6.25, description: 'airport coffee' });
  assert.equal(edited.entry.amount, 6.25);
  assert.equal(edited.entry.description, 'airport coffee');
  assert.equal(edited.entry.payee, '', 'untouched fields survive the edit');
  const flip = await client.expectToolError('update_cash_flow_entry', { id: coffee.entry.id, kind: 'income' });
  assert.match(flip, /records expense/, 'an edit cannot flip an expense under an expense category');

  // Categories: creation is idempotent; renames clash-check; kinds pin once used.
  const rent = await client.callTool('save_cash_flow_category', { name: 'Rent', kind: 'expense' });
  assert.equal(rent.action, 'created');
  const rentAgain = await client.callTool('save_cash_flow_category', { name: 'Rent', kind: 'expense' });
  assert.equal(rentAgain.action, 'exists');
  assert.equal(rentAgain.category.id, rent.category.id);
  const renameClash = await client.expectToolError('update_cash_flow_category', { id: rent.category.id, name: 'Food' });
  assert.match(renameClash, /already exists/);
  const rekind = await client.expectToolError('update_cash_flow_category', { id: food, kind: 'income' });
  assert.match(rekind, /cannot change/);

  // Deactivation is the soft removal: new entries reject it, history stays.
  const deactivated = await client.callTool('update_cash_flow_category', { id: rent.category.id, active: false });
  assert.equal(deactivated.category.active, 0);
  const blocked = await client.expectToolError('save_cash_flow_entry', { account_id: account.id, category_id: rent.category.id, kind: 'expense', date: '2026-11-05', amount: 900 });
  assert.match(blocked, /deactivated/);

  // Deleting entries is the one ledger MCP may prune; counts update accordingly.
  const deleted = await client.callTool('delete_cash_flow_entry', { id: coffeeAgain.entry.id });
  assert.equal(deleted.action, 'deleted');
  await client.expectToolError('delete_cash_flow_entry', { id: 9999 });
  const listed = await client.callTool('list_cash_flow_categories');
  assert.equal(listed.find((c) => c.name === 'Food').entry_count, 1);

  // Isolation: none of this touches holdings, dividends, or the portfolio summary.
  assert.equal(JSON.stringify(await client.callTool('get_summary')), summaryBefore);
});

test('requests without a known session are rejected', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  const { status } = await client.rpc('tools/list', {}); // no initialize performed
  assert.equal(status, 404);
});

test('a browser-style GET explains the endpoint instead of a bare 404', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  const response = await fetch(`${client.base}/mcp`); // no session header, like typing the URL in a browser
  assert.equal(response.status, 405, 'GET without a session is refused, but with a body that says why');
  const hint = await response.json();
  assert.match(hint.error, /not a web page/i);
  assert.match(hint.error, /the API server is up/i);
});

