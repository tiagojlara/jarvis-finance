const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const { createReadOnlyGuard, isReadOnlyTool, READ_ONLY_TOOLS } = require('../src/assistant/readOnlyGuard');
const { normalizeEndpointUrl } = require('../src/assistant/endpoints');
const { sanitizeError } = require('../src/assistant/model');

// An explicitly provisioned key keeps these tests off the macOS Keychain: no test run should
// create or read a credential that belongs to the person running them.
process.env.JARVIS_ASSISTANT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
delete process.env.JARVIS_ASSISTANT_KEY_FILE;

const TOKEN = 'secret-token-never-echoed';
const MONTH = new Date().toISOString().slice(0, 7);

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible endpoint. Deliberately not a mock of LangChain: the
// point is to exercise the real model client, the real tool loop and the real
// Authorization header against a local endpoint (localhost HTTP is allowed by
// the endpoint policy), while staying able to assert what actually went out.
// ---------------------------------------------------------------------------
async function startFakeModel({ toolCalls = [], answer = 'You have 2 accounts.' } = {}) {
  const calls = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      turn += 1;
      const payload = JSON.parse(raw || '{}');
      calls.push({ url: req.url, headers: req.headers, body: payload, turn });
      const usedTool = (payload.messages || []).some((message) => message.role === 'tool');
      const wanted = usedTool || turn > toolCalls.length ? null : toolCalls[turn - 1];
      const plain = payload.stream !== true;

      if (wanted) {
        const toolCall = { id: `call_${turn}`, type: 'function', function: { name: wanted, arguments: '{}' } };
        if (plain) {
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [toolCall] } }] }));
        }
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return undefined;
      }

      if (plain) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      }
      res.setHeader('content-type', 'text/event-stream');
      for (const part of [answer.slice(0, Math.ceil(answer.length / 2)), answer.slice(Math.ceil(answer.length / 2))]) {
        if (!part) continue;
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return undefined;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    server,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// Boots the real app (its own /mcp endpoint included) against a throwaway database,
// plus a fake model endpoint. Same harness shape as api.test.js and cashflow.test.js.
async function startAssistant({ toolCalls, answer } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-assistant-test-'));
  const model = await startFakeModel({ toolCalls, answer });
  let server;
  const { app, db } = createApp({
    dataDir,
    assistantMcpUrl: () => `http://127.0.0.1:${server.address().port}/mcp`,
  });
  server = await new Promise((resolve) => {
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
    try { payload = await response.json(); } catch { /* streamed or non-JSON response */ }
    return { status: response.status, payload };
  };

  // Reads the streamed answer to completion; events come back in order. A refused request
  // (no disclosure yet) answers with JSON instead of a stream, so both are returned.
  const streamChat = async (message, extra = {}) => {
    const response = await fetch(`${base}assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...extra }),
    });
    const text = await response.text();
    const events = text.split('\n\n').filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice('data: '.length)));
    let json = null;
    try { json = JSON.parse(text); } catch { /* streamed */ }
    return { status: response.status, events, json };
  };

  const configure = async () => {
    const saved = await request('assistant/model', { method: 'PUT', body: { baseUrl: model.baseUrl, model: 'fake-model', token: TOKEN } });
    assert.equal(saved.status, 200, JSON.stringify(saved.payload));
    await request('assistant/disclosure', { method: 'POST' });
    return saved;
  };

  // The assistant holds a live MCP session against this same server, so close() would wait
  // for a keep-alive connection that only the client can end. Destroy the sockets first.
  const close = async () => {
    server.closeAllConnections?.();
    model.server?.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await model.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { request, streamChat, configure, db, dataDir, model, base, close };
}

async function seedCashFlow(request, { name = 'Salary', kind = 'income', amount = 3200, currency = 'EUR', account = 'Brokerage' } = {}) {
  const accounts = await request('accounts', { method: 'POST', body: { name: account, currency } });
  assert.equal(accounts.status, 200, JSON.stringify(accounts.payload));
  const categories = (await request('cash_flow_categories')).payload;
  const category = categories.find((row) => row.name === name && row.kind === kind);
  assert.ok(category, `category ${name}/${kind} should be seeded`);
  const entry = await request('cash_flow_transactions', {
    method: 'POST',
    body: { account_id: accounts.payload.id, category_id: category.id, kind, date: `${MONTH}-05`, amount, currency },
  });
  assert.equal(entry.status, 200, JSON.stringify(entry.payload));
  return { accountId: accounts.payload.id, categoryId: category.id, entryId: entry.payload.id };
}

// ---- settings and the token -------------------------------------------------------------

test('the saved token is encrypted, never returned, and only replaceable or clearable', async (t) => {
  const { request, db, close } = await startAssistant();
  t.after(close);

  const saved = await request('assistant/model', { method: 'PUT', body: { baseUrl: 'https://inference.example.com/v1', model: 'gpt-4o-mini', token: TOKEN } });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.tokenConfigured, true);
  assert.equal(saved.payload.ready, true);
  assert.equal(JSON.stringify(saved.payload).includes(TOKEN), false, 'the settings response must not carry the token');
  assert.equal(saved.payload.baseUrl, 'https://inference.example.com/v1');

  const read = await request('assistant/model');
  assert.equal(JSON.stringify(read.payload).includes(TOKEN), false, 'GET must not reveal the saved value');

  const stored = db.prepare("SELECT value FROM assistant_settings WHERE key = 'model.token'").get().value;
  assert.equal(stored.includes(TOKEN), false, 'the database row must hold ciphertext only');
  const envelope = JSON.parse(stored);
  assert.equal(envelope.alg, 'aes-256-gcm');
  assert.equal(envelope.keySource, 'env');
  assert.ok(envelope.iv && envelope.tag && envelope.data);

  // Replacing it leaves a different ciphertext and no plaintext anywhere.
  const replaced = await request('assistant/model', { method: 'PUT', body: { token: 'another-token' } });
  assert.equal(replaced.payload.tokenConfigured, true);
  assert.notEqual(db.prepare("SELECT value FROM assistant_settings WHERE key = 'model.token'").get().value, stored);

  await request('assistant/model', { method: 'PUT', body: { clearToken: true } });
  const cleared = await request('assistant/model');
  assert.equal(cleared.payload.tokenConfigured, false);
  assert.equal(cleared.payload.ready, false);
  assert.equal(db.prepare("SELECT value FROM assistant_settings WHERE key = 'model.token'").get(), undefined);
});

test('assistant state is absent from /api/settings and /api/backup', async (t) => {
  const { request, db, close } = await startAssistant();
  t.after(close);
  await request('assistant/model', { method: 'PUT', body: { baseUrl: 'https://inference.example.com/v1', model: 'm', token: TOKEN } });
  await request('assistant/disclosure', { method: 'POST' });
  const conversation = (await request('assistant/conversations', { method: 'POST', body: { title: 'Secret question' } })).payload.conversation;
  assert.ok(conversation);

  const settings = await request('settings');
  assert.equal(JSON.stringify(settings.payload).includes(TOKEN), false);
  assert.equal(Object.keys(settings.payload).some((key) => key.startsWith('model.') || key.startsWith('assistant')), false, 'assistant keys must not live in the client-visible settings table');

  const backup = await request('backup');
  assert.equal(backup.status, 200);
  for (const key of Object.keys(backup.payload.data)) {
    assert.equal(key.startsWith('assistant_'), false, `backup must not export ${key}`);
  }
  assert.equal(JSON.stringify(backup.payload).includes(TOKEN), false, 'a backup is a file meant for sharing');
  assert.equal(JSON.stringify(backup.payload).includes('Secret question'), false);

  // The rows are still there locally — the exclusion is about the export surface.
  assert.ok(db.prepare('SELECT 1 FROM assistant_conversations').get());
});

test('endpoint policy: https anywhere, plain http only for localhost', async (t) => {
  const { request, close } = await startAssistant();
  t.after(close);

  assert.equal((await request('assistant/model/validate', { method: 'POST', body: { baseUrl: 'https://api.openai.com/v1' } })).status, 200);
  const local = await request('assistant/model/validate', { method: 'POST', body: { baseUrl: 'http://127.0.0.1:11434' } });
  assert.equal(local.status, 200);
  assert.equal(local.payload.loopback, true);
  assert.equal(local.payload.effectiveUrl, 'http://127.0.0.1:11434/v1', 'a bare host gets the conventional /v1 API root');

  const remote = await request('assistant/model/validate', { method: 'POST', body: { baseUrl: 'http://model.example.com/v1' } });
  assert.equal(remote.status, 400);
  assert.match(remote.payload.error, /Plain HTTP is only allowed for a localhost endpoint/i);

  const override = await request('assistant/model/validate', { method: 'POST', body: { baseUrl: 'http://model.example.com/v1', allowInsecureHttp: true } });
  assert.equal(override.status, 200, 'the documented override allows it');

  for (const bad of ['not a url', 'ftp://host/x', 'https://user:pass@host/v1', 'https://host/v1?key=abc', '']) {
    const response = await request('assistant/model/validate', { method: 'POST', body: { baseUrl: bad } });
    assert.equal(response.status, 400, `${bad} must be rejected`);
  }

  // Turning the override off re-checks a URL that was saved while it was on.
  const saved = await request('assistant/model', { method: 'PUT', body: { baseUrl: 'http://model.example.com/v1', allowInsecureHttp: true, model: 'm' } });
  assert.equal(saved.status, 200);
  const revoked = await request('assistant/model', { method: 'PUT', body: { allowInsecureHttp: false } });
  assert.equal(revoked.status, 400);
  assert.match(revoked.payload.error, /Plain HTTP/i);
});

test('normalizeEndpointUrl keeps the URL as typed and computes where requests go', () => {
  assert.equal(normalizeEndpointUrl('https://host.example/v1').url, 'https://host.example/v1');
  assert.equal(normalizeEndpointUrl('https://host.example/v1/').effectiveUrl, 'https://host.example/v1');
  assert.equal(normalizeEndpointUrl('http://localhost:1234/v1').loopback, true);
  assert.equal(normalizeEndpointUrl('http://my-box.localhost/v1').loopback, true);
  assert.equal(normalizeEndpointUrl('http://127.0.0.1:1234/v1').insecure, true);
  assert.throws(() => normalizeEndpointUrl('http://10.0.0.5/v1'), /Plain HTTP/);
  assert.throws(() => normalizeEndpointUrl('https://host.example/v1'.padEnd(3000, 'x')), /too long/);
});

// ---- test connection -------------------------------------------------------------------

test('"test connection" sends no financial data and keeps the token in the header', async (t) => {
  const { request, configure, model, close } = await startAssistant();
  t.after(close);
  await seedCashFlow(request);
  await configure();

  const result = await request('assistant/model/test', { method: 'POST' });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.ok, true);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(model.calls[0].url, '/v1/chat/completions');
  assert.deepEqual(model.calls[0].body.tools, undefined, 'a connection test must not carry tools');
  const serialized = JSON.stringify(model.calls[0].body.messages);
  assert.equal(serialized.includes('Salary'), false, 'no record contents in a connectivity check');
  assert.equal(serialized.includes(TOKEN), false, 'the token belongs in the header, not the body');
});

test('a rejected token is reported without echoing it back', async (t) => {
  const { request, db, close } = await startAssistant();
  t.after(close);
  const bad = await startFailingModel(401, `Invalid API key provided: Bearer ${TOKEN}`);
  t.after(bad.close);
  await request('assistant/model', { method: 'PUT', body: { baseUrl: bad.baseUrl, model: 'm', token: TOKEN } });

  const result = await request('assistant/model/test', { method: 'POST' });
  assert.equal(result.status, 502);
  assert.equal(JSON.stringify(result.payload).includes(TOKEN), false, 'sanitised errors only');
  assert.match(result.payload.error, /rejected the token/i);
  assert.ok(db);
});

// An endpoint that fails the way real ones do, including putting the bearer token in the
// error text — which is exactly why errors get sanitised before anyone sees them.
async function startFailingModel(status, message) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

test('sanitizeError strips credentials and gives the user something to act on', () => {
  const token = 'sk-super-secret-value';
  const direct = sanitizeError(new Error(`401 Invalid API key provided: Bearer ${token}`), { token, model: 'm', baseUrl: 'http://127.0.0.1:9/v1' });
  assert.equal(direct.includes(token), false);
  assert.match(direct, /rejected the token/i);

  assert.match(sanitizeError(Object.assign(new Error('404 not found'), { status: 404 }), { model: 'gpt-9-turbo', baseUrl: 'https://x.dev/v1' }), /no model "gpt-9-turbo"/i);
  assert.match(sanitizeError(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { baseUrl: 'http://127.0.0.1:1234/v1' }), /Nothing is listening/i);
  assert.match(sanitizeError(Object.assign(new Error('429 slow down'), { status: 429 }), {}), /rate limited/i);
  assert.match(sanitizeError(new Error(''), {}), /could not be reached/i);
});

// ---- the local MCP connection ----------------------------------------------------------

test('the app connects to its own MCP endpoint and exposes only the read tools', async (t) => {
  const { request, close } = await startAssistant();
  t.after(close);

  const status = await request('assistant/mcp');
  assert.equal(status.status, 200, JSON.stringify(status.payload));
  assert.equal(status.payload.connected, true);
  assert.equal(status.payload.enabled, true);
  const names = status.payload.tools.map((tool) => tool.name);
  assert.equal(status.payload.tools.length, 20, 'the assistant sees the whole tool list and then filters it');
  assert.ok(names.includes('get_summary') && names.includes('list_cash_flow_transactions'));

  // Drift guard: every tool the MCP server offers is deliberately classified. A new read tool
  // has to be added to the allowlist, and a new write tool must stay off it, or this fails.
  const writes = names.filter((name) => !isReadOnlyTool(name)).sort();
  assert.deepEqual(writes, [
    'delete_cash_flow_entry', 'save_cash_flow_category', 'save_cash_flow_entry', 'save_dividend',
    'save_fx_rate', 'save_price', 'update_cash_flow_category', 'update_cash_flow_entry',
  ]);
  assert.deepEqual(READ_ONLY_TOOLS.slice().sort(), names.filter((name) => isReadOnlyTool(name)).sort());
  assert.equal(status.payload.exposed, READ_ONLY_TOOLS.length);
});

test('tool switches change what the model is offered and cannot enable a write tool', async (t) => {
  const { request, streamChat, configure, model, close } = await startAssistant({ toolCalls: ['jarvis_get_summary'], answer: 'Totals are 3200.00 EUR.' });
  t.after(close);
  await seedCashFlow(request);
  await configure();
  const off = await request('assistant/mcp/tools/get_summary', { method: 'PUT', body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.payload.disabledTools, ['get_summary']);

  await streamChat('what is my income this month');
  const offered = model.calls[0].body.tools.map((tool) => tool.function.name);
  assert.equal(offered.includes('jarvis_get_summary'), false, 'a switched-off tool must not even be listed');
  assert.ok(offered.includes('jarvis_list_cash_flow_transactions'));
  assert.equal(offered.some((name) => /save_|update_|delete_/.test(name)), false, 'no write tool is ever offered');

  const refused = await request('assistant/mcp/tools/save_dividend', { method: 'PUT', body: { enabled: true } });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.error, /not a read-only Jarvis tool/i);

  const backOn = await request('assistant/mcp/tools/get_summary', { method: 'PUT', body: { enabled: true } });
  assert.equal(backOn.status, 200);
});

test('turning the built-in connection off stops the assistant from answering', async (t) => {
  const { request, streamChat, configure, model, close } = await startAssistant({ answer: 'I estimate you have about 10000' });
  t.after(close);
  await configure();
  const off = await request('assistant/mcp', { method: 'PUT', body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.payload.connected, false);
  assert.equal(off.payload.enabled, false);

  const { events } = await streamChat('how much do I have');
  const failure = events.find((event) => event.type === 'error');
  assert.ok(failure, 'an unreachable connection is an actionable failure, not a guessed answer');
  assert.match(failure.message, /turned on|not reachable|Reconnect/i);
  assert.equal(events.some((event) => event.type === 'delta'), false, 'no streamed text either');
  assert.equal(model.calls.length, 0, 'no model request without records to ground it');

  const stored = (await request(`assistant/conversations/${failure.conversationId}`)).payload.conversation;
  assert.match(stored.messages.at(-1).error, /could not read your records/i, 'the failure is part of the history the user can inspect');

  const on = await request('assistant/mcp', { method: 'PUT', body: { enabled: true } });
  assert.equal(on.payload.connected, true);
});

// ---- chat ------------------------------------------------------------------------------

test('chat answers from a tool call, streams, and persists the exchange', async (t) => {
  const answer = 'You have one account: Brokerage (EUR).';
  const { request, streamChat, configure, model, db, close } = await startAssistant({ toolCalls: ['jarvis_list_accounts'], answer });
  t.after(close);
  await seedCashFlow(request);
  await configure();

  const { events } = await streamChat('what accounts do I have?');
  const types = events.map((event) => event.type);
  assert.deepEqual(types.filter((type) => type !== 'delta'), ['user', 'tool', 'done'], JSON.stringify(events));

  const toolEvent = events.find((event) => event.type === 'tool');
  assert.equal(toolEvent.activity.tool, 'list_accounts');
  assert.equal(toolEvent.activity.status, 'ok');

  const done = events[events.length - 1];
  assert.equal(done.text, answer);
  assert.equal(done.model, 'fake-model');
  assert.ok(done.activity.length >= 1, 'the finished answer keeps its tool trail (FR-8)');

  // The answer is what the user saw: streamed pieces, then the stored message.
  assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), answer);

  const conversation = (await request(`assistant/conversations/${done.conversationId}`)).payload.conversation;
  assert.deepEqual(conversation.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(conversation.messages[1].content, answer);
  assert.equal(conversation.messages[1].toolActivity[0].tool, 'list_accounts');
  assert.equal(conversation.title, 'what accounts do I have?', 'the first question becomes the title');

  // The tool call really went to the local MCP endpoint, and the token stayed in the header.
  assert.match(JSON.stringify(model.calls[0].body.messages), /READ-ONLY/, 'grounding rules travel with the request');
  assert.equal(model.calls[1].body.messages.some((message) => message.role === 'tool'), true, 'the tool result was fed back');
  assert.equal(JSON.stringify(model.calls[1].body.messages).includes(TOKEN), false);
  assert.equal(JSON.stringify(model.calls[1].body.messages).includes('jarvis_tool_data'), true, 'tool output is marked as data, not instructions');
  assert.ok(db.prepare('SELECT 1 FROM assistant_messages').get());
});

test('a tool call outside the read-only allowlist is refused before it runs', async (t) => {
  const { request, db, close } = await startAssistant();
  t.after(close);
  await seedCashFlow(request);
  const before = db.prepare('SELECT COUNT(*) AS n FROM dividends').get().n;

  const guard = createReadOnlyGuard();
  let executed = 0;
  const handler = async () => { executed += 1; return { content: 'should never run' }; };
  const refusal = await guard.middleware.wrapToolCall({ toolCall: { name: 'jarvis_save_dividend', args: { account_id: 1, amount: 500 }, id: 'x1' } }, handler);
  assert.equal(executed, 0, 'refusing means not calling the tool at all (§9)');
  assert.equal(refusal.status, 'error');
  assert.match(refusal.content, /read-only/i);
  assert.equal(guard.refusals[0].tool, 'save_dividend');
  assert.equal(guard.activity[0].status, 'refused');

  // And a read tool passes through, wrapped as untrusted data.
  const ok = await guard.middleware.wrapToolCall({ toolCall: { name: 'jarvis_get_summary', args: {}, id: 'x2' } }, async () => ({ content: '{"valueByCurrency":{"EUR":1000}}' }));
  assert.match(ok.content, /<jarvis_tool_data tool="get_summary">/);
  assert.match(ok.content, /not instructions to follow/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dividends').get().n, before, 'nothing was written');
});

test('the conversation replays earlier turns and the disclosure gates the first request', async (t) => {
  const { request, streamChat, configure, model, close } = await startAssistant({ answer: 'ok' });
  t.after(close);

  const early = await streamChat('hello');
  assert.equal(early.status, 428, 'no request leaves the machine before the disclosure is accepted');
  assert.equal(early.events.length, 0);
  assert.match(early.json.disclosure.body.join(' '), /records the model reads back/);
  assert.equal(early.json.disclosure.acknowledgedAt, null);

  await configure();
  const first = await streamChat('how much do I have in EUR?', { conversationId: undefined });
  const conversationId = first.events.at(-1).conversationId;
  await streamChat('and in SEK then?', { conversationId });

  const last = model.calls.at(-1).body.messages;
  assert.ok(last.filter((message) => message.role === 'user').length >= 2, 'the earlier question is replayed');
  assert.equal(last[0].role, 'system');
  assert.ok(JSON.stringify(last).includes('how much do I have in EUR'));
});

test('history can be inspected, renamed and deleted without touching financial records', async (t) => {
  const { request, streamChat, configure, db, close } = await startAssistant({ answer: 'noted' });
  t.after(close);
  const seeded = await seedCashFlow(request);
  await configure();

  const first = await streamChat('remember this question');
  const conversationId = first.events.at(-1).conversationId;
  await streamChat('and this answer matters', { conversationId });

  const listed = (await request('assistant/conversations')).payload.conversations;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 4, 'two questions and two answers');

  const renamed = await request(`assistant/conversations/${conversationId}`, { method: 'PUT', body: { title: 'Quarter check' } });
  assert.equal(renamed.payload.conversation.title, 'Quarter check');

  const oneMessage = (await request(`assistant/conversations/${conversationId}`)).payload.conversation.messages[0];
  assert.equal((await request(`assistant/conversations/${conversationId}/messages/${oneMessage.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`assistant/conversations/${conversationId}`)).payload.conversation.messages.length, 3);

  assert.equal((await request(`assistant/conversations/${conversationId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request('assistant/conversations')).payload.conversations.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assistant_messages').get().n, 0, 'deleting a conversation cascades to its messages');

  // FR-10: the ledger the conversation was about is untouched.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cash_flow_transactions WHERE id = ?').get(seeded.entryId).n, 1);
  assert.equal((await request(`assistant/conversations/999999`, { method: 'DELETE' })).status, 404);
});

// ---- summary cards ---------------------------------------------------------------------

test('summaries are generated on demand, cached, and marked stale when the data changes', async (t) => {
  const { request, configure, model, close } = await startAssistant({ answer: 'Income of 3200.00 EUR this month, all of it Salary. Nothing was spent.' });
  t.after(close);
  const seeded = await seedCashFlow(request);
  await configure();

  const empty = await request(`assistant/summaries?placement=cashflow&period=${MONTH}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.payload.cached, null);
  assert.equal(empty.payload.stale, false);
  assert.equal(model.calls.length, 0, 'loading the page never calls the model');

  const generated = await request('assistant/summaries', { method: 'POST', body: { placement: 'cashflow', period: MONTH } });
  assert.equal(generated.status, 200, JSON.stringify(generated.payload));
  assert.equal(generated.payload.cached.text, 'Income of 3200.00 EUR this month, all of it Salary. Nothing was spent.');
  assert.ok(generated.payload.cached.generatedAt);
  assert.equal(generated.payload.stale, false);

  const snapshot = model.calls[0].body.messages.at(-1).content;
  assert.match(snapshot, /3200/, 'the card is built from the app\'s own aggregation');
  assert.match(snapshot, /currencies_not_converted/);
  assert.equal(snapshot.includes(TOKEN), false);

  const cached = await request(`assistant/summaries?placement=cashflow&period=${MONTH}`);
  assert.equal(cached.payload.cached.text, generated.payload.cached.text);
  assert.equal(model.calls.length, 1, 'reading a cached card costs no request');

  // A new entry changes the digest the card was generated against.
  await request('cash_flow_transactions', { method: 'POST', body: { account_id: seeded.accountId, category_id: seeded.categoryId, kind: 'income', date: `${MONTH}-20`, amount: 500, currency: 'EUR' } });
  const stale = await request(`assistant/summaries?placement=cashflow&period=${MONTH}`);
  assert.equal(stale.payload.stale, true, 'the data moved, so the card must say so');
  assert.equal(stale.payload.cached.text, generated.payload.cached.text, 'stale does not silently rewrite the text');

  const refreshed = await request('assistant/summaries', { method: 'POST', body: { placement: 'cashflow', period: MONTH } });
  assert.equal(refreshed.payload.stale, false);
  assert.equal(model.calls.length, 2);

  assert.equal((await request(`assistant/summaries?placement=overview`)).payload.cached, null);
  const overview = await request('assistant/summaries', { method: 'POST', body: { placement: 'overview' } });
  assert.equal(overview.status, 200);
  assert.match(overview.payload.cached.text, /Income of/);
  assert.equal((await request('assistant/summaries', { method: 'POST', body: { placement: 'nonsense' } })).status, 502);
  assert.equal((await request('assistant/summaries?placement=cashflow')).status, 400, 'a cash-flow card needs a month');

  await request('assistant/summaries', { method: 'DELETE' });
  assert.equal((await request(`assistant/summaries?placement=cashflow&period=${MONTH}`)).payload.cached, null);
});

test('a summary failure is reported as an actionable message, not a broken card', async (t) => {
  const { request, configure, close } = await startAssistant();
  t.after(close);
  const failure = await startFailingModel(503, 'upstream busy');
  t.after(failure.close);
  await request('assistant/model', { method: 'PUT', body: { baseUrl: failure.baseUrl, model: 'm', token: 'x' } });

  const result = await request('assistant/summaries', { method: 'POST', body: { placement: 'overview' } });
  assert.equal(result.status, 502);
  assert.match(result.payload.error, /server error \(503\)/i);

  await request('assistant/model', { method: 'PUT', body: { clearToken: true } });
  const unconfigured = await request('assistant/summaries', { method: 'POST', body: { placement: 'overview' } });
  assert.equal(unconfigured.status, 502);
  assert.match(unconfigured.payload.error, /Settings/i, 'tells the user where to fix it');
  const read = await request('assistant/summaries?placement=overview');
  assert.equal(read.status, 200, JSON.stringify(read.payload));
  assert.equal(read.payload.modelConfigured, false, JSON.stringify(read.payload));
});
