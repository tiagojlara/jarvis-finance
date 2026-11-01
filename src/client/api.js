export const currencies = ['EUR', 'SEK', 'USD', 'BRL'];
export const api = async (path, options = {}) => {
  const response = await fetch(`/api/${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
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
