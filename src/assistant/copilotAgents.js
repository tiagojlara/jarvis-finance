// The agents the CopilotKit endpoint actually serves.
//
// copilotRuntime.js owns the wire and stays generic — it must be testable with a stand-in that has no
// assistant behind it. This file is where that wire meets the app: it turns an AG-UI run request into one
// call of `assistant.run()` and pipes the result through the bridge, so the agent loop, the read-only
// guard, the token handling and the SQLite history all stay exactly where they were (§13:203 keeps the
// provider and MCP adapters out of the UI; the same reasoning keeps them out of the transport).
//
// One fresh agent per request, built by the registry factory in copilotRuntime.js, closing over nothing
// mutable: the model token is decrypted per request and never held on an object the runtime might reuse
// or clone.

const { BuiltInAgent } = require('@copilotkit/runtime/v2');
const { toAguiEvents, runErrorEvent } = require('./aguiBridge');
// The codes come from errors.js, not from the bridge that also uses them: this file gates on the
// assistant's own rules, and the shared table is what keeps those names identical to the ones `agent.js`
// puts on its failures.
const { ERROR_CODES } = require('./errors');
const { EventType } = require('@ag-ui/core');

// A conversation id, or null. `threadId === String(conversation.id)` is the whole identity scheme, so a
// thread that is not one of ours is not a conversation the assistant may write into — and the agent's own
// auto-create fallback is deliberately unreachable here, because a run that silently invented a different
// conversation id than the client is watching would split a chat in two.
function conversationIdFrom(threadId) {
  const text = String(threadId ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// AG-UI carries message content as a string or as parts; only the text of a turn can be a question.
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('');
  }
  return String(content);
}

// The newest user turn, and nothing else.
//
// Measured against 1.85.0: the factory receives exactly what the browser sent, with no server-side
// accumulation, so `input.messages` is the client's account of the conversation — including any history a
// modified page invents. §9 treats that as untrusted data, and FR-1 makes the answer need grounded facts,
// so the browser's history is not used at all: this takes the question and `assistant.run({conversationId})`
// replays the real turns from SQLite. A client that rewrote its own history changes what it sees locally
// and nothing else.
function latestUserTurn(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return contentToText(message.content);
  }
  return '';
}

// The chat. `store`, `history` and `assistant` are the collaborators createAssistantRouter already
// builds — the CopilotKit surface gates and answers with exactly the same objects the REST surface does,
// so the two transports cannot drift into different safety rules.
async function* runTamandua({ ctx, assistant, history, store }) {
  const { threadId, runId } = ctx.input;

  // Disclosure first, before anything that could reach a model. The REST chat answers 428 for the same
  // condition (`routes.js:174-177`); a run error is the closest equivalent here, since a status code does
  // not survive the SSE stream — and the client branches on the code rather than on matching the message
  // text, which is what §C asks for.
  if (!store.acknowledgement().acknowledgedAt) {
    yield runErrorEvent({
      code: ERROR_CODES.disclosureRequired,
      message: 'Acknowledge the data disclosure first.',
    });
    return;
  }

  const conversationId = conversationIdFrom(threadId);
  if (conversationId === null) {
    yield runErrorEvent({
      code: ERROR_CODES.threadRequired,
      message: 'Tamanduá answers inside a saved conversation. Start one and send the question again.',
    });
    return;
  }
  if (!history.get(conversationId)) {
    yield runErrorEvent({
      code: ERROR_CODES.threadUnknown,
      message: 'That conversation no longer exists. Start a new one to keep asking.',
    });
    return;
  }

  // `ctx.abortSignal` is fired by `agent/stop` — the Stop button — and by a run that a newer one on the
  // same thread supersedes. It is NOT fired when the browser closes the connection, which is why the
  // runner is configured to supersede (see copilotRuntime.js) rather than to refuse a second run.
  yield* toAguiEvents({
    source: assistant.run({ conversationId, message: latestUserTurn(ctx.input.messages), signal: ctx.abortSignal }),
    threadId,
    runId,
  });
}

// `assistant.run()` is a factory of collaborators, not of agents: the app builds one assistant at startup
// (it holds the MCP connection) and every request gets its own agent object.
function createTamanduaAgent({ assistant, history, store }) {
  return new BuiltInAgent({
    type: 'custom',
    factory: (ctx) => runTamandua({ ctx, assistant, history, store }),
  });
}

function createSummaryAgent({ summaries }) {
  return new BuiltInAgent({ type: 'custom', factory: async function* (ctx) {
    const { placement, period, system } = ctx.input.forwardedProps || {};
    if (!['overview', 'cashflow'].includes(placement)) throw new Error('Unknown summary placement.');
    const userText = latestUserTurn(ctx.input.messages);
    let text;
    try {
      text = await summaries.completeSummary({ system, userText, placement, period, signal: ctx.abortSignal });
    } catch (error) {
      yield runErrorEvent({ code: ERROR_CODES.runFailed, message: error?.message || 'The summary could not be generated.' });
      return;
    }
    const messageId = `summary-${ctx.input.runId}`;
    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' };
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: String(text) };
    yield { type: EventType.TEXT_MESSAGE_END, messageId };
  } });
}

// The agents whose runs can put finance records on the wire. `summary` is listed before it exists (§F):
// a gate that has to be widened when a second record-reading agent is registered is a gate that will be
// forgotten. `echo` is deliberately absent — it reads nothing and is the transport's own stand-in.
const RECORD_AGENTS = new Set(['tamandua', 'summary']);

// A run request is refused before the agent is built unless the disclosure has been accepted.
//
// This is the *policy* gate, and it is not there for the browser's benefit: the browser is already
// covered by `runTamandua`, which yields a coded `RUN_ERROR`. This one is what `routes.js:174-177`
// guarantees today for the legacy SSE route — that a hand-rolled client speaking the wire protocol
// cannot reach `assistant.run()` without accepting. It sits in `hooks.onBeforeHandler` because that is
// the one place the request is inspected before the run starts, on both entry points at once: the
// express router for the browser and the fetch handler `runLocal` uses for the cards are built from the
// same options object (copilotRuntime.js:94), so neither can be reached without passing here.
//
// Measured, and load-bearing for the shape of the body:
//   - `@copilotkit/runtime`'s fetch handler catches a thrown `Response` and returns it verbatim
//     (core/fetch-handler.cjs:223), so this really is an HTTP 428 on the socket, not an SSE stream.
//   - the browser's transport reads a non-2xx JSON answer into `error.payload` and puts the status on
//     `error.status` (@ag-ui/client `runHttpRequest`), so the code below does reach `onError` — it just
//     arrives there as `error.payload.code` rather than as a RUN_ERROR.
//   - `route` for a run is `{method:'agent/run', agentId}` with no threadId (fetch-handler.cjs:408-413),
//     so the gate can be per-agent but not per-conversation; the thread rules live in the factory.
//
// `agent/connect` and `agent/stop` are not gated on purpose: the first moves no records (measured: an
// empty 200 stream) and the second only stops a run that got here some other way. Refusing Stop would
// strand a run that started before the acknowledgement was withdrawn.
function createPolicyHooks({ store, disclosure, agents = RECORD_AGENTS } = {}) {
  if (!store || typeof store.acknowledgement !== 'function') {
    throw new Error('createPolicyHooks needs the assistant store — a gate that cannot read the acknowledgement is not a gate');
  }
  return {
    onBeforeHandler({ route }) {
      const gated = route && (route.method === 'agent/run' || route.method === 'agent/suggest');
      if (!gated || !agents.has(route.agentId)) return;
      const acknowledgement = store.acknowledgement();
      if (acknowledgement.acknowledgedAt) return;
      throw new Response(JSON.stringify({
        error: 'Acknowledge the data disclosure first.',
        code: ERROR_CODES.disclosureRequired,
        // The same payload the REST surface returns for the same condition, so the modal text the person
        // agrees to is the text the app states (routes.js:93), and a client never has to make a second
        // request to find out what it is being asked to accept.
        disclosure: { ...disclosure, ...acknowledgement },
      }), {
        // 428 Precondition Required, as in routes.js:176 — the code is the one thing the SSE transport
        // cannot carry, so the two surfaces agree on the status and on the code both.
        status: 428,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

module.exports = { createTamanduaAgent, createSummaryAgent, createPolicyHooks, runTamandua, latestUserTurn, contentToText, conversationIdFrom, RECORD_AGENTS };
