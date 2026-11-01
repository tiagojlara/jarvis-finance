import { useEffect, useState } from 'react';
import { api, currencies, today } from '../api.js';

const schemas = {
  account: [['name', 'Account name', 'text'], ['currency', 'Currency', 'select', currencies]],
  asset: [['name', 'Asset name', 'text'], ['ticker', 'Ticker / identifier', 'text'], ['marketstack_symbol', 'Marketstack symbol (optional)', 'text'], ['alphavantage_symbol', 'Alpha Vantage symbol (optional)', 'text'], ['alphavantage_currency', 'Alpha Vantage quote currency', 'select', ['', ...currencies]], ['type', 'Asset type', 'select', ['Stock', 'ETF', 'Mutual fund', 'Bond', 'Cash', 'Other']], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  transaction: [['kind', 'Activity type', 'select', ['buy', 'sell', 'deposit', 'withdrawal', 'fee']], ['account_id', 'Account', 'select', 'accounts'], ['asset_id', 'Asset (for buy/sell)', 'select', 'assets'], ['date', 'Date', 'date'], ['quantity', 'Quantity', 'number'], ['unit_price', 'Unit price', 'number'], ['amount', 'Cash flow amount', 'number'], ['fees', 'Fees', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  price: [['asset_id', 'Asset', 'select', 'assets'], ['date', 'Price date', 'date'], ['price', 'Price', 'number'], ['currency', 'Currency', 'select', currencies], ['source', 'Source', 'text']],
  dividend: [['asset_id', 'Asset', 'select', 'assets'], ['account_id', 'Account (optional)', 'select', 'accounts'], ['date', 'Payment date', 'date'], ['amount', 'Amount', 'number'], ['currency', 'Currency', 'select', currencies], ['shares', 'Shares held (optional)', 'number'], ['notes', 'Notes', 'textarea']],
};

export default function Modal({ type, data, existing, onClose, onSave }) {
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [symbolResults, setSymbolResults] = useState([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!type) return;
    setError('');
    setSymbolResults([]);
    setForm({ date: today(), currency: data.accounts[0]?.currency || 'EUR', source: 'Manual', account_id: data.accounts[0]?.id || '', asset_id: data.assets[0]?.id || '', kind: 'buy', type: 'Stock', ...(existing || {}) });
  }, [type, existing?.id]);
  useEffect(() => { if (!type) return undefined; const onKey = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [type, onClose]);
  if (!type) return null;
  const options = (key) => key === 'accounts' ? data.accounts.map((x) => [x.id, x.name]) : data.assets.map((x) => [x.id, x.name]);
  const fields = schemas[type] || [];
  const searchSymbols = async () => {
    const keywords = String(form.ticker || form.name || '').trim();
    if (!keywords) { setError('Enter a name or ticker before searching.'); return; }
    setError(''); setSearching(true);
    try { const result = await api(`market-data/search?keywords=${encodeURIComponent(keywords)}`); setSymbolResults(result.results || []); if (!result.results?.length) setError('No symbols found. Try a ticker or a shorter name.'); }
    catch (e) { setError(e.message); } finally { setSearching(false); }
  };
  const submit = async (event) => {
    event.preventDefault(); setError('');
    const payload = { ...form };
    for (const key of ['account_id', 'asset_id', 'quantity', 'unit_price', 'amount', 'fees', 'price', 'shares']) if (payload[key] !== '' && payload[key] != null) payload[key] = Number(payload[key]);
    if (type === 'transaction' && ['buy', 'sell'].includes(payload.kind)) {
      const asset = data.assets.find((x) => x.id === payload.asset_id);
      if (!asset || !(payload.quantity > 0) || !(payload.unit_price > 0)) { setError('Choose an asset and enter a positive quantity and unit price.'); return; }
      payload.currency = asset.currency;
      const held = data.summary.holdings.find((x) => x.id === asset.id)?.quantity || 0;
      if (payload.kind === 'sell' && payload.quantity > held) { setError('Sale quantity exceeds shares held.'); return; }
    }
    if (['price', 'dividend'].includes(type)) payload.currency = data.assets.find((x) => x.id === payload.asset_id)?.currency;
    try { await onSave(type, payload, existing?.id); } catch (e) { setError(e.message); }
  };
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><div className="eyebrow">PORTFOLIO RECORD</div><h2 id="modal-title">{existing ? 'Edit' : 'Add'} {type}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></header>{type === 'account' && <p className="panel-note">An account means a brokerage, pension, bank, or other investment account. It is not an app login.</p>}{type === 'asset' && <><p className="panel-note">Provider symbols are separate from your ticker or ISIN. Alpha Vantage provides end-of-day prices; search sends the entered name or ticker to Alpha Vantage.</p><button type="button" className="button button-quiet" disabled={searching} onClick={searchSymbols}>{searching ? 'Searching…' : 'Search Alpha Vantage symbols'}</button>{symbolResults.length > 0 && <div className="allocation-currency">{symbolResults.map((item) => { const matches = currencies.includes(item.currency) && item.currency === (form.currency || existing?.currency || 'EUR'); return <button type="button" className="allocation-row text-action" disabled={!matches} key={`${item.symbol}-${item.region}`} onClick={() => { setForm({ ...form, alphavantage_symbol: item.symbol, alphavantage_currency: item.currency }); setSymbolResults([]); }}><span><b>{item.symbol}</b> · {item.name} · {item.region} · {item.currency}{!matches && ' · currency mismatch'}</span><small>{Math.round(item.matchScore * 100)}%</small></button>; })}</div>}</>}<form onSubmit={submit}><div className="form-grid">{fields.map(([key, label, kind, choices]) => {
    const vals = choices === 'accounts' || choices === 'assets' ? options(choices) : Array.isArray(choices) ? choices.map((v) => [v, v || 'Not selected']) : [];
    const required = ['name', 'date', 'price'].includes(key) || (key === 'amount' && (type === 'dividend' || (type === 'transaction' && !['buy', 'sell'].includes(form.kind)))) || (key === 'quantity' && type === 'transaction' && ['buy', 'sell'].includes(form.kind)) || (key === 'unit_price' && type === 'transaction' && ['buy', 'sell'].includes(form.kind));
    return <label key={key} className={`field ${kind === 'textarea' ? 'field-wide' : ''}`}><span>{label}</span>{kind === 'select' ? <select required={key === 'account_id' || (key === 'asset_id' && ['price', 'dividend'].includes(type))} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>{vals.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select> : kind === 'textarea' ? <textarea value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/> : <input required={required} min={kind === 'number' ? '0' : undefined} step={kind === 'number' ? 'any' : undefined} type={kind} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/>}</label>;
  })}</div>{error && <p className="form-error">{error}</p>}<footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary">Save record</button></footer></form></section></div>;
}
