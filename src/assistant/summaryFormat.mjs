// Turns a summary card reply into the structure the page renders.
//
// The prompt asks for `LEAD:` / `PLUS:` / `WATCH:` / `NOTE:` lines because a card that reads
// "November looks steady, but two thirds of your SEK sits in one fund" is only useful if the page
// can tell the verdict from the caution. The model does not always obey, so this is a tolerant
// reader rather than a strict one:
//
//   - a `LABEL:` line becomes a point of that kind (aliases included — models drift to GOOD/RISK);
//   - a sentence with no known label becomes a plain point, still shown as an observation;
//   - text with no labels at all — a card cached before this format existed, or a model that
//     ignored it — comes back as `paragraphs` and the card renders it as prose, so no cached
//     summary is ever displayed as an error.
//
// The colon is required on purpose: without it, an ordinary sentence starting with "Next month"
// or "Note that" would be mistaken for a label and lose its first word.

export const SUMMARY_KINDS = {
  lead: { label: '', mark: '' },
  plus: { label: 'Looking good', mark: '+' },
  watch: { label: 'Worth a look', mark: '!' },
  note: { label: 'Missing', mark: '○' },
  plain: { label: '', mark: '·' },
};

const ALIASES = {
  LEAD: 'lead', HEADLINE: 'lead', VERDICT: 'lead', OVERVIEW: 'lead',
  PLUS: 'plus', GOOD: 'plus', HEALTHY: 'plus', STRENGTH: 'plus', POSITIVE: 'plus',
  WATCH: 'watch', RISK: 'watch', BUT: 'watch', CAUTION: 'watch', ATTENTION: 'watch', CONCERN: 'watch', HOWEVER: 'watch',
  NOTE: 'note', MISSING: 'note', GAP: 'note', UNKNOWN: 'note', NEXT: 'note', TIP: 'note', DATA: 'note',
};

// "**LEAD:** text", "- WATCH : text", "plus: text" all parse; a bold marker is stripped below.
const LABELLED = /^\W*([A-Za-z]{3,10})\s*:\s*(.*)$/;

const clean = (text) => String(text || '')
  .replace(/^\s*[-*•–]\s+/, '')
  .replace(/\*\*|__|`/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function splitLabel(line) {
  const match = LABELLED.exec(line);
  if (!match) return null;
  const kind = ALIASES[match[1].toUpperCase()];
  if (!kind) return null;
  const text = clean(match[2]);
  return text ? { kind, text } : null;
}

export function parseSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map(splitLabel);
  const labelled = parsed.filter(Boolean).length;

  // Nothing obeyed the format: keep it as prose rather than inventing structure it lacks.
  if (!labelled) return { lead: '', points: [], paragraphs: lines.map(clean), structured: false };

  let lead = '';
  const points = [];
  parsed.forEach((entry, index) => {
    if (!entry) {
      const text2 = clean(lines[index]);
      if (text2) points.push({ kind: 'plain', text: text2 });
      return;
    }
    // One headline only: a second LEAD line is kept, but demoted to a plain point.
    if (entry.kind === 'lead' && !lead) lead = entry.text;
    else points.push(entry.kind === 'lead' ? { kind: 'plain', text: entry.text } : entry);
  });
  return { lead, points, paragraphs: [], structured: true };
}

export const summaryKind = (kind) => SUMMARY_KINDS[kind] || SUMMARY_KINDS.plain;
