const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const calc = require('./src/calculations');
const { fetchLatestPrices } = require('./src/market-data/marketstack');
const alphaVantage = require('./src/market-data/alphavantage');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const app = express();
app.use(express.json({ limit: '20mb' }));
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'portfolio.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, ticker TEXT, type TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), asset_id INTEGER REFERENCES assets(id), kind TEXT NOT NULL, date TEXT NOT NULL, quantity REAL DEFAULT 0, unit_price REAL DEFAULT 0, amount REAL DEFAULT 0, fees REAL DEFAULT 0, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS prices(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), date TEXT NOT NULL, price REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), source TEXT NOT NULL DEFAULT 'Manual');
CREATE TABLE IF NOT EXISTS dividends(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), account_id INTEGER REFERENCES accounts(id), date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), shares REAL, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS fx_rates(id INTEGER PRIMARY KEY, date TEXT NOT NULL, base TEXT NOT NULL CHECK(base IN ('EUR','SEK','USD','BRL')), quote TEXT NOT NULL CHECK(quote IN ('EUR','SEK','USD','BRL')), rate REAL NOT NULL CHECK(rate > 0), source TEXT NOT NULL DEFAULT 'Manual', UNIQUE(date,base,quote));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
if (!db.prepare('PRAGMA table_info(assets)').all().some((column) => column.name === 'price_symbol')) db.exec("ALTER TABLE assets ADD COLUMN price_symbol TEXT NOT NULL DEFAULT ''");
for (const [column, type] of [['marketstack_symbol', "TEXT NOT NULL DEFAULT ''"], ['alphavantage_symbol', "TEXT NOT NULL DEFAULT ''"], ['alphavantage_currency', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!db.prepare('PRAGMA table_info(assets)').all().some((item) => item.name === column)) db.exec(`ALTER TABLE assets ADD COLUMN ${column} ${type}`);
}
db.exec("UPDATE assets SET marketstack_symbol=price_symbol WHERE marketstack_symbol='' AND price_symbol!=''");
if (!db.prepare('PRAGMA table_info(fx_rates)').all().some((column) => column.name === 'source')) db.exec("ALTER TABLE fx_rates ADD COLUMN source TEXT NOT NULL DEFAULT 'Manual'");
const allowed = new Set(['accounts','assets','transactions','prices','dividends','fx_rates']);
const tables = { accounts:['name','currency'], assets:['name','ticker','type','currency','notes','price_symbol','marketstack_symbol','alphavantage_symbol','alphavantage_currency'], transactions:['account_id','asset_id','kind','date','quantity','unit_price','amount','fees','currency','notes'], prices:['asset_id','date','price','currency','source'], dividends:['asset_id','account_id','date','amount','currency','shares','notes'], fx_rates:['date','base','quote','rate','source'] };
const tickerFallback = asset => /^([A-Za-z][A-Za-z0-9._-]{0,19})$/.test(asset.ticker||'')&&!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(asset.ticker) ? asset.ticker.trim() : '';
const marketSymbolFor = asset => String(asset.marketstack_symbol||asset.price_symbol||tickerFallback(asset)).trim();
const alphaSymbolFor = asset => String(asset.alphavantage_symbol||'').trim();
app.get('/api/:table', (req,res)=>{ if(req.params.table==='summary'){const accounts=db.prepare('SELECT * FROM accounts').all();const assets=db.prepare('SELECT * FROM assets').all();const transactions=db.prepare('SELECT * FROM transactions ORDER BY date,id').all();const prices=db.prepare('SELECT p.* FROM prices p JOIN (SELECT asset_id,MAX(date) d FROM prices GROUP BY asset_id) x ON x.asset_id=p.asset_id AND x.d=p.date').all();const dividends=db.prepare('SELECT * FROM dividends').all();return res.json({accounts,assets,transactions,prices,dividends,summary:calc.summarize({accounts,assets,transactions,prices,dividends})});} if(req.params.table==='settings')return res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,JSON.parse(x.value)]))); if(!allowed.has(req.params.table))return res.sendStatus(404); const rows=db.prepare(`SELECT * FROM ${req.params.table} ORDER BY id DESC`).all(); res.json(rows); });
app.post('/api/:table',(req,res)=>{const t=req.params.table, fields=tables[t]; if(!fields)return res.sendStatus(404); const data=req.body||{}; if(t==='transactions'){if(!['buy','sell','deposit','withdrawal','fee'].includes(data.kind))return res.status(400).json({error:'Invalid transaction type'});if(['buy','sell'].includes(data.kind)){if(!(data.quantity>0)||!(data.unit_price>0)||!data.asset_id)return res.status(400).json({error:'Purchases and sales need a positive quantity, price, and asset'});const a=db.prepare('SELECT currency FROM assets WHERE id=?').get(data.asset_id);if(!a||a.currency!==data.currency)return res.status(400).json({error:'Transaction currency must match the asset currency'});}else if(!(data.amount>0))return res.status(400).json({error:'Cash flows need a positive amount'});}if(t==='prices'){const a=db.prepare('SELECT currency FROM assets WHERE id=?').get(data.asset_id);if(!a||a.currency!==data.currency)return res.status(400).json({error:'Price currency must match the asset currency'});if(!(data.price>0))return res.status(400).json({error:'Price must be positive'});}if(t==='dividends'&&!(data.amount>0))return res.status(400).json({error:'Dividend amount must be positive'});const keys=fields.filter(k=>data[k]!==undefined); if(!keys.length)return res.status(400).json({error:'No valid fields supplied'}); try{const info=db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(k=>`@${k}`).join(',')})`).run(data);res.json(db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(info.lastInsertRowid));}catch(e){res.status(400).json({error:e.message});}});
app.put('/api/:table/:id',(req,res)=>{const t=req.params.table, fields=tables[t],id=req.params.id;if(!fields)return res.sendStatus(404);if(t==='assets'&&req.body.currency){const prior=db.prepare('SELECT currency FROM assets WHERE id=?').get(id);if(prior&&prior.currency!==req.body.currency&&['transactions','prices','dividends'].some(table=>db.prepare(`SELECT 1 FROM ${table} WHERE asset_id=? LIMIT 1`).get(id)))return res.status(400).json({error:'Currency cannot be changed after transactions, prices, or dividends have been recorded for this asset.'});}const keys=fields.filter(k=>req.body[k]!==undefined);if(!keys.length)return res.status(400).json({error:'No valid fields supplied'});try{db.prepare(`UPDATE ${t} SET ${keys.map(k=>`${k}=@${k}`).join(',')} WHERE id=@id`).run({...req.body,id});res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.delete('/api/:table/:id',(req,res)=>{const {table,id}=req.params;if(!allowed.has(table))return res.sendStatus(404);if(table==='accounts'&&db.prepare('SELECT 1 FROM transactions WHERE account_id=? LIMIT 1').get(id))return res.status(400).json({error:'This account has transaction history. Remove its transactions first, or keep the account for historical records.'});if(table==='assets'&&['transactions','prices','dividends'].some(t=>db.prepare(`SELECT 1 FROM ${t} WHERE asset_id=? LIMIT 1`).get(id)))return res.status(400).json({error:'This asset has related records. Remove its transactions, prices, and dividends first, or keep it for historical records.'});try{db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/summary',(req,res)=>{const accounts=db.prepare('SELECT * FROM accounts').all();const assets=db.prepare('SELECT * FROM assets').all();const transactions=db.prepare('SELECT * FROM transactions ORDER BY date,id').all();const prices=db.prepare('SELECT p.* FROM prices p JOIN (SELECT asset_id,MAX(date) d FROM prices GROUP BY asset_id) x ON x.asset_id=p.asset_id AND x.d=p.date').all();const dividends=db.prepare('SELECT * FROM dividends').all();res.json({accounts,assets,transactions,prices,dividends,summary:calc.summarize({accounts,assets,transactions,prices,dividends})});});
app.get('/api/backup',(req,res)=>{res.json({version:1,exportedAt:new Date().toISOString(),data:{...Object.fromEntries([...allowed].map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all()])),settings:db.prepare('SELECT * FROM settings').all()}});});
app.post('/api/restore',(req,res)=>{const b=req.body?.data;if(!b)return res.status(400).json({error:'Invalid backup'});const restore=db.transaction(()=>{for(const t of allowed){db.prepare(`DELETE FROM ${t}`).run();for(const row of (b[t]||[])){const keys=tables[t].filter(k=>row[k]!==undefined);const cols=['id',...keys];const vals={id:row.id};for(const k of keys)vals[k]=row[k];db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(k=>`@${k}`).join(',')})`).run(vals);}}db.prepare('DELETE FROM settings').run();for(const row of (b.settings||[]))db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(row.key,row.value);});try{restore();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/fx/sync',async(req,res)=>{const provider=req.body?.provider||'frankfurter';if(!['frankfurter','ecb'].includes(provider))return res.status(400).json({error:'Unsupported FX provider'});const activityDates=db.prepare("SELECT date FROM transactions UNION SELECT date FROM prices UNION SELECT date FROM dividends ORDER BY date").all().map(row=>row.date);if(!activityDates.length)return res.json({ok:true,stored:0,dates:0,message:'Add transactions, prices, or dividends first.'});const from=activityDates[0],to=new Date().toISOString().slice(0,10),url=new URL('https://api.frankfurter.dev/v2/rates');url.searchParams.set('base','EUR');url.searchParams.set('quotes','SEK,USD,BRL');url.searchParams.set('from',from);url.searchParams.set('to',to);if(provider==='ecb')url.searchParams.set('providers','ecb');try{const response=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!response.ok)return res.status(502).json({error:`Frankfurter returned HTTP ${response.status}`});const rows=await response.json();if(!Array.isArray(rows))return res.status(502).json({error:'Unexpected response from Frankfurter'});const source=provider==='ecb'?'Frankfurter · ECB':'Frankfurter';const insert=db.prepare("INSERT INTO fx_rates(date,base,quote,rate,source) VALUES(@date,@base,@quote,@rate,@source) ON CONFLICT(date,base,quote) DO UPDATE SET rate=excluded.rate,source=excluded.source WHERE fx_rates.source!='Manual' AND fx_rates.source!=excluded.source");const save=db.transaction(data=>{let stored=0;for(const row of data){if(row.base!=='EUR'||!['SEK','USD','BRL'].includes(row.quote)||!(Number(row.rate)>0))continue;stored+=insert.run({...row,source}).changes;}return stored;});const stored=save(rows);res.json({ok:true,stored,dates:new Set(rows.map(row=>row.date)).size,from,to,source});}catch(error){res.status(502).json({error:`Could not fetch historical FX rates: ${error.message}`});}});
app.get('/api/market-data/status',(req,res)=>{
  const assets=db.prepare('SELECT * FROM assets').all();
  const provider=process.env.MARKET_DATA_PROVIDER||'alphavantage';
  const usage=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alphavantage_usage'").get()?.value||'{}');
  const today=new Date().toISOString().slice(0,10), requestsToday=usage.date===today?Number(usage.count)||0:0;
  const configured=provider==='alphavantage'?Boolean(process.env.ALPHA_VANTAGE_API_KEY):provider==='marketstack'?Boolean(process.env.MARKETSTACK_API_KEY):false;
  res.json({provider,configured,assets:assets.length,withSymbol:assets.filter(provider==='alphavantage'?alphaSymbolFor:marketSymbolFor).length,requestsToday,requestsRemaining:Math.max(0,25-requestsToday)});
});
const consumeAlphaVantageRequest=()=>{
  const today=new Date().toISOString().slice(0,10), row=db.prepare("SELECT value FROM settings WHERE key='alphavantage_usage'").get();
  const usage=JSON.parse(row?.value||'{}'), count=usage.date===today?Number(usage.count)||0:0;
  if(count>=25)return false;
  db.prepare("INSERT INTO settings(key,value) VALUES('alphavantage_usage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({date:today,count:count+1}));
  return true;
};
let alphaVantageQueue=Promise.resolve();
const waitForAlphaVantageSlot=()=>{
  const operation=alphaVantageQueue.then(async()=>{
    const last=Number(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alphavantage_last_request_at'").get()?.value||'0'))||0;
    const delay=Math.max(0,12000-(Date.now()-last));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    db.prepare("INSERT INTO settings(key,value) VALUES('alphavantage_last_request_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(Date.now()));
  });
  alphaVantageQueue=operation.catch(()=>{});
  return operation;
};
app.get('/api/market-data/search',async(req,res)=>{
  const keywords=String(req.query.keywords||'').trim().slice(0,100);
  if(!keywords)return res.status(400).json({error:'Enter an asset name or ticker to search.'});
  if((process.env.MARKET_DATA_PROVIDER||'alphavantage')!=='alphavantage')return res.status(400).json({error:'Symbol search is available when Alpha Vantage is the selected provider.'});
  const key=process.env.ALPHA_VANTAGE_API_KEY;
  if(!key)return res.status(400).json({error:'Alpha Vantage is not configured. Add ALPHA_VANTAGE_API_KEY to the local .env file and restart the app.'});
  if(!consumeAlphaVantageRequest())return res.status(429).json({error:'Alpha Vantage daily request limit reached. Try again tomorrow.'});
  try{await waitForAlphaVantageSlot();res.json({results:await alphaVantage.searchSymbols(keywords,key)});}catch(error){res.status(error.status||502).json({error:error.publicMessage||'Alpha Vantage symbol search failed.'});}
});
app.post('/api/prices/sync',async(req,res)=>{
  const provider=process.env.MARKET_DATA_PROVIDER||'alphavantage';
  if(!['marketstack','alphavantage'].includes(provider))return res.status(400).json({error:'Configured market-data provider is not supported.'});
  const apiKey=provider==='alphavantage'?process.env.ALPHA_VANTAGE_API_KEY:process.env.MARKETSTACK_API_KEY;
  if(!apiKey)return res.status(400).json({error:`${provider==='alphavantage'?'Alpha Vantage':'Marketstack'} is not configured. Add ${provider==='alphavantage'?'ALPHA_VANTAGE_API_KEY':'MARKETSTACK_API_KEY'} to the local .env file and restart the app.`});
  const requestedIds=Array.isArray(req.body?.assetIds)?[...new Set(req.body.assetIds.map(Number).filter(Number.isInteger))]:null;
  if(requestedIds&&(!requestedIds.length||requestedIds.length>100))return res.status(400).json({error:'Choose between 1 and 100 assets to update.'});
  const assets=requestedIds
    ? db.prepare(`SELECT * FROM assets WHERE id IN (${requestedIds.map(()=>'?').join(',')})`).all(...requestedIds)
    : db.prepare('SELECT * FROM assets ORDER BY id').all();
  let candidates=assets.map(asset=>({asset,symbol:provider==='alphavantage'?alphaSymbolFor(asset):marketSymbolFor(asset)})).filter(item=>item.symbol);
  if(!candidates.length)return res.json({ok:true,stored:0,skipped:assets.length,unmatched:[],message:`No assets have a ${provider==='alphavantage'?'Alpha Vantage':'Marketstack'} symbol. Edit an asset to add its price lookup symbol.`});
  try{
    let rows;
    if(provider==='alphavantage'){
      const remaining=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alphavantage_usage'").get()?.value||'{}');
      const today=new Date().toISOString().slice(0,10),used=remaining.date===today?Number(remaining.count)||0:0;
      const allowance=Math.max(0,25-used), selected=candidates.slice(0,allowance);
      candidates=selected; rows=[];
      let processed=0,providerError=null;
      for(const item of selected){
        if(!consumeAlphaVantageRequest())break;
        processed++;
        try{await waitForAlphaVantageSlot();const quote=await alphaVantage.fetchLatestPrice(item.symbol,apiKey);if(quote)rows.push({...quote,price_currency:item.asset.alphavantage_currency||item.asset.currency});}
        catch(error){providerError=error;break;}
      }
      candidates=selected.slice(0,processed);
      if(providerError&&!rows.length){
        const status=providerError.status||502;
        return res.status(status).json({error:providerError.publicMessage||'Alpha Vantage could not update prices. No new prices were saved.'});
      }
      if(providerError)req.alphaVantageSyncWarning=providerError.publicMessage||'Alpha Vantage stopped responding.';
    }else rows=await fetchLatestPrices(candidates.map(item=>item.symbol),apiKey);
    const bySymbol=new Map(rows.map(row=>[String(row.symbol||'').toUpperCase(),row]));
    const source=provider==='alphavantage'?'Alpha Vantage · end-of-day':'Marketstack · end-of-day';
    const update=db.prepare("UPDATE prices SET price=@price,currency=@currency,source=@source WHERE id=@id");
    const insert=db.prepare("INSERT INTO prices(asset_id,date,price,currency,source) VALUES(@asset_id,@date,@price,@currency,@source)");
    let stored=0,manualKept=0;
    const unmatched=[];
    const save=db.transaction(()=>{
      for(const {asset,symbol} of candidates){
        const quote=bySymbol.get(symbol.toUpperCase());
        if(!quote||!(Number(quote.close)>0)||!/^\d{4}-\d{2}-\d{2}/.test(String(quote.date||''))){unmatched.push(symbol);continue;}
        const quoteCurrency=String(provider==='alphavantage'?asset.alphavantage_currency:(quote.price_currency||asset.currency)).toUpperCase();
        if(quoteCurrency!==asset.currency){unmatched.push(`${symbol} (${quoteCurrency}; asset uses ${asset.currency})`);continue;}
        const date=String(quote.date).slice(0,10);
        const manual=db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source='Manual' LIMIT 1").get(asset.id,date);
        if(manual){manualKept++;continue;}
        const previous=db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source=? LIMIT 1").get(asset.id,date,source);
        const payload={asset_id:asset.id,date,price:Number(quote.close),currency:asset.currency,source};
        if(previous)update.run({...payload,id:previous.id});else insert.run(payload);
        stored++;
      }
    });
    save();
    const quotaSkipped=provider==='alphavantage'&&!req.alphaVantageSyncWarning?Math.max(0,assets.filter(asset=>alphaSymbolFor(asset)).length-candidates.length):0;
    res.json({ok:true,stored,requested:candidates.length,unmatched,manualKept,source,requestsRemaining:provider==='alphavantage'?Math.max(0,25-(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='alphavantage_usage'").get()?.value||'{}').count||0)):null,message:`Saved ${stored} dated end-of-day prices. ${unmatched.length} symbols had no matching quote${quotaSkipped?`; ${quotaSkipped} skipped due to the daily request limit`:''}${manualKept?`; kept ${manualKept} manual price${manualKept===1?'':'s'} unchanged`:''}${req.alphaVantageSyncWarning?`; stopped early: ${req.alphaVantageSyncWarning}`:''}.`});
  }catch(error){
    const status=error.status||502;
    res.status(status).json({error:error.publicMessage||'Marketstack request failed. Check the API key, plan quota, and ticker symbols.'});
  }
});
app.get('/api/settings',(req,res)=>res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,JSON.parse(x.value)]))));
app.put('/api/settings',(req,res)=>{const s=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');for(const [k,v]of Object.entries(req.body))s.run(k,JSON.stringify(v));res.json({ok:true});});
app.use(express.static(path.join(__dirname,'dist')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));
const port=Number(process.env.PORT||3000);app.listen(port,'127.0.0.1',()=>console.log(`Portfolio planner running at http://localhost:${port}`));
