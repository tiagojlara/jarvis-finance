function summarize({accounts,assets,transactions,prices,dividends,cash_balances=[]}) {
  const priceMap=new Map(prices.map(p=>[p.asset_id,p])); const holdings=new Map();
  const sorted=[...transactions].sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);
  for(const t of sorted){if(!t.asset_id||!['buy','sell'].includes(t.kind))continue;const h=holdings.get(t.asset_id)||{quantity:0,cost:0,realized:0};
    if(t.kind==='buy'){h.quantity+=Number(t.quantity);h.cost+=Number(t.quantity)*Number(t.unit_price)+Number(t.fees||0);}
    else {const q=Math.min(Number(t.quantity),h.quantity);const avg=h.quantity?h.cost/h.quantity:0;h.realized+=q*(Number(t.unit_price)-avg)-Number(t.fees||0);h.cost-=q*avg;h.quantity-=q;}
    holdings.set(t.asset_id,h);
  }
  const rows=assets.map(a=>{const h=holdings.get(a.id)||{quantity:0,cost:0,realized:0};const p=priceMap.get(a.id);return {...a,quantity:h.quantity,cost_basis:h.cost,realized_gain:h.realized,price:p?.price??null,price_date:p?.date??null,price_source:p?.source??null,current_value:p?h.quantity*p.price:null,unrealized_gain:p?h.quantity*p.price-h.cost:null};});
  const accountsById=new Map(accounts.map((account)=>[account.id,account]));
  const assetsById=new Map(assets.map((asset)=>[asset.id,asset]));
  const latestCash=new Map();
  for(const row of cash_balances){const key=`${row.account_id}:${row.asset_id??'account'}`;const prior=latestCash.get(key);if(!prior||row.date>prior.date||(row.date===prior.date&&row.id>prior.id))latestCash.set(key,row);}
  for(const balance of latestCash.values()){
    const account=accountsById.get(balance.account_id);const asset=balance.asset_id?assetsById.get(balance.asset_id):null;
    rows.push({id:`cash-balance-${balance.id}`,cash_balance_id:balance.id,is_cash_balance:true,account_id:balance.account_id,asset_id:balance.asset_id,name:asset?`${asset.name} · ${account?.name||'Account'}`:`Cash · ${account?.name||'Account'}`,ticker:'CASH',type:'Cash',currency:balance.currency,quantity:Number(balance.balance),cost_basis:Number(balance.balance),realized_gain:0,price:1,price_date:balance.date,price_source:'Manual cash balance',current_value:Number(balance.balance),unrealized_gain:0});
  }
  const valueByCurrency={},costByCurrency={};for(const r of rows){if(r.current_value!==null)valueByCurrency[r.currency]=(valueByCurrency[r.currency]||0)+r.current_value;costByCurrency[r.currency]=(costByCurrency[r.currency]||0)+r.cost_basis;}
  const divByCurrency={};for(const d of dividends)divByCurrency[d.currency]=(divByCurrency[d.currency]||0)+Number(d.amount);
  return {holdings:rows,valueByCurrency,costByCurrency,dividendIncomeByCurrency:divByCurrency,totalAssets:rows.length,accountCount:accounts.length};
}
// Retirement projection lives in src/projection.mjs (shared with the browser and tests).
module.exports={summarize};
