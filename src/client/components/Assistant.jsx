import { useEffect, useRef, useState } from 'react';
import { assistantApi, stamp } from '../api.js';
import { useTamandua } from '../tamanduaState.jsx';

// The full-width conversation at /assistant.
//
// The transcript itself is not here: it is the one chat surface the app has (components/TamanduaChat.jsx),
// which renders into `tamandua-slot` below through a portal, so the same conversation can also float over
// any other page from the launcher icon. What stays on this page is the part that is ours and has nothing
// to do with streaming — the conversation list, the endpoint status and the FR-10
// controls that let a person inspect and delete their own history.
//
// Keeping those here rather than inside the chat is also why this module imports no CopilotKit: the page
// renders instantly, and only the panel it hosts is the lazily fetched chunk.

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

// FR-10 asks that a person can inspect what was stored and delete any of it. The transcript is the
// library's to render, so the row-by-row control lives beside it, read from the same SQLite rows the
// chat was restored from — which means this list is also the place the full `toolActivity` record (args,
// durations) is still legible, and the tool chips in the chat are the short version of it.
function MessageList({ rows, onDelete }) {
  if (!rows.length) return <p className="panel-note">Nothing stored in this conversation yet.</p>;
  return <ul className="assistant-messages">
    {rows.map((message) => <li key={message.id} className="assistant-message-row">
      <div className="assistant-message-main">
        <b>{message.role === 'user' ? 'You' : 'Tamanduá'}</b>
        <span>{String(message.content || '').slice(0, 90) || (message.error ? message.error : '(no text)')}</span>
        <time dateTime={message.createdAt}>{stamp(message.createdAt)}</time>
        {message.toolActivity?.length ? <span className="tool-ms">{message.toolActivity.map((item) => item.tool).join(', ')}</span> : null}
      </div>
      <button type="button" className="table-action table-remove" onClick={() => onDelete(message)}>Delete</button>
    </li>)}
  </ul>;
}

export default function Assistant({ navigate }) {
  const tamandua = useTamandua();
  const { settings, conversations, threadId, rows, chatReady } = tamandua;
  const slotRef = useRef(null);

  // Hand the chat a place to render into, and take it back on unmount so the panel falls through to its
  // floating form the moment this page is gone.
  useEffect(() => {
    tamandua.registerSlot(slotRef.current);
    return () => tamandua.registerSlot(null);
  }, [tamandua.registerSlot]);

  const removeMessage = async (message) => {
    if (!window.confirm('Remove this message from the conversation?')) return;
    try {
      await assistantApi(`conversations/${threadId}/messages/${message.id}`, { method: 'DELETE' });
      // Re-read from the server rather than splicing the local list: the stored rows are the authority, and
      // a deleted message can leave a tool result whose call is gone, which the chat must not be shown.
      await tamandua.openConversation(threadId);
    } catch (e) { tamandua.setChatError(e.message); }
  };

  const ready = Boolean(settings?.ready);
  const mcpBlocked = settings && settings.mcpEnabled === false;
  const active = conversations.find((conversation) => String(conversation.id) === threadId);

  return <div className="assistant-shell">
    <aside className="assistant-list panel">
      <div className="assistant-list-head">
        <h2>Conversations</h2>
        <button type="button" className="button button-primary" onClick={() => tamandua.startNewChat()}>＋ New chat</button>
      </div>
      {conversations.length ? <ul className="assistant-conversations">
        {conversations.map((conversation) => <ConversationRow key={conversation.id} conversation={conversation} active={String(conversation.id) === threadId}
          onSelect={tamandua.openConversation} onRename={tamandua.renameConversation} onDelete={tamandua.removeConversation}/>)}
      </ul> : <p className="panel-note">No conversations yet. Anything you ask is stored in this app&apos;s local database, and you can delete it here or message by message.</p>}
      {active && <details className="assistant-inspect">
        <summary>Inspect this conversation</summary>
        <MessageList rows={rows} onDelete={removeMessage}/>
      </details>}
      <p className="panel-note assistant-list-foot">History lives on this device only. Deleting a conversation never deletes a record.</p>
    </aside>

    <section className="panel assistant-chat">
      <div className="panel-heading">
        <h2>{active ? active.title : 'Ask Tamanduá'}</h2>
        <span className={`assistant-status ${ready ? 'assistant-ready' : 'assistant-blocked'}`} title={ready ? 'Model endpoint configured' : (settings?.invalidTokenUrl || 'No model endpoint configured yet')}>
          {ready ? '● Model endpoint ready' : '○ No model endpoint'}
        </span>
      </div>

      {!ready && settings && <div className="assistant-gate">
        <p><b>No model endpoint is configured.</b> Chat and summaries are proxy calls to an endpoint you choose; until then Tamanduá answers nothing, because a guessed number is worse than none. {settings.invalidTokenUrl ? settings.invalidTokenUrl : ''}</p>
        {navigate && <button type="button" className="button button-quiet" onClick={() => navigate('settings')}>Open model endpoint settings</button>}
      </div>}
      {ready && mcpBlocked && <div className="assistant-gate assistant-gate-warn">
        <p>The local Tamanduá connection is switched off, so the assistant cannot read your records. Turn it on under Settings &amp; backup → Model endpoint and assistant.</p>
      </div>}
      {tamandua.chatError && <p className="form-error chat-error" role="alert">{tamandua.chatError}</p>}

      <div className="tamandua-slot" ref={slotRef}>
        {!chatReady && <div className="chat-empty">
          <b>Loading Tamanduá…</b>
          <span>The conversation is a separate bundle, fetched once and kept for the rest of this session.</span>
        </div>}
      </div>
    </section>
  </div>;
}
