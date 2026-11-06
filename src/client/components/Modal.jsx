import { useEffect, useState } from 'react';
import { currencies, today } from '../api.js';

const schemas = {
  account: [['name', 'Account name', 'text'], ['currency', 'Currency', 'select', currencies]],
  asset: [['name', 'Asset name', 'text'], ['ticker', 'Ticker / identifier', 'text'], ['type', 'Asset type', 'select', ['Stock', 'ETF', 'Mutual fund', 'Bond', 'Cash', 'Other']], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  transaction: [['kind', 'Activity type', 'select', ['buy', 'sell', 'deposit', 'withdrawal', 'fee']], ['account_id', 'Account', 'select', 'accounts'], ['asset_id', 'Asset (for buy/sell)', 'select', 'assets'], ['date', 'Date', 'date'], ['quantity', 'Quantity', 'number'], ['unit_price', 'Unit price', 'number'], ['amount', 'Cash flow amount', 'number'], ['fees', 'Fees', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  price: [['asset_id', 'Asset', 'select', 'assets'], ['date', 'Price date', 'date'], ['price', 'Price', 'number'], ['currency', 'Currency', 'select', currencies], ['source', 'Source', 'text']],
  dividend: [['asset_id', 'Asset', 'select', 'assets'], ['account_id', 'Account (optional)', 'select', 'accounts'], ['date', 'Payment date', 'date'], ['amount', 'Amount', 'number'], ['currency', 'Currency', 'select', currencies], ['shares', 'Shares held (optional)', 'number'], ['notes', 'Notes', 'textarea']],
  cashBalance: [['account_id', 'Account', 'select', 'accounts'], ['asset_id', 'Cash asset (optional)', 'select', 'cashAssets'], ['date', 'Balance date', 'date'], ['balance', 'Cash balance', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  physicalAsset: [['name', 'Asset name', 'text'], ['type', 'Category', 'select', ['Property', 'Vehicle', 'Other']], ['purchase_date', 'Purchase date (optional)', 'date'], ['purchase_price', 'Purchase price (optional)', 'number'], ['currency', 'Currency', 'select', currencies], ['notes', 'Notes', 'textarea']],
  valuation: [['physical_asset_id', 'Physical asset', 'select', 'physicalAssets'], ['date', 'Valuation date', 'date'], ['value', 'Estimated value', 'number'], ['currency', 'Currency', 'select', currencies], ['source', 'Source', 'text'], ['notes', 'Notes', 'textarea']],
  liability: [['name', 'Loan name', 'text'], ['type', 'Loan type', 'select', ['Mortgage', 'Vehicle finance', 'Personal loan', 'Other']], ['physical_asset_id', 'Linked physical asset (optional)', 'select', 'physicalAssets'], ['original_amount', 'Original amount', 'number'], ['currency', 'Currency', 'select', currencies], ['interest_rate', 'Interest rate % (optional)', 'number'], ['notes', 'Notes', 'textarea']],
  liabilityBalance: [['liability_id', 'Loan', 'select', 'liabilities'], ['date', 'Balance date', 'date'], ['balance', 'Remaining balance', 'number'], ['notes', 'Notes', 'textarea']],
  cashFlowCategory: [['name', 'Category name', 'text'], ['kind', 'Type', 'select', ['income', 'expense']], ['active', 'Status', 'select', 'cashFlowActive']],
  cashFlowTransaction: [['kind', 'Type', 'select', ['income', 'expense']], ['account_id', 'Account', 'select', 'accounts'], ['category_id', 'Category', 'select', 'cashFlowCategories'], ['date', 'Date', 'date'], ['amount', 'Amount', 'number'], ['payee', 'Payee / merchant (optional)', 'text'], ['description', 'Description (optional)', 'textarea']],
};

export default function Modal({ type, data, existing, onClose, onSave }) {
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  useEffect(() => {
    if (!type) return;
    setError('');
    setForm({ date: today(), currency: data.accounts[0]?.currency || 'EUR', source: type === 'valuation' ? 'Manual estimate' : 'Manual', account_id: data.accounts[0]?.id || '', category_id: '', asset_id: type === 'cashBalance' ? '' : data.assets[0]?.id || '', physical_asset_id: data.physical_assets?.[0]?.id || '', liability_id: data.liabilities?.[0]?.id || '', kind: type === 'cashFlowTransaction' ? 'expense' : 'buy', type: type === 'physicalAsset' ? 'Property' : type === 'liability' ? 'Mortgage' : 'Stock', active: 1, ...(existing || {}) });
  }, [type, existing?.id]);
  useEffect(() => { if (!type) return undefined; const onKey = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [type, onClose]);
  if (!type) return null;
  const options = (key) => key === 'accounts' ? data.accounts.map((x) => [x.id, x.name]) : key === 'cashAssets' ? [['', 'Account-level balance'], ...data.assets.filter((x) => x.type === 'Cash').map((x) => [x.id, x.name])] : key === 'physicalAssets' ? [['', 'Unlinked'], ...(data.physical_assets || []).map((x) => [x.id, x.name])] : key === 'liabilities' ? (data.liabilities || []).map((x) => [x.id, x.name]) : key === 'cashFlowCategories' ? [['', 'Choose a category'], ...(data.cash_flow_categories || []).filter((x) => x.kind === form.kind && (x.active || x.id === form.category_id)).map((x) => [x.id, x.name])] : key === 'cashFlowActive' ? [[1, 'Active'], [0, 'Inactive']] : data.assets.map((x) => [x.id, x.name]);
  const fields = schemas[type] || [];
  const submit = async (event) => {
    event.preventDefault(); setError('');
    const payload = { ...form };
    for (const key of ['account_id', 'asset_id', 'physical_asset_id', 'liability_id', 'category_id', 'quantity', 'unit_price', 'amount', 'fees', 'price', 'shares', 'balance', 'value', 'purchase_price', 'original_amount', 'interest_rate', 'active']) if (payload[key] !== '' && payload[key] != null) payload[key] = Number(payload[key]);
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
    if (type === 'cashFlowTransaction') {
      const account = data.accounts.find((item) => item.id === payload.account_id);
      if (!account) { setError('Choose an account — create one first if the list is empty.'); return; }
      if (!payload.category_id) { setError('Choose a category that matches this entry type.'); return; }
      if (!(Number(payload.amount) > 0)) { setError('Enter an amount greater than zero.'); return; }
      payload.currency = account.currency;
    }
    try { await onSave(type, payload, existing?.id); } catch (e) { setError(e.message); }
  };
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><div className="eyebrow">PORTFOLIO RECORD</div><h2 id="modal-title">{existing ? 'Edit' : 'Add'} {({ cashBalance: 'cash balance', cashFlowTransaction: 'cash-flow entry', cashFlowCategory: 'category' })[type] || type}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></header>{type === 'account' && <p className="panel-note">An account means a brokerage, pension, bank, or other investment account. It is not an app login.</p>}{type === 'cashBalance' && <p className="panel-note">Record a cash snapshot directly—no buy or sell activity is created. Leave the cash asset empty for the account’s cash balance, or choose a Cash asset. Use one method per account to avoid double-counting.</p>}{type === 'asset' && <p className="panel-note">Tickers and ISINs are identifiers you choose for your own records; prices for this asset are recorded manually, dated by you or an MCP agent.</p>}{type === 'cashFlowCategory' && <p className="panel-note">Income and spending categories are kept separate. Once a category has entries, deactivate it instead of deleting it so history stays categorized.</p>}{type === 'cashFlowTransaction' && <p className="panel-note">This records money in or out on a chosen date, in one of your accounts — the same accounts the portfolio uses. It never creates portfolio activity, and it never changes holdings, dividends, or net worth. The currency follows the selected account.</p>}<form onSubmit={submit}><div className="form-grid">{fields.map(([key, label, kind, choices]) => {
    const vals = ['accounts', 'assets', 'cashAssets', 'physicalAssets', 'liabilities', 'cashFlowCategories', 'cashFlowActive'].includes(choices) ? options(choices) : Array.isArray(choices) ? choices.map((v) => [v, v || 'Not selected']) : [];
    const required = ['name', 'date', 'price', 'value'].includes(key) || (key === 'physical_asset_id' && type === 'valuation') || (key === 'liability_id' && type === 'liabilityBalance') || (key === 'original_amount' && type === 'liability') || (key === 'balance' && ['cashBalance', 'liabilityBalance'].includes(type)) || (key === 'amount' && (type === 'dividend' || (type === 'transaction' && !['buy', 'sell'].includes(form.kind)))) || (key === 'quantity' && type === 'transaction' && ['buy', 'sell'].includes(form.kind)) || (key === 'unit_price' && type === 'transaction' && ['buy', 'sell'].includes(form.kind)) || (key === 'amount' && type === 'cashFlowTransaction');
    return <label key={key} className={`field ${kind === 'textarea' ? 'field-wide' : ''}`}><span>{label}</span>{kind === 'select' ? <select required={key === 'account_id' || (key === 'physical_asset_id' && type === 'valuation') || (key === 'liability_id' && type === 'liabilityBalance') || (key === 'asset_id' && ['price', 'dividend'].includes(type)) || (key === 'category_id' && type === 'cashFlowTransaction')} value={form[key] ?? ''} onChange={(e) => { const value=e.target.value; const next={...form,[key]:value}; if(type==='cashBalance'&&key==='asset_id'){const asset=data.assets.find((item)=>String(item.id)===value);if(asset)next.currency=asset.currency;} if(type==='cashBalance'&&key==='account_id'&&!form.asset_id){const account=data.accounts.find((item)=>String(item.id)===value);if(account)next.currency=account.currency;} if(['valuation','liability'].includes(type)&&key==='physical_asset_id'&&value){const asset=data.physical_assets.find((item)=>String(item.id)===value);if(asset)next.currency=asset.currency;} if(type==='cashFlowTransaction'&&key==='kind')next.category_id=''; if(type==='cashFlowTransaction'&&key==='account_id'){const account=data.accounts.find((item)=>String(item.id)===value);if(account)next.currency=account.currency;} setForm(next); }}>{vals.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select> : kind === 'textarea' ? <textarea value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/> : <input required={required} min={kind === 'number' ? '0' : undefined} step={kind === 'number' ? 'any' : undefined} type={kind} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/>}</label>;
  })}</div>{error && <p className="form-error">{error}</p>}<footer className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary">Save record</button></footer></form></section></div>;
}
