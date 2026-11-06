// Pure cash-flow reporting helpers, kept out of the components so they can be
// tested with plain node and reused by the Cash Flow view.

// 'YYYY-MM' month arithmetic without Date drift: months are just integers 1..12.
export function shiftMonth(month, delta) {
  const [year, m] = month.split('-').map(Number);
  const total = year * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`;
}

export const monthOf = (entry) => String(entry.date).slice(0, 7);

export function monthLabel(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// Totals are per currency and never summed across currencies: a cash-flow account
// holds exactly one currency, and mixing EUR/SEK/USD/BRL amounts would invent FX
// conversions the app cannot date-check here.
export function cashFlowTotals(entries) {
  const totals = {};
  for (const entry of entries) {
    const row = (totals[entry.currency] ||= { income: 0, expense: 0, net: 0 });
    row[entry.kind] += Number(entry.amount);
    row.net = row.income - row.expense;
  }
  return totals;
}

// Category subtotals for one kind, per currency, largest first.
export function categoryBreakdown(entries, categories, kind = 'expense') {
  const rows = {};
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    const key = `${entry.currency}|${entry.category_id}`;
    const row = (rows[key] ||= {
      currency: entry.currency,
      category_id: entry.category_id,
      name: categories.find((category) => category.id === entry.category_id)?.name || 'Category',
      total: 0,
      count: 0,
    });
    row.total += Number(entry.amount);
    row.count += 1;
  }
  return Object.values(rows).sort((a, b) => b.total - a.total);
}
