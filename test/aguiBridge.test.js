// The bridge is a translator, so it gets tested as one: a scripted list of the events `assistant.run()`
// yields in, the AG-UI events out, with no HTTP, no model and no database.
//
// What makes these tests worth more than reading the bridge back to myself: the ordering rules are the
// library's contract, not mine, so almost every case is also fed through `verifyEvents` and
// `enforceEvents` — the actual operators `@ag-ui/client` uses to police a run. They are requirable from
// CommonJS, which means a CopilotKit minor that tightens a rule fails a test here instead of failing a
// user's chat. `verifyEvents` and `enforceEvents` are also checked against a deliberately broken
// sequence, because an oracle that cannot fail is not an oracle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyEvents, enforceEvents } = require('@ag-ui/client');
const { EventType } = require('@ag-ui/core');
// rxjs is not ours to own — @ag-ui/client, @copilotkit/runtime, core and shared each pin exactly 7.8.1
// while the hoisted copy in this tree is 7.8.2. So `from` is resolved from the package whose operators we
// drive, never from the repo root: handing a library an Observable built by a different copy of its own
// scheduler dependency is the kind of failure that only appears after a routine `npm install`. Nothing in
// package.json should ever declare rxjs; test/dependencies.test.js holds that line.
const { from } = require(require.resolve('rxjs', { paths: [require.resolve('@ag-ui/client')] }));

const { toAguiEvents, ERROR_CODES, RESULT_MESSAGE_LIMIT } = require('../src/assistant/aguiBridge');
const { AssistantInputError } = require('../src/assistant/errors');
const { createCopilotModule } = require('../src/assistant/copilotRuntime');
const { BuiltInAgent } = require('@copilotkit/runtime/v2');

const THREAD = '7';
const RUN = 'run-1';
const ASSISTANT_ID = `assistant-${RUN}`;

// A scripted `assistant.run()`. Fields match what agent.js actually yields, including the ones the
// bridge must ignore (`step`, `text`, `conversationId` on a user row).
async function* script(events) {
  for (const event of events) yield event;
}
async function* throwsAfter(events, error) {
  for (const event of events) yield event;
  throw error;
}

async function collect(source) {
  const events = [];
  for await (const event of toAguiEvents({ source, threadId: THREAD, runId: RUN })) events.push(event);
  return events;
}

const typesOf = (events) => events.map((event) => event.type);
const deltasOf = (events, messageId) => events
  .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && (!messageId || event.messageId === messageId))
  .map((event) => event.delta)
  .join('');
const event = (events, type) => events.find((candidate) => candidate.type === type);
const wire = (events) => JSON.stringify(events);

// The oracle. Returns {lifecycle, schema}, each null when the corresponding operator was satisfied.
async function protocolOf(events, { threadId = THREAD, runId = RUN, envelope = true } = {}) {
  const stream = envelope ? [{ type: EventType.RUN_STARTED, threadId, runId }, ...events] : events;
  // Resolved from BOTH terminal callbacks: an RxJS stream that errors never calls `complete`, so a helper
  // that only settles there hangs instead of reporting the violation it was built to catch — which is how
  // this first version behaved, and why the teeth case below is the one that found it.
  const run = (operator) => new Promise((resolve) => {
    operator(from(stream)).subscribe({
      next: () => {},
      error: (error) => resolve(String(error?.message ?? error)),
      complete: () => resolve(null),
    });
  });
  return { lifecycle: await run(verifyEvents({ threadId, runId })), schema: await run(enforceEvents()) };
}

async function assertProtocol(events, label) {
  const { lifecycle, schema } = await protocolOf(events);
  assert.equal(lifecycle, null, `${label}: verifyEvents rejected the ordering — ${lifecycle}`);
  assert.equal(schema, null, `${label}: enforceEvents rejected an event shape — ${schema}`);
}

// The tool call used by most cases. `rows` is what a real MCP result would carry; it must never reach the
// wire, while `args` must, because FR-8 asks which tools ran and with what.
const RECORDS_CALL = {
  id: 'call_9f2',
  tool: 'list_records',
  args: { table: 'transactions', month: '2026-11' },
  ms: 3,
  status: 'ok',
  rows: [{ amount: 12345.67, currency: 'EUR', note: 'Lidl Groceries' }],
};

const SCENARIOS = {
  'a plain answer': [{ type: 'delta', text: 'You are ', step: 0 }, { type: 'delta', text: 'fine.', step: 0 },
    { type: 'done', messageId: 12, conversationId: 7, text: 'ignored', model: 'fake-model', activity: [], refusals: [], aborted: false }],
  'an answer that consults a tool': [{ type: 'delta', text: 'Let me look.', step: 0 },
    { type: 'tool', activity: RECORDS_CALL }, { type: 'delta', text: 'You are fine.', step: 1 },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [RECORDS_CALL], refusals: [], aborted: false }],
  'an answer interrupted by a refusal': [{ type: 'delta', text: 'Checking.', step: 0 },
    { type: 'notice', message: 'Read-only: deleting a record was refused.' },
    { type: 'tool', activity: { ...RECORDS_CALL, status: 'refused', message: 'write tool blocked' } },
    { type: 'delta', text: 'Nothing was changed.', step: 1 },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [{ tool: 'delete_record' }], aborted: false }],
  'two tool calls in one turn': [{ type: 'tool', activity: RECORDS_CALL },
    { type: 'tool', activity: { ...RECORDS_CALL, id: 'call_3a1', tool: 'monthly_cashflow' } },
    { type: 'delta', text: 'Two reads.', step: 1 },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [], aborted: false }],
  'a stopped answer': [{ type: 'delta', text: 'Half an ', step: 0 },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [], aborted: true }],
  'a failure mid-answer': [{ type: 'delta', text: 'So far so', step: 0 },
    { type: 'error', message: 'The model endpoint is not configured.', messageId: 12, conversationId: 7, code: 'tamandua_model_not_configured' }],
  'a failure with no code': [{ type: 'error', message: 'Something went wrong.' }],
};

test('every sequence the bridge produces satisfies AG-UI itself', async () => {
  for (const [label, events] of Object.entries(SCENARIOS)) {
    await assertProtocol(await collect(script(events)), label);
  }
});

test('the oracle has teeth: a broken sequence is not accepted', async () => {
  // Without this, the case above could be passing because the operators never reject anything — the same
  // reasoning as the telemetry suite's negative control.
  const broken = [{ type: EventType.TEXT_MESSAGE_START, messageId: 'a', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'x' },
    { type: EventType.RUN_FINISHED, threadId: THREAD, runId: RUN }];
  const { lifecycle } = await protocolOf(broken);
  assert.match(String(lifecycle), /RUN_FINISHED.*text messages are still active|text messages are still active/, 'the lifecycle operator accepted an unterminated message');

  const noEnvelope = await protocolOf([{ type: EventType.TEXT_MESSAGE_START, messageId: 'a', role: 'assistant' }], { envelope: false });
  assert.match(String(noEnvelope.lifecycle), /First event must be/, 'the operator ran but never enforces the envelope either');
});

test('an answer streams as one assistant message', async () => {
  const events = await collect(script(SCENARIOS['a plain answer']));
  assert.deepEqual(typesOf(events).filter((type) => type !== EventType.RUN_FINISHED), [
    EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
  ]);
  // One id for the whole turn, and only the first delta opens it — a second START on an open message is
  // rejected outright by verifyEvents, which is what the bridge's textOpen flag exists to prevent.
  for (const event of events) if (event.messageId) assert.equal(event.messageId, ASSISTANT_ID);
  assert.equal(deltasOf(events), 'You are fine.');
});

test('the user turn the client already sent is never re-emitted', async () => {
  const events = await collect(script([{ type: 'user', message: { id: 1, role: 'user', content: 'how am I doing?' }, conversationId: 7 },
    ...SCENARIOS['a plain answer']]));
  assert.equal(typesOf(events).filter((type) => type === EventType.TEXT_MESSAGE_START).length, 1);
  assert.doesNotMatch(wire(events), /how am I doing\?/, 'the bridge replayed the user turn back into the run');
});

test('the tool chip closes the paragraph it interrupts', async () => {
  const events = await collect(script(SCENARIOS['an answer that consults a tool']));
  const order = typesOf(events);
  const endBeforeTool = order.indexOf(EventType.TEXT_MESSAGE_END) < order.indexOf(EventType.TOOL_CALL_START);
  assert.ok(endBeforeTool, `the chip arrived inside an open message: ${order.join(' -> ')}`);
  // The answer resumes under the same message id, so one turn is one bubble in the client.
  assert.equal(order.filter((type) => type === EventType.TEXT_MESSAGE_START).length, 2);
  assert.deepEqual(order.slice(order.indexOf(EventType.TOOL_CALL_START), order.indexOf(EventType.TOOL_CALL_START) + 4), [
    EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT,
  ]);
  assert.equal(deltasOf(events), 'Let me look.You are fine.');
});

test('a tool result carries the guard log and never the records', async () => {
  const events = await collect(script(SCENARIOS['an answer that consults a tool']));
  const result = event(events, EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(result.content), { status: 'ok', ms: 3 });
  assert.equal(result.role, 'tool');
  // The call itself is on the wire — which tool, with what arguments (FR-8).
  assert.equal(event(events, EventType.TOOL_CALL_START).toolCallName, 'list_records');
  assert.match(event(events, EventType.TOOL_CALL_ARGS).delta, /"table":"transactions"/);
  // What must not be: anything from the result payload. This becomes a persisted thread message that any
  // process on the loopback bind could ask to replay.
  const serialized = wire(events);
  for (const secret of ['12345.67', 'Lidl', 'EUR', 'rows']) {
    assert.ok(!serialized.includes(secret), `a record payload reached the wire: ${secret}`);
  }
  // The same call also arrives on `done` as `activity`, and the scenario puts the payload in it on
  // purpose: this is what caught the bridge copying that list into RUN_FINISHED.result, which would have
  // made every record a persisted thread message readable by anything on the loopback bind.
  assert.ok(SCENARIOS['an answer that consults a tool'].at(-1).activity.length > 0, 'the done-activity path is no longer exercised');
});

test('a failure reason is kept and cut to a length', async () => {
  const events = await collect(script([{ type: 'tool', activity: { ...RECORDS_CALL, status: 'error', message: 'x'.repeat(5000) } },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [], aborted: false }]));
  const content = JSON.parse(event(events, EventType.TOOL_CALL_RESULT).content);
  assert.equal(content.status, 'error');
  assert.equal(content.reason.length, RESULT_MESSAGE_LIMIT, 'the reason was not bounded');
});

test('a tool call the guard gave no id for still pairs', async () => {
  // The guard now puts an id on every entry, but conversations persisted before it did still have none,
  // and a hand-made activity object is easy to pass through. Either way the quartet has to be internally
  // consistent: verifyEvents refuses TOOL_CALL_ARGS for a toolCallId nothing opened, but accepts an
  // unmatched TOOL_CALL_RESULT *silently* — so a mispairing shows up as a chip that never rendered, not
  // as an error. This is the bridge's own defence, tested separately from the guard's.
  const events = await collect(script([{ type: 'tool', activity: { tool: 'list_records', args: {}, ms: 1, status: 'ok' } },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [], aborted: false }]));
  const started = event(events, EventType.TOOL_CALL_START);
  assert.match(started.toolCallId, /^tool-run-1-\d+$/, `expected a generated id, got ${started.toolCallId}`);
  assert.equal(event(events, EventType.TOOL_CALL_ARGS).toolCallId, started.toolCallId);
  assert.equal(event(events, EventType.TOOL_CALL_END).toolCallId, started.toolCallId);
  assert.equal(event(events, EventType.TOOL_CALL_RESULT).toolCallId, started.toolCallId);
  await assertProtocol(events, 'an id-less tool call');
});

test('two calls in one turn get distinct ids', async () => {
  const events = await collect(script(SCENARIOS['two tool calls in one turn']));
  const starts = events.filter((candidate) => candidate.type === EventType.TOOL_CALL_START).map((candidate) => candidate.toolCallId);
  assert.deepEqual(starts, ['call_9f2', 'call_3a1']);
  assert.equal(new Set(events.filter((c) => c.type === EventType.TOOL_CALL_RESULT).map((c) => c.toolCallId)).size, 2);
});

test('a refusal notice is its own message, not part of the answer', async () => {
  const events = await collect(script(SCENARIOS['an answer interrupted by a refusal']));
  const noticeStarts = events.filter((candidate) => candidate.type === EventType.TEXT_MESSAGE_START && candidate.messageId !== ASSISTANT_ID);
  assert.equal(noticeStarts.length, 1, 'a refusal should arrive as exactly one standalone message');
  assert.notEqual(noticeStarts[0].messageId, ASSISTANT_ID);
  assert.equal(deltasOf(events, noticeStarts[0].messageId), 'Read-only: deleting a record was refused.');
  assert.equal(deltasOf(events, ASSISTANT_ID), 'Checking.Nothing was changed.');
  // The notice does not disturb the run envelope: the terminal event is still last.
  assert.equal(typesOf(events).at(-1), EventType.RUN_FINISHED);
});

test('done ends the run with the answer metadata and nothing follows it', async () => {
  const events = await collect(script(SCENARIOS['a plain answer']));
  const finished = events.at(-1);
  assert.equal(finished.type, EventType.RUN_FINISHED);
  assert.equal(finished.threadId, THREAD);
  assert.equal(finished.runId, RUN);
  assert.deepEqual(finished.result, { messageId: 12, conversationId: 7, model: 'fake-model', refusals: [], aborted: false });
  // The bridge emits no envelope of its own beyond the RUN_FINISHED the runner consumes; RUN_STARTED in
  // particular would arrive twice and make the verifier fail the stream.
  assert.equal(typesOf(events).filter((type) => type === EventType.RUN_STARTED).length, 0);
});

test('a stopped answer says so, and a late event cannot follow the terminal', async () => {
  const events = await collect(script([{ type: 'delta', text: 'Half an ', step: 0 },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [], aborted: true },
    { type: 'delta', text: 'answer that arrived after the stop', step: 1 }]));
  assert.equal(event(events, EventType.RUN_FINISHED).result.aborted, true);
  assert.doesNotMatch(deltasOf(events), /arrived after the stop/, 'the bridge kept emitting after the run finished');
  await assertProtocol(events, 'a stopped answer with a late delta');
  // Nothing may *depend* on that result: when a run is stopped the runner suppresses its own synthesized
  // RUN_FINISHED, so the payload never reaches the client. The stopped message comes from the client's own
  // Stop action and the partial row in SQLite. This is why the flag is carried, not relied upon.
});

test('a failure keeps its typed code, and an untyped one is named', async () => {
  const coded = await collect(script(SCENARIOS['a failure mid-answer']));
  assert.deepEqual(typesOf(coded), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
  assert.equal(event(coded, EventType.RUN_ERROR).code, 'tamandua_model_not_configured');
  assert.equal(event(coded, EventType.RUN_ERROR).message, 'The model endpoint is not configured.');

  const bare = await collect(script(SCENARIOS['a failure with no code']));
  assert.equal(event(bare, EventType.RUN_ERROR).code, ERROR_CODES.runFailed);
  // Never a RUN_FINISHED after a failure, or the client would render a finished answer and an error.
  assert.equal(typesOf(bare).includes(EventType.RUN_FINISHED), false);
});

test('a source that throws becomes a typed failure with the user’s own error named', async () => {
  const input = await collect(throwsAfter([], new AssistantInputError('Ask something first.')));
  assert.deepEqual(typesOf(input), [EventType.RUN_ERROR]);
  assert.equal(input[0].code, ERROR_CODES.inputInvalid);
  assert.equal(input[0].message, 'Ask something first.');

  const internal = await collect(throwsAfter([{ type: 'delta', text: 'partial' }], new Error('cannot read properties of undefined')));
  assert.deepEqual(typesOf(internal), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
  assert.equal(internal.at(-1).code, ERROR_CODES.runFailed);
  await assertProtocol(internal, 'a thrown error mid-answer');
});

test('an event this bridge does not know is ignored, not fatal', async () => {
  const events = await collect(script([
    { type: 'delta', text: 'answer' },
    { type: 'progress', percent: 40 },
    { type: 'done', messageId: 12, conversationId: 7, model: 'fake-model', activity: [], refusals: [], aborted: false },
  ]));
  assert.equal(deltasOf(events), 'answer');
  assert.equal(typesOf(events).at(-1), EventType.RUN_FINISHED);
});

test('a run that says nothing emits nothing at all', async () => {
  assert.deepEqual(await collect(script([])), [], 'an empty run should not invent a message');
  // A source that ends without ever yielding done/error still leaves no lifecycle open, which is the only
  // way the runtime can close the run without failing the verifier.
  const textOnly = await collect(script([{ type: 'delta', text: 'dangling' }]));
  assert.deepEqual(typesOf(textOnly), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END]);
  await assertProtocol(textOnly, 'a source that never terminates');
});

test('the bridge drives a real run through the runtime', async () => {
  // The part the pure cases cannot show: the runtime's injected envelope and the bridge's body have to
  // interleave into one valid stream, and the runner's merge of our RUN_FINISHED result has to survive.
  const { runLocal } = createCopilotModule({
    extraAgents: async () => ({
      tamandua: new BuiltInAgent({
        type: 'custom',
        factory: (ctx) => toAguiEvents({
          source: script(SCENARIOS['an answer that consults a tool']),
          threadId: ctx.input.threadId,
          runId: ctx.input.runId,
        }),
      }),
    }),
  });
  // A non-numeric thread: the runtime's thread store is process-global, so summary and bridge runs must
  // not share ids with real conversation ids.
  const { text, events } = await runLocal({ agentId: 'tamandua', threadId: 'bridge-e2e-1', message: 'am I overexposed?' });

  assert.equal(typesOf(events).at(0), EventType.RUN_STARTED, 'no envelope');
  assert.equal(typesOf(events).at(-1), EventType.RUN_FINISHED);
  assert.equal(typesOf(events).filter((type) => type === EventType.RUN_STARTED).length, 1, 'the run started twice');
  assert.equal(typesOf(events).filter((type) => type === EventType.RUN_FINISHED).length, 1, 'two terminal events reached the client');
  assert.equal(text, 'Let me look.You are fine.');
  assert.deepEqual(events.filter((e) => e.type === EventType.TOOL_CALL_RESULT).map((e) => JSON.parse(e.content)), [{ status: 'ok', ms: 3 }]);
  // Merged from the event the bridge yielded, by the runner rather than dropped by it.
  assert.equal(event(events, EventType.RUN_FINISHED).result.model, 'fake-model');
  assert.equal(event(events, EventType.RUN_FINISHED).result.messageId, 12);
  assert.equal(event(events, EventType.RUN_ERROR), undefined, `the run failed: ${wire(events)}`);
});
