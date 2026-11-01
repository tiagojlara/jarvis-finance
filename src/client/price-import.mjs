// Parses fund NAV history CSVs — the "Ladda ner kursdata" export from an Avanza fund page, or
// any two-column date/value list — into { date, price } rows. Built for Swedish dialects:
// ';' delimiter, decimal comma, space or dot thousands separators, dd/mm/yyyy or ISO dates,
// sv/en headers (Datum/Värde). Files mixing ',' as delimiter AND decimal comma are ambiguous
// and unsupported (re-save from the provider with ';' or use ISO export).
export function parsePriceHistory(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], skipped: 0, error: 'The file is empty.' };
  const candidates = [';', '\t', ','];
  const scores = candidates.map((d) => lines.reduce((n, line) => n + line.split(d).length - 1, 0));
  const best = scores.indexOf(Math.max(...scores));
  if (!scores[best]) return { rows: [], skipped: lines.length, error: 'No delimiter (; , or tab) found — is this a CSV?' };
  const delimiter = candidates[best];

  const rows = new Map();
  let skipped = 0;
  for (const line of lines) {
    const cells = line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
    const date = parseDate(cells[0]);
    const valueIndex = cells.findIndex((cell, i) => i > 0 && parseAmount(cell) !== null);
    if (!date || valueIndex === -1) {
      if (/^datum$|^date$/i.test(cells[0]) && /värde|value|kurs|nav|close/i.test(cells[1] || '')) continue; // header row
      skipped += 1;
      continue;
    }
    rows.set(date, parseAmount(cells[valueIndex])); // same date twice: last row wins
  }
  const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([date, price]) => ({ date, price }));
  if (!sorted.length) return { rows: [], skipped, error: 'No readable date + value rows found. Expected e.g. "02/01/2026;1234,56".' };
  return { rows: sorted, skipped };
}

function parseDate(raw) {
  const value = String(raw || '').trim();
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return value;
  match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

function parseAmount(raw) {
  let value = String(raw || '').trim().replace(/[\s "]/g, '');
  if (!value) return null;
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(value)) value = value.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else if (value.includes(',') && value.includes('.')) value = value.replace(/,/g, ''); // 1,234.56
  else value = value.replace(',', '.'); // 1234,56
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
