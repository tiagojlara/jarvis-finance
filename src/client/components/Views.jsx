import { useMemo, useState } from 'react';
import { DividendChart, FlowCategoryChart, PortfolioValueChart, ScenarioChart } from './Charts.jsx';
import { api, convertRate, currencies, getHomeValue, money, today } from '../api.js';
import { periodReturn, portfolioHistory, roiPercent } from '../history.mjs';
import { cashFlowTotals, categoryBreakdown, monthLabel, monthOf, shiftMonth } from '../cashflow.mjs';
import { projectRetirement } from '../../projection.mjs';
import SummaryCard from './SummaryCard.jsx';
import AssistantSettings from './AssistantSettings.jsx';

export function Metric({ label, value, detail, tone = '' }) {
  return <article className="metric-card"><div className="metric-label">{label}</div><div className={`metric-value ${tone}`}>{value}</div>{detail && <div className="metric-detail">{detail}</div>}</article>;
}
export function Section({ title, action, children, className = '' }) {
  return <section className={`panel ${className}`}><div className="panel-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}
export function Empty({ title = 'Nothing here yet', children }) { return <div className="empty-state"><span className="empty-icon">✳</span><b>{title}</b><span>{children}</span></div>; }
export function DataTable({ columns, rows, empty, onDelete, onEdit, pageSize = 0 }) {
  const [page, setPage] = useState(0);
  if (!rows.length) return <Empty>{empty}</Empty>;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  // Clamp so deletions or filter changes that shrink the list never strand us past the last page.
  const current = Math.min(page, totalPages - 1);
  const visible = totalPages > 1 ? rows.slice(current * pageSize, current * pageSize + pageSize) : rows;
  return <>
    <div className="table-scroll"><table><thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}{(onDelete || onEdit) && <th className="actions-heading">ACTIONS</th>}</tr></thead><tbody>{visible.map((row) => <tr key={row.id}>{columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>)}{(onDelete || onEdit) && <td className="table-actions">{onEdit && <button type="button" className="table-action table-edit" onClick={() => onEdit(row)}>Edit</button>}{onDelete && <button type="button" className="table-action table-remove" onClick={() => onDelete(row)}>Remove</button>}</td>}</tr>)}</tbody></table></div>
    {totalPages > 1 && <div className="table-pagination" role="group" aria-label="Table pages">
      <button type="button" className="page-button" onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page">‹ Prev</button>
      <span className="page-status" aria-live="polite">Showing {current * pageSize + 1}–{Math.min(rows.length, (current + 1) * pageSize)} of {rows.length}</span>
      <button type="button" className="page-button" onClick={() => setPage(current + 1)} disabled={current >= totalPages - 1} aria-label="Next page">Next ›</button>
    </div>}
  </>;
}
export function Overview({ data, homeValue, settings, navigate, revision = 0 }) {
  const [period, setPeriod] = useState('1Y');
  const income = Object.entries(data.summary.dividendIncomeByCurrency || {}).map(([currency, amount]) => money(amount, currency)).join(' · ') || '—';
  const investmentValue = getHomeValue(data.summary.holdings.filter((holding) => !holding.is_cash_balance), data.fx_rates, settings.homeCurrency);
  const investmentGain = investmentValue.value - investmentValue.cost;
  const roi = investmentValue.complete ? roiPercent(investmentValue.value, investmentValue.cost) : null;
  const history = portfolioHistory({ ...data, rates: data.fx_rates, homeCurrency: settings.homeCurrency });
  const latestDate = history.at(-1)?.date || today();
  const startDate = (() => {
    const date = new Date(`${latestDate}T12:00:00`);
    if (period === 'ALL') return null;
    if (period === 'YTD') return `${date.getFullYear()}-01-01`;
    if (period === '1Y') date.setFullYear(date.getFullYear() - 1);
    else date.setDate(date.getDate() - Number(period.replace('D', '')));
    return date.toISOString().slice(0, 10);
  })();
  const prior = startDate ? [...history].reverse().find((point) => point.date < startDate) : null;
  const visible = history.filter((point) => !startDate || point.date >= startDate);
  const periodHistory = prior && visible.length ? [prior, ...visible] : visible;
  const first = periodHistory[0]; const last = periodHistory.at(-1);
  const periodChange = periodReturn(periodHistory);
  const currencyEntries = Object.entries(data.summary.valueByCurrency || {});
  const accountValues = {};
  for (const holding of data.summary.holdings) {
    if (holding.is_cash_balance) {
      const account = data.accounts.find((item) => item.id === holding.account_id);
      const label = `${account?.name || 'Account'} · ${holding.currency}`;
      accountValues[label] = (accountValues[label] || 0) + Number(holding.current_value || 0);
      continue;
    }
    const accountPositions = {};
    for (const transaction of data.transactions) if (transaction.asset_id === holding.id && ['buy', 'sell'].includes(transaction.kind)) {
      const key = `${transaction.account_id}:${holding.id}`;
      accountPositions[key] = (accountPositions[key] || 0) + (transaction.kind === 'buy' ? 1 : -1) * Number(transaction.quantity);
    }
    for (const [key, quantity] of Object.entries(accountPositions)) {
      if (!holding.current_value || !holding.quantity) continue;
      const accountId = Number(key.split(':')[0]);
      const account = data.accounts.find((item) => item.id === accountId);
      const label = `${account?.name || 'Account'} · ${holding.currency}`;
      accountValues[label] = (accountValues[label] || 0) + holding.current_value * Math.max(0, quantity) / holding.quantity;
    }
  }
  const periods = ['30D', '90D', '180D', 'YTD', '1Y', 'ALL'];
  return <><div className="metric-grid metric-grid-five">
    <Metric label={`PORTFOLIO VALUE · ${settings.homeCurrency}`} value={homeValue.complete ? money(homeValue.value, settings.homeCurrency) : 'Rates or prices needed'} detail="Current holdings and saved cash balances"/>
    <Metric label={`INVESTED · ${settings.homeCurrency}`} value={money(investmentValue.cost, settings.homeCurrency)} detail="Weighted-average basis · fees included"/>
    <Metric label="UNREALIZED GAIN / LOSS" value={investmentValue.complete ? money(investmentGain, settings.homeCurrency) : '—'} tone={investmentGain >= 0 ? 'text-positive' : 'text-negative'} detail="Open investment positions only"/>
    <Metric label="UNREALIZED ROI" value={roi === null ? '—' : `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`} tone={roi === null ? '' : roi >= 0 ? 'text-positive' : 'text-negative'} detail="Gain ÷ cost basis · excludes cash and realized gains"/>
    <Metric label="DIVIDENDS RECEIVED" value={income} detail={<button className="text-action" onClick={() => navigate('dividends')}>View dividend history →</button>}/>
  </div>
    <SummaryCard placement="overview" title="Jarvis summary · your holdings" navigate={navigate} revision={revision}/>
    <div className="content-grid content-grid-main"><Section title={`Portfolio value history · ${settings.homeCurrency}`}>
      <div className="period-controls" role="group" aria-label="Portfolio history period">{periods.map((option) => <button type="button" key={option} aria-pressed={period === option} className={period === option ? 'period-button selected' : 'period-button'} onClick={() => setPeriod(option)}>{option === '30D' ? '1M' : option === '90D' ? '3M' : option === '180D' ? '6M' : option === 'ALL' ? 'All' : option}</button>)}</div>
      <p className="panel-note">Historical holdings and cash balances converted using rates available on each date. Period change is not adjusted for contributions or withdrawals.</p>
      <PortfolioValueChart data={periodHistory} currency={settings.homeCurrency}/>
      <div className="history-footer">{first && last && <span>{first.date} → {last.date}</span>}{periodChange !== null && <b className={periodChange >= 0 ? 'text-positive' : 'text-negative'}>{periodChange >= 0 ? '+' : ''}{periodChange.toFixed(2)}% period change</b>}</div>
    </Section><Section title="Portfolio allocation"><div className="allocation-currency">{currencyEntries.map(([currency, amount]) => <div className="allocation-row" key={currency}><span>{currency}</span><b>{money(amount, currency)}</b></div>)}{!currencyEntries.length && <Empty>Add an asset and a manual price to see allocation.</Empty>}</div><div className="divider"/><h3 className="subheading">By account · original currencies</h3>{Object.entries(accountValues).map(([label, amount]) => <div className="allocation-row" key={label}><span>{label}</span><b>{money(amount, label.split(' · ').at(-1))}</b></div>)}{!Object.keys(accountValues).length && <p className="panel-note">Account allocation appears after holdings or cash balances are entered.</p>}</Section></div>
    <Section title="Your holdings" action={<button className="text-action" onClick={() => navigate('portfolio')}>View portfolio <span aria-hidden>→</span></button>}><HoldingsTable holdings={data.summary.holdings.filter((holding) => holding.quantity > 0).slice(0, 6)}/></Section>
  </>;
}

export function HoldingsTable({ holdings }) {
  return <DataTable pageSize={12} empty="Create an account, add a purchase, then record a manual price to see your holdings." rows={holdings} columns={[
    { key: 'name', label: 'HOLDING', render: (h) => <><b>{h.name}</b><small className="table-sub">{h.is_cash_balance ? 'Cash balance' : (h.ticker || h.type)} · {h.currency} · {h.price_date || 'No price yet'}</small></> },
    { key: 'quantity', label: 'QUANTITY', render: (h) => h.is_cash_balance ? '—' : Number(h.quantity).toLocaleString() },
    { key: 'cost_basis', label: 'COST BASIS', render: (h) => h.is_cash_balance ? '—' : money(h.cost_basis, h.currency) },
    { key: 'current_value', label: 'VALUE', render: (h) => <>{money(h.current_value, h.currency)}<small className="table-sub">{h.price_source || 'No price'}</small></> },
    { key: 'unrealized_gain', label: 'GAIN / LOSS', render: (h) => h.is_cash_balance ? '—' : <span className={h.unrealized_gain >= 0 ? 'text-positive' : 'text-negative'}>{money(h.unrealized_gain, h.currency)}</span> },
  ]}/>;
}
export function Portfolio({ data, onAdd, onDelete, onEdit }) {
  const [account, setAccount] = useState('');
  const filtered = useMemo(() => data.summary.holdings.filter((h) => h.quantity > 0 && (!account || (h.is_cash_balance ? String(h.account_id) === account : data.transactions.some((t) => t.asset_id === h.id && String(t.account_id) === account)))), [data, account]);
  const currencyEntries = Object.entries(data.summary.valueByCurrency || {});
  return <><div className="toolbar"><select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><div className="toolbar-spacer"/><button className="button button-quiet" onClick={() => onAdd('account')}>＋ Account</button><button className="button button-quiet" onClick={() => onAdd('asset')}>＋ Asset</button><button className="button button-quiet" onClick={() => onAdd('cashBalance')}>＋ Cash balance</button><button className="button button-primary" onClick={() => onAdd('price')}>＋ Manual price</button></div>
    <Section title="Holdings"><HoldingsTable key={account || 'all'} holdings={filtered}/></Section><div className="content-grid content-grid-main"><Section title="Accounts"><DataTable empty="Create your first account." rows={data.accounts} onEdit={(a) => onEdit('account', a)} onDelete={(a) => onDelete('accounts', a)} columns={[{ key: 'name', label: 'ACCOUNT' }, { key: 'currency', label: 'CURRENCY' }]}/></Section><Section title="Value by currency"><div className="allocation-currency">{currencyEntries.map(([c, v]) => <div className="allocation-row" key={c}><span>{c}</span><b>{money(v, c)}</b></div>)}{!currencyEntries.length && <Empty>Prices will show up here.</Empty>}</div></Section></div><Section title="Cash balances"><DataTable empty="Add an account cash balance or a Cash asset balance without buy/sell transactions." rows={[...data.cash_balances].sort((a,b)=>b.date.localeCompare(a.date))} pageSize={12} onEdit={(row)=>onEdit('cashBalance',row)} onDelete={(row)=>onDelete('cash_balances',row)} columns={[{key:'date',label:'DATE'},{key:'account',label:'ACCOUNT',render:(row)=>data.accounts.find((a)=>a.id===row.account_id)?.name||'Account'},{key:'asset',label:'TRACKING',render:(row)=>row.asset_id?data.assets.find((a)=>a.id===row.asset_id)?.name||'Cash asset':'Account cash'},{key:'balance',label:'BALANCE',render:(row)=>money(row.balance,row.currency)}]}/></Section><Section title="Assets"><DataTable pageSize={12} empty="Add your first asset." rows={data.assets} onEdit={(a) => onEdit('asset', a)} onDelete={(a) => onDelete('assets', a)} columns={[{ key: 'name', label: 'ASSET' }, { key: 'ticker', label: 'TICKER / ID' }, { key: 'type', label: 'TYPE' }, { key: 'currency', label: 'CURRENCY' }]}/></Section><Section title="Price history"><DataTable empty="Enter manual dated prices to value your holdings." rows={[...data.prices].sort((a,b)=>b.date.localeCompare(a.date))} onDelete={(p) => onDelete('prices', p)} pageSize={20} columns={[{ key: 'date', label: 'DATE' }, { key: 'asset', label: 'ASSET', render: (p) => data.assets.find((a) => a.id === p.asset_id)?.name || 'Asset' }, { key: 'price', label: 'PRICE', render: (p) => money(p.price,p.currency) }, { key: 'source', label: 'SOURCE' }]}/></Section></>;
}
export function Activity({ data, onAdd, onDelete }) {
  const [kind, setKind] = useState('');
  const transactions = data.transactions.filter((transaction) => !kind || transaction.kind === kind).sort((a, b) => b.date.localeCompare(a.date));
  return <><div className="toolbar"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All activity</option>{['buy', 'sell', 'deposit', 'withdrawal', 'fee'].map((value) => <option key={value}>{value}</option>)}</select><div className="toolbar-spacer"/><button className="button button-primary" onClick={() => onAdd('transaction')}>＋ Activity</button></div>
    <Section title="Transactions"><DataTable key={kind || 'all'} pageSize={20} empty="Record purchases, sales, deposits, withdrawals, and fees here." rows={transactions} onDelete={(transaction) => onDelete('transactions', transaction)} columns={[{ key: 'date', label: 'DATE' }, { key: 'kind', label: 'TYPE', render: (transaction) => <span className="tag">{transaction.kind}</span> }, { key: 'asset', label: 'ASSET / ACCOUNT', render: (transaction) => data.assets.find((asset) => asset.id === transaction.asset_id)?.name || data.accounts.find((account) => account.id === transaction.account_id)?.name || 'Cash flow' }, { key: 'quantity', label: 'QUANTITY', render: (transaction) => transaction.quantity || '—' }, { key: 'amount', label: 'AMOUNT', render: (transaction) => money(transaction.amount || Number(transaction.quantity || 0) * Number(transaction.unit_price || 0), transaction.currency) }, { key: 'fees', label: 'FEES', render: (transaction) => money(transaction.fees, transaction.currency) }]}/></Section>
  </>;
}

export function Dividends({ data, onAdd, onDelete, onEdit }) {
  const [assetId, setAssetId] = useState('');
  const [period, setPeriod] = useState('1Y');
  const dividendAssets = data.assets.filter((asset) => data.dividends.some((payment) => String(payment.asset_id) === String(asset.id)));
  const payments = data.dividends.filter((payment) => !assetId || String(payment.asset_id) === assetId).sort((a, b) => b.date.localeCompare(a.date));
  // Continuous month axis for the chart: every month in the selected period gets one bar,
  // including months without payments (zero), so gaps in income are visible as real calendar time.
  const currentMonth = today().slice(0, 7);
  const chartStart = (() => {
    if (period === 'ALL') return null;
    const date = new Date();
    if (period === 'YTD') return `${date.getFullYear()}-01`;
    date.setMonth(date.getMonth() - (period === '1Y' ? 11 : period === '3Y' ? 35 : 59));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  })();
  const monthRange = (from, to) => {
    const months = [];
    let [year, month] = from.split('-').map(Number);
    const [endYear, endMonth] = to.split('-').map(Number);
    while (year < endYear || (year === endYear && month <= endMonth)) {
      months.push(`${year}-${String(month).padStart(2, '0')}`);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    return months;
  };
  const monthOf = (payment) => payment.date.slice(0, 7);
  // The metric cards and the charts share one window: the top totals follow the selected period.
  const windowPayments = payments.filter((payment) => (!chartStart || monthOf(payment) >= chartStart) && monthOf(payment) <= currentMonth);
  const totals = windowPayments.reduce((result, payment) => { result[payment.currency] = (result[payment.currency] || 0) + Number(payment.amount); return result; }, {});
  const periodText = { YTD: 'year to date', '1Y': 'last 12 months', '3Y': 'last 3 years', '5Y': 'last 5 years', ALL: 'all time' }[period];
  const assetName = (id) => data.assets.find((asset) => asset.id === id)?.name || 'Asset';
  const chartCurrencies = currencies.filter((currency) => payments.some((payment) => payment.currency === currency));
  return <><div className="dividend-intro"><div><span className="cashflow-kicker">INCOME FROM YOUR HOLDINGS</span><h2>Dividend income</h2><p>Follow the payments you have received over time. Each currency is shown separately, and monthly bars show which holdings paid.</p></div><div className="dividend-intro-mark" aria-hidden="true">↗</div></div>
    <div className="toolbar dividend-toolbar"><label className="dividend-asset-select"><span>HOLDING</span><select aria-label="Filter dividends by asset" value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="">All holdings</option>{dividendAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><div className="dividend-period"><span>TIME PERIOD</span><div className="period-controls" role="group" aria-label="Dividend chart period">{['YTD', '1Y', '3Y', '5Y', 'ALL'].map((option) => <button type="button" key={option} aria-pressed={period === option} className={period === option ? 'period-button selected' : 'period-button'} onClick={() => setPeriod(option)}>{option === 'ALL' ? 'All time' : option}</button>)}</div></div><div className="toolbar-spacer"/><div className="dividend-record-count">{windowPayments.length} {windowPayments.length === 1 ? 'payment' : 'payments'} · {periodText}</div><button className="button button-primary" onClick={() => onAdd('dividend')}>＋ Record dividend</button></div>
    <div className="metric-grid dividend-metrics">{chartCurrencies.map((currency) => <Metric key={currency} label={`RECEIVED · ${currency}`} value={money(totals[currency] || 0, currency)} tone="text-positive" detail={`${windowPayments.filter((payment) => payment.currency === currency).length} payments · ${periodText}`}/>)}{!payments.length && <Metric label="DIVIDENDS RECEIVED" value="—" detail="Recorded payments appear here"/>}</div>
    <p className="panel-note dividend-note">Recorded dividend payments only. These totals do not include estimates or projected income.</p>
    <div className="content-grid">{chartCurrencies.map((currency) => {
      const currencyPayments = payments.filter((payment) => payment.currency === currency);
      // One stacked segment per asset; colors and legend stay stable across period switches.
      const series = [...new Set(currencyPayments.map((payment) => payment.asset_id))].map((id) => ({ key: `asset-${id}`, name: assetName(id) }));
      const months = monthRange(chartStart || currencyPayments.map(monthOf).sort()[0], currentMonth);
      const rows = months.map((month) => ({ month, ...Object.fromEntries(series.map((segment) => [segment.key, 0])) }));
      const rowByMonth = new Map(rows.map((row) => [row.month, row]));
      for (const payment of currencyPayments) {
        const row = rowByMonth.get(monthOf(payment)); // outside the window: not charted, not counted
        if (row) row[`asset-${payment.asset_id}`] += Number(payment.amount);
      }
      return <Section key={currency} className="dividend-chart-panel" title={`Monthly payments · ${currency}`}><DividendChart currency={currency} data={rows} series={series}/></Section>;
    })}{!chartCurrencies.length && <Section className="dividend-chart-panel" title="Monthly history"><Empty title="Your dividend history starts here">Record a payment to see income trends and which holdings contributed.</Empty></Section>}</div>
    <Section className="dividend-payments" title="Payment history"><DataTable key={assetId || 'all'} pageSize={20} empty="No dividend payments recorded. Add a payment to begin a history." rows={payments} onEdit={onEdit ? (payment) => onEdit('dividend', payment) : undefined} onDelete={(payment) => onDelete('dividends', payment)} columns={[{ key: 'date', label: 'PAYMENT DATE' }, { key: 'asset', label: 'HOLDING', render: (payment) => data.assets.find((asset) => asset.id === payment.asset_id)?.name || 'Asset' }, { key: 'account', label: 'ACCOUNT', render: (payment) => data.accounts.find((account) => account.id === payment.account_id)?.name || '—' }, { key: 'shares', label: 'SHARES HELD', render: (payment) => payment.shares ?? '—' }, { key: 'amount', label: 'AMOUNT', render: (payment) => <b className="text-positive">{money(payment.amount, payment.currency)}</b> }, { key: 'notes', label: 'NOTES' }]}/></Section>
  </>;
}
export function CashFlow({ data, onAdd, onDelete, onEdit, navigate, revision = 0 }) {
  const accounts = data.accounts || [];
  const categories = data.cash_flow_categories || [];
  const entries = data.cash_flow_transactions || [];
  const currentMonth = today().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [period, setPeriod] = useState('month');
  const [kindFilter, setKindFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const activeAccounts = useMemo(() => accounts.filter((account) => entries.some((entry) => String(entry.account_id) === String(account.id))), [accounts, entries]);
  const periodStart = period === 'month' ? month : period === '3m' ? shiftMonth(currentMonth, -2) : period === '6m' ? shiftMonth(currentMonth, -5) : period === '12m' ? shiftMonth(currentMonth, -11) : period === 'ytd' ? `${currentMonth.slice(0, 4)}-01` : null;
  const periodLabel = period === 'month' ? monthLabel(month) : ({ '3m': 'Last 3 months', '6m': 'Last 6 months', '12m': 'Last 12 months', ytd: 'Year to date', all: 'All time' }[period]);
  const periodEntries = useMemo(() => entries.filter((entry) => {
    const entryMonth = monthOf(entry);
    return (!periodStart || entryMonth >= periodStart) && (period === 'month' ? entryMonth === month : period === 'all' || entryMonth <= currentMonth) && (!accountFilter || String(entry.account_id) === accountFilter);
  }), [entries, periodStart, period, month, currentMonth, accountFilter]);
  const totals = useMemo(() => cashFlowTotals(periodEntries), [periodEntries]);
  const expenseRows = useMemo(() => categoryBreakdown(periodEntries, categories, 'expense'), [periodEntries, categories]);
  const incomeRows = useMemo(() => categoryBreakdown(periodEntries, categories, 'income'), [periodEntries, categories]);
  const accountName = (id) => accounts.find((account) => account.id === id)?.name || '—';
  const categoryName = (id) => categories.find((category) => category.id === id)?.name || '—';
  const visibleEntries = useMemo(() => [...periodEntries]
    .filter((entry) => (!kindFilter || entry.kind === kindFilter) && (!categoryFilter || String(entry.category_id) === categoryFilter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id), [periodEntries, kindFilter, categoryFilter]);
  const currenciesInUse = Object.keys(totals).sort();
  return <>
    <div className="cashflow-intro"><div><span className="cashflow-kicker">YOUR MONEY, AT A GLANCE</span><p className="panel-note">Track recorded income and spending across your accounts. Totals stay in their original currencies; only entries you add appear here.</p></div><span className="cashflow-period-label">{periodLabel}</span></div>
    <div className="toolbar cashflow-toolbar">
      <label className="cashflow-period-select"><span>CALENDAR VIEW</span><select aria-label="Calendar view" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="month">Selected month</option><option value="3m">Last 3 months</option><option value="6m">Last 6 months</option><option value="12m">Last 12 months</option><option value="ytd">Year to date</option><option value="all">All time</option></select></label>
      {period === 'month' && <div className="month-picker"><button type="button" className="month-step" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
      <input type="month" aria-label="Month" value={month} onChange={(event) => event.target.value && setMonth(event.target.value)}/>
      <button type="button" className="month-step" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button></div>}
      {period === 'month' && month !== currentMonth && <button type="button" className="text-action" onClick={() => setMonth(currentMonth)}>Current month</button>}
      <label className="cashflow-account-select"><span>ACCOUNT</span><select aria-label="Filter cash flow by account" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}><option value="">All active accounts</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <div className="toolbar-spacer"/>
      <button className="button button-quiet" onClick={() => onAdd('account')}>＋ Account</button>
      <button className="button button-quiet" onClick={() => onAdd('cashFlowCategory')}>＋ Category</button>
      <button className="button button-primary" onClick={() => onAdd('cashFlowTransaction')}>＋ Record entry</button>
    </div>
    <div className="metric-grid">
      {currenciesInUse.map((currency) => { const t = totals[currency]; return [
        <Metric key={`${currency}-income`} label={`INCOME · ${currency}`} value={money(t.income, currency)} tone="text-positive" detail={`${periodEntries.filter((entry) => entry.currency === currency && entry.kind === 'income').length} entries · ${periodLabel}`}/>,
        <Metric key={`${currency}-expense`} label={`SPENDING · ${currency}`} value={`−${money(t.expense, currency)}`} tone="text-negative" detail={`${periodEntries.filter((entry) => entry.currency === currency && entry.kind === 'expense').length} entries · ${periodLabel}`}/>,
        <Metric key={`${currency}-net`} label={`NET · ${currency}`} value={`${t.net < 0 ? '−' : '+'}${money(Math.abs(t.net), currency)}`} tone={t.net >= 0 ? 'text-positive' : 'text-negative'} detail="Income minus spending"/>,
      ]; }).flat()}
      {!currenciesInUse.length && <Metric label="RECORDED CASH FLOW" value="—" detail={`Nothing recorded for ${periodLabel} yet. Income and spending you add show up here.`}/>}
    </div>
    <SummaryCard placement="cashflow" period={month} title="Jarvis summary · cash flow" navigate={navigate} revision={revision}/>
    <div className="content-grid content-grid-main">
      <Section title={`Spending by category · ${periodLabel}`} className="cashflow-breakdown" action={categoryFilter ? <button type="button" className="text-action" onClick={() => setCategoryFilter('')}>Clear filter</button> : undefined}>
        {expenseRows.length ? <div className="flow-breakdown-grid">{currenciesInUse.map((currency) => { const rows = expenseRows.filter((row) => row.currency === currency); return rows.length ? <div className="flow-breakdown-card" key={currency}><div className="flow-breakdown-heading"><span>Spending</span><b>{currency}</b></div><FlowCategoryChart rows={rows} currency={currency} kind="expense" selectedCategory={categoryFilter} onSelectCategory={setCategoryFilter}/></div> : null; })}</div> : <Empty>No spending recorded for this period. Add an expense entry to see where it went.</Empty>}
      </Section>
      <Section title={`Income by category · ${periodLabel}`} className="cashflow-breakdown">
        {incomeRows.length ? <div className="flow-breakdown-grid">{currenciesInUse.map((currency) => { const rows = incomeRows.filter((row) => row.currency === currency); return rows.length ? <div className="flow-breakdown-card income" key={currency}><div className="flow-breakdown-heading"><span>Income</span><b>{currency}</b></div><FlowCategoryChart rows={rows} currency={currency} kind="income"/></div> : null; })}</div> : <Empty>Recorded income appears here, per category.</Empty>}
      </Section>
    </div>
    <Section title={`Entries · ${periodLabel}`}>
      {!accounts.length && <Empty title="No accounts yet">Create an account — the same list your portfolio uses (bank, card, brokerage) — to start recording income and spending. <button type="button" className="text-action" onClick={() => onAdd('account')}>＋ Add account</button></Empty>}
      {accounts.length > 0 && <>
        <div className="toolbar">
          <select aria-label="Filter by type" value={kindFilter} onChange={(event) => { setKindFilter(event.target.value); setCategoryFilter(''); }}><option value="">Any type</option><option value="income">Income</option><option value="expense">Spending</option></select>
          <select aria-label="Filter by category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{categories.filter((category) => (category.active || category.id === Number(categoryFilter)) && (!kindFilter || category.kind === kindFilter)).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
          {(kindFilter || accountFilter || categoryFilter) && <button type="button" className="text-action" onClick={() => { setKindFilter(''); setAccountFilter(''); setCategoryFilter(''); }}>Clear filters</button>}
        </div>
        <DataTable key={`${period}-${month}-${kindFilter}-${accountFilter}-${categoryFilter}`} pageSize={20} empty={`Nothing recorded for ${periodLabel}${(kindFilter || accountFilter || categoryFilter) ? ' with the current filters' : ''}.`} rows={visibleEntries}
          onEdit={(entry) => onEdit('cashFlowTransaction', entry)} onDelete={(entry) => onDelete('cash_flow_transactions', entry)}
          columns={[
            { key: 'date', label: 'DATE' },
            { key: 'kind', label: 'TYPE', render: (entry) => <span className="tag">{entry.kind === 'expense' ? 'spending' : 'income'}</span> },
            { key: 'account', label: 'ACCOUNT', render: (entry) => accountName(entry.account_id) },
            { key: 'category', label: 'CATEGORY', render: (entry) => categoryName(entry.category_id) },
            { key: 'payee', label: 'PAYEE', render: (entry) => entry.payee || '—' },
            { key: 'description', label: 'DESCRIPTION', render: (entry) => entry.description || '—' },
            { key: 'amount', label: 'AMOUNT', render: (entry) => <b className={entry.kind === 'expense' ? 'text-negative' : 'text-positive'}>{entry.kind === 'expense' ? '−' : '+'}{money(entry.amount, entry.currency, 2)}</b> },
          ]}/>
      </>}
    </Section>
    <Section title="Categories"><p className="panel-note">Income and spending use separate categories. Categories are deactivated, not deleted, once entries use them, so history stays categorized. Entries use the same accounts as the portfolio — manage them with the ＋ Account button above or on the Portfolio page.</p><DataTable pageSize={12} empty="Defaults are seeded here; add your own categories as needed." rows={[...categories].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))} onEdit={(category) => onEdit('cashFlowCategory', category)} onDelete={(category) => onDelete('cash_flow_categories', category)} columns={[{ key: 'name', label: 'CATEGORY' }, { key: 'kind', label: 'TYPE', render: (category) => <span className="tag">{category.kind}</span> }, { key: 'active', label: 'STATUS', render: (category) => category.active ? <span className="text-positive">Active</span> : <span className="tag">Inactive</span> }, { key: 'entries', label: 'ENTRIES', render: (category) => entries.filter((entry) => entry.category_id === category.id).length }]}/></Section>
  </>;
}

export function NetWorth({ data, settings, homeValue, onAdd, onDelete, onEdit }) {
  const latestFor = (rows, key, id) => [...rows].filter((row) => row[key] === id).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)[0];
  const assets = data.physical_assets.map((asset) => ({ ...asset, valuation: latestFor(data.physical_valuations, 'physical_asset_id', asset.id) }));
  const loans = data.liabilities.map((loan) => ({ ...loan, snapshot: latestFor(data.liability_balances, 'liability_id', loan.id) }));
  const convert = (amount, currency, date) => { const rate = convertRate(data.fx_rates, currency, settings.homeCurrency, date || today()); return rate == null ? null : Number(amount) * rate; };
  const assetTotal = assets.reduce((sum, asset) => sum + (asset.valuation ? convert(asset.valuation.value, asset.currency, asset.valuation.date) ?? 0 : 0), 0);
  const debtTotal = loans.reduce((sum, loan) => sum + (loan.snapshot ? convert(loan.snapshot.balance, loan.currency, loan.snapshot.date) ?? 0 : 0), 0);
  const incomplete = assets.some((asset) => asset.valuation && convert(asset.valuation.value, asset.currency, asset.valuation.date) == null) || loans.some((loan) => loan.snapshot && convert(loan.snapshot.balance, loan.currency, loan.snapshot.date) == null);
  const valuedAssets = assets.filter((asset) => asset.valuation);
  const recordedLoans = loans.filter((loan) => loan.snapshot);
  return <><div className="metric-grid"><Metric label={`INVESTMENTS & CASH · ${settings.homeCurrency}`} value={homeValue.complete ? money(homeValue.value, settings.homeCurrency) : 'Rates or prices needed'} detail="Current portfolio value"/><Metric label={`PHYSICAL ASSETS · ${settings.homeCurrency}`} value={incomplete ? 'FX rate needed' : money(assetTotal, settings.homeCurrency)} detail={`${valuedAssets.length} with a recorded valuation`}/><Metric label={`LOAN BALANCES · ${settings.homeCurrency}`} value={incomplete ? 'FX rate needed' : money(debtTotal, settings.homeCurrency)} detail={`${recordedLoans.length} with a recorded balance`}/><Metric label={`ESTIMATED NET WORTH · ${settings.homeCurrency}`} value={incomplete || !homeValue.complete ? 'Values or FX rates needed' : money(homeValue.value + assetTotal - debtTotal, settings.homeCurrency)} detail="Investments and cash + physical assets − recorded loans"/></div>
    <p className="panel-note">Manual estimates and balances only. Dates show when each value was recorded. Physical assets and loans are excluded from investment performance and retirement projections; this page is a separate net-worth view.</p>
    <div className="toolbar"><div className="toolbar-spacer"/><button className="button button-quiet" onClick={() => onAdd('liability')}>＋ Loan or mortgage</button><button className="button button-primary" onClick={() => onAdd('physicalAsset')}>＋ Physical asset</button></div>
    <Section title="Physical assets" action={<button className="text-action" onClick={() => onAdd('valuation')} disabled={!assets.length}>＋ Record valuation</button>}><DataTable empty="Add a property, vehicle, or other physical asset, then record its estimated value." rows={assets} onEdit={(row) => onEdit('physicalAsset', row)} onDelete={(row) => onDelete('physical_assets', row)} columns={[{key:'name',label:'ASSET',render:(row)=><><b>{row.name}</b><small className="table-sub">{row.type}{row.purchase_date?` · purchased ${row.purchase_date}`:''}</small></>},{key:'value',label:'LATEST ESTIMATED VALUE',render:(row)=>row.valuation?<>{money(row.valuation.value,row.currency)}<small className="table-sub">{row.valuation.date} · {row.valuation.source}</small></>:'No valuation'},{key:'equity',label:'LINKED LOAN / EQUITY',render:(row)=>{const related=loans.filter((loan)=>loan.physical_asset_id===row.id);const debt=related.reduce((sum,loan)=>sum+Number(loan.snapshot?.balance||0),0);return row.valuation?money(Number(row.valuation.value)-debt,row.currency):'—';}}]}/></Section>
    <Section title="Loans and mortgages" action={<button className="text-action" onClick={() => onAdd('liabilityBalance')} disabled={!loans.length}>＋ Record balance</button>}><DataTable empty="Add a mortgage, vehicle finance, or other loan to track its current balance." rows={loans} onEdit={(row) => onEdit('liability', row)} onDelete={(row) => onDelete('liabilities', row)} columns={[{key:'name',label:'LOAN',render:(row)=><><b>{row.name}</b><small className="table-sub">{row.type}{row.physical_asset_id?` · ${data.physical_assets.find((asset)=>asset.id===row.physical_asset_id)?.name||'Linked asset'}`:''}</small></>},{key:'balance',label:'LATEST BALANCE',render:(row)=>row.snapshot?<>{money(row.snapshot.balance,row.currency)}<small className="table-sub">as of {row.snapshot.date}</small></>:'No balance recorded'},{key:'original_amount',label:'ORIGINAL AMOUNT',render:(row)=>money(row.original_amount,row.currency)},{key:'interest_rate',label:'INTEREST',render:(row)=>row.interest_rate==null?'—':`${row.interest_rate}%`}]}/></Section>
    <div className="content-grid"><Section title="Valuation history"><DataTable empty="No valuations recorded." rows={[...data.physical_valuations].sort((a,b)=>b.date.localeCompare(a.date))} pageSize={10} onDelete={(row)=>onDelete('physical_valuations',row)} columns={[{key:'date',label:'DATE'},{key:'physical_asset_id',label:'ASSET',render:(row)=>data.physical_assets.find((asset)=>asset.id===row.physical_asset_id)?.name||'Asset'},{key:'value',label:'VALUE',render:(row)=>money(row.value,row.currency)},{key:'source',label:'SOURCE'}]}/></Section><Section title="Loan balance history"><DataTable empty="No balances recorded." rows={[...data.liability_balances].sort((a,b)=>b.date.localeCompare(a.date))} pageSize={10} onDelete={(row)=>onDelete('liability_balances',row)} columns={[{key:'date',label:'DATE'},{key:'liability_id',label:'LOAN',render:(row)=>data.liabilities.find((loan)=>loan.id===row.liability_id)?.name||'Loan'},{key:'balance',label:'BALANCE',render:(row)=>money(row.balance,data.liabilities.find((loan)=>loan.id===row.liability_id)?.currency||settings.homeCurrency)}]}/></Section></div>
  </>;
}
export function Planning({ settings, setSettings, homeValue }) {
  const [form, setForm] = useState({ ...settings, inflation: Number(settings.inflation ?? .02) * 100, conservative: Number(settings.scenarios?.[0] ?? .03) * 100, base: Number(settings.scenarios?.[1] ?? .05) * 100, optimistic: Number(settings.scenarios?.[2] ?? .07) * 100 });
  const years = Math.max(0, Number(form.retirementAge) - Number(form.currentAge));
  const forecast = (annualRate) => projectRetirement({ startingValue: Number(homeValue.value || 0) + Number(form.oneTimeContribution || 0), monthlyContribution: Number(form.monthlyContribution || 0), annualReturn: Number(annualRate), inflation: Number(form.inflation) / 100, yearsToRetirement: years, retirementYears: 30, monthlyWithdrawal: Number(form.monthlyWithdrawal || 0), withdrawalRate: .04 });
  const valueAtRetirement = (annualRate) => forecast(annualRate).retirementValue;
  const scenarios = [['Conservative', 'conservative'], ['Base', 'base'], ['Optimistic', 'optimistic']];
  const series = scenarios.map(([label, key]) => ({ label, values: forecast(Number(form[key]) / 100).points.map((point) => point.value) }));
  const baseProjection = forecast(Number(form.base) / 100);
  const targetIncome = Number(form.monthlyIncome || 0);
  const incomeCoverage = targetIncome > 0 ? baseProjection.monthlyIncome / targetIncome * 100 : null;
  const save = async (e) => { e.preventDefault(); await setSettings({ ...form, currentAge: Number(form.currentAge), retirementAge: Number(form.retirementAge), monthlyContribution: Number(form.monthlyContribution), monthlyIncome: Number(form.monthlyIncome), oneTimeContribution: Number(form.oneTimeContribution), monthlyWithdrawal: Number(form.monthlyWithdrawal), inflation: Number(form.inflation) / 100, scenarios: [Number(form.conservative) / 100, Number(form.base) / 100, Number(form.optimistic) / 100] }); };
  const update = (key, value) => setForm({ ...form, [key]: value });
  return <><div className="retirement-intro"><span className="cashflow-kicker">PLAN FOR YOUR FUTURE</span><h2>A retirement plan in today’s money</h2><p>See how your portfolio could grow after inflation, then estimate a starting retirement income using the 4% rule.</p></div>
    <div className="metric-grid retirement-metrics"><Metric label="TIME TO RETIREMENT" value={`${Math.floor(years)} years`} detail={`Age ${form.currentAge} → ${form.retirementAge}`}/><Metric label="CURRENT PORTFOLIO" value={money(homeValue.value, form.homeCurrency)} detail={homeValue.complete ? 'Current value · nominal' : 'Partial value · prices or FX missing'}/><Metric label="TARGET MONTHLY INCOME" value={money(targetIncome, form.homeCurrency)} detail="In today’s purchasing power"/><Metric label="4% RULE · MONTHLY" value={money(baseProjection.monthlyIncome, form.homeCurrency)} tone={incomeCoverage != null && incomeCoverage >= 100 ? 'text-positive' : 'text-negative'} detail={`${incomeCoverage == null ? 'Base scenario · at retirement' : `${incomeCoverage.toFixed(0)}% of target · base scenario`}`}/></div>
    {!homeValue.complete && <div className="retirement-data-warning" role="status"><b>Starting portfolio value is incomplete.</b> Some holdings are missing prices or exchange rates. The projection uses only values it can convert, so it may be understated.</div>}
    <div className="content-grid content-grid-main"><Section title="Portfolio projection · today’s money" action={<span className="retirement-chart-tag">Retirement phase · 30 years</span>}><p className="panel-note">Balances are inflation-adjusted. The dashed line marks retirement; after it, the chart models a 4% first-year withdrawal that keeps the same purchasing power each year.</p><ScenarioChart lines={series} currency={form.homeCurrency} retirementYear={Math.floor(years)} startAge={Number(form.currentAge)}/><div className="scenario-assumptions"><b>Scenario assumptions</b><span>Nominal annual returns are editable inputs. New plans start at 3%, 5%, and 7%; these are not forecasts or values inferred from your portfolio.</span></div><div className="scenario-list">{scenarios.map(([label, key]) => <label className="scenario-row" key={key}><span><b>{label}</b><small>Nominal return · {Number(form.inflation)}% inflation</small></span><input aria-label={`${label} nominal annual return percent`} type="number" step="0.5" value={form[key]} onChange={(e) => update(key, e.target.value)}/><span>%</span><b className="scenario-value">{money(valueAtRetirement(Number(form[key]) / 100), form.homeCurrency)}<small>at retirement</small></b></label>)}</div></Section>
      <Section title="Your assumptions"><form onSubmit={save}><div className="form-grid">{[['currentAge','Current age'],['retirementAge','Retirement age'],['monthlyContribution','Monthly contribution'],['monthlyIncome','Desired monthly income'],['oneTimeContribution','One-time contribution'],['monthlyWithdrawal','Monthly withdrawal before retirement'],['inflation','Inflation (%)']].map(([key, label]) => <label className="field" key={key}><span>{label}</span><input type="number" step="any" value={form[key]} onChange={(e) => update(key, e.target.value)}/></label>)}<label className="field"><span>Home currency</span><select value={form.homeCurrency} onChange={(e) => update('homeCurrency', e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label></div><button className="button button-primary assumption-save">Save assumptions</button></form><p className="panel-note">The 4% rule starts with 4% of the portfolio at retirement. Retirement withdrawals stay level in today’s money, which means they rise with inflation in future currency. Returns, inflation, contributions, and pre-retirement withdrawals are assumptions. Excludes taxes and fees; the 4% rule is a historical guideline, not a guarantee.</p></Section>
    </div></>;
}
export function Settings({ data, settings, onHomeCurrency, onDelete, onRefresh }) {
  const [date, setDate] = useState(today()); const [base, setBase] = useState('EUR'); const [quote, setQuote] = useState('SEK'); const [rate, setRate] = useState(''); const [fxMessage, setFxMessage] = useState('');
  const saveRate = async () => { if (base === quote || !(Number(rate) > 0)) { setFxMessage('Choose different currencies and enter a positive rate.'); return; } try { await onHomeCurrency({ fx_rate: { date, base, quote, rate: Number(rate), source: 'Manual' } }); setFxMessage('Exchange rate saved.'); } catch (e) { setFxMessage(e.message); } };
  const syncRates = async () => { setFxMessage(''); try { const result = await api('fx/sync', { method: 'POST', body: JSON.stringify({ provider: settings.fxProvider }) }); setFxMessage(result.message || `Stored ${result.stored} new rates across ${result.dates} dates (${result.source}).`); await onRefresh(); } catch (error) { setFxMessage(error.message); } };
  return <><AssistantSettings/><div className="content-grid content-grid-main"><Section title="Home currency and exchange rates"><label className="field max-field"><span>Home currency for portfolio totals and planning</span><select value={settings.homeCurrency} onChange={(e) => onHomeCurrency({ homeCurrency: e.target.value })}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label><p className="panel-note">Portfolio snapshots are translated using rates dated on or before each valuation date.</p><div className="divider"/><h3 className="subheading">Historical rate provider</h3><label className="field max-field"><span>Provider</span><select value={settings.fxProvider} onChange={(e) => onHomeCurrency({ fxProvider: e.target.value })}><option value="frankfurter">Frankfurter blended daily reference rates</option><option value="ecb">Frankfurter · ECB reference rates</option></select></label><button className="button button-primary assumption-save" onClick={syncRates}>Sync historical FX rates</button><p className="panel-note">Only currency codes and date ranges are sent to Frankfurter; your holdings and amounts stay local. Rates are daily references, not live quotes.</p><div className="divider"/><h3 className="subheading">Add a manual exchange rate</h3><div className="form-grid"><label className="field"><span>Rate date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)}/></label><label className="field"><span>From</span><select value={base} onChange={(e) => setBase(e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label><label className="field"><span>To</span><select value={quote} onChange={(e) => setQuote(e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label><label className="field"><span>1 {base} = ? {quote}</span><input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)}/></label></div><button className="button button-quiet assumption-save" onClick={saveRate}>Save manual rate</button>{fxMessage && <p className="panel-note" role="status">{fxMessage}</p>}{data.fx_rates.length ? <p className="panel-note">{data.fx_rates.length} dated rates stored locally · latest {data.fx_rates.reduce((max, r) => (r.date > max ? r.date : max), '')}. Re-syncing refreshes provider rows and never overwrites manual ones.</p> : <p className="panel-note">No exchange rates stored yet — sync or add one manually above.</p>}</Section>
    <Section title="Backup and data"><p className="panel-note">The full JSON backup includes accounts, assets, activity, dated cash balances, manual prices, dividends, exchange rates, and retirement assumptions.</p><div className="button-row"><button className="button button-primary" onClick={() => window.dispatchEvent(new Event('backup-data'))}>Download full backup</button><button className="button button-quiet" onClick={() => document.getElementById('restore-file').click()}>Restore backup</button></div><div className="divider"/><p className="panel-note"><b>Local database</b><br/>Stored on this computer in <code>data/portfolio.sqlite</code>. Keep backups private; they contain your financial records.</p><p className="panel-note"><b>Prices and FX</b><br/>Asset prices are manual and are never called live. Historical FX sync is optional and sends only currency codes and a date range to the selected Frankfurter source. Rates are stored locally; no portfolio amounts, holdings, or tickers are sent.</p><p className="panel-note"><b>Cost basis</b><br/>Moving weighted average. Purchase fees add to basis; sale fees reduce proceeds; partial sales remove average cost. Demo records, if enabled, are clearly marked.</p></Section></div></>;
}
