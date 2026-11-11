import { useCallback, useEffect, useState } from 'react';
import { assistantApi, stamp } from '../api.js';
import { parseSummary, summaryKind } from '../../assistant/summaryFormat.mjs';

// AI summary card for Overview and Cash flow (phase one, item 5): generated on demand, cached
// locally, with a visible refresh timestamp and a stale-data indication.
//
// Nothing here is automatic. Mounting the card reads the cache; only Generate/Refresh asks the
// model, so opening a page never spends a request or sends records off the machine. The stale
// flag comes from the server's own fingerprint of the rows this card was built from, so it
// means "the numbers moved", not "this text is old".
//
// The card is a reading of the records, not a second chart: the page below it already shows the
// totals, so the layout puts the verdict first, then the observations under the marker the model
// gave them (see src/assistant/summaryFormat.mjs), and the provenance last and small.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-11" reads as "November 2026" on a card; a raw key reads like a database.
function periodLabel(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!match) return period || '';
  const index = Number(match[2]) - 1;
  return index >= 0 && index < 12 ? `${MONTH_NAMES[index]} ${match[1]}` : period;
}

// The model's reply is untrusted text, so it is rendered as text — no HTML, no markdown engine.
// Lines the parser could not classify fall back to the flat prose layout the card used first.
function prose(lines) {
  if (!lines?.length) return null;
  const bulleted = lines.filter((line) => /^([-*•–]|\d+[.)])\s+/.test(line));
  if (bulleted.length && bulleted.length >= lines.length - 1) {
    return <ul className="summary-list">{lines.map((line, index) => <li key={index}>{line.replace(/^([-*•–]|\d+[.)])\s+/, '')}</li>)}</ul>;
  }
  return <div className="summary-prose">{lines.map((line, index) => <p key={index}>{line}</p>)}</div>;
}

function Points({ points }) {
  return <ul className="summary-points">
    {points.map((point, index) => {
      const kind = summaryKind(point.kind);
      return <li key={index} className={`summary-point summary-point-${point.kind}`}>
        {kind.mark ? <span className="summary-point-mark" aria-hidden="true">{kind.mark}</span> : null}
        {kind.label ? <span className="summary-point-label">{kind.label}</span> : null}
        <span className="summary-point-text">{point.text}</span>
      </li>;
    })}
  </ul>;
}

export default function SummaryCard({ placement, period = '', revision = 0, navigate, title = 'Tamanduá summary' }) {
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
      setOpen(true);
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
  const reading = parseSummary(cached?.text || '');
  const stale = Boolean(card?.stale);

  return <section className={`panel summary-card ${cached ? '' : 'summary-card-empty'} ${stale ? 'summary-card-stale' : ''}`}>
    <div className="panel-heading">
      <h2>{title}{period ? <span className="summary-period">{periodLabel(period)}</span> : null}</h2>
      <div className="summary-actions">
        {cached && <button type="button" className="text-action" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>}
        {cached && <button type="button" className="text-action danger" onClick={discard} disabled={busy}>Remove</button>}
        <button type="button" className="button button-quiet summary-generate" onClick={generate} disabled={busy || !configured}>
          {busy ? 'Asking your model…' : cached ? (stale ? 'Refresh summary' : 'Regenerate') : 'Generate summary'}
        </button>
      </div>
    </div>

    {!configured && <p className="panel-note">An AI summary needs a model endpoint. Set one under <b>Settings &amp; backup → Model endpoint and assistant</b>. {navigate ? '' : 'Your records stay local until you do.'}</p>}
    {!configured && navigate && <button type="button" className="text-action" onClick={() => navigate('settings')}>Open settings</button>}

    {cached && <>
      {open && <div className="summary-read">
        {reading.lead ? <p className="summary-lead">{reading.lead}</p> : null}
        {reading.points.length ? <Points points={reading.points}/> : null}
        {!reading.lead && !reading.points.length && prose(reading.paragraphs)}
      </div>}
      {/* Collapsed, the card keeps its first sentence whatever shape the reply came in. */}
      {!open && <p className="summary-lead summary-lead-peek">{reading.lead || reading.points[0]?.text || reading.paragraphs[0] || ''}</p>}
      <div className="summary-status" aria-live="polite">
        {stale
          ? <span className="tag tag-warn">Records changed since this was written</span>
          : <span className="tag">Checked against current records</span>}
        <span className="summary-stamp">Generated {stamp(cached.generatedAt)}{cached.model ? ` · ${cached.model}` : ''}</span>
      </div>
    </>}

    {!cached && configured && !busy && <p className="panel-note">
      Nothing generated for {periodLabel(period) || 'this page'} yet. One press sends these figures to the endpoint you configured and caches the answer here — it reads the same records this page shows, then comments on what stands out instead of repeating the chart.
    </p>}
    {busy && !cached && <p className="panel-note" role="status">One request, then the answer is stored locally.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="summary-footnote">Planning aid only · Not financial or tax advice · The assistant cannot change records</p>
  </section>;
}
