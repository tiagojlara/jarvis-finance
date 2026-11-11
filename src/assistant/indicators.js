// Numbers the summary cards are allowed to talk about, computed here rather than by the model.
//
// Two reasons this exists. The first is correctness: a small local model adding up a JSON table
// is a currency-mixing accident waiting to happen (FR-2), so every share, percentage and
// month-over-month change is calculated from the app's own aggregation and handed over ready to
// cite. The second is the point of the card at all — the page already charts the totals, so a
// summary that repeats them is worth nothing. What a person wants is the *shape*: how much of one
// currency sits in a single position, whether the month is ahead of the last one, which records
// cannot be valued yet. Those are the things computed below.
//
// Everything is per currency and never converted. A percentage is always a share *within* one
// currency, which is stated in the output so the model cannot quietly merge SEK and EUR.

const { cashFlowMonthSummary, shiftMonthKey } = require('../cashflow-summary');

const PRICE_STALE_DAYS = 30;
const DIVIDEND_WINDOW_DAYS = 90;
// A pace projection on day 2 of the month is noise, not a signal.
const MIN_DAYS_FOR_PROJECTION = 5;

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
};

// A share as a percentage, or null when there is nothing to be a share of — null travels to the
// model as "cannot say" instead of a fabricated 0.
const share = (part, whole) => (Number(whole) > 0 ? round((Number(part) / Number(whole)) * 100, 1) : null);

const changePct = (now, before) => (Number(before) > 0 ? round(((Number(now) - Number(before)) / Number(before)) * 100, 1) : null);

const dayDiff = (from, to) => Math.floor((to.getTime() - new Date(from).getTime()) / 86400000);

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const bucket = map.get(row[key]);
    if (bucket) bucket.push(row);
    else map.set(row[key], [row]);
  }
  return map;
}

const isCashRow = (row) => Boolean(row.is_cash_balance) || String(row.type || '').toLowerCase() === 'cash';

// Overview: concentration, mix, return, and what the records cannot yet value.
function portfolioIndicators({ summary, dividends = [], today = new Date() }) {
  const held = summary.holdings.filter((row) => Number(row.quantity) > 0);
  const perCurrency = {};
  for (const [currency, rows] of groupBy(held, 'currency')) {
    const valued = rows.filter((row) => row.current_value !== null && row.current_value !== undefined);
    const total = valued.reduce((sum, row) => sum + Number(row.current_value), 0);
    const cost = valued.reduce((sum, row) => sum + Number(row.cost_basis), 0);
    const cashValue = valued.filter(isCashRow).reduce((sum, row) => sum + Number(row.current_value), 0);
    const byValue = [...valued].sort((a, b) => Number(b.current_value) - Number(a.current_value));
    const top3 = byValue.slice(0, 3).reduce((sum, row) => sum + Number(row.current_value), 0);
    const typeMix = {};
    for (const row of byValue) {
      const label = String(row.type || 'Unclassified');
      typeMix[label] = round((typeMix[label] || 0) + Number(row.current_value));
    }
    // Ranked by return on its own cost, not by absolute gain: a small position that doubled is
    // the interesting one, and a big position that moved 1% is not.
    const performants = valued.filter((row) => Number(row.cost_basis) > 0 && row.unrealized_gain !== null)
      .map((row) => ({
        name: row.name,
        type: row.type,
        currency,
        value: round(row.current_value),
        gain: round(row.unrealized_gain),
        gain_pct: round((Number(row.unrealized_gain) / Number(row.cost_basis)) * 100, 1),
        price_date: row.price_date || null,
      }))
      .sort((a, b) => b.gain_pct - a.gain_pct);
    perCurrency[currency] = {
      positions: rows.length,
      positions_valued: valued.length,
      positions_without_price: rows.length - valued.length,
      total_value: round(total),
      cash_value: round(cashValue),
      cash_share_pct: share(cashValue, total),
      largest_position: byValue.length
        ? { name: byValue[0].name, type: byValue[0].type, value: round(byValue[0].current_value), share_pct: share(byValue[0].current_value, total) }
        : null,
      top3_share_pct: share(top3, total),
      type_mix_value: typeMix,
      type_mix_pct: Object.fromEntries(Object.entries(typeMix).map(([label, value]) => [label, share(value, total)])),
      unrealized_gain: round(valued.reduce((sum, row) => sum + Number(row.unrealized_gain || 0), 0)),
      unrealized_return_pct: share(valued.reduce((sum, row) => sum + Number(row.unrealized_gain || 0), 0), cost),
      realized_gain: round(rows.reduce((sum, row) => sum + Number(row.realized_gain || 0), 0)),
      best_position: performants[0] || null,
      worst_position: performants.length > 1 ? performants[performants.length - 1] : null,
      dividend_income_all_time: round(summary.dividendIncomeByCurrency[currency] || 0),
    };
  }

  const withoutPrice = held
    .filter((row) => row.current_value === null || row.current_value === undefined)
    .map((row) => ({ name: row.name, type: row.type, currency: row.currency, quantity: round(row.quantity), cost_basis: round(row.cost_basis) }));
  const stalePrices = held
    .filter((row) => row.current_value !== null && row.price_date)
    .map((row) => ({ name: row.name, currency: row.currency, price_date: row.price_date, days_old: dayDiff(row.price_date, today) }))
    .filter((row) => row.days_old > PRICE_STALE_DAYS)
    .sort((a, b) => b.days_old - a.days_old);

  // Dividends over the last quarter against the quarter before it: a trend the page does not chart.
  const windowStart = new Date(today.getTime() - DIVIDEND_WINDOW_DAYS * 86400000);
  const priorStart = new Date(today.getTime() - 2 * DIVIDEND_WINDOW_DAYS * 86400000);
  const recent = {};
  const prior = {};
  let recentCount = 0;
  let lastPaymentDate = null;
  for (const row of dividends) {
    const date = new Date(row.date);
    if (!lastPaymentDate || row.date > lastPaymentDate) lastPaymentDate = row.date;
    if (date > windowStart) {
      recent[row.currency] = round((recent[row.currency] || 0) + Number(row.amount));
      recentCount += 1;
    } else if (date > priorStart) {
      prior[row.currency] = round((prior[row.currency] || 0) + Number(row.amount));
    }
  }
  const recentChange = {};
  for (const currency of new Set([...Object.keys(recent), ...Object.keys(prior)])) {
    recentChange[currency] = { last_90_days: recent[currency] ?? 0, previous_90_days: prior[currency] ?? null, change_pct: changePct(recent[currency] || 0, prior[currency] || 0) };
  }

  return {
    scope: 'each figure belongs to one currency; a share_pct is a share of that currency total, never of a combined amount',
    per_currency: perCurrency,
    coverage: {
      holdings_without_price: withoutPrice.slice(0, 8),
      holdings_without_price_count: withoutPrice.length,
      price_stale_after_days: PRICE_STALE_DAYS,
      stale_prices: stalePrices.slice(0, 8),
      stale_prices_count: stalePrices.length,
    },
    dividends: {
      window_days: DIVIDEND_WINDOW_DAYS,
      payments_last_90_days: recentCount,
      last_payment_date: lastPaymentDate,
      by_currency: recentChange,
    },
  };
}

// Cash flow: rate of saving, concentration of spending, and the month against its neighbour.
function cashFlowIndicators(db, month, { today = new Date() } = {}) {
  const current = cashFlowMonthSummary(db, month);
  const previousMonth = shiftMonthKey(month, -1);
  const previous = cashFlowMonthSummary(db, previousMonth);
  const rows = db.prepare(`SELECT t.kind, t.currency, t.amount, t.date, t.payee, c.name AS category
    FROM cash_flow_transactions t LEFT JOIN cash_flow_categories c ON c.id = t.category_id
    WHERE substr(t.date,1,7) = ? ORDER BY t.date, t.id`).all(month);

  const perCurrency = {};
  for (const [currency, bucket] of Object.entries(current.totals_by_currency)) {
    const mine = rows.filter((row) => row.currency === currency);
    const spending = mine.filter((row) => row.kind === 'expense');
    const income = mine.filter((row) => row.kind === 'income');
    // A category deleted from the ledger still has rows pointing at it; name the hole rather
    // than hand the model a null it would have to describe.
    const orphans = '(no category)';
    const ranked = [...groupBy(spending, 'category').entries()]
      .map(([name, list]) => ({ name: name || orphans, total: round(list.reduce((sum, row) => sum + Number(row.amount), 0)), entries: list.length }))
      .sort((a, b) => b.total - a.total);
    const incomeRanked = [...groupBy(income, 'category').entries()]
      .map(([name, list]) => ({ name: name || orphans, total: round(list.reduce((sum, row) => sum + Number(row.amount), 0)) }))
      .sort((a, b) => b.total - a.total);
    const biggest = [...mine].sort((a, b) => Number(b.amount) - Number(a.amount))[0] || null;
    const before = previous.totals_by_currency[currency];
    perCurrency[currency] = {
      income: round(bucket.income),
      expense: round(bucket.expense),
      net: round(bucket.net),
      savings_rate_pct: share(bucket.net, bucket.income),
      spending_entries: spending.length,
      days_with_spending: new Set(spending.map((row) => row.date)).size,
      top_spending_category: ranked[0] ? { name: ranked[0].name, total: ranked[0].total, share_pct: share(ranked[0].total, bucket.expense), entries: ranked[0].entries } : null,
      top3_spending_share_pct: share(ranked.slice(0, 3).reduce((sum, row) => sum + row.total, 0), bucket.expense),
      // Named with a share each, so the card can point at one category instead of guessing.
      spending_categories: ranked.slice(0, 10).map((row) => ({ name: row.name, total: row.total, share_pct: share(row.total, bucket.expense) })),
      top_income_category: incomeRanked[0] ? { name: incomeRanked[0].name, total: incomeRanked[0].total, share_pct: share(incomeRanked[0].total, bucket.income) } : null,
      largest_entry: biggest ? { amount: round(biggest.amount), date: biggest.date, kind: biggest.kind, category: biggest.category || orphans, payee: biggest.payee || '' } : null,
      previous_month: before ? { month: previousMonth, income: round(before.income), expense: round(before.expense), net: round(before.net) } : { month: previousMonth, income: 0, expense: 0, net: 0, entries: 0 },
      // null means "there is nothing to compare against", which the card is told to say instead
      // of inventing a percentage. A negative net last month is not a base either.
      change_vs_previous_pct: {
        income: changePct(bucket.income, before?.income || 0),
        expense: changePct(bucket.expense, before?.expense || 0),
        net: changePct(bucket.net, before?.net || 0),
      },
    };
  }

  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const isCurrentMonth = month === new Date().toISOString().slice(0, 7);
  const daysElapsed = isCurrentMonth ? new Date().getUTCDate() : daysInMonth;
  const pace = {};
  for (const [currency, bucket] of Object.entries(current.totals_by_currency)) {
    const perDay = daysElapsed > 0 ? Number(bucket.expense) / daysElapsed : 0;
    const projected = round(perDay * daysInMonth);
    const before = previous.totals_by_currency[currency];
    pace[currency] = {
      days_elapsed: daysElapsed,
      days_in_month: daysInMonth,
      expense_per_day: round(perDay),
      projected_month_expense: daysElapsed >= MIN_DAYS_FOR_PROJECTION ? projected : null,
      projected_vs_previous_pct: daysElapsed >= MIN_DAYS_FOR_PROJECTION && before && before.expense > 0 ? changePct(projected, before.expense) : null,
    };
  }

  return {
    scope: 'each figure belongs to one currency; never combine currencies or report a converted total',
    month,
    is_current_month: isCurrentMonth,
    entries: current.entries,
    months_with_records: db.prepare('SELECT COUNT(DISTINCT substr(date,1,7)) AS n FROM cash_flow_transactions').get().n,
    first_record_month: db.prepare('SELECT substr(MIN(date),1,7) AS m FROM cash_flow_transactions').get().m,
    per_currency: perCurrency,
    pace: isCurrentMonth ? pace : null,
  };
}

module.exports = { portfolioIndicators, cashFlowIndicators, PRICE_STALE_DAYS, DIVIDEND_WINDOW_DAYS };
