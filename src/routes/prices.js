const express = require('express');
const marketstack = require('../market-data/marketstack');
const alphavantage = require('../market-data/alphavantage');
const { isHeld } = require('./portfolio');

const ALPHA_VANTAGE_DAILY_LIMIT = 25;
const ALPHA_VANTAGE_MIN_INTERVAL_MS = 12000;
// Backfill stores at most this much history per asset, even if the provider returns more.
const MAX_BACKFILL_YEARS = 3;

// Ticker fallback is shared by both providers: a plain equity-style ticker, never an ISIN.
const tickerFallback = (asset) => (
  /^([A-Za-z][A-Za-z0-9._-]{0,19})$/.test(asset.ticker || '') && !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(asset.ticker) ? asset.ticker.trim() : ''
);
const marketSymbolFor = (asset) => String(asset.marketstack_symbol || asset.price_symbol || tickerFallback(asset)).trim();
const alphaSymbolFor = (asset) => String(asset.alphavantage_symbol || '').trim();

function createPricesRouter({
  db,
  fetchLatestPrices = marketstack.fetchLatestPrices,
  fetchLatestAlphaPrice = alphavantage.fetchLatestPrice,
  fetchAlphaPriceOnDate = alphavantage.fetchPriceOnDate,
  fetchAlphaWeeklyHistory = alphavantage.fetchWeeklyHistory,
  searchAlphaSymbols = alphavantage.searchSymbols,
} = {}) {
  const router = express.Router();

  // Local bookkeeping of Alpha Vantage quota and pacing, persisted in the settings table.
  const readSetting = (key, fallback) => {
    try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? null) ?? fallback; }
    catch { return fallback; }
  };
  const writeSetting = (key, value) => {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const alphaRequestsToday = () => {
    const usage = readSetting('alphavantage_usage', {});
    return usage.date === today() ? Number(usage.count) || 0 : 0;
  };
  const consumeAlphaVantageRequest = () => {
    const count = alphaRequestsToday();
    if (count >= ALPHA_VANTAGE_DAILY_LIMIT) return false;
    writeSetting('alphavantage_usage', { date: today(), count: count + 1 });
    return true;
  };

  // Serialize Alpha Vantage calls with at least 12 seconds between them (free-plan pacing).
  let alphaVantageQueue = Promise.resolve();
  const waitForAlphaVantageSlot = () => {
    const operation = alphaVantageQueue.then(async () => {
      const last = Number(readSetting('alphavantage_last_request_at', 0)) || 0;
      const delay = Math.max(0, ALPHA_VANTAGE_MIN_INTERVAL_MS - (Date.now() - last));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      writeSetting('alphavantage_last_request_at', Date.now());
    });
    alphaVantageQueue = operation.catch(() => {});
    return operation;
  };

  const alphaKey = () => process.env.ALPHA_VANTAGE_API_KEY;
  const activeProvider = () => process.env.MARKET_DATA_PROVIDER || 'alphavantage';

  router.get('/api/market-data/status', (req, res) => {
    const assets = db.prepare('SELECT * FROM assets').all();
    const provider = activeProvider();
    const configured = provider === 'alphavantage' ? Boolean(alphaKey()) : provider === 'marketstack' ? Boolean(process.env.MARKETSTACK_API_KEY) : false;
    const requestsToday = alphaRequestsToday();
    res.json({
      provider,
      configured,
      assets: assets.length,
      withSymbol: assets.filter(provider === 'alphavantage' ? alphaSymbolFor : marketSymbolFor).length,
      requestsToday,
      requestsRemaining: Math.max(0, ALPHA_VANTAGE_DAILY_LIMIT - requestsToday),
    });
  });

  router.get('/api/market-data/search', async (req, res) => {
    const keywords = String(req.query.keywords || '').trim().slice(0, 100);
    if (!keywords) return res.status(400).json({ error: 'Enter an asset name or ticker to search.' });
    if (activeProvider() !== 'alphavantage') return res.status(400).json({ error: 'Symbol search is available when Alpha Vantage is the selected provider.' });
    const key = alphaKey();
    if (!key) return res.status(400).json({ error: 'Alpha Vantage is not configured. Add ALPHA_VANTAGE_API_KEY to the local .env file and restart the app.' });
    if (!consumeAlphaVantageRequest()) return res.status(429).json({ error: 'Alpha Vantage daily request limit reached. Try again tomorrow.' });
    try {
      await waitForAlphaVantageSlot();
      res.json({ results: await searchAlphaSymbols(keywords, key) });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.publicMessage || 'Alpha Vantage symbol search failed.' });
    }
  });

  // Read-only quote for one asset on a chosen (past) date: fills the manual-price form for review,
  // it never writes. Assets with no open position are still allowed — this is how historical
  // gaps on sold positions get repaired, one quota request at a time.
  router.get('/api/market-data/quote', async (req, res) => {
    const assetId = Number(req.query.assetId);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today();
    if (!Number.isInteger(assetId) || assetId < 1) return res.status(400).json({ error: 'Choose an asset first.' });
    if (date > today()) return res.status(400).json({ error: 'Cannot fetch a price for a future date.' });
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    if (activeProvider() !== 'alphavantage') return res.status(400).json({ error: 'Dated fetch needs Alpha Vantage; Marketstack supports latest prices only. Enter the price manually for now.' });
    const symbol = alphaSymbolFor(asset);
    if (!symbol) return res.status(400).json({ error: 'Add an Alpha Vantage symbol to this asset first: edit the asset and search for its listing.' });
    const key = alphaKey();
    if (!key) return res.status(400).json({ error: 'Alpha Vantage is not configured. Add ALPHA_VANTAGE_API_KEY to the local .env file and restart the app.' });
    try {
      // The fetcher gates (quota) and paces (12s) each provider call it makes: one request for
      // recent dates, a second weekly request when the free daily window doesn't reach back far enough.
      const quote = await fetchAlphaPriceOnDate(symbol, date, key, { gate: consumeAlphaVantageRequest, pace: waitForAlphaVantageSlot });
      if (!quote) return res.status(502).json({ error: `Alpha Vantage has no price history for ${symbol} on or before ${date}.` });
      res.json({
        price: Number(quote.close),
        date: quote.date,
        symbol,
        currency: asset.alphavantage_currency || asset.currency,
        exact: quote.exact !== false,
        source: quote.exact === false ? 'Alpha Vantage · weekly close' : 'Alpha Vantage · end-of-day',
        requestsRemaining: Math.max(0, ALPHA_VANTAGE_DAILY_LIMIT - alphaRequestsToday()),
      });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.publicMessage || 'Alpha Vantage could not fetch that price.' });
    }
  });

  // Bulk import of dated fund NAVs (e.g. the CSV downloaded from an Avanza fund page).
  // Mutual funds are out of reach for the stock providers; this path needs no provider and
  // no quota. Manual prices for the same date always win; existing provider rows get updated.
  router.post('/api/prices/import', (req, res) => {
    const assetId = Number(req.body?.assetId);
    const asset = db.prepare('SELECT currency FROM assets WHERE id=?').get(assetId);
    if (!asset) return res.status(404).json({ error: 'Choose an existing asset to import into.' });
    const incoming = Array.isArray(req.body?.prices) ? req.body.prices : null;
    if (!incoming?.length) return res.status(400).json({ error: 'Nothing to import. Load a CSV with dated values first.' });
    if (incoming.length > 15000) return res.status(400).json({ error: 'Import too large (max 15000 rows).' });
    const source = 'Avanza · NAV';
    const findManual = db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source='Manual' LIMIT 1");
    const findProvider = db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source!='Manual' LIMIT 1");
    const update = db.prepare('UPDATE prices SET price=@price,currency=@currency,source=@source WHERE id=@id');
    const insert = db.prepare('INSERT INTO prices(asset_id,date,price,currency,source) VALUES(@asset_id,@date,@price,@currency,@source)');
    let stored = 0;
    let manualKept = 0;
    let rejected = 0;
    const run = db.transaction(() => {
      for (const row of incoming) {
        const price = Number(row?.price);
        const date = String(row?.date || '');
        if (!(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { rejected += 1; continue; }
        if (findManual.get(assetId, date)) { manualKept += 1; continue; }
        const existing = findProvider.get(assetId, date);
        if (existing) update.run({ price, currency: asset.currency, source, id: existing.id });
        else insert.run({ asset_id: assetId, date, price, currency: asset.currency, source });
        stored += 1;
      }
    });
    run();
    res.json({ ok: true, stored, manualKept, rejected, source });
  });

  // History backfill: ONE TIME_SERIES_WEEKLY call per asset stores up to 3 years of
  // dated weekly closes (the free tier serves ~100 weeks per call, about two years).
  // Like the full sync, the default run only spends the allowance on assets with open
  // positions; explicitly requested assetIds are honored as-is so a sold asset's
  // history can still be repaired. Manual prices are never overwritten; existing
  // provider rows for the same date are updated in place.
  router.post('/api/prices/backfill', async (req, res) => {
    if (activeProvider() !== 'alphavantage') return res.status(400).json({ error: 'History backfill needs Alpha Vantage; Marketstack serves latest prices only.' });
    const key = alphaKey();
    if (!key) return res.status(400).json({ error: 'Alpha Vantage is not configured. Add ALPHA_VANTAGE_API_KEY to the local .env file and restart the app.' });
    const requestedIds = Array.isArray(req.body?.assetIds) ? [...new Set(req.body.assetIds.map(Number).filter(Number.isInteger))] : null;
    if (requestedIds && (!requestedIds.length || requestedIds.length > ALPHA_VANTAGE_DAILY_LIMIT)) return res.status(400).json({ error: `Choose between 1 and ${ALPHA_VANTAGE_DAILY_LIMIT} assets to backfill.` });
    const allAssets = requestedIds
      ? db.prepare(`SELECT * FROM assets WHERE id IN (${requestedIds.map(() => '?').join(',')})`).all(...requestedIds)
      : db.prepare('SELECT * FROM assets ORDER BY id').all();
    const openAssets = requestedIds ? allAssets : allAssets.filter((asset) => isHeld(db, asset.id));
    const noPositionSkipped = allAssets.length - openAssets.length;
    // The weekly payload carries no currency, so assets whose provider quote currency
    // differs from their record currency cannot be stored safely (same guard as the sync).
    const currencySkipped = openAssets.filter((asset) => alphaSymbolFor(asset) && (asset.alphavantage_currency || asset.currency) !== asset.currency).map((asset) => asset.name);
    const targets = openAssets.filter((asset) => alphaSymbolFor(asset) && (asset.alphavantage_currency || asset.currency) === asset.currency);
    if (!targets.length) {
      return res.json({
        ok: true, results: [], noPositionSkipped, skippedCurrency: currencySkipped, quotaSkipped: 0,
        message: `Nothing to backfill: no eligible asset has a usable Alpha Vantage symbol${noPositionSkipped ? ` (${noPositionSkipped} asset${noPositionSkipped === 1 ? '' : 's'} with no open position skipped)` : ''}.`,
      });
    }
    const allowance = Math.max(0, ALPHA_VANTAGE_DAILY_LIMIT - alphaRequestsToday());
    const selected = targets.slice(0, allowance);
    const quotaSkipped = targets.length - selected.length;
    const cutoff = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - MAX_BACKFILL_YEARS); return d.toISOString().slice(0, 10); })();
    const source = 'Alpha Vantage · weekly close';
    const findManual = db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source='Manual' LIMIT 1");
    const findProvider = db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source!='Manual' LIMIT 1");
    const update = db.prepare('UPDATE prices SET price=@price,currency=@currency,source=@source WHERE id=@id');
    const insert = db.prepare('INSERT INTO prices(asset_id,date,price,currency,source) VALUES(@asset_id,@date,@price,@currency,@source)');
    const results = [];
    let providerError = null;
    for (const asset of selected) {
      try {
        const history = await fetchAlphaWeeklyHistory(alphaSymbolFor(asset), key, { gate: consumeAlphaVantageRequest, pace: waitForAlphaVantageSlot });
        let stored = 0;
        let manualKept = 0;
        let trimmed = 0;
        let oldest = null;
        const save = db.transaction(() => {
          for (const point of history) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(point.date)) || !(Number(point.close) > 0) || point.date < cutoff || point.date > today()) { trimmed += 1; continue; }
            if (findManual.get(asset.id, point.date)) { manualKept += 1; continue; }
            if (!oldest || point.date < oldest) oldest = point.date;
            const existing = findProvider.get(asset.id, point.date);
            const payload = { asset_id: asset.id, date: point.date, price: Number(point.close), currency: asset.currency, source };
            if (existing) update.run({ ...payload, id: existing.id }); else insert.run(payload);
            stored += 1;
          }
        });
        save();
        results.push({ assetId: asset.id, name: asset.name, symbol: alphaSymbolFor(asset), stored, manualKept, trimmed, oldest });
      } catch (error) {
        providerError = error;
        break;
      }
    }
    if (providerError && !results.length) return res.status(providerError.status || 502).json({ error: providerError.publicMessage || 'Alpha Vantage could not fetch history. No prices were saved.' });
    const totalStored = results.reduce((sum, row) => sum + row.stored, 0);
    const totalManual = results.reduce((sum, row) => sum + row.manualKept, 0);
    res.json({
      ok: true,
      results,
      noPositionSkipped,
      skippedCurrency: currencySkipped,
      quotaSkipped,
      requestsRemaining: Math.max(0, ALPHA_VANTAGE_DAILY_LIMIT - alphaRequestsToday()),
      message: `Backfilled ${totalStored} dated weekly closes across ${results.length} asset${results.length === 1 ? '' : 's'}`
        + `${totalManual ? `; kept ${totalManual} manual price${totalManual === 1 ? '' : 's'} unchanged` : ''}`
        + `${noPositionSkipped ? `; skipped ${noPositionSkipped} asset${noPositionSkipped === 1 ? '' : 's'} with no open position` : ''}`
        + `${quotaSkipped ? `; ${quotaSkipped} eligible asset${quotaSkipped === 1 ? '' : 's'} skipped due to the daily request limit` : ''}`
        + `${currencySkipped.length ? `; skipped ${currencySkipped.join(', ')} (provider quote currency differs from the asset currency)` : ''}`
        + `${providerError ? `; stopped early: ${providerError.publicMessage || 'provider error'}` : ''}.`,
    });
  });

  router.post('/api/prices/sync', async (req, res) => {
    const provider = activeProvider();
    if (!['marketstack', 'alphavantage'].includes(provider)) return res.status(400).json({ error: 'Configured market-data provider is not supported.' });
    const apiKey = provider === 'alphavantage' ? alphaKey() : process.env.MARKETSTACK_API_KEY;
    if (!apiKey) return res.status(400).json({ error: `${provider === 'alphavantage' ? 'Alpha Vantage' : 'Marketstack'} is not configured. Add ${provider === 'alphavantage' ? 'ALPHA_VANTAGE_API_KEY' : 'MARKETSTACK_API_KEY'} to the local .env file and restart the app.` });

    const requestedIds = Array.isArray(req.body?.assetIds) ? [...new Set(req.body.assetIds.map(Number).filter(Number.isInteger))] : null;
    if (requestedIds && (!requestedIds.length || requestedIds.length > 100)) return res.status(400).json({ error: 'Choose between 1 and 100 assets to update.' });
    const allAssets = requestedIds
      ? db.prepare(`SELECT * FROM assets WHERE id IN (${requestedIds.map(() => '?').join(',')})`).all(...requestedIds)
      : db.prepare('SELECT * FROM assets ORDER BY id').all();
    // A full sync only spends the daily provider allowance on assets with open positions;
    // fully sold assets need no valuation anymore. Explicitly selected ids are honored as-is.
    const openAssets = requestedIds ? allAssets : allAssets.filter((asset) => isHeld(db, asset.id));
    const noPositionSkipped = allAssets.length - openAssets.length;
    const skipNote = noPositionSkipped ? ` ${noPositionSkipped} asset${noPositionSkipped === 1 ? '' : 's'} with no open positions were skipped.` : '';

    let candidates = openAssets
      .map((asset) => ({ asset, symbol: provider === 'alphavantage' ? alphaSymbolFor(asset) : marketSymbolFor(asset) }))
      .filter((item) => item.symbol);
    if (!candidates.length) return res.json({ ok: true, stored: 0, skipped: allAssets.length, skippedNoPosition: noPositionSkipped, unmatched: [], message: `No assets have a ${provider === 'alphavantage' ? 'Alpha Vantage' : 'Marketstack'} symbol. Edit an asset to add its price lookup symbol.${skipNote}` });

    try {
      let rows;
      let syncWarning = null;
      if (provider === 'alphavantage') {
        const allowance = Math.max(0, ALPHA_VANTAGE_DAILY_LIMIT - alphaRequestsToday());
        const selected = candidates.slice(0, allowance);
        candidates = selected;
        rows = [];
        let processed = 0;
        let providerError = null;
        for (const item of selected) {
          if (!consumeAlphaVantageRequest()) break;
          processed += 1;
          try {
            await waitForAlphaVantageSlot();
            const quote = await fetchLatestAlphaPrice(item.symbol, apiKey);
            if (quote) rows.push({ ...quote, price_currency: item.asset.alphavantage_currency || item.asset.currency });
          } catch (error) {
            providerError = error;
            break;
          }
        }
        candidates = selected.slice(0, processed);
        if (providerError && !rows.length) {
          return res.status(providerError.status || 502).json({ error: providerError.publicMessage || 'Alpha Vantage could not update prices. No new prices were saved.' });
        }
        if (providerError) syncWarning = providerError.publicMessage || 'Alpha Vantage stopped responding.';
      } else {
        rows = await fetchLatestPrices(candidates.map((item) => item.symbol), apiKey);
      }

      const bySymbol = new Map(rows.map((row) => [String(row.symbol || '').toUpperCase(), row]));
      const source = provider === 'alphavantage' ? 'Alpha Vantage · end-of-day' : 'Marketstack · end-of-day';
      const update = db.prepare('UPDATE prices SET price=@price,currency=@currency,source=@source WHERE id=@id');
      const insert = db.prepare('INSERT INTO prices(asset_id,date,price,currency,source) VALUES(@asset_id,@date,@price,@currency,@source)');
      let stored = 0;
      let manualKept = 0;
      const unmatched = [];
      const save = db.transaction(() => {
        for (const { asset, symbol } of candidates) {
          const quote = bySymbol.get(symbol.toUpperCase());
          if (!quote || !(Number(quote.close) > 0) || !/^\d{4}-\d{2}-\d{2}/.test(String(quote.date || ''))) { unmatched.push(symbol); continue; }
          const quoteCurrency = String(provider === 'alphavantage' ? asset.alphavantage_currency : (quote.price_currency || asset.currency)).toUpperCase();
          if (quoteCurrency !== asset.currency) { unmatched.push(`${symbol} (${quoteCurrency}; asset uses ${asset.currency})`); continue; }
          const date = String(quote.date).slice(0, 10);
          const manual = db.prepare("SELECT id FROM prices WHERE asset_id=? AND date=? AND source='Manual' LIMIT 1").get(asset.id, date);
          if (manual) { manualKept += 1; continue; }
          const previous = db.prepare('SELECT id FROM prices WHERE asset_id=? AND date=? AND source=? LIMIT 1').get(asset.id, date, source);
          const payload = { asset_id: asset.id, date, price: Number(quote.close), currency: asset.currency, source };
          if (previous) update.run({ ...payload, id: previous.id }); else insert.run(payload);
          stored += 1;
        }
      });
      save();

      const quotaSkipped = provider === 'alphavantage' && !syncWarning ? Math.max(0, openAssets.filter((asset) => alphaSymbolFor(asset)).length - candidates.length) : 0;
      res.json({
        ok: true,
        stored,
        requested: candidates.length,
        unmatched,
        manualKept,
        skippedNoPosition: noPositionSkipped,
        source,
        requestsRemaining: provider === 'alphavantage' ? Math.max(0, ALPHA_VANTAGE_DAILY_LIMIT - alphaRequestsToday()) : null,
        message: `Saved ${stored} dated end-of-day prices. ${unmatched.length} symbols had no matching quote${quotaSkipped ? `; ${quotaSkipped} skipped due to the daily request limit` : ''}${manualKept ? `; kept ${manualKept} manual price${manualKept === 1 ? '' : 's'} unchanged` : ''}${noPositionSkipped ? `; skipped ${noPositionSkipped} asset${noPositionSkipped === 1 ? '' : 's'} with no open position` : ''}${syncWarning ? `; stopped early: ${syncWarning}` : ''}.`,
      });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.publicMessage || 'Marketstack request failed. Check the API key, plan quota, and ticker symbols.' });
    }
  });

  return router;
}

module.exports = { createPricesRouter };
