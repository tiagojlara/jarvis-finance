import { useCallback, useEffect, useState } from 'react';
import { assistantApi, stamp } from '../api.js';

// AI summary card for Overview and Cash flow (phase one, item 5): generated on demand, cached
// locally, with a visible refresh timestamp and a stale-data indication.
//
// Nothing here is automatic. Mounting the card reads the cache; only Generate/Refresh asks the
// model, so opening a page never spends a request or sends records off the machine. The stale
// flag comes from the server's own fingerprint of the rows this card was built from, so it
// means "the numbers moved", not "this text is old".

function prose(text) {
  // The model's reply is untrusted text, so it is rendered as text — no HTML, no markdown
  // engine. Lines become paragraphs, leading bullets/dashes become list items.
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items = lines.filter((line) => /^([-*•–]|\d+[.)])\s+/.test(line));
  if (items.length && items.length >= lines.length - 1) {
    return <ul className="summary-list">{lines.map((line, index) => <li key={index}>{line.replace(/^([-*•–]|\d+[.)])\s+/, '')}</li>)}</ul>;
  }
  return <div className="summary-prose">{lines.map((line, index) => <p key={index}>{line}</p>)}</div>;
}

export default function SummaryCard({ placement, period = '', revision = 0, navigate, title = 'Jarvis summary' }) {
  const [card, setCard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);

  const query = `summaries?placement=${encodeURIComponent(placement)}${period ? `&period=${encodeURIComponent(period)}` : ''}`;

  const load = useCallback(async () => {
    try {
      setCard(await assistantApi(query));
      setError('');
    } catch (e) {
      // A missing card is not a broken page; the rest of the view still works without it.
      setError(e.message);
    }
  }, [query]);

  useEffect(() => { load(); }, [load, revision]);

  const generate = async () => {
    setBusy(true); setError('');
    try {
      setCard(await assistantApi('summaries', { method: 'POST', body: JSON.stringify({ placement, period }) }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await assistantApi(query, { method: 'DELETE' });
      await load();
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cached = card?.cached?.text ? card.cached : null;
  const configured = card?.modelConfigured !== false;

  return <section className={`panel summary-card ${cached ? '' : 'summary-card-empty'}`}>
    <div className="panel-heading">
      <h2>{title}{period ? <span className="summary-period">{period}</span> : null}</h2>
      <div className="summary-actions">
        {cached && <button type="button" className="text-action" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>}
        {cached && <button type="button" className="text-action danger" onClick={discard} disabled={busy}>Remove</button>}
        <button type="button" className="button button-quiet summary-generate" onClick={generate} disabled={busy || !configured}>
          {busy ? 'Asking your model…' : cached ? (card.stale ? 'Refresh summary' : 'Regenerate') : 'Generate summary'}
        </button>
      </div>
    </div>

    {!configured && <p className="panel-note">An AI summary needs a model endpoint. Set one under <b>Settings &amp; backup → Model endpoint and assistant</b>. {navigate ? '' : 'Your records stay local until you do.'}</p>}
    {!configured && navigate && <button type="button" className="text-action" onClick={() => navigate('settings')}>Open settings</button>}

    {cached && <>
      <div className="summary-status" aria-live="polite">
        {card.stale
          ? <span className="tag tag-warn">Records changed since this summary</span>
          : <span className="tag">Checked against current records</span>}
        <span className="summary-stamp">Generated {stamp(cached.generatedAt)}{cached.model ? ` · ${cached.model}` : ''}</span>
      </div>
      {open && prose(cached.text)}
    </>}

    {!cached && configured && !busy && <p className="panel-note">Nothing generated for {period || 'this page'} yet. This is on demand only: Jarvis reads the same figures this page shows, sends them to the model endpoint you configured, and caches the answer in the local database.</p>}
    {busy && !cached && <p className="panel-note" role="status">One request, then the answer is stored locally.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="summary-footnote">Planning aid only · Not financial or tax advice · The assistant cannot change records</p>
  </section>;
}
