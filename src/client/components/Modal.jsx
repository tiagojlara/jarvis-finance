import { useEffect, useState } from 'react';
import { api, currencies, today } from '../api.js';

const schemas = {
  account: [['name', 'Account name', 'text'], ['currency', 'Currency', 'select', currencies]],
  asset: [['name', 'Asset name', 'text'], ['ticker', 'Ticker / identifier', 'text'], ['marketstack_symbol', 'Marketstack symbol (optional)', 'text'], ['alphavantage_symbol', 'Alpha Vantage symbol (optional)', 'text'], ['alphavantage_currency', 'Alpha Vantage quote currency', 'select', ['', ...currencies]], ['type', 'Asset type', 'select', ['Stock', 'ETF', 'Mutual fund', 'Bond', 'Cash', 'Other']], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  transaction: [['kind', 'Activity type', 'select', ['buy', 'sell', 'deposit', 'withdrawal', 'fee']], ['account_id', 'Account', 'select', 'accounts'], ['asset_id', 'Asset (for buy/sell)', 'select', 'assets'], ['date', 'Date', 'date'], ['quantity', 'Quantity', 'number'], ['unit_price', 'Unit price', 'number'], ['amount', 'Cash flow amount', 'number'], ['fees', 'Fees', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  price: [['asset_id', 'Asset', 'select', 'assets'], ['date', 'Price date', 'date'], ['price', 'Price', 'number'], ['currency', 'Currency', 'select', currencies], ['source', 'Source', 'text']],
  dividend: [['asset_id', 'Asset', 'select', 'assets'], ['account_id', 'Account (optional)', 'select', 'accounts'], ['date', 'Payment date', 'date'], ['amount', 'Amount', 'number'], ['currency', 'Currency', 'select', currencies], ['shares', 'Shares held (optional)', 'number'], ['notes', 'Notes', 'textarea']],
  cashBalance: [['account_id', 'Account', 'select', 'accounts'], ['asset_id', 'Cash asset (optional)', 'select', 'cashAssets'], ['date', 'Balance date', 'date'], ['balance', 'Cash balance', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  physicalAsset: [['name', 'Asset name', 'text'], ['type', 'Category', 'select', ['Property', 'Vehicle', 'Other']], ['purchase_date', 'Purchase date (optional)', 'date'], ['purchase_price', 'Purchase price (optional)', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  valuation: [['physical_asset_id', 'Physical asset', 'select', 'physicalAssets'], ['date', 'Valuation date', 'date'], ['value', 'Estimated value', 'number'], ['currency', 'Currency', 'select', currencies], ['source', 'Source', 'text'], ['notes', 'Notes', 'textarea']],
  liability: [['name', 'Loan name', 'text'], ['type', 'Loan type', 'select', ['Mortgage', 'Vehicle finance', 'Personal loan', 'Other']], ['physical_asset_id', 'Linked physical asset (optional)', 'select', 'physicalAssets'], ['original_amount', 'Original amount', 'number'], ['currency', 'Currency', 'select', currencies], ['interest_rate', 'Interest rate % (optional)', 'number'], ['notes', 'Notes', 'textarea']],
  liabilityBalance: [['liability_id', 'Loan', 'select', 'liabilities'], ['date', 'Balance date', 'date'], ['balance', 'Remaining balance', 'number'], ['notes', 'Notes', 'textarea']],
};

export default function Modal({ type, data, existing, onClose, onSave, onRefresh }) {
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [symbolResults, setSymbolResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [fetchNote, setFetchNote] = useState('');
  useEffect(() => {
    if (!type) return;
    setError('');
    setSymbolResults([]);
    setFetchNote('');
    setForm({ date: today(), currency: data.accounts[0]?.currency || 'EUR', source: type === 'valuation' ? 'Manual estimate' : 'Manual', account_id: data.accounts[0]?.id || '', asset_id: type === 'cashBalance' ? '' : data.assets[0]?.id || '', physical_asset_id: data.physical_assets?.[0]?.id || '', liability_id: data.liabilities?.[0]?.id || '', kind: 'buy', type: type === 'physicalAsset' ? 'Property' : type === 'liability' ? 'Mortgage' : 'Stock', ...(existing || {}) });
  }, [type, existing?.id]);
  useEffect(() => { if (!type) return undefined; const onKey = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [type, onClose]);
  if (!type) return null;
  const options = (key) => key === 'accounts' ? data.accounts.map((x) => [x.id, x.name]) : key === 'cashAssets' ? [['', 'Account-level balance'], ...data.assets.filter((x) => x.type === 'Cash').map((x) => [x.id, x.name])] : key === 'physicalAssets' ? [['', 'Unlinked'], ...(data.physical_assets || []).map((x) => [x.id, x.name])] : key === 'liabilities' ? (data.liabilities || []).map((x) => [x.id, x.name]) : data.assets.map((x) => [x.id, x.name]);
  const fields = schemas[type] || [];
  const searchSymbols = async () => {
    const keywords = String(form.ticker || form.name || '').trim();
    if (!keywords) { setError('Enter a name or ticker before searching.'); return; }
    setError(''); setSearching(true);
    try { const result = await api(`market-data/search?keywords=${encodeURIComponent(keywords)}`); setSymbolResults(result.results || []); if (!result.results?.length) setError('No symbols found. Try a ticker or a shorter name.'); }
    catch (e) { setError(e.message); } finally { setSearching(false); }
  };
  // Dated provider fetch for the manual-price form: fills the inputs for review only.
  // Works for assets no longer held, so past gaps in price history can be repaired.
  const fetchPriceForDate = async () => {
    if (!form.asset_id) { setError('Choose an asset first.'); return; }
    setError(''); setFetchNote(''); setFetching(true);
    try {
      const quote = await api(`market-data/quote?assetId=${encodeURIComponent(form.asset_id)}&date=${encodeURIComponent(form.date || today())}`);
      setForm((current) => ({ ...current, price: String(quote.price), source: quote.source, date: quote.date }));
      const reason = quote.exact === false ? 'approximate: the free daily window ends ~5 months back, so the last weekly close before it was used'
        : quote.date !== form.date ? 'market was closed on your chosen date, previous close used' : '';
      setFetchNote(`Filled ${quote.price} ${quote.currency} from ${quote.symbol}'s close on ${quote.date}${reason ? ` (${reason})` : ''}; press Save record to store it. ${quote.requestsRemaining} of 25 provider requests remain today.`);
    } catch (e) { setError(e.message); } finally { setFetching(false); }
  };
  // One-call history backfill for this single asset: stores up to 3 years of weekly
  // closes straight into the database (unlike the dated fetch, which only fills the
  // form). Works for sold assets too; manual prices on the same dates are kept.
  const backfillAssetHistory = async () => {
    if (!form.asset_id) { setError('Choose an asset first.'); return; }
    setError(''); setFetchNote(''); setBackfilling(true);
    try {
      const result = await api('prices/backfill', { method: 'POST', body: JSON.stringify({ assetIds: [Number(form.asset_id)] }) });
      const row = result.results?.[0];
      setFetchNote(row
        ? `Stored ${row.stored} weekly close${row.stored === 1 ? '' : 's'} for ${row.name}${row.oldest ? ` back to ${row.oldest}` : ''}${row.manualKept ? `, kept ${row.manualKept} manual price${row.manualKept === 1 ? '' : 's'}` : ''}. ${result.requestsRemaining} of 25 provider requests remain today.`
        : result.message);
      await onRefresh?.();
    } catch (e) { setError(e.message); } finally { setBackfilling(false); }
  };
  const submit = async (event) => {
    event.preventDefault(); setError('');
    const payload = { ...form };
    for (const key of ['account_id', 'asset_id', 'physical_asset_id', 'liability_id', 'quantity', 'unit_price', 'amount', 'fees', 'price', 'shares', 'balance', 'value', 'purchase_price', 'original_amount', 'interest_rate']) if (payload[key] !== '' && payload[key] != null) payload[key] = Number(payload[key]);
    if (payload.physical_asset_id === '') payload.physical_asset_id = null;
    if (type === 'valuation') payload.currency = data.physical_assets.find((item) => item.id === payload.physical_asset_id)?.currency || payload.currency;
    if (type === 'liability') payload.physical_asset_id = payload.physical_asset_id || null;
    if (type === 'transaction' && ['buy', 'sell'].includes(payload.kind)) {
      const asset = data.assets.find((x) => x.id === payload.asset_id);
      if (!asset || !(payload.quantity > 0) || !(payload.unit_price > 0)) { setError('Choose an asset and enter a positive quantity and unit price.'); return; }
      payload.currency = asset.currency;
      const held = data.summary.holdings.find((x) => x.id === asset.id)?.quantity || 0;
      if (payload.kind === 'sell' && payload.quantity > held) { setError('Sale quantity exceeds shares held.'); return; }
    }
    if (['price', 'dividend'].includes(type)) payload.currency = data.assets.find((x) => x.id === payload.asset_id)?.currency;
    if (type === 'cashBalance') {
      const account = data.accounts.find((item) => item.id === payload.account_id);
      const cashAsset = data.assets.find((item) => item.id === payload.asset_id && item.type === 'Cash');
      if (!payload.asset_id) payload.asset_id = null;
      payload.currency = cashAsset?.currency || account?.currency;
    }
    try { await onSave(type, payload, existing?.id); } catch (e) { setError(e.message); }
  };
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><div className="eyebrow">PORTFOLIO RECORD</div><h2 id="modal-title">{existing ? 'Edit' : 'Add'} {type === 'cashBalance' ? 'cash balance' : type}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></header>{type === 'account' && <p className="panel-note">An account means a brokerage, pension, bank, or other investment account. It is not an app login.</p>}{type === 'cashBalance' && <p className="panel-note">Record a cash snapshot directly—no buy or sell activity is created. Leave the cash asset empty for the account’s cash balance, or choose a Cash asset. Use one method per account to avoid double-counting.</p>}{type === 'asset' && <><p className="panel-note">Provider symbols are separate from your ticker or ISIN. Alpha Vantage provides end-of-day prices; search sends the entered name or ticker to Alpha Vantage.</p><button type="button" className="button button-quiet" disabled={searching} onClick={searchSymbols}>{searching ? 'Searching…' : 'Search Alpha Vantage symbols'}</button>{symbolResults.length > 0 && <div className="allocation-currency">{symbolResults.map((item) => { const matches = currencies.includes(item.currency) && item.currency === (form.currency || existing?.currency || 'EUR'); return <button type="button" className="allocation-row text-action" disabled={!matches} key={`${item.symbol}-${item.region}`} onClick={() => { setForm({ ...form, alphavantage_symbol: item.symbol, alphavantage_currency: item.currency }); setSymbolResults([]); }}><span><b>{item.symbol}</b> · {item.name} · {item.region} · {item.currency}{!matches && ' · currency mismatch'}</span><small>{Math.round(item.matchScore * 100)}%</small></button>; })}</div>}</>}<form onSubmit={submit}><div className="form-grid">{fields.map(([key, label, kind, choices]) => {
    const vals = ['accounts', 'assets', 'cashAssets', 'physicalAssets', 'liabilities'].includes(choices) ? options(choices) : Array.isArray(choices) ? choices.map((v) => [v, v || 'Not selected']) : [];
    const required = ['name', 'date', 'price', 'value'].includes(key) || (key === 'physical_asset_id' && type === 'valuation') || (key === 'liability_id' && type === 'liabilityBalance') || (key === 'original_amount' && type === 'liability') || (key === 'balance' && ['cashBalance', 'liabilityBalance'].includes(type)) || (key === 'amount' && (type === 'dividend' || (type === 'transaction' && !['buy', 'sell'].includes(form.kind)))) || (key === 'quantity' && type === 'transaction' && ['buy', 'sell'].includes(form.kind)) || (key === 'unit_price' && type === 'transaction' && ['buy', 'sell'].includes(form.kind));
    return <label key={key} className={`field ${kind === 'textarea' ? 'field-wide' : ''}`}><span>{label}</span>{kind === 'select' ? <select required={key === 'account_id' || (key === 'physical_asset_id' && type === 'valuation') || (key === 'liability_id' && type === 'liabilityBalance') || (key === 'asset_id' && ['price', 'dividend'].includes(type))} value={form[key] ?? ''} onChange={(e) => { const value=e.target.value; const next={...form,[key]:value}; if(type==='cashBalance'&&key==='asset_id'){const asset=data.assets.find((item)=>String(item.id)===value);if(asset)next.currency=asset.currency;} if(type==='cashBalance'&&key==='account_id'&&!form.asset_id){const account=data.accounts.find((item)=>String(item.id)===value);if(account)next.currency=account.currency;} if(['valuation','liability'].includes(type)&&key==='physical_asset_id'&&value){const asset=data.physical_assets.find((item)=>String(item.id)===value);if(asset)next.currency=asset.currency;} setForm(next); }}>{vals.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select> : kind === 'textarea' ? <textarea value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/> : <input required={required} min={kind === 'number' ? '0' : undefined} step={kind === 'number' ? 'any' : undefined} type={kind} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/>}</label>;
  })}</div>{type === 'price' && <><div className="button-row"><button type="button" className="button button-quiet assumption-save" disabled={fetching || backfilling} onClick={fetchPriceForDate}>{fetching ? 'Fetching from Alpha Vantage…' : 'Fetch price for this date'}</button><button type="button" className="button button-quiet assumption-save" disabled={fetching || backfilling} onClick={backfillAssetHistory}>{backfilling ? 'Backfilling history…' : 'Backfill history (weekly closes)'}</button></div>{fetchNote && <p className="panel-note" role="status">{fetchNote}</p>}</>}{error && <p className="form-error">{error}</p>}<footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary">Save record</button></footer></form></section></div>;
}
