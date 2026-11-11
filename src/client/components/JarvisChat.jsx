import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CopilotChat, CopilotKitProvider, useAgent, useRenderTool } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import { useJarvis } from '../jarvisState.jsx';
import { historyToMessages, readToolResult } from '../jarvisMessages.mjs';
import { JARVIS_CODES } from '../jarvisCodes.mjs';

// The CopilotKit half of the assistant, and the only module in the client that imports the library.
//
// Everything about the answer — which tools ran, what the model was told, whether the disclosure was
// accepted — is decided server-side (`src/assistant/copilotAgents.js` → `agent.js`). This file renders
// the transcript the AG-UI stream produces and routes the typed failure codes back to the right surface
// (Settings, the disclosure, or a plain message).
//
// Loaded lazily, by jarvisState.jsx, on the first press of the launcher or a visit to /assistant. Measured
// with `npm run build`: this module's import graph is a 258 kB gzipped chunk that nothing else needs, and
// the entry bundle is unchanged at 96 kB. A holdings table has no business waiting on either.

const AGENT_ID = 'jarvis';

// The library's composer, labelled in our words. `chatDisclaimerText` is the §9 line the hand-rolled
// composer used to print under the input, and `welcomeMessageText` is the empty state; both are strings
// the person reads before anything leaves the machine, so they belong here rather than in a stylesheet.
const LABELS = {
  chatInputPlaceholder: 'Ask about your records — Enter sends, Shift+Enter adds a line',
  welcomeMessageText: 'Read-only answers, from your own records. Jarvis looks them up through this app’s local tools and quotes what it finds, per currency.',
  chatDisclaimerText: 'Sends your question, this conversation, and the records the tools read to the endpoint in Settings. Nothing else.',
};

const STATUS_LABELS = { ok: 'read', error: 'failed', refused: 'refused' };

// FR-8: "users can see which tools ran and whether they read or wrote data".
//
// Registering a renderer is not cosmetic. In 1.85.0 a tool call with no matching renderer paints *nothing*
// (the lookup returns null and the view skips it) — so without this, a run that consulted four tools would
// show an answer with no evidence behind it, and the redacted `{status, ms, reason}` payload the bridge
// sends would be invisible. `group: true` lets the chat fold consecutive calls into one block.
function ToolChip({ name, args, status, result }) {
  const info = readToolResult(result);
  const settled = String(status).toLowerCase() === 'complete';
  const label = STATUS_LABELS[info.status] || (settled ? 'read' : 'reading');
  const shown = STATUS_LABELS[info.status] ? info.status : settled ? 'ok' : 'pending';
  let argText = '';
  try { argText = args && Object.keys(args).length ? JSON.stringify(args) : ''; } catch { argText = ''; }
  return <div className={`jarvis-tool tool-${shown}`}>
    <code>{name}</code>
    <span className={`tag ${shown === 'ok' ? '' : shown === 'refused' ? 'tag-warn' : 'tag-bad'}`}>{label}</span>
    {info.ms ? <span className="tool-ms">{info.ms} ms</span> : null}
    {info.reason ? <span className="tool-ms">{info.reason}</span> : null}
    {argText ? <code className="tool-args">{argText}</code> : null}
  </div>;
}

export default function JarvisChat() {
  return <CopilotKitProvider
    runtimeUrl="/api/copilotkit"
    agentId={AGENT_ID}
    // Both default to on, and both reach for infrastructure this app does not have: the inspector is a
    // developer panel, and the intelligence indicator opens a websocket to the runtime's channel server.
    // `activateChannels: false` on the server side is the other half of the same decision.
    enableInspector={false}
    showIntelligenceIndicator={false}
  >
    <JarvisPanel/>
  </CopilotKitProvider>;
}

function JarvisPanel() {
  const jarvis = useJarvis();
  const { threadId, rows, historyToken, settings, chatError, open, page, slot } = jarvis;
  const panelRef = useRef(null);
  const expanded = page === 'assistant';
  // The same agent instance CopilotChat runs against — `useAgent` reads the registry, not a copy, so
  // `setMessages` here is what the transcript renders from (the view draws `agent.messages` verbatim).
  const { agent, isReady } = useAgent({ agentId: AGENT_ID });

  useRenderTool({ name: '*', group: true, render: ToolChip }, []);

  // The bundle is here; anything the page was showing as "Loading Jarvis…" can stop. Mounted once and
  // kept mounted while the app runs, which is also what keeps the transcript alive across page changes.
  useEffect(() => {
    jarvis.setChatReady(true);
    return () => jarvis.setChatReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore a conversation from SQLite.
  //
  // The chat's own store only holds the turn it watched, so without this an old conversation would reopen
  // with answers whose tool calls have vanished (FR-8 applies to history, not only to live output).
  //
  // Keyed on `historyToken`, not `rows`: the token is bumped exactly when the transcript should be
  // *replaced* server→screen. `rows` is read but not a dependency on purpose — appending a message during
  // a run also changes its identity, and re-applying history then would take the streaming answer back.
  //
  // This is also why the thread is not switched with the `threadId` prop alone: a change there clears the
  // list and posts `agent/connect` (measured: answered here with an empty 200 stream, so nothing re-clears
  // afterwards — the ordering that survives is "library clears, we fill").
  useEffect(() => {
    if (!isReady || !agent) return;
    agent.setMessages(historyToMessages(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, agent, historyToken, threadId]);

  useEffect(() => {
    if (open && !expanded) panelRef.current?.focus();
  }, [open, expanded]);

  // Escape closes the floating panel. On /assistant there is nothing to close.
  useEffect(() => {
    if (!open || expanded) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') jarvis.closePanel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, expanded, jarvis]);

  // The typed codes the server yields (`src/assistant/errors.js`), not a regex over the message: FR-9 wants
  // a failure to say what to do, and "open Settings" is a different action from "read the disclosure".
  //
  // Two measured shapes, because the two gates fail differently:
  //   - a yielded `RUN_ERROR` arrives as `{error, code: 'agent_run_error_event', context: {runtimeErrorCode:
  //     our code, event}}`, with the code also on `error.code`;
  //   - the policy gate's HTTP 428 never becomes an event. AG-UI's `runHttpRequest` reads a non-2xx JSON
  //     body into `error.payload` (and `error.status`), and the core re-emits it as `agent_run_failed`, so
  //     `payload.code` is where our code is — and `payload.disclosure` is the text to show, already here.
  // All three are read, in that order, because which one survives the wrapper is the library's business.
  const handleError = useCallback((event) => {
    const payload = event?.error?.payload;
    const code = event?.context?.runtimeErrorCode || payload?.code || event?.error?.code || '';
    if (code === JARVIS_CODES.runStopped) {
      // Not a failure: the person pressed Stop. The partial answer is already on screen and already
      // persisted server-side, so there is nothing to report and nothing to retry.
      return;
    }
    if (code === JARVIS_CODES.disclosureRequired) { jarvis.ensureDisclosure(payload?.disclosure); return; }
    if (code === JARVIS_CODES.modelNotConfigured) { jarvis.loadSettings(); jarvis.setChatError(event?.error?.message || 'No model endpoint is configured yet.'); return; }
    if (code === JARVIS_CODES.threadRequired || code === JARVIS_CODES.threadUnknown) {
      // The conversation this tab is writing to no longer exists — deleted from the other surface, or a
      // thread id the library invented before ours landed. Make a real one and say so plainly.
      jarvis.ensureThread().catch(() => {});
      jarvis.setChatError('This conversation was removed. Send again to start a new one.');
      return;
    }
    // `payload.error` first: for an HTTP refusal the message AG-UI builds is `HTTP 428: {"error":…}` —
    // the sentence the server wrote is the one to show, not the wire dump around it.
    jarvis.setChatError(payload?.error || event?.error?.message || 'Jarvis could not answer.');
  }, [jarvis]);

  if (!open && !expanded) return null;

  const ready = Boolean(settings?.ready);
  const body = <>
    {!expanded && <div className="jarvis-panel-head">
      <b>Ask Jarvis</b>
      <span className="jarvis-panel-actions">
        <button type="button" className="table-action" onClick={() => jarvis.startNewChat()}>New chat</button>
        <button type="button" className="icon-button" onClick={jarvis.closePanel} aria-label="Close Ask Jarvis">×</button>
      </span>
    </div>}
    {!ready && settings && <p className="jarvis-gate">
      No model endpoint is configured, so Jarvis answers nothing — a guessed number is worse than none.
      {jarvis.navigate && <button type="button" className="text-action" onClick={() => jarvis.navigate('settings')}>Open settings</button>}
    </p>}
    {chatError && <p className="form-error chat-error" role="alert">{chatError}</p>}
    <div className="jarvis-chat">
      <CopilotChat
        agentId={AGENT_ID}
        // `threadId === String(conversation.id)` (§B). Never null: the provider creates the conversation
        // when the surface opens, and an invented library id would be refused server-side as
        // `jarvis_thread_unknown` rather than silently writing somewhere we do not own.
        threadId={threadId || undefined}
        labels={LABELS}
        onError={handleError}
        inspectorTools={false}
        // No `attachments`: a file picker would open a second path for records to leave the machine, and
        // the §9 disclosure above does not describe one.
      />
    </div>
  </>;

  // One chat instance, two placements: the full page hands us a node to render into, and navigating back
  // to it moves the same conversation rather than remounting it.
  if (expanded) {
    return slot ? createPortal(<div className="jarvis-panel jarvis-inpage">{body}</div>, slot)
      : <div className="chat-empty"><b>Loading Jarvis…</b></div>;
  }
  return <div className="jarvis-panel jarvis-floating" role="dialog" aria-label="Ask Jarvis" ref={panelRef} tabIndex={-1}>{body}</div>;
}
