import { useCallback, useEffect, useState } from 'react';
import { assistantApi, stamp } from '../api.js';

// Model endpoint, local Jarvis MCP connection and assistant data controls.
//
// Two rules shape this form. The token is write-only: the server never sends it back, so the UI
// can only say that one is saved, replace it, or clear it. And every model request is proxied by
// the local server — this page holds no key, no bearer header, and no request to a model host.

function StatusLine({ ok, children }) {
  return <p className={`assistant-result ${ok ? 'assistant-result-ok' : 'assistant-result-bad'}`} role="status">{children}</p>;
}

// The switch means "offered to the assistant". A write tool is never offered in phase one, so it
// is shown as off and unchangeable rather than as an enabled row — the inventory stays visible,
// the capability does not exist.
function ToolSwitch({ tool, disabled, onToggle }) {
  return <label className={`assistant-tool ${tool.readOnly ? '' : 'assistant-tool-blocked'}`}>
    <input type="checkbox" checked={tool.readOnly && tool.enabled} disabled={!tool.readOnly || disabled}
      onChange={(event) => onToggle(tool, event.target.checked)}/>
    <span className="assistant-tool-name"><code>{tool.name}</code>{tool.readOnly ? null : <span className="tag tag-warn">write · never offered</span>}<span className="assistant-tool-desc">{tool.description}</span></span>
  </label>;
}

export default function AssistantSettings() {
  const [settings, setSettings] = useState(null);
  const [mcp, setMcp] = useState(null);
  const [disclosure, setDisclosure] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', model: '', token: '', allowInsecureHttp: false });
  const [hint, setHint] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // Every key of the form is carried over explicitly: a state update that builds a new object
  // has to list all of them, or the token field becomes undefined and the next read of
  // form.token.trim() throws. The typed token survives a save/reload because the server can
  // never send the stored one back.
  const apply = useCallback((next) => {
    setSettings(next);
    setForm((current) => ({
      baseUrl: next?.baseUrl ?? current.baseUrl,
      model: next?.model ?? current.model,
      token: current.token ?? '',
      allowInsecureHttp: Boolean(next?.allowInsecure),
    }));
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await assistantApi('model'));
      setMcp(await assistantApi('mcp'));
      setDisclosure(await assistantApi('disclosure'));
    } catch (e) { setError(e.message); }
  }, [apply]);

  useEffect(() => { load(); }, [load]);

  // The endpoint is normalised server-side before anything is saved, so the hint the user sees
  // is the URL the model client will actually be built from (including the /v1 default).
  const validateUrl = async () => {
    if (!form.baseUrl.trim()) { setHint(null); return; }
    try {
      setHint({ ok: true, ...await assistantApi('model/validate', { method: 'POST', body: JSON.stringify({ baseUrl: form.baseUrl, allowInsecureHttp: form.allowInsecureHttp }) }) });
      setError('');
    } catch (e) { setHint({ ok: false, message: e.message }); }
  };

  const save = async () => {
    setBusy('save'); setError(''); setMessage('');
    try {
      const body = { baseUrl: form.baseUrl, model: form.model };
      if (form.token.trim()) body.token = form.token.trim();
      apply(await assistantApi('model', { method: 'PUT', body: JSON.stringify(body) }));
      setMessage(form.token.trim() ? 'Endpoint saved. The token was encrypted and stored in a settings record of its own.' : 'Endpoint saved. The token already stored was kept — it is never shown again.');
      setForm((current) => ({ ...current, token: '' }));
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const clearToken = async () => {
    if (!window.confirm('Remove the saved token? Chat and summaries will not work until you add one again.')) return;
    setBusy('token'); setError('');
    try {
      apply(await assistantApi('model', { method: 'PUT', body: JSON.stringify({ clearToken: true }) }));
      setMessage('Saved token removed. The key that encrypted it stays where it is; nothing else changed.');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const test = async () => {
    setBusy('test'); setError(''); setMessage('');
    try {
      const result = await assistantApi('model/test', { method: 'POST' });
      setMessage(`The endpoint answered in ${result.latencyMs} ms${result.reply ? ` (“${result.reply}”)` : ''}. No financial records were sent — a test request carries only a fixed line of text, and the token stays on the server.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const setInsecure = async (enabled) => {
    setBusy('http'); setError(''); setMessage('');
    try {
      apply(await assistantApi('model', { method: 'PUT', body: JSON.stringify({ allowInsecureHttp: enabled }) }));
      setMessage(enabled ? 'Plain HTTP is now allowed for the saved endpoint. Only do this for a network path you control.' : 'Plain HTTP allowed off again. The saved endpoint was re-checked against the policy.');
      await load();
    } catch (e) {
      // Turning the override off can make a stored http endpoint inadmissible; say so plainly.
      setError(e.message);
      await load();
    } finally { setBusy(''); }
  };

  const setMcpEnabled = async (enabled) => {
    setBusy('mcp'); setError('');
    try { setMcp(await assistantApi('mcp', { method: 'PUT', body: JSON.stringify({ enabled }) })); } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const reconnect = async () => {
    setBusy('reconnect'); setError('');
    try { setMcp(await assistantApi('mcp/reconnect', { method: 'POST' })); } catch (e) { setError(e.message); setMcp(await assistantApi('mcp').catch(() => null)); }
    finally { setBusy(''); }
  };

  const toggleTool = async (tool, enabled) => {
    setBusy(`tool-${tool.name}`); setError('');
    try {
      await assistantApi(`mcp/tools/${encodeURIComponent(tool.name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      setMcp(await assistantApi('mcp'));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const wipeHistory = async () => {
    if (!window.confirm('Delete every conversation and message? Financial records are not touched.')) return;
    setBusy('wipe'); setError('');
    try {
      const { conversations } = await assistantApi('conversations');
      await Promise.all(conversations.map((conversation) => assistantApi(`conversations/${conversation.id}`, { method: 'DELETE' })));
      setMessage(conversations.length ? `Deleted ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}.` : 'There was nothing to delete.');
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const wipeSummaries = async () => {
    if (!window.confirm('Delete every cached AI summary?')) return;
    setBusy('wipe2'); setError('');
    try { const result = await assistantApi('summaries', { method: 'DELETE' }); setMessage(`Removed ${result.cleared} cached summar${result.cleared === 1 ? 'y' : 'ies'}.`); } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const keySource = settings?.keySource;

  return <section className="panel assistant-settings">
    <div className="panel-heading"><h2>Model endpoint and assistant</h2><span className={`assistant-status ${settings?.ready ? 'assistant-ready' : 'assistant-blocked'}`}>{settings?.ready ? '● Configured' : '○ Not configured'}</span></div>

    <p className="panel-note">The assistant is <b>read-only</b>: it answers from the records this app already keeps, through the app&apos;s own local MCP connection, and cannot add, change or remove anything. Requests to your model endpoint go through this local server, so the token never reaches browser code, and chat history is never part of a backup file.</p>

    <div className="form-grid">
      <label className="field"><span>OpenAI-compatible base URL</span>
        <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} onBlur={validateUrl} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck="false"/>
      </label>
      <label className="field"><span>Model identifier</span>
        <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o-mini · qwen2.5:14b · llama3.1" autoComplete="off" spellCheck="false"/>
      </label>
      <label className="field field-wide"><span>API token {settings?.tokenConfigured ? <em className="text-positive">· one is saved ({stamp(settings.tokenSavedAt)})</em> : <em>· none saved yet</em>}</span>
        <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={settings?.tokenConfigured ? 'Leave blank to keep the saved token; type to replace it' : 'Paste the token — it is encrypted before it is stored'} autoComplete="new-password" spellCheck="false"/>
      </label>
    </div>

    {hint?.ok && <p className="panel-note">Requests will go to <code>{hint.effectiveUrl}/chat/completions</code>{hint.insecure ? ' · plain HTTP' : ''}{hint.loopback ? ' · localhost' : ''}. Saved as <code>{hint.url}</code>.</p>}
    {hint && !hint.ok && <p className="form-error">{hint.message}</p>}
    {settings?.invalidTokenUrl && <p className="form-error">The saved endpoint no longer passes the policy: {settings.invalidTokenUrl}</p>}

    <label className="assistant-check"><input type="checkbox" checked={form.allowInsecureHttp} disabled={Boolean(busy)} onChange={(e) => setInsecure(e.target.checked)}/>
      <span>Allow plain HTTP for a remote endpoint. Off by default: only a localhost endpoint may use HTTP otherwise, because model requests carry your records in their context.</span></label>

    <div className="button-row assistant-buttons">
      <button type="button" className="button button-primary" onClick={save} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save endpoint'}</button>
      <button type="button" className="button button-quiet" onClick={test} disabled={Boolean(busy) || !settings?.tokenConfigured}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
      {settings?.tokenConfigured && <button type="button" className="button button-quiet danger" onClick={clearToken} disabled={Boolean(busy)}>Clear saved token</button>}
    </div>
    {message && <StatusLine ok>{message}</StatusLine>}
    {error && <StatusLine ok={false}>{error}</StatusLine>}

    <p className="panel-note assistant-key-source"><b>Encryption key</b><br/>{keySource?.error ? `Not available: ${keySource.error}` : `Held outside the database — ${keySource?.label || 'resolving…'}. The token is stored as AES-256-GCM ciphertext in its own settings record, which /api/settings and the backup file do not include.`}</p>

    <div className="divider"/>
    <h3 className="subheading">Local Jarvis connection</h3>
    <p className="panel-note">The app connects to its own <code>{mcp?.url || '/mcp'}</code> endpoint as an MCP client. This is separate from exposing <code>/mcp</code> to external agents: those keep the descriptions and safety semantics the server publishes.{mcp?.checkedAt ? ` Checked ${stamp(mcp.checkedAt)}.` : ''}</p>
    <div className="assistant-mcp-status">
      <span className={`tag ${mcp?.connected ? '' : 'tag-warn'}`}>{mcp?.enabled ? (mcp?.connected ? `● Connected · ${mcp.exposed} read tool${mcp.exposed === 1 ? '' : 's'} offered` : '○ Not connected') : '○ Turned off'}</span>
      <button type="button" className="button button-quiet" onClick={reconnect} disabled={Boolean(busy)}>{busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}</button>
      <label className="assistant-check"><input type="checkbox" checked={Boolean(mcp?.enabled)} disabled={Boolean(busy)} onChange={(e) => setMcpEnabled(e.target.checked)}/><span>Let the assistant read Jarvis records</span></label>
    </div>
    {mcp?.error && <p className="form-error">{mcp.error}</p>}
    <div className="assistant-tool-list">
      {(mcp?.tools || []).map((tool) => <ToolSwitch key={tool.name} tool={tool} disabled={Boolean(busy) || !mcp?.enabled} onToggle={toggleTool}/>)}
      {!mcp?.tools?.length && <p className="panel-note">No tools listed — the connection is off or unreachable, so reconnect to load the inventory.</p>}
    </div>

    <div className="divider"/>
    <h3 className="subheading">What leaves this machine</h3>
    {disclosure && <details className="assistant-disclosure">
      <summary>{disclosure.title} {settings?.disclosureAcknowledgedAt ? <span className="tag">agreed {stamp(settings.disclosureAcknowledgedAt)}</span> : <span className="tag tag-warn">not agreed yet</span>}</summary>
      {disclosure.body.map((line, index) => <p className="panel-note" key={index}>{line}</p>)}
    </details>}

    <div className="divider"/>
    <h3 className="subheading">Assistant data</h3>
    <p className="panel-note">Conversations, cached summaries and endpoint settings live in dedicated <code>assistant_*</code> tables. They are excluded from <code>/api/backup</code> on purpose: a backup is meant to be copied somewhere else, and a transcript of financial questions is not.</p>
    <div className="button-row">
      <button type="button" className="button button-quiet danger" onClick={wipeHistory} disabled={Boolean(busy)}>{busy === 'wipe' ? 'Deleting…' : 'Delete all conversations'}</button>
      <button type="button" className="button button-quiet danger" onClick={wipeSummaries} disabled={Boolean(busy)}>{busy === 'wipe2' ? 'Deleting…' : 'Delete cached summaries'}</button>
    </div>
  </section>;
}
