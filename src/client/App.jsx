import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, currencies, escapeCsv, getHomeValue } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import Modal from './components/Modal.jsx';
import { Activity, CashFlow, Dividends, NetWorth, Overview, Planning, Portfolio, Settings } from './components/Views.jsx';
import Assistant from './components/Assistant.jsx';

const initialSettings = { homeCurrency: 'EUR', fxProvider: 'frankfurter', currentAge: 35, retirementAge: 65, monthlyContribution: 500, monthlyIncome: 2500, oneTimeContribution: 0, monthlyWithdrawal: 0, inflation: .02, scenarios: [.03, .05, .07] };
const titles = { overview: 'Overview', portfolio: 'Portfolio', networth: 'Net worth', activity: 'Activity', dividends: 'Dividends', cashflow: 'Cash flow', assistant: 'Ask Jarvis', planning: 'Retirement plan', settings: 'Settings & backup' };
const routes = ['overview', 'portfolio', 'networth', 'activity', 'dividends', 'cashflow', 'assistant', 'planning', 'settings'];
const pathFor = (page) => (page === 'overview' ? '/' : `/${page}`);
const pageFromLocation = () => {
  const slug = window.location.pathname.split('/')[1] || '';
  return routes.includes(slug) ? slug : 'overview';
};
const emptyData = { accounts: [], assets: [], transactions: [], prices: [], dividends: [], cash_balances: [], physical_assets: [], physical_valuations: [], liabilities: [], liability_balances: [], fx_rates: [], cash_flow_categories: [], cash_flow_transactions: [], summary: { holdings: [], valueByCurrency: {}, costByCurrency: {}, dividendIncomeByCurrency: {} } };

export default function App() {
  const [page, setPage] = useState(pageFromLocation); const [data, setData] = useState(emptyData); const [settings, setSettings] = useState(initialSettings);
  const [modal, setModal] = useState(null); const [editing, setEditing] = useState(null); const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  // Bumped on every reload of the records, so the AI summary cards can re-check whether their
  // cached answer still matches the data without polling or re-asking the model.
  const [revision, setRevision] = useState(0);
  const navigate = useCallback((next) => {
    if (!routes.includes(next)) return;
    if (window.location.pathname !== pathFor(next)) window.history.pushState({ page: next }, '', pathFor(next));
    setPage(next);
  }, []);
  useEffect(() => {
    const onPop = () => setPage(pageFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    document.title = `Jarvis Finance · ${titles[page]}`;
    // Normalize any unknown deep link (e.g. /anything) back to the page we actually render.
    if (window.location.pathname !== pathFor(page)) window.history.replaceState({ page }, '', pathFor(page));
  }, [page]);
  const refresh = useCallback(async () => {
    try {
      const [summary, accounts, assets, transactions, prices, dividends, cash_balances, physical_assets, physical_valuations, liabilities, liability_balances, fx_rates, cash_flow_categories, cash_flow_transactions, saved] = await Promise.all([
        'summary', 'accounts', 'assets', 'transactions', 'prices', 'dividends', 'cash_balances', 'physical_assets', 'physical_valuations', 'liabilities', 'liability_balances', 'fx_rates', 'cash_flow_categories', 'cash_flow_transactions', 'settings',
      ].map((path) => api(path)));
      setData({ accounts, assets, transactions, prices, dividends, cash_balances, physical_assets, physical_valuations, liabilities, liability_balances, fx_rates, cash_flow_categories, cash_flow_transactions, summary: summary.summary });
      const storedCurrency = typeof saved.homeCurrency === 'string' ? saved.homeCurrency : saved.homeCurrency?.homeCurrency;
      const homeCurrency = ['EUR', 'SEK', 'USD', 'BRL'].includes(storedCurrency) ? storedCurrency : initialSettings.homeCurrency;
      setSettings({ ...initialSettings, ...saved, homeCurrency });
      // Repair settings written by the old overview currency selector, which nested this value.
      if (saved.homeCurrency !== homeCurrency) await api('settings', { method: 'PUT', body: JSON.stringify({ homeCurrency }) });
      setError('');
      setRevision((value) => value + 1);
    } catch (e) { setError(`Could not reach the local database: ${e.message}`); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const homeValue = useMemo(() => getHomeValue(data.summary.holdings, data.fx_rates, settings.homeCurrency), [data, settings.homeCurrency]);
  const addRecord = (type) => {
    const cashFlowTypes = ['cashFlowCategory', 'cashFlowTransaction'];
    if (!['account', 'asset', 'physicalAsset', 'liability'].includes(type) && !cashFlowTypes.includes(type) && data.accounts.length === 0 && !['valuation', 'liabilityBalance'].includes(type)) { setError(''); navigate('portfolio'); setEditing(null); setModal('account'); return; }
    if (['price', 'dividend'].includes(type) && data.assets.length === 0) { setError(''); navigate('portfolio'); setEditing(null); setModal('asset'); return; }
    if (type === 'valuation' && data.physical_assets.length === 0) { setError(''); navigate('networth'); setEditing(null); setModal('physicalAsset'); return; }
    if (type === 'liabilityBalance' && data.liabilities.length === 0) { setError(''); navigate('networth'); setEditing(null); setModal('liability'); return; }
    // Cash flow shares the portfolio account list; guide creation without leaving the page.
    if (type === 'cashFlowTransaction' && data.accounts.length === 0) { setError(''); navigate('cashflow'); setEditing(null); setModal('account'); return; }
    if (type === 'cashFlowTransaction' && !(data.cash_flow_categories || []).some((category) => category.active)) { setError(''); navigate('cashflow'); setEditing(null); setModal('cashFlowCategory'); return; }
    setError(''); setEditing(null); setModal(type);
  };
  const editRecord = (type, record) => { setError(''); setEditing(record); setModal(type); };
  const saveRecord = async (type, payload, id) => {
    const endpoint = { account: 'accounts', asset: 'assets', transaction: 'transactions', price: 'prices', dividend: 'dividends', cashBalance: 'cash_balances', physicalAsset: 'physical_assets', valuation: 'physical_valuations', liability: 'liabilities', liabilityBalance: 'liability_balances', cashFlowCategory: 'cash_flow_categories', cashFlowTransaction: 'cash_flow_transactions' }[type];
    await api(id ? `${endpoint}/${id}` : endpoint, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); setModal(null); setEditing(null); await refresh();
  };
  const deleteRecord = async (endpoint, record) => {
    const label = { cash_flow_transactions: 'cash-flow entry', cash_flow_categories: 'category' }[endpoint] || endpoint.replace(/s$/, '');
    if (!window.confirm(`Remove this ${label}? Keep a backup if you may need to recover it.`)) return;
    try { await api(`${endpoint}/${record.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e.message); }
  };
  const updateSettings = async (next) => {
    if (next.fx_rate) { await api('fx_rates', { method: 'POST', body: JSON.stringify(next.fx_rate) }); await refresh(); return; }
    const merged = { ...settings, ...next };
    // Send only the changed keys: a full-state PUT could clobber settings another request updated server-side.
    setSettings(merged); await api('settings', { method: 'PUT', body: JSON.stringify(next) }); await refresh();
  };
  const exportCsv = () => {
    const header = ['Name', 'Ticker', 'Type', 'Currency', 'Quantity', 'Cost basis', 'Latest price', 'Price date', 'Price source', 'Current value', 'Unrealized gain'];
    const rows = data.summary.holdings.map((h) => [h.name, h.ticker, h.type, h.currency, h.quantity, h.cost_basis, h.price, h.price_date, h.price_source, h.current_value, h.unrealized_gain]);
    const blob = new Blob([[header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    download(blob, `jarvis-finance-portfolio-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const backup = async () => { const file = await api('backup'); download(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), `jarvis-finance-backup-${new Date().toISOString().slice(0, 10)}.json`); };
  useEffect(() => { const listener = () => backup(); window.addEventListener('backup-data', listener); return () => window.removeEventListener('backup-data', listener); }, [data]);
  const restore = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const backupFile = JSON.parse(await file.text());
      if (!backupFile?.data || !window.confirm('Restore this backup and replace the current records?')) return;
      await api('restore', { method: 'POST', body: JSON.stringify(backupFile) }); await refresh(); setError('Backup restored.');
    } catch (e) { setError(`Could not restore backup: ${e.message}`); }
    finally { event.target.value = ''; }
  };
  const content = {
    overview: <Overview data={data} homeValue={homeValue} settings={settings} navigate={navigate} revision={revision}/>,
    portfolio: <Portfolio data={data} onAdd={addRecord} onDelete={deleteRecord} onEdit={editRecord}/>,
    networth: <NetWorth data={data} settings={settings} homeValue={homeValue} onAdd={addRecord} onDelete={deleteRecord} onEdit={editRecord}/>,
    activity: <Activity data={data} onAdd={addRecord} onDelete={deleteRecord}/>,
    dividends: <Dividends data={data} onAdd={addRecord} onDelete={deleteRecord} onEdit={editRecord}/>,
    cashflow: <CashFlow data={data} onAdd={addRecord} onDelete={deleteRecord} onEdit={editRecord} navigate={navigate} revision={revision}/>,
    // The assistant page reads its own state from /api/assistant; `revision` only tells it that
    // the records it answers about were reloaded, so its status line stays honest.
    assistant: <Assistant navigate={navigate} revision={revision}/>,
    planning: <Planning settings={settings} setSettings={updateSettings} homeValue={homeValue}/>,
    settings: <Settings data={data} settings={settings} onHomeCurrency={updateSettings} onDelete={deleteRecord} onRefresh={refresh}/>,
  };
  return <div className="app-shell min-h-screen"><Sidebar page={page} navigate={navigate}/><main className="main-content"><header className="topbar flex items-center justify-between"><div><div className="eyebrow">PERSONAL WEALTH</div><h1>{titles[page]}</h1></div><div className="topbar-actions"><label className="topbar-currency" title="Home currency for totals, charts, and planning"><span>HOME</span><select aria-label="Home currency" value={settings.homeCurrency} onChange={(event) => updateSettings({ homeCurrency: event.target.value })}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label><button className="button button-quiet desktop-button" onClick={exportCsv}>Export CSV</button><button className="button button-primary" onClick={() => addRecord('transaction')}>＋ Add activity</button></div></header>
    <div className="notice"><span>✳</span> Planning tool only · Estimates are uncertain and are not financial advice.</div>
    {error && <div className="error-banner" role="status"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
    {busy ? <div className="loading-state">Opening your local portfolio…</div> : content[page]}
    <footer className="app-footer"><span>● Stored on this device</span><span>Manual prices are not live quotes</span><button className="mobile-export" onClick={exportCsv}>Export CSV</button></footer>
    </main><Modal type={modal} data={data} existing={editing} onClose={() => { setModal(null); setEditing(null); }} onSave={saveRecord}/><input id="restore-file" className="hidden-input" type="file" accept="application/json" onChange={restore}/></div>;
}

function download(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }
