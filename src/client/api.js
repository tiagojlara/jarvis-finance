export const currencies = ['EUR', 'SEK', 'USD', 'BRL'];
export const api = async (path, options = {}) => {
  const response = await fetch(`/api/${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    // An HTML body means the request never reached a matching API route — typically a
    // server process older than the UI. Say so instead of leaking a JSON parse error.
    throw new Error(response.status === 404
      ? 'The API server does not have this endpoint — it is probably older than the interface. Restart the server (npm run dev or npm start) and try again.'
      : `The server returned an unexpected response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
};
// Assistant endpoints are their own tree (/api/assistant/...), never the generic
// /api/:table CRUD surface, so nothing here can touch a financial record.
export const assistantApi = (path = '', options = {}) => api(`assistant/${path}`, options);

// No streaming helper lives here any more. The assistant's answer arrives over the CopilotKit endpoint
// (`/api/copilotkit`, components/TamanduaChat.jsx), which owns its own transport and event folding; the
// hand-rolled `POST /api/assistant/chat` reader that used to sit in this file was deleted with the route
// it served. What the client still needs from this module is the plain JSON surface: conversations,
// messages, disclosure, settings — `assistantApi` below.

// Server stamps are UTC instants (history.js and the summary rows both normalise them), so
// they need an explicit local rendering — a raw ISO string in the UI reads as a machine log.
export const stamp = (value, { time = true } = {}) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = date.toLocaleDateString();
  return time ? `${day} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : day;
};

export const money = (value, currency = 'EUR', digits = 0) => value == null ? '—' :
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value);
export const today = () => new Date().toISOString().slice(0, 10);
export const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function convertRate(rates, from, to, asOf = today()) {
  if (from === to) return 1;
  const applicable = rates.filter((r) => r.date <= asOf);
  const direct = applicable.filter((r) => r.base === from && r.quote === to).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (direct) return Number(direct.rate);
  const inverse = applicable.filter((r) => r.base === to && r.quote === from).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (inverse) return 1 / Number(inverse.rate);
  const eurRate = (currency) => applicable.filter((r) => r.base === 'EUR' && r.quote === currency).sort((a, b) => b.date.localeCompare(a.date))[0]?.rate;
  if (from !== 'EUR' && to !== 'EUR') {
    const source = eurRate(from); const target = eurRate(to);
    if (source && target) return Number(target) / Number(source);
  }
  if (to === 'EUR' && eurRate(from)) return 1 / Number(eurRate(from));
  if (from === 'EUR' && eurRate(to)) return Number(eurRate(to));
  return null;
}

export function getHomeValue(holdings, rates, homeCurrency) {
  let value = 0; let cost = 0; let complete = true;
  for (const holding of holdings) {
    if (!holding.quantity) continue;
    if (holding.current_value == null) { complete = false; continue; }
    const rate = convertRate(rates, holding.currency, homeCurrency, holding.price_date);
    if (rate == null) { complete = false; continue; }
    value += holding.current_value * rate;
    cost += holding.cost_basis * rate;
  }
  return { value, cost, complete };
}
