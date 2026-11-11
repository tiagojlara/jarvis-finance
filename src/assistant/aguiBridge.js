// Translates the assistant's own event stream into AG-UI events.
//
// This is the whole CopilotKit integration on the server side: `assistant.run()` stays the brain —
// tool activity tracking, MCP connection, token handling, SQLite history — and everything the chat
// protocol needs is derived here from what it already
// yields. Nothing in this file opens a socket, reads a database or knows about Express, which is what
// makes it testable by feeding it a scripted list of events.
//
// Measured against CopilotKit 1.85.0, and load-bearing for the choices below:
//   - the runtime injects RUN_STARTED and RUN_FINISHED itself; a factory emitting its own RUN_STARTED
//     produces a duplicate and the event verifier fails the stream with INCOMPLETE_STREAM;
//   - for a custom agent, a yielded RUN_FINISHED is consumed and merged into the synthesized one, so a
//     `result` payload survives — but it is dropped when the run was stopped, so nothing may depend on
//     reading it after an abort (the partial answer lives in SQLite, not in the event);
//   - RUN_ERROR is accepted while a text message is still open, and a thrown error becomes a RUN_ERROR
//     with no code — a typed code only exists if it is yielded here;
//   - one messageId may be reused across a tool call and the text after it, which is what lets a single
//     assistant turn keep one id;
//   - the rules that really bind, read out of `verifyEvents` (which is requirable, so
//     test/aguiBridge.test.js uses the library's own operator as the oracle rather than my reading of
//     it): RUN_FINISHED is refused while a text message is open, a messageId already in progress cannot
//     be re-opened, and TOOL_CALL_ARGS is refused for a toolCallId no TOOL_CALL_START opened. An
//     unmatched TOOL_CALL_RESULT, by contrast, is accepted and simply never renders — so a mispaired
//     call fails quietly and pairing has to be asserted, not assumed.

const { EventType } = require('@ag-ui/core');
// Re-exported below: the names are the assistant's, not the transport's, so they are defined in errors.js
// and `agent.js` uses the same table without requiring anything from this file.
const { ERROR_CODES } = require('./errors');

// A RUN_ERROR that the factory can yield directly, for the gates that happen before a run starts.
function runErrorEvent({ code, message }) {
  return { type: EventType.RUN_ERROR, code: code || ERROR_CODES.runFailed, message: String(message || 'The assistant could not answer.') };
}

// How long a tool's error text may be before it is cut. The message is written for a person to read in
// the activity panel, and an MCP failure can echo back part of what it was given; the records themselves
// never appear here, but a pathological error string should not become a thread message either.
const RESULT_MESSAGE_LIMIT = 400;

// What a tool call looks like on the wire. Deliberately the guard's own log — status, timing, the reason
// it failed — and never the tool's result payload: a TOOL_CALL_RESULT becomes a persisted thread message
// that anything on the loopback bind could ask to replay, and FR-8 asks which tools ran, not for the
// rows they read.
function toolResultContent(activity) {
  const content = { status: activity.status || 'ok', ms: Number(activity.ms) || 0 };
  if (activity.message) content.reason = String(activity.message).slice(0, RESULT_MESSAGE_LIMIT);
  return JSON.stringify(content);
}

// One completed tool call, as the four events AG-UI expects. `fallbackId` exists because the guard's
// entry carries the LangChain call id only in recent versions; a tool call with no id cannot pair its
// START with its RESULT, so it gets a deterministic one.
function* toolCallEvents(activity, fallbackId) {
  const toolCallId = String(activity.id || fallbackId);
  yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: String(activity.tool || 'tool') };
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: typeof activity.args === 'string' ? activity.args : JSON.stringify(activity.args ?? {}) };
  yield { type: EventType.TOOL_CALL_END, toolCallId };
  yield { type: EventType.TOOL_CALL_RESULT, messageId: `${toolCallId}-result`, toolCallId, role: 'tool', content: toolResultContent(activity) };
}

// A standalone line the assistant says *about* the run rather than as its answer.
function* noticeEvents(message, id) {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' };
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: String(message) };
  yield { type: EventType.TEXT_MESSAGE_END, messageId: id };
}

// The bridge. `source` is `assistant.run()`'s async iterable (or any iterable of the same events, in a
// test); `threadId` and `runId` come from the AG-UI run input and are echoed back on the terminal event
// the runtime re-emits.
async function* toAguiEvents({ source, threadId, runId }) {
  const chatRunId = String(runId || 'run');
  const assistantMessageId = `assistant-${chatRunId}`;
  let textOpen = false;
  let sequence = 0;
  let terminal = false;

  // Anything but a further delta closes the open message first. The protocol only *requires* this
  // before RUN_FINISHED (refused while a text message is active) and before re-opening the same id; a
  // TOOL_CALL_START or a notice's own message would both be accepted mid-paragraph. We close anyway
  // because of how the client renders: a tool chip or a refusal line arriving inside the streaming
  // answer nests it under the paragraph it interrupted, which is the difference between the activity
  // panel reading as a step and reading as a typo in the middle of a sentence.
  const closeText = () => {
    if (!textOpen) return null;
    textOpen = false;
    return { type: EventType.TEXT_MESSAGE_END, messageId: assistantMessageId };
  };

  try {
    for await (const event of source) {
      switch (event.type) {
        case 'user':
          // Already in input.messages — the client sent it. Re-emitting would duplicate the turn.
          break;

        case 'delta': {
          if (!textOpen) {
            textOpen = true;
            yield { type: EventType.TEXT_MESSAGE_START, messageId: assistantMessageId, role: 'assistant' };
          }
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantMessageId, delta: String(event.text ?? '') };
          break;
        }

        case 'tool': {
          const closing = closeText();
          if (closing) yield closing;
          sequence += 1;
          yield* toolCallEvents(event.activity || {}, `tool-${chatRunId}-${sequence}`);
          break;
        }

        case 'notice': {
          const closing = closeText();
          if (closing) yield closing;
          sequence += 1;
          yield* noticeEvents(event.message, `notice-${chatRunId}-${sequence}`);
          break;
        }

        case 'error': {
          const closing = closeText();
          if (closing) yield closing;
          terminal = true;
          // Yielded rather than thrown, which is the whole point: a thrown factory error reaches the client
          // as RUN_ERROR with no code, and the UI needs the code to know whether to open Settings or the
          // disclosure modal.
          //
          // The runtime then appends its own RUN_FINISHED when this generator completes, and AG-UI's own
          // verifier refuses it ("the run has already errored") — so the client's last event is this one and
          // the answer's partial text is not taken back. That refusal prints one "Agent execution failed"
          // stack in the server log per failed run; it is the library's fight, not a bug here, and
          // test/copilotTransport.test.js pins both halves.
          yield runErrorEvent({ code: event.code || ERROR_CODES.runFailed, message: event.message });
          return;
        }

        case 'done': {
          const closing = closeText();
          if (closing) yield closing;
          terminal = true;
          // Consumed by the runner and merged into the RUN_FINISHED it emits. On an aborted run the
          // runtime suppresses that one, so this payload is for a finished answer only.
          yield {
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            // Deliberately not `event.activity`. It is the same list the client has already received one
            // TOOL_CALL_* quartet per entry for, so forwarding it would double a payload that becomes a
            // persisted thread message — and would quietly inherit whatever `record()` decides to carry
            // some day. Today that list is `{tool, args, ms, status, message}` with args previewed, so a
            // `result`/`rows` field added to the guard two modules away would land here with no test
            // failing. Names and reasons stay; the guard's full log is readable from SQLite history, which
            // is the surface FR-10 assigns it.
            result: {
              messageId: event.messageId ?? null,
              conversationId: event.conversationId ?? null,
              model: event.model ?? null,
              aborted: Boolean(event.aborted),
            },
          };
          return;
        }

        default:
          // An event from a newer agent.js than this bridge knows about. Ignoring it keeps a working
          // answer; throwing would turn a forward-compatible addition into a red error card.
          break;
      }
    }

    if (!terminal) {
      // The source ran out without saying done or error. Close cleanly and let the runtime finish the
      // run; the alternative — an unterminated text message — fails the protocol verifier.
      const closing = closeText();
      if (closing) yield closing;
    }
  } catch (error) {
    const closing = closeText();
    if (closing) yield closing;
    if (!terminal) {
      // `run()` throws before it can emit anything usable: an empty message, one that is too long, or a
      // failure with no partial to keep. AssistantInputError is the user's own fault and says so.
      const code = error?.name === 'AssistantInputError' ? ERROR_CODES.inputInvalid : ERROR_CODES.runFailed;
      terminal = true;
      yield runErrorEvent({ code, message: error?.message || 'The assistant could not answer.' });
    }
  }
}

module.exports = { toAguiEvents, toolCallEvents, noticeEvents, runErrorEvent, ERROR_CODES, toolResultContent, RESULT_MESSAGE_LIMIT };
