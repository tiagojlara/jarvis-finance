import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, escapeCsv, getHomeValue } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import Modal from './components/Modal.jsx';
import { Activity, Overview, Planning, Portfolio, Settings } from './components/Views.jsx';

const initialSettings = { homeCurrency: 'EUR', fxProvider: 'frankfurter', currentAge: 35, retirementAge: 65, monthlyContribution: 500, monthlyIncome: 2500, oneTimeContribution: 0, monthlyWithdrawal: 0, inflation: .02, scenarios: [.03, .05, .07] };
const titles = { overview: 'Overview', portfolio: 'Portfolio', activity: 'Activity', planning: 'Retirement plan', settings: 'Settings & backup' };
const emptyData = { accounts: [], assets: [], transactions: [], prices: [], dividends: [], fx_rates: [], summary: { holdings: [], valueByCurrency: {}, costByCurrency: {}, dividendIncomeByCurrency: {} } };

export default function App() {
  const [page, setPage] = useState('overview'); const [data, setData] = useState(emptyData); const [settings, setSettings] = useState(initialSettings);
  const [modal, setModal] = useState(null); const [editing, setEditing] = useState(null); const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [summary, accounts, assets, transactions, prices, dividends, fx_rates, saved] = await Promise.all([
        'summary', 'accounts', 'assets', 'transactions', 'prices', 'dividends', 'fx_rates', 'settings',
      ].map((path) => api(path)));
      setData({ accounts, assets, transactions, prices, dividends, fx_rates, summary: summary.summary });
      setSettings({ ...initialSettings, ...saved }); setError('');
    } catch (e) { setError(`Could not reach the local database: ${e.message}`); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const homeValue = useMemo(() => getHomeValue(data.summary.holdings, data.fx_rates, settings.homeCurrency), [data, settings.homeCurrency]);
  const addRecord = (type) => {
    if (type !== 'account' && type !== 'asset' && data.accounts.length === 0) { setError(''); setPage('portfolio'); setEditing(null); setModal('account'); return; }
    if (['price', 'dividend'].includes(type) && data.assets.length === 0) { setError(''); setPage('portfolio'); setEditing(null); setModal('asset'); return; }
    setError(''); setEditing(null); setModal(type);
  };
  const editRecord = (type, record) => { setError(''); setEditing(record); setModal(type); };
  const saveRecord = async (type, payload, id) => {
    const endpoint = { account: 'accounts', asset: 'assets', transaction: 'transactions', price: 'prices', dividend: 'dividends' }[type];
    await api(id ? `${endpoint}/${id}` : endpoint, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); setModal(null); setEditing(null); await refresh();
  };
  const deleteRecord = async (endpoint, record) => {
    if (!window.confirm(`Remove this ${endpoint.replace(/s$/, '')}? Keep a backup if you may need to recover it.`)) return;
    try { await api(`${endpoint}/${record.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e.message); }
  };
  const updateSettings = async (next) => {
    if (next.fx_rate) { await api('fx_rates', { method: 'POST', body: JSON.stringify(next.fx_rate) }); await refresh(); return; }
    const merged = { ...settings, ...next };
    setSettings(merged); await api('settings', { method: 'PUT', body: JSON.stringify(merged) }); await refresh();
  };
  const exportCsv = () => {
    const header = ['Name', 'Ticker', 'Type', 'Currency', 'Quantity', 'Cost basis', 'Latest price', 'Price date', 'Price source', 'Current value', 'Unrealized gain'];
    const rows = data.summary.holdings.map((h) => [h.name, h.ticker, h.type, h.currency, h.quantity, h.cost_basis, h.price, h.price_date, h.price_source, h.current_value, h.unrealized_gain]);
    const blob = new Blob([[header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    download(blob, `northstar-portfolio-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const backup = async () => { const file = await api('backup'); download(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), `northstar-backup-${new Date().toISOString().slice(0, 10)}.json`); };
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
    overview: <Overview data={data} homeValue={homeValue} settings={settings} navigate={setPage} onHomeCurrency={(homeCurrency) => updateSettings({ homeCurrency })}/>,
    portfolio: <Portfolio data={data} onAdd={addRecord} onDelete={deleteRecord} onEdit={editRecord}/>,
    activity: <Activity data={data} onAdd={addRecord} onDelete={deleteRecord}/>,
    planning: <Planning settings={settings} setSettings={updateSettings} homeValue={homeValue}/>,
    settings: <Settings data={data} settings={settings} onHomeCurrency={updateSettings} onDelete={deleteRecord} onRefresh={refresh}/>,
  };
  return <div className="app-shell min-h-screen"><Sidebar page={page} navigate={setPage}/><main className="main-content"><header className="topbar flex items-center justify-between"><div><div className="eyebrow">PERSONAL WEALTH</div><h1>{titles[page]}</h1></div><div className="topbar-actions"><button className="button button-quiet desktop-button" onClick={exportCsv}>Export CSV</button><button className="button button-primary" onClick={() => addRecord('transaction')}>＋ Add activity</button></div></header>
    <div className="notice"><span>✳</span> Planning tool only · Estimates are uncertain and are not financial advice.</div>
    {error && <div className="error-banner" role="status"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
    {busy ? <div className="loading-state">Opening your local portfolio…</div> : content[page]}
    <footer className="app-footer"><span>● Stored on this device</span><span>Manual prices are not live quotes</span><button className="mobile-export" onClick={exportCsv}>Export CSV</button></footer>
    </main><Modal type={modal} data={data} existing={editing} onClose={() => { setModal(null); setEditing(null); }} onSave={saveRecord}/><input id="restore-file" className="hidden-input" type="file" accept="application/json" onChange={restore}/></div>;
}

function download(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }
