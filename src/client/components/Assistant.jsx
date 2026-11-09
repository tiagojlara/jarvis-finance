import { useCallback, useEffect, useRef, useState } from 'react';
import { assistantApi, stamp, streamAssistant } from '../api.js';

// In-app chat with Jarvis read tools (phase one, items 2, 4 and 6).
//
// The browser never holds the model token and never talks to the model: the question is POSTed
// to this app's own server, which proxies it to the endpoint you configured and streams the
// answer back as server-sent events. Everything shown here is either local history or the
// model's text. Tool records are rendered as names and durations (FR-8), never as a place to
// act — phase one reads only, so there are no write controls in this view at all.

const STATUS_LABELS = { ok: 'read', error: 'failed', refused: 'refused' };

function ToolActivity({ activity }) {
  if (!activity?.length) return null;
  return <details className="tool-activity">
    <summary>{activity.length} Jarvis tool call{activity.length === 1 ? '' : 's'} <span className="tool-activity-note">what the answer was built from</span></summary>
    <ul>
      {activity.map((item, index) => <li key={`${item.tool}-${index}`} className={`tool-row tool-${item.status}`}>
        <code>{item.tool}</code>
        <span className={`tag ${item.status === 'ok' ? '' : item.status === 'refused' ? 'tag-warn' : 'tag-bad'}`}>{STATUS_LABELS[item.status] || item.status}</span>
        {item.ms ? <span className="tool-ms">{item.ms} ms</span> : null}
        {item.message ? <span className="tool-ms">{item.message}</span> : null}
        {item.args && item.args !== '{}' && <code className="tool-args">{item.args}</code>}
      </li>)}
    </ul>
  </details>;
}

function Message({ message, onRemove }) {
  const failed = Boolean(message.error);
  return <article className={`chat-msg chat-${message.role}${failed ? ' chat-failed' : ''}`}>
    <div className="chat-meta">
      <b>{message.role === 'user' ? 'You' : 'Jarvis'}</b>
      {message.model && message.role === 'assistant' ? <span>{message.model}</span> : null}
      {message.createdAt ? <time dateTime={message.createdAt}>{stamp(message.createdAt)}</time> : null}
      {onRemove && <button type="button" className="text-action danger" onClick={onRemove} aria-label={`Delete this ${message.role === 'user' ? 'question' : 'answer'}`}>Delete</button>}
    </div>
    {message.content ? <div className="chat-body">{message.content}</div> : null}
    {failed && <p className="form-error" role="status">{message.error}</p>}
    {message.role === 'assistant' && <ToolActivity activity={message.toolActivity}/>}
  </article>;
}

function ConversationRow({ conversation, active, onSelect, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (!title || title === conversation.title) { setDraft(conversation.title); return; }
    onRename(conversation.id, title);
  };
  if (editing) {
    return <li className="chat-row chat-row-editing">
      <label className="sr-only" htmlFor={`rename-${conversation.id}`}>Rename conversation</label>
      <input id={`rename-${conversation.id}`} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(conversation.title); setEditing(false); } }}/>
    </li>;
  }
  return <li className={`chat-row ${active ? 'selected' : ''}`}>
    <button type="button" className="chat-row-main" onClick={() => onSelect(conversation.id)} aria-current={active ? 'true' : undefined}>
      <span className="chat-row-title">{conversation.title}</span>
      <span className="chat-row-detail">{conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'} · {stamp(conversation.lastMessageAt || conversation.updatedAt, { time: false })}</span>
    </button>
    <span className="chat-row-actions">
      <button type="button" className="table-action" onClick={() => setEditing(true)}>Rename</button>
      <button type="button" className="table-action table-remove" onClick={() => onDelete(conversation)}>Remove</button>
    </span>
  </li>;
}

export default function Assistant({ navigate, revision = 0 }) {
  const [settings, setSettings] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [disclosure, setDisclosure] = useState(null);
  const [retryAfterDisclosure, setRetryAfterDisclosure] = useState('');
  const abortRef = useRef(null);
  const logEndRef = useRef(null);
  const disclosureRef = useRef(null);

  const loadSettings = useCallback(async () => {
    try { setSettings(await assistantApi('model')); } catch (e) { setError(e.message); }
  }, []);
  const loadList = useCallback(async () => {
    try {
      const { conversations: list } = await assistantApi('conversations');
      setConversations(list);
      return list;
    } catch (e) { setError(e.message); return []; }
  }, []);

  useEffect(() => { loadSettings(); loadList(); }, [loadSettings, loadList]);
  // Another page saved a record while the chat was open; the transcript does not need to change,
  // but the endpoint status line does, so re-read it when app data is refreshed.
  useEffect(() => { if (revision) loadSettings(); }, [revision, loadSettings]);

  const openConversation = useCallback(async (id) => {
    if (!id) {
      setConversationId(null); setMessages([]); setError('');
      const box = document.getElementById('chat-input');
      box?.focus();
      return;
    }
    try {
      const { conversation } = await assistantApi(`conversations/${id}`);
      setConversationId(conversation.id);
      setMessages(conversation.messages);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);

  // The disclosure is a gate, not a decoration: when it opens it takes focus, so a keyboard user
  // lands on the choice instead of tabbing through the transcript to discover it (FR-11).
  useEffect(() => { if (disclosure) disclosureRef.current?.focus(); }, [disclosure]);

  const send = async (question) => {
    const text = String(question ?? draft).trim();
    if (!text || streaming) return;
    setDraft('');
    setError('');
    setStreaming(true);
    setPending({ text: '', activity: [], notices: [] });
    const abort = new AbortController();
    abortRef.current = abort;
    let sawDone = false;
    // The first message of a new chat has no id yet; the server assigns one and echoes it, and
    // the closure below must not read the state variable that has not updated.
    let activeId = conversationId;
    try {
      await streamAssistant({
        message: text,
        conversationId,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === 'user') {
            setMessages((current) => [...current, event.message]);
            if (event.conversationId) { activeId = event.conversationId; setConversationId(event.conversationId); }
          } else if (event.type === 'delta') {
            setPending((current) => (current ? { ...current, text: current.text + event.text } : current));
          } else if (event.type === 'tool') {
            setPending((current) => (current ? { ...current, activity: [...current.activity, event.activity] } : current));
          } else if (event.type === 'notice') {
            setPending((current) => (current ? { ...current, notices: [...current.notices, event.message] } : { text: '', activity: [], notices: [event.message] }));
          } else if (event.type === 'done') {
            sawDone = true;
            if (event.conversationId) { activeId = event.conversationId; setConversationId(event.conversationId); }
            setMessages((current) => [...current, {
              id: event.messageId, role: 'assistant', content: event.text, toolActivity: event.activity || [],
              model: event.model || '', error: event.aborted ? 'Stopped before the answer finished.' : (event.text ? '' : 'The model answered with no text.'),
              createdAt: new Date().toISOString(),
            }]);
            setPending(null);
          } else if (event.type === 'error') {
            // Deliberately not marking the run finished: the server persisted this answer with
            // the tool activity it had already gathered, and re-reading the conversation in the
            // finally block is what shows those calls under a failed answer (FR-8).
            setMessages((current) => [...current, {
              id: event.messageId, role: 'assistant', content: event.partial || '', toolActivity: [],
              model: settings?.model || '', error: event.message, createdAt: new Date().toISOString(),
            }]);
            setPending(null);
          }
        },
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        setPending(null);
      } else if (/disclosure/i.test(e.message)) {
        // HTTP 428: §9 wants the user told what leaves the machine before the first request
        // goes out. The question is kept, not re-typed, and sent once the disclosure is agreed.
        setPending(null);
        setError('');
        setRetryAfterDisclosure(text);
        try { setDisclosure(await assistantApi('disclosure')); } catch { setDisclosure(null); setError(e.message); }
      } else {
        // Run-level failures arrive before any stream frame. Put the question back so the text
        // is not lost on a rejection.
        setError(e.message);
        setDraft((current) => current || text);
        setPending(null);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      // A stream that ended without a done frame (tab closed, abort, dropped socket) leaves the
      // server holding the authoritative rows, so re-read rather than guess at what was saved.
      if (!sawDone && activeId) await openConversation(activeId);
      loadList();
    }
  };

  const acknowledgeAndSend = async () => {
    try {
      await assistantApi('disclosure', { method: 'POST' });
      setDisclosure(null);
      await loadSettings();
      const question = retryAfterDisclosure;
      setRetryAfterDisclosure('');
      if (question) await send(question);
    } catch (e) { setError(e.message); }
  };

  const removeConversation = async (conversation) => {
    if (!window.confirm(`Delete this conversation and its ${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}? No financial record is changed — this only removes the chat.`)) return;
    try {
      await assistantApi(`conversations/${conversation.id}`, { method: 'DELETE' });
      if (conversation.id === conversationId) { setConversationId(null); setMessages([]); }
      await loadList();
    } catch (e) { setError(e.message); }
  };

  const renameConversation = async (id, title) => {
    try { await assistantApi(`conversations/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }); await loadList(); } catch (e) { setError(e.message); }
  };

  const removeMessage = async (message) => {
    if (!window.confirm('Remove this message from the conversation?')) return;
    try {
      await assistantApi(`conversations/${conversationId}/messages/${message.id}`, { method: 'DELETE' });
      setMessages((current) => current.filter((item) => item.id !== message.id));
    } catch (e) { setError(e.message); }
  };

  const ready = settings?.ready;
  const mcpBlocked = settings && settings.mcpEnabled === false;

  return <div className="assistant-shell">
    <aside className="assistant-list panel">
      <div className="assistant-list-head">
        <h2>Conversations</h2>
        <button type="button" className="button button-primary" onClick={() => openConversation(null)}>＋ New chat</button>
      </div>
      {conversations.length ? <ul className="assistant-conversations">
        {conversations.map((conversation) => <ConversationRow key={conversation.id} conversation={conversation} active={conversation.id === conversationId}
          onSelect={openConversation} onRename={renameConversation} onDelete={removeConversation}/>)}
      </ul> : <p className="panel-note">No conversations yet. Anything you ask is stored in this app&apos;s local database, and you can delete it here or message by message.</p>}
      <p className="panel-note assistant-list-foot">History lives on this device only. Deleting a conversation never deletes a record.</p>
    </aside>

    <section className="panel assistant-chat">
      <div className="panel-heading">
        <h2>{conversationId ? `Conversation ${conversationId}` : 'Ask Jarvis'}</h2>
        <span className={`assistant-status ${ready ? 'assistant-ready' : 'assistant-blocked'}`} title={ready ? 'Model endpoint configured' : (settings?.invalidTokenUrl || 'No model endpoint configured yet')}>
          {ready ? '● Model endpoint ready' : '○ No model endpoint'}
        </span>
      </div>

      {!ready && settings && <div className="assistant-gate">
        <p><b>No model endpoint is configured.</b> Chat and summaries are proxy calls to an endpoint you choose; until then Jarvis answers nothing, because a guessed number is worse than none. {settings.invalidTokenUrl ? settings.invalidTokenUrl : ''}</p>
        {navigate && <button type="button" className="button button-quiet" onClick={() => navigate('settings')}>Open model endpoint settings</button>}
      </div>}
      {ready && mcpBlocked && <div className="assistant-gate assistant-gate-warn">
        <p>The local Jarvis connection is switched off, so the assistant cannot read your records. Turn it on under Settings &amp; backup → Model endpoint and assistant.</p>
      </div>}

      <div className="chat-log" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && !pending && <div className="chat-empty">
          <b>Read-only answers, from your own records</b>
          <span>Jarvis looks them up through this app&apos;s local tools and quotes what it finds, per currency. Try “what did I spend in October, by category?” or “which holdings have no price saved?”.</span>
        </div>}
        {messages.map((message) => <Message key={message.id} message={message} onRemove={conversationId ? () => removeMessage(message) : undefined}/>)}
        {pending && <article className="chat-msg chat-assistant">
          <div className="chat-meta"><b>Jarvis</b>{streaming ? <span className="tag">thinking…</span> : null}</div>
          {pending.notices.map((line, index) => <p className="chat-notice" key={index} role="status">{line}</p>)}
          {pending.text ? <div className="chat-body">{pending.text}</div> : <div className="chat-body chat-body-muted">Reading your records…</div>}
          <ToolActivity activity={pending.activity}/>
        </article>}
        <div ref={logEndRef}/>
      </div>

      {error && <p className="form-error chat-error" role="alert">{error}</p>}

      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); send(draft); }}>
        <label className="field field-wide" htmlFor="chat-input">
          <span>Ask about your records <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
          <textarea id="chat-input" rows={3} value={draft} maxLength={8000} placeholder="Which accounts hold cash, and how much in each currency?"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(draft); } }}/>
        </label>
        <div className="chat-composer-actions">
          <span className="chat-composer-note">Sends your question, this conversation, and the records the tools read to the endpoint in Settings. Nothing else.</span>
          {streaming
            ? <button type="button" className="button button-quiet" onClick={() => abortRef.current?.abort()}>Stop</button>
            : <button type="submit" className="button button-primary" disabled={!draft.trim()}>Send</button>}
        </div>
      </form>
    </section>

    {disclosure && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="disclosure-title">
      <div className="modal-card disclosure-card" ref={disclosureRef} tabIndex={-1}
        onKeyDown={(event) => { if (event.key === 'Escape') setDisclosure(null); }}>
        <div className="modal-header"><h2 id="disclosure-title">{disclosure.title}</h2><button type="button" className="icon-button" onClick={() => setDisclosure(null)} aria-label="Close">×</button></div>
        {disclosure.body.map((line, index) => <p className="panel-note" key={index}>{line}</p>)}
        {disclosure.endpoint && <p className="panel-note"><b>Requests go to:</b> <code>{disclosure.endpoint}</code></p>}
        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={() => setDisclosure(null)}>Not now</button>
          <button type="button" className="button button-primary" onClick={acknowledgeAndSend}>I understand, continue</button>
        </div>
      </div>
    </div>}
  </div>;
}
