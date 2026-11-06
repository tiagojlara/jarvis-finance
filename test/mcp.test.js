const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

// Boots the real app (MCP router included) against a throwaway database and speaks
// JSON-RPC to /mcp the way an MCP client would: initialize, then initialized, then calls.
async function startMcp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-finance-mcp-test-'));
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
      clientInfo: { name: 'jarvis-test', version: '1.0' },
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
    rpc, initialize, callTool, expectToolError, listTools, api, db,
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
  assert.equal(init.result.serverInfo.name, 'jarvis-finance');
  const names = await client.listTools();
  for (const expected of ['get_summary', 'list_assets', 'list_transactions', 'list_prices', 'list_fx_rates', 'get_net_worth', 'save_price', 'save_fx_rate']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
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

test('requests without a known session are rejected', async (t) => {
  const client = await startMcp();
  t.after(client.close);
  const { status } = await client.rpc('tools/list', {}); // no initialize performed
  assert.equal(status, 404);
});

