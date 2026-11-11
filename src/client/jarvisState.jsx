import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { assistantApi } from './api.js';

// Split out of this module's import graph on purpose. `npm run build` measures CopilotKit's UI stack at
// 258 kB gzipped, and the launcher below has to be on screen at first paint of every page — so the chat is
// fetched the first time it is actually wanted (`armed`) and the entry bundle stays what it was.
const JarvisChat = lazy(() => import('./components/JarvisChat.jsx'));

// Everything the assistant surfaces share, held outside CopilotKit so it survives a chat remount and so
// this module can sit in the entry bundle. The chat itself (components/JarvisChat.jsx) is loaded lazily
// and owns the CopilotKit provider; this file owns the parts that are ours: the conversation list, the
// thread identity, the model-endpoint status line, and the §9 disclosure.
//
// That split is deliberate. The two surfaces — the floating launcher on every page and the full-width
// conversation at /assistant — must never disagree about which conversation is open or whether the
// disclosure has been accepted, and a context above both is the only place that cannot drift.
const JarvisContext = createContext(null);
export const useJarvis = () => useContext(JarvisContext);

export function JarvisProvider({ page, revision = 0, navigate, children }) {
  // The heavy chat module is only fetched once the person shows they want it: the first tap on the
  // launcher, or arriving on /assistant. Measured with `npm run build`, CopilotKit's UI stack is 258 kB
  // gzipped, and it has no business being on the critical path of a page that shows a holdings table.
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  // String form of a SQLite conversation id: CopilotKit's thread id and ours are the same number (§B).
  const [threadId, setThreadId] = useState(null);
  const [rows, setRows] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [settings, setSettings] = useState(null);
  const [disclosure, setDisclosure] = useState(null);
  const [chatError, setChatError] = useState('');
  // Set by the chat module once it has actually mounted, so the page can tell "still downloading the
  // bundle" apart from "downloading is done and this conversation is empty" — the two look identical
  // otherwise, and an unexplained blank panel on a local-first app reads as broken.
  const [chatReady, setChatReady] = useState(false);
  // Bumped only when the transcript on screen should be *replaced* from the server: opening a
  // conversation, starting a new one, an explicit reload. Deliberately not bumped when a run appends
  // messages locally, because re-applying stored history over a live transcript would take the streaming
  // answer back mid-sentence.
  const [historyToken, setHistoryToken] = useState(0);

  // State is what renders; refs are what the callbacks branch on. Reading `threadId` inside a callback
  // would see the value from the render that created it, so a "clear then create" sequence would find the
  // old id still there and return it.
  const threadRef = useRef(null);
  const rowsRef = useRef([]);
  const creatingRef = useRef(null);
  const setThread = useCallback((id) => { threadRef.current = id; setThreadId(id); }, []);
  const setTranscript = useCallback((next) => {
    rowsRef.current = next;
    setRows(next);
    setHistoryToken((token) => token + 1);
  }, []);

  const loadSettings = useCallback(async () => {
    try { setSettings(await assistantApi('model')); } catch { /* the status line stays "no model endpoint" */ }
  }, []);
  const loadConversations = useCallback(async () => {
    try { const { conversations: list } = await assistantApi('conversations'); setConversations(list); } catch { /* the list is a convenience here */ }
  }, []);

  useEffect(() => { loadSettings(); loadConversations(); }, [loadSettings, loadConversations]);
  // Another page saved a record while the chat was open: the transcript does not change, the endpoint
  // status line does.
  useEffect(() => { if (revision) loadSettings(); }, [revision, loadSettings]);

  const openConversation = useCallback(async (id) => {
    setChatError('');
    if (!id) { setThread(null); setTranscript([]); return null; }
    setThread(String(id));
    try {
      const { conversation } = await assistantApi(`conversations/${id}`);
      setTranscript(conversation.messages || []);
    } catch (e) { setChatError(e.message); setTranscript([]); }
    return String(id);
  }, [setThread, setTranscript]);

  // A conversation is created when the panel is opened, not on first send, because the transport refuses a
  // run with no thread it recognises (`jarvis_thread_required`): the id has to be in SQLite before the
  // first message goes out, and a browser cannot mint one. In-flight creates are shared, so the launcher
  // and the /assistant page mounting together produce one conversation rather than two.
  const ensureThread = useCallback(async () => {
    if (threadRef.current) return threadRef.current;
    if (creatingRef.current) return creatingRef.current;
    const pending = assistantApi('conversations', { method: 'POST', body: '{}' })
      .then(({ conversation }) => {
        const id = String(conversation.id);
        setThread(id);
        setTranscript([]);
        loadConversations();
        return id;
      })
      .finally(() => { if (creatingRef.current === pending) creatingRef.current = null; });
    creatingRef.current = pending;
    return pending;
  }, [setThread, setTranscript, loadConversations]);

  // An empty conversation is the one artefact of creating on open, so it is dropped again when the surface
  // closes with nothing said. The conversation row only — never a record (FR-10).
  const dropThread = useCallback(async (id) => {
    if (threadRef.current === id) { setThread(null); setTranscript([]); }
    try { await assistantApi(`conversations/${id}`, { method: 'DELETE' }); } catch { /* left behind, and listed */ }
    loadConversations();
  }, [setThread, setTranscript, loadConversations]);

  const closePanel = useCallback(() => {
    setOpen(false);
    const id = threadRef.current;
    if (id && !rowsRef.current.length) dropThread(id);
  }, [dropThread]);

  const startNewChat = useCallback(async () => {
    const previous = threadRef.current;
    if (previous && !rowsRef.current.length) {
      await dropThread(previous);
      setChatError('');
      return ensureThread();
    }
    setThread(null);
    setTranscript([]);
    setChatError('');
    return ensureThread();
  }, [dropThread, ensureThread, setThread, setTranscript]);

  const removeConversation = useCallback(async (conversation) => {
    if (!window.confirm(`Delete this conversation and its ${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}? No financial record is changed — this only removes the chat.`)) return;
    try {
      await assistantApi(`conversations/${conversation.id}`, { method: 'DELETE' });
      if (String(conversation.id) === threadRef.current) { setThread(null); setTranscript([]); }
      await loadConversations();
    } catch (e) { setChatError(e.message); }
  }, [setThread, setTranscript, loadConversations]);

  const renameConversation = useCallback(async (id, title) => {
    try { await assistantApi(`conversations/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }); await loadConversations(); } catch (e) { setChatError(e.message); }
  }, [loadConversations]);

  // §9: what leaves the machine has to be said before the first request goes out. The old page raised the
  // disclosure only after the server refused the run; asking the moment the chat is opened is stronger, and
  // it means a question is never typed, refused, and re-typed. The server-side gate stays regardless —
  // this one is a courtesy on top of a rule.
  // `prefetched` is the disclosure the policy gate sent back with its 428: the server already spelled out
  // what it would send, so asking it again would be a second request for text we are holding.
  const ensureDisclosure = useCallback(async (prefetched) => {
    try {
      const info = prefetched || await assistantApi('disclosure');
      if (!info.acknowledgedAt) setDisclosure(info);
      return info;
    } catch { return null; }
  }, []);

  const acknowledgeDisclosure = useCallback(async () => {
    try {
      await assistantApi('disclosure', { method: 'POST' });
      setDisclosure(null);
      await loadSettings();
    } catch (e) { setChatError(e.message); }
  }, [loadSettings]);

  // Opening the chat is the one moment we know the person wants the heavy module: arm the lazy import,
  // make sure there is a thread to write into, and put the disclosure up if it has not been agreed to.
  const arm = useCallback(() => {
    setArmed(true);
    setOpen(true);
    setChatError('');
    ensureDisclosure();
    ensureThread().catch((e) => setChatError(e.message));
  }, [ensureDisclosure, ensureThread]);

  // The full-page view hands the chat a place to render into; the floating panel renders in this module's
  // own subtree instead. One chat instance either way, so the transcript survives navigating.
  const [slot, setSlot] = useState(null);
  const registerSlot = useCallback((node) => setSlot(node), []);
  // /assistant is the expanded conversation, so arriving there is the same intent as opening the panel —
  // without the disclosure check having to wait for a click.
  useEffect(() => {
    if (page !== 'assistant') return;
    setArmed(true);
    ensureDisclosure();
    ensureThread().catch((e) => setChatError(e.message));
  }, [page, ensureDisclosure, ensureThread]);

  const value = {
    page, armed, open, setOpen, closePanel, arm, navigate,
    threadId, rows, historyToken, conversations, settings, disclosure, chatError, slot, chatReady,
    setChatError, setDisclosure, setChatReady,
    ensureThread, openConversation, startNewChat, removeConversation, renameConversation,
    loadConversations, loadSettings, ensureDisclosure, acknowledgeDisclosure, registerSlot,
  };
  // The chat icon on every page (Ask Jarvis is no longer a nav entry). Plain HTML and CSS, rendered from
  // this module so it exists before the chat module has even been requested. Hidden on /assistant, where
  // the conversation is the page itself, and while the panel is open, because the panel owns its close
  // control — two ways to do the same thing reads as a glitch.
  const launcher = page !== 'assistant' && !open && <button type="button" className="jarvis-launcher" onClick={arm}
    aria-label="Open Ask Jarvis" title={settings?.ready ? 'Ask Jarvis about your records' : 'Ask Jarvis — no model endpoint configured yet'}>
    <span aria-hidden="true">✦</span>
    {settings && !settings.ready && <span className="jarvis-launcher-dot" aria-hidden="true"/>}
  </button>;

  return <JarvisContext.Provider value={value}>
    {children}
    {launcher}
    {armed && <Suspense fallback={null}><JarvisChat/></Suspense>}
    <DisclosureModal/>
  </JarvisContext.Provider>;
}

// One instance, for both surfaces: whoever trips the disclosure gate gets the same modal, and the chat
// module never has to own it.
function DisclosureModal() {
  const { disclosure, setDisclosure, acknowledgeDisclosure } = useJarvis();
  const boxRef = useRef(null);
  // It takes focus when it opens, so a keyboard user lands on the choice instead of tabbing through the
  // transcript to discover it (FR-11).
  useEffect(() => { if (disclosure) boxRef.current?.focus(); }, [disclosure]);
  if (!disclosure) return null;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="disclosure-title">
    <div className="modal-card disclosure-card" ref={boxRef} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') setDisclosure(null); }}>
      <div className="modal-header"><h2 id="disclosure-title">{disclosure.title}</h2><button type="button" className="icon-button" onClick={() => setDisclosure(null)} aria-label="Close">×</button></div>
      {disclosure.body.map((line, index) => <p className="panel-note" key={index}>{line}</p>)}
      {disclosure.endpoint && <p className="panel-note"><b>Requests go to:</b> <code>{disclosure.endpoint}</code></p>}
      <div className="modal-actions">
        <button type="button" className="button button-quiet" onClick={() => setDisclosure(null)}>Not now</button>
        <button type="button" className="button button-primary" onClick={acknowledgeDisclosure}>I understand, continue</button>
      </div>
    </div>
  </div>;
}
