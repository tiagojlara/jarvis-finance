// Cash-flow aggregation for one calendar month, shared by three callers:
// the MCP `get_cash_flow_summary` tool, the REST cash-flow endpoints, and the assistant's
// cached summaries. Extracted so the assistant cannot grow a second, weaker aggregation
// (see docs/agent-product-requirements.md FR-6: reuse existing validation and semantics).
// Totals stay per currency and are never converted here.

const round = (value) => Math.round(value * 100) / 100;

// month is 'YYYY-MM'; defaults to the current month, same as the MCP tool.
function cashFlowMonthSummary(db, month) {
  const target = month || new Date().toISOString().slice(0, 7);
  const rows = db.prepare('SELECT kind, currency, amount, category_id FROM cash_flow_transactions WHERE substr(date, 1, 7) = ?').all(target);
  const totals = {};
  for (const row of rows) {
    const bucket = totals[row.currency] || { income: 0, expense: 0 };
    bucket[row.kind] += row.amount;
    totals[row.currency] = bucket;
  }
  for (const [currency, bucket] of Object.entries(totals)) {
    totals[currency] = { income: round(bucket.income), expense: round(bucket.expense), net: round(bucket.income - bucket.expense) };
  }
  const categoryNames = new Map(db.prepare('SELECT id, name FROM cash_flow_categories').all().map((c) => [c.id, c.name]));
  const byCategory = (kind) => {
    const acc = new Map();
    for (const row of rows.filter((r) => r.kind === kind)) {
      const key = `${row.currency}|${row.category_id}`;
      const item = acc.get(key) || { category_id: row.category_id, name: categoryNames.get(row.category_id) || '(unknown)', currency: row.currency, total: 0, entries: 0 };
      item.total += row.amount;
      item.entries += 1;
      acc.set(key, item);
    }
    return [...acc.values()].map((i) => ({ ...i, total: round(i.total) })).sort((a, b) => b.total - a.total);
  };
  return {
    month: target,
    entries: rows.length,
    totals_by_currency: totals,
    spending_by_category: byCategory('expense'),
    income_by_category: byCategory('income'),
  };
}

// 'YYYY-MM' shifted by a whole number of months; used for equal-length period comparison.
function shiftMonthKey(month, delta) {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = { cashFlowMonthSummary, shiftMonthKey };
