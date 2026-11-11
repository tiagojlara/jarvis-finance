// The CopilotKit transport, tested over the real mounted app: real sockets, real SSE, real express
// ordering. These are the behaviours the assistant UI will depend on and that no amount of reading the
// library's typings can establish — several of them contradicted what the typings suggested, so they are
// pinned here instead of in a comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// An explicitly provisioned key keeps these tests off the macOS Keychain, as in assistant.test.js.
process.env.TAMANDUA_ASSISTANT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
delete process.env.TAMANDUA_ASSISTANT_KEY_FILE;

const { createApp } = require('../src/app');
const { createCopilotModule, CopilotRunError, COPILOT_BASE_PATH, eventsFromSse } = require('../src/assistant/copilotRuntime');
const { createTamanduaAgent, createPolicyHooks, RECORD_AGENTS } = require('../src/assistant/copilotAgents');
const { runErrorEvent, ERROR_CODES } = require('../src/assistant/aguiBridge');
const { BuiltInAgent } = require('@copilotkit/runtime/v2');
const { EventType } = require('@ag-ui/core');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The body shape the browser sends. Mirrors what @copilotkit/react-core puts on the wire, because the
// contract under test is the one our handler has to satisfy, not the one a component happens to build.
const runBody = ({ threadId = '1', runId = 'run-1', content = 'how am I doing?', forwardedProps = {}, agentId = 'echo' } = {}) => ({
  method: 'agent/run',
  params: { agentId },
  body: {
    threadId,
    runId,
    tools: [],
    context: [],
    state: {},
    forwardedProps,
    messages: [{ id: `${runId}-user`, role: 'user', content }],
  },
});

async function postRun(url, body, init = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...init,
  });
  const text = await response.text();
  return { response, events: eventsFromSse(text) };
}

const typesOf = (events) => events.map((event) => (event.type === EventType.RUN_ERROR ? `RUN_ERROR(${event.code})` : event.type));
const textOf = (events) => events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta).join('');

// The app under test, listening on an ephemeral loopback port — the same bind the product ships with.
async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-copilot-test-'));
  let server;
  // `copilot` is returned so a test can drive the in-process route (`runLocal`, the summary cards' route)
  // against the same app that serves the socket, which is the only way to show both go through one gate.
  const { app, db, copilot } = createApp({ dataDir, assistantMcpUrl: () => `http://127.0.0.1:${server.address().port}/mcp` });
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const url = `http://127.0.0.1:${server.address().port}${COPILOT_BASE_PATH}`;
  const api = async (route, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
    return { status: response.status, type: response.headers.get('content-type') || '', body: await response.text() };
  };
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { url, api, copilot, close };
}

// A bare app around one module, for the cases that need an agent the shipped registry does not have.
async function startWith(module) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(module.router);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  return {
    url: `http://127.0.0.1:${server.address().port}${COPILOT_BASE_PATH}`,
    close: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test('the assistant answers over the CopilotKit endpoint', async () => {
  const { url, close } = await startApp();
  try {
    const { response, events } = await postRun(url, runBody({ content: 'am I overexposed?' }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    // The runtime owns the run envelope: RUN_STARTED first, RUN_FINISHED last, our text in between.
    // A bridge that emitted its own lifecycle events would double these and fail the server's own
    // event verifier, which is why the shape is asserted rather than assumed.
    assert.deepEqual(typesOf(events).slice(0, 1), [EventType.RUN_STARTED]);
    assert.equal(typesOf(events).at(-1), EventType.RUN_FINISHED);
    assert.match(textOf(events), /am I overexposed\?/);
  } finally {
    await close();
  }
});

test('forwardedProps reach the agent', async () => {
  const { url, close } = await startApp();
  try {
    const { events } = await postRun(url, runBody({ forwardedProps: { placement: 'cashflow', period: '2026-11' } }));
    assert.match(textOf(events), /"placement":"cashflow"/);
    assert.match(textOf(events), /"period":"2026-11"/);
  } finally {
    await close();
  }
});

test('a question larger than the body parser used to tolerate still arrives whole', async () => {
  const { url, close } = await startApp();
  try {
    const long = 'x'.repeat(9000);
    const { events } = await postRun(url, runBody({ content: long }));
    // express.json has already consumed the stream by the time the handler runs; it rebuilds the
    // request from the parsed body. If that re-serialisation broke, this is where it shows.
    assert.equal(textOf(events).split('echo:')[1].split('|props:')[0].length, long.length);
  } finally {
    await close();
  }
});

test('the endpoint is mounted ahead of the generic /api/:table router', async () => {
  const { url, api, close } = await startApp();
  try {
    const { response } = await postRun(url, runBody());
    assert.equal(response.status, 200);
    // The portfolio router answers /api/<anything> as a table lookup. If it were registered first it
    // would take the POST and reply with a JSON 404, and the chat would die with a parse error.
    const mistaken = await api('/api/copilotkit/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.doesNotMatch(mistaken.type, /text\/event-stream/);
  } finally {
    await close();
  }
});

test('one conversation can hold many turns', async () => {
  const { url, close } = await startApp();
  try {
    // threadId === the SQLite conversation id, so reuse is the whole design. The default runner throws
    // for a thread it considers busy; three sequential turns on one thread have to answer three times.
    for (const [runId, content] of [['t1', 'first'], ['t2', 'second'], ['t3', 'third']]) {
      const { events } = await postRun(url, runBody({ threadId: '42', runId, content }));
      assert.equal(typesOf(events).at(-1), EventType.RUN_FINISHED, `${runId}: ${typesOf(events).join('->')}`);
      assert.match(textOf(events), new RegExp(content));
    }
  } finally {
    await close();
  }
});

// A stand-in for a slow model answer. `forwardedProps.hang` decides whether this turn stalls, so one
// agent can play both the abandoned run and the follow-up that has to be allowed to run. `aborts`
// counts aborts across runs instead of storing a flag: the follow-up run starts its own generator, and
// anything boolean would be reset by it before the test gets to read it.
function scriptedAgent(state = { aborts: 0 }) {
  const factory = async function* (ctx) {
    const hang = Boolean((ctx.input.forwardedProps || {}).hang);
    ctx.abortSignal.addEventListener('abort', () => { state.aborts += 1; });
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'h1', role: 'assistant' };
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'h1', delta: 'half an answer' };
    if (hang) for (let i = 0; i < 200 && !ctx.abortSignal.aborted; i += 1) await sleep(25);
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'h1' };
  };
  return { state, agent: new BuiltInAgent({ type: 'custom', factory }) };
}

test('a dropped connection does not lock the conversation', async () => {
  // The failure this guards: a user closes the tab mid-answer. The in-memory runner marks a thread as
  // running for the duration of a run, and an abandoned run leaves it marked — so the next question in
  // the same conversation answers RUN_ERROR(THREAD_ALREADY_RUNNING), and stays that way until the
  // server restarts, because a conversation id *is* the thread id here. `onConcurrentRun: "supersede"`
  // is what lets the follow-up run evict the ghost instead of being refused by it.
  const scripted = scriptedAgent();
  const { url, close } = await startWith(createCopilotModule({ extraAgents: async () => ({ echo: scripted.agent }) }));
  try {
    const controller = new AbortController();
    const abandoned = postRun(url, runBody({ threadId: '7', runId: 'abandoned', content: 'hang up on me', forwardedProps: { hang: true } }), { signal: controller.signal })
      .catch(() => ({ events: [] }));
    await sleep(150);
    controller.abort();
    await abandoned;
    assert.equal(scripted.state.aborts, 0, 'a client disconnect aborted the run — the library does not do this, so the test would be asserting the wrong contract');

    const { events } = await postRun(url, runBody({ threadId: '7', runId: 'after', content: 'back again' }));
    assert.deepEqual(events.filter((event) => event.type === EventType.RUN_ERROR).map((event) => event.code), [], `the abandoned run locked the thread: ${typesOf(events).join(' -> ')}`);
    assert.equal(typesOf(events).at(-1), EventType.RUN_FINISHED);

    // The abandoned generator is not left parked either: the superseding run is what tells it to stop.
    // Disconnecting the client does NOT (measured — the library stops pulling from the generator and
    // leaves the signal un-fired, so a model request would keep running against a dead socket), which
    // is exactly why a ghost run must be evictable rather than merely tolerated.
    await sleep(150);
    assert.ok(scripted.state.aborts >= 1, 'the superseded run was never told to stop, so its model call would keep going');
  } finally {
    await close();
  }
});

test('agent/stop aborts the run in flight, which is what the Stop button needs', async () => {
  // "Stopped before the answer finished." has to be reachable on demand, and the partial has to be
  // persisted by the aborted run rather than lost. @copilotkit/core implements stopAgent() as exactly
  // this POST to the same single route (core/dist/index.mjs:1416), so this is the wire the browser's
  // Stop button produces — and the only thing that makes ctx.abortSignal fire.
  const scripted = scriptedAgent();
  const { url, close } = await startWith(createCopilotModule({ extraAgents: async () => ({ echo: scripted.agent }) }));
  try {
    const running = postRun(url, runBody({ threadId: '8', runId: 'in-flight', content: 'stop me', forwardedProps: { hang: true } }));
    await sleep(200);
    const stop = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'agent/stop', params: { agentId: 'echo', threadId: '8' }, body: {} }) });
    assert.equal(stop.status, 200);
    const { events } = await running;
    assert.ok(scripted.state.aborts >= 1, 'the run kept going after agent/stop');
    // The stream ends one way or the other; what matters is that it ends and that the run stopped.
    assert.ok(events.length > 0, 'the stopped run returned no events at all');
  } finally {
    await close();
  }
});

test('runLocal answers in-process, without a socket', async () => {
  // This is how a summary card gets its completion. Nothing about it touches a port, so it cannot be
  // reached by another process on the loopback bind — which matters because the card prompt carries a
  // snapshot of the user's records.
  const { runLocal } = createCopilotModule();
  const { text } = await runLocal({ agentId: 'echo', threadId: 'local-1', message: 'card', forwardedProps: { placement: 'overview', period: '2026-11' } });
  assert.match(text, /echo:card/);
  assert.match(text, /"placement":"overview"/);
});

test('runLocal raises a typed error instead of returning an empty answer', async () => {
  const { runLocal } = createCopilotModule();
  await assert.rejects(
    () => runLocal({ agentId: 'no-such-agent', threadId: 'local-2', message: 'hi' }),
    (error) => {
      assert.ok(error instanceof CopilotRunError, `got ${error.name}`);
      assert.ok(error.code, 'the caller branches on error.code');
      return true;
    },
  );
  await assert.rejects(() => runLocal({ agentId: 'echo', message: 'no thread' }), /threadId/);
  // The stand-in is registered as `echo`, never as `tamandua`: an app that failed to wire the real agent
  // should answer "no such agent", not a polite echo that a user would read as an answer about their money.
  await assert.rejects(() => runLocal({ agentId: 'tamandua', threadId: 'local-3', message: 'am I overexposed?' }), (error) => {
    assert.ok(error instanceof CopilotRunError, `got ${error.name}`);
    assert.doesNotMatch(error.message, /echo:/, 'the stand-in answered for the real agent');
    return true;
  });
});

test('a yielded RUN_ERROR is the last thing the client sees, and the partial before it survives', async (t) => {
  // This one is worth pinning because the mechanism behind it is a library fight, not our code.
  //
  // When a factory's iterable completes, the runtime appends its own RUN_FINISHED unconditionally
  // (`@copilotkit/runtime/dist/agent/index.cjs:1260` — the only guard is on `signal.aborted`, not on the
  // run having already errored). AG-UI's verifier then refuses it: "Cannot send event type 'RUN_FINISHED':
  // The run has already errored with 'RUN_ERROR'". The refused event never reaches the wire, so the client
  // gets exactly the sequence asserted below — and the server console gets one "Agent execution failed"
  // stack per failed run, which is why this test also asserts the stack. If a future release fixes the
  // synthesis, that assertion fails and says so; if one ever let RUN_FINISHED through after a failure, the
  // client would read a finished answer on a run that did not finish, and the sequence assertion catches it.
  const seen = [];
  t.mock.method(console, 'error', (...args) => seen.push(args.map(String).join(' ')));
  const failing = new BuiltInAgent({
    type: 'custom',
    factory: async function* () {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'half', role: 'assistant' };
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'half', delta: 'some text before the failure' };
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'half' };
      yield runErrorEvent({ code: ERROR_CODES.runFailed, message: 'the model stopped answering' });
    },
  });
  const { url, close } = await startWith(createCopilotModule({ extraAgents: async () => ({ echo: failing }) }));
  try {
    const { response, events } = await postRun(url, runBody({ threadId: '9', content: 'go' }));
    assert.equal(response.status, 200, 'a failed run still answers the stream');
    // `typesOf` renders a failure as `RUN_ERROR(code)`, so the code is part of the sequence assertion.
    assert.deepEqual(typesOf(events), [
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      `RUN_ERROR(${ERROR_CODES.runFailed})`,
    ]);
    assert.equal(textOf(events), 'some text before the failure', 'the partial is not taken back');
    assert.equal(events.at(-1).code, ERROR_CODES.runFailed);
    assert.equal(events.some((event) => event.type === EventType.RUN_FINISHED), false);
    assert.ok(seen.some((line) => /Agent execution failed/.test(line)), 'the library no longer fights its own terminal event — update this test');
    assert.ok(seen.some((line) => /already errored with 'RUN_ERROR'/.test(line)), JSON.stringify(seen));
  } finally {
    await close();
  }
});

test('the mounted app refuses an unacknowledged run before the agent is built', async () => {
  // §C, the policy gate, measured on the app that ships. The refusal happens in `hooks.onBeforeHandler`,
  // which is why the answer is a JSON 428 and not an SSE stream: the run never starts, so there is no run
  // to fail. A hand-rolled client speaking the wire protocol hits this same wall, which is the property
  // the legacy SSE route (`routes.js:174-177`) guarantees and a factory-side check alone would not.
  const { url, close } = await startApp();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(runBody({ threadId: '1', content: 'how much do I have?', agentId: 'tamandua' })),
    });
    const raw = await response.text();
    assert.equal(response.status, 428, raw);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const refusal = JSON.parse(raw);
    assert.equal(refusal.code, ERROR_CODES.disclosureRequired);
    assert.match(refusal.disclosure.body.join(' '), /records the model reads back/);
    assert.equal(refusal.disclosure.acknowledgedAt, null);
    assert.equal(eventsFromSse(raw).length, 0, 'a refused request must not also open a stream');
  } finally {
    await close();
  }
});

test('the gate lets an acknowledged client through to the real tamandua agent', async () => {
  // The other half of that rename, checked against the app that ships: after the disclosure is accepted
  // the request reaches `tamandua` — and the reply is the agent's own thread rule, which the stand-in does
  // not have. An echo here would mean the real agent is not registered, and a polite answer about
  // someone's money would be the failure mode.
  const { url, api, close } = await startApp();
  try {
    const accepted = await api('/api/assistant/disclosure', { method: 'POST' });
    assert.equal(accepted.status, 200, accepted.body);
    const { response, events } = await postRun(url, runBody({ threadId: 'not-a-conversation', content: 'how much do I have?', agentId: 'tamandua' }));
    assert.equal(response.status, 200, typesOf(events).join(' -> '));
    assert.equal(events.at(-1).type, EventType.RUN_ERROR);
    assert.equal(events.at(-1).code, ERROR_CODES.threadRequired, JSON.stringify(events.at(-1)));
    assert.doesNotMatch(textOf(events), /echo:/, 'the stand-in answered for the real agent');
  } finally {
    await close();
  }
});

test('the policy gate is scoped to the agents that read records', async () => {
  // A gate that blocks everything is a gate someone will switch off. What has to stay open while the
  // disclosure is unacked: the transport stand-in (no records, and the tests above lean on it), the
  // `info` handshake the provider performs on mount, `agent/connect` (measured: an empty 200 stream that
  // moves nothing), and `agent/stop`, which only ever ends a run that got here some other way.
  const { url, api, close } = await startApp();
  try {
    const echo = await postRun(url, runBody({ threadId: '1', content: 'still echoing' }));
    assert.equal(echo.response.status, 200);
    assert.match(textOf(echo.events), /still echoing/);

    const info = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'info', params: {}, body: {} }) });
    assert.equal(info.status, 200, await info.text());

    // Framed the way the client frames it — `runId` and `messages` are validated even though a connect
    // reads neither, so a bare body is a 400 rather than evidence of anything.
    const connect = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'agent/connect', params: { agentId: 'tamandua' }, body: { threadId: '1', runId: 'connect-probe', messages: [] } }) });
    assert.equal(connect.status, 200, await connect.text());

    const stop = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'agent/stop', params: { agentId: 'tamandua', threadId: '1' }, body: {} }) });
    assert.notEqual(stop.status, 428, 'Stop was gated, which would strand a run that is already going');

    // And the gate is real for the record-reading agent on this same app, so the four passes above are
    // scoping, not an absent hook.
    const gated = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(runBody({ agentId: 'tamandua' })) });
    assert.equal(gated.status, 428);
    assert.equal((await api('/api/assistant/disclosure', { method: 'POST' })).status, 200);
  } finally {
    await close();
  }
});

test('runLocal goes through the same gate as the browser', async () => {
  // The reason the two entry points are built from one options object (copilotRuntime.js:94). The summary
  // cards send a snapshot of the records, which is more than a question does, so a gate that covered only
  // the socket route would be guarding the smaller of the two paths.
  const { copilot, api, close } = await startApp();
  try {
    await assert.rejects(
      () => copilot.runLocal({ agentId: 'tamandua', threadId: '1', message: 'how much do I have?' }),
      (error) => {
        assert.ok(error instanceof CopilotRunError, `got ${error.name}`);
        // The code is lifted out of the JSON body: without it, "you have not accepted the disclosure" and
        // "the endpoint is down" are the same error, and a caller cannot tell a modal from a retry.
        assert.equal(error.code, ERROR_CODES.disclosureRequired, error.message);
        assert.equal(error.status, 428);
        assert.match(error.message, /disclosure/i);
        return true;
      },
    );
    await api('/api/assistant/disclosure', { method: 'POST' });
    // Acknowledged: the request now reaches the agent, and the code comes back the other way — out of a
    // RUN_ERROR event on a 200 stream. Both lifts are asserted because the two failure shapes are
    // genuinely different and the cards have to survive either.
    await assert.rejects(
      () => copilot.runLocal({ agentId: 'tamandua', threadId: '0', message: 'how much do I have?' }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.threadRequired, error.message);
        assert.equal(error.status, undefined, 'a coded run error has no HTTP status — the stream said 200');
        return true;
      },
    );
  } finally {
    await close();
  }
});

test('an agent built without the hooks still gates inside itself', async () => {
  // Defence in depth, asserted rather than assumed: `runTamandua` checks the acknowledgement too, so a
  // module constructed without `createPolicyHooks` — a future mount that forgets the hooks, or a test
  // harness — cannot answer a record question either. The shape differs (a coded RUN_ERROR on a 200
  // stream, because the run did start) and that difference is why the client reads both `payload.code`
  // and `context.runtimeErrorCode`.
  const store = { acknowledgement: () => ({ acknowledgedAt: null }) };
  const history = { get: () => ({ id: 1 }) };
  let ran = 0;
  const assistant = { run: async function* () { ran += 1; yield { type: 'delta', text: 'should not be reached' }; } };
  const agent = createTamanduaAgent({ assistant, history, store });
  const { url, close } = await startWith(createCopilotModule({ extraAgents: async () => ({ echo: agent }) }));
  try {
    const { response, events } = await postRun(url, runBody({ threadId: '1', content: 'how much do I have?' }));
    assert.equal(response.status, 200, 'the refusal is inside the stream here, not before it');
    assert.equal(events.at(-1).type, EventType.RUN_ERROR);
    assert.equal(events.at(-1).code, ERROR_CODES.disclosureRequired, JSON.stringify(events.at(-1)));
    assert.equal(textOf(events), '', 'a gated run cannot answer');
    assert.equal(ran, 0, 'assistant.run() was called while the disclosure was unacked');
  } finally {
    await close();
  }
});

test('createPolicyHooks reads the route, not the request body', async () => {
  // The pure half of the gate, without a socket: which routes it looks at, which agents it refuses, and
  // what it answers with. `route` is what the runtime hands a hook for a run — `{method:'agent/run',
  // agentId}` with no threadId (fetch-handler.cjs:408-413) — so this is also the test that says the gate
  // cannot be per-conversation, which is why the thread rules sit in the factory instead.
  const disclosure = { title: 'What the assistant sends', body: ['one', 'two'] };
  const pending = { acknowledgement: () => ({ acknowledgedAt: null }) };
  const accepted = { acknowledgement: () => ({ acknowledgedAt: '2026-11-10T09:00:00.000Z' }) };
  const run = { method: 'agent/run', agentId: 'tamandua' };

  assert.equal(createPolicyHooks({ store: accepted, disclosure }).onBeforeHandler({ route: run }), undefined,
    'an acknowledged run is passed through, unchanged');
  assert.equal(createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({ route: { method: 'agent/run', agentId: 'echo' } }), undefined,
    'the transport stand-in reads no records, so it is not gated');
  assert.equal(createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({ route: { method: 'info' } }), undefined);
  assert.equal(createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({ route: { method: 'agent/connect', agentId: 'tamandua' } }), undefined);
  assert.equal(createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({ route: { method: 'agent/stop', agentId: 'tamandua', threadId: '1' } }), undefined);
  assert.equal(createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({}), undefined, 'a route the runtime did not resolve is not a run');

  // A thrown Response can only be consumed once, so the status and the body are read from one capture.
  // The body is the contract with both clients: the browser's transport parses it into `error.payload`,
  // and `runLocal` lifts `code` out of it for the cards.
  const refusal = capture(() => createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({ route: run }));
  assert.ok(refusal instanceof Response, `expected a Response to short-circuit with, got ${refusal}`);
  assert.equal(refusal.status, 428);
  assert.match(refusal.headers.get('content-type'), /application\/json/);
  const payload = await refusal.json();
  assert.equal(payload.code, ERROR_CODES.disclosureRequired);
  assert.equal(payload.error, 'Acknowledge the data disclosure first.');
  assert.equal(payload.disclosure.title, 'What the assistant sends');
  assert.deepEqual(payload.disclosure.body, ['one', 'two'], 'the disclosure text the person agrees to is the app’s own');
  assert.equal(payload.disclosure.acknowledgedAt, null);

  assert.throws(
    () => createPolicyHooks({ store: pending, disclosure }).onBeforeHandler({ route: { method: 'agent/suggest', agentId: 'summary' } }),
    (response) => { assert.equal(response.status, 428); return true; },
    'a suggestion run reads records too',
  );
  assert.deepEqual([...RECORD_AGENTS].sort(), ['tamandua', 'summary'], 'a new record-reading agent must be added to the gated set');
  assert.throws(() => createPolicyHooks({ disclosure }), /store/, 'a gate that cannot read the acknowledgement refuses to be built');
});

// Returns what the hook threw, or null when it let the request through.
function capture(fn) {
  try { fn(); return null; } catch (thrown) { return thrown; }
}
