const express = require('express');
const calc = require('../calculations');
const { TABLE_FIELDS, TABLE_ORDER, CHILD_FIRST } = require('../db');
const { fetchFxRates } = require('../market-data/frankfurter');

const ALLOWED_TABLES = new Set(TABLE_ORDER);

// Legacy quota bookkeeping keys left in existing databases from the removed Alpha Vantage
// integration. The browser loads and re-saves the settings blob, so these stay hidden and
// ignored: no dead provider state round-trips into the UI or gets reset by stale writes.
const SERVER_ONLY_SETTINGS = new Set(['alphavantage_usage', 'alphavantage_last_request_at']);

// One row per asset: the newest date, preferring Manual over provider rows on the same date.
const LATEST_PRICES_SQL = `SELECT p.* FROM prices p WHERE p.id = (
  SELECT q.id FROM prices q WHERE q.asset_id = p.asset_id
  ORDER BY q.date DESC, (q.source = 'Manual') DESC, q.id ASC LIMIT 1
)`;

const EPSILON = 1e-9;

function heldQuantity(db, assetId, excludeTransactionId = null) {
  const base = "SELECT kind, quantity FROM transactions WHERE asset_id = ? AND kind IN ('buy','sell')";
  const rows = excludeTransactionId === null
    ? db.prepare(base).all(assetId)
    : db.prepare(`${base} AND id != ?`).all(assetId, excludeTransactionId);
  return rows.reduce((total, row) => total + (row.kind === 'buy' ? 1 : -1) * Number(row.quantity || 0), 0);
}

function cashBalanceError(db, data, excludeId = null) {
  const accountId = Number(data.account_id);
  const assetId = data.asset_id == null || data.asset_id === '' ? null : Number(data.asset_id);
  if (!Number.isInteger(accountId) || !(Number(data.balance) >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) {
    return 'Choose an account and date, and enter a non-negative balance.';
  }
  const account = db.prepare('SELECT currency FROM accounts WHERE id=?').get(accountId);
  if (!account) return 'Choose an existing account.';
  if (assetId !== null) {
    const asset = db.prepare("SELECT currency,type FROM assets WHERE id=?").get(assetId);
    if (!asset || asset.type !== 'Cash') return 'A linked asset must have the Cash asset type.';
    if (asset.currency !== data.currency) return 'Cash balance currency must match the linked cash asset currency.';
    if (db.prepare('SELECT 1 FROM cash_balances WHERE account_id=? AND asset_id IS NULL AND id!=COALESCE(?, -1) LIMIT 1').get(accountId, excludeId)) {
      return 'This account already uses account-level cash balances. Remove those entries before switching to a cash asset.';
    }
  } else {
    if (account.currency !== data.currency) return 'Cash balance currency must match the account currency.';
    if (db.prepare('SELECT 1 FROM cash_balances WHERE account_id=? AND asset_id IS NOT NULL AND id!=COALESCE(?, -1) LIMIT 1').get(accountId, excludeId)) {
      return 'This account already tracks cash as an asset. Remove those entries before switching to account-level balances.';
    }
  }
  return null;
}

function readSummaryData(db) {
  return {
    accounts: db.prepare('SELECT * FROM accounts').all(),
    assets: db.prepare('SELECT * FROM assets').all(),
    transactions: db.prepare('SELECT * FROM transactions ORDER BY date, id').all(),
    prices: db.prepare(LATEST_PRICES_SQL).all(),
    dividends: db.prepare('SELECT * FROM dividends').all(),
    cash_balances: db.prepare('SELECT * FROM cash_balances ORDER BY date,id').all(),
  };
}

function summaryResponse(db) {
  const payload = readSummaryData(db);
  return { ...payload, summary: calc.summarize(payload) };
}

function createPortfolioRouter({ db, fetchFxRates: fetchFx = fetchFxRates } = {}) {
  const router = express.Router();

  // Registered before /api/:table so these exact paths win.
  router.get('/api/summary', (req, res) => res.json(summaryResponse(db)));

  router.get('/api/settings', (req, res) => {
    res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all()
      .filter((x) => !SERVER_ONLY_SETTINGS.has(x.key))
      .map((x) => [x.key, JSON.parse(x.value)])));
  });

  router.put('/api/settings', (req, res) => {
    const save = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [key, value] of Object.entries(req.body || {})) {
      if (SERVER_ONLY_SETTINGS.has(key)) continue;
      save.run(key, JSON.stringify(value));
    }
    res.json({ ok: true });
  });

  // Backup/restore are single-segment paths like /api/:table, so they must be registered first.
  router.get('/api/backup', (req, res) => {
    const data = Object.fromEntries(TABLE_ORDER.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    data.settings = db.prepare('SELECT * FROM settings').all();
    res.json({ version: 1, exportedAt: new Date().toISOString(), data });
  });

  router.post('/api/restore', (req, res) => {
    const backup = req.body?.data;
    if (!backup) return res.status(400).json({ error: 'Invalid backup' });
    const restore = db.transaction(() => {
      // Delete children before parents and insert parents before children so foreign keys hold.
      for (const table of CHILD_FIRST) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of TABLE_ORDER) {
        for (const row of (backup[table] || [])) {
          const keys = TABLE_FIELDS[table].filter((k) => row[k] !== undefined);
          const columns = ['id', ...keys];
          const values = { id: row.id };
          for (const key of keys) values[key] = row[key];
          db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((k) => `@${k}`).join(',')})`).run(values);
        }
      }
      db.prepare('DELETE FROM settings').run();
      for (const row of (backup.settings || [])) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(row.key, row.value);
    });
    try {
      restore();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/api/:table', (req, res) => {
    if (!ALLOWED_TABLES.has(req.params.table)) return res.sendStatus(404);
    res.json(db.prepare(`SELECT * FROM ${req.params.table} ORDER BY id DESC`).all());
  });

  router.post('/api/:table', (req, res) => {
    const table = req.params.table;
    const fields = TABLE_FIELDS[table];
    if (!fields) return res.sendStatus(404);
    const data = req.body || {};

    if (table === 'transactions') {
      if (!['buy', 'sell', 'deposit', 'withdrawal', 'fee'].includes(data.kind)) {
        return res.status(400).json({ error: 'Invalid transaction type' });
      }
      if (['buy', 'sell'].includes(data.kind)) {
        if (!(data.quantity > 0) || !(data.unit_price > 0) || !data.asset_id) {
          return res.status(400).json({ error: 'Purchases and sales need a positive quantity, price, and asset' });
        }
        const asset = db.prepare('SELECT currency FROM assets WHERE id=?').get(data.asset_id);
        if (!asset || asset.currency !== data.currency) {
          return res.status(400).json({ error: 'Transaction currency must match the asset currency' });
        }
        if (data.kind === 'sell' && Number(data.quantity) > heldQuantity(db, data.asset_id) + EPSILON) {
          return res.status(400).json({ error: 'Sale quantity exceeds shares held' });
        }
      } else if (!(data.amount > 0)) {
        return res.status(400).json({ error: 'Cash flows need a positive amount' });
      }
    }

    if (table === 'prices') {
      const asset = db.prepare('SELECT currency FROM assets WHERE id=?').get(data.asset_id);
      if (!asset || asset.currency !== data.currency) {
        return res.status(400).json({ error: 'Price currency must match the asset currency' });
      }
      if (!(data.price > 0)) return res.status(400).json({ error: 'Price must be positive' });
    }

    if (table === 'dividends') {
      if (!(data.amount > 0)) {
        return res.status(400).json({ error: 'Dividend amount must be positive' });
      }
      const asset = db.prepare('SELECT currency FROM assets WHERE id=?').get(data.asset_id);
      if (!asset || asset.currency !== data.currency) {
        return res.status(400).json({ error: 'Dividend currency must match the asset currency' });
      }
    }

    if (table === 'cash_balances') {
      const error = cashBalanceError(db, data);
      if (error) return res.status(400).json({ error });
    }

    if (table === 'physical_valuations') {
      const asset = db.prepare('SELECT currency FROM physical_assets WHERE id=?').get(data.physical_asset_id);
      if (!asset || asset.currency !== data.currency || !(Number(data.value) >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) return res.status(400).json({ error: 'Choose an asset, use its currency, and enter a valid date and non-negative value.' });
    }
    if (table === 'liabilities' && data.physical_asset_id) {
      const asset = db.prepare('SELECT currency FROM physical_assets WHERE id=?').get(data.physical_asset_id);
      if (!asset || asset.currency !== data.currency) return res.status(400).json({ error: 'A linked loan must use the physical asset currency. Leave it unlinked if it uses a different currency.' });
    }
    if (table === 'liability_balances' && (!db.prepare('SELECT 1 FROM liabilities WHERE id=?').get(data.liability_id) || !(Number(data.balance) >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || '')))) return res.status(400).json({ error: 'Choose a loan and enter a valid date and non-negative balance.' });

    const keys = fields.filter((k) => data[k] !== undefined);
    if (!keys.length) return res.status(400).json({ error: 'No valid fields supplied' });
    try {
      const info = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => `@${k}`).join(',')})`).run(data);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put('/api/:table/:id', (req, res) => {
    const table = req.params.table;
    const fields = TABLE_FIELDS[table];
    const id = req.params.id;
    if (!fields) return res.sendStatus(404);

    if (table === 'assets' && req.body.currency) {
      const prior = db.prepare('SELECT currency FROM assets WHERE id=?').get(id);
      if (prior && prior.currency !== req.body.currency
        && ['transactions', 'prices', 'dividends'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE asset_id=? LIMIT 1`).get(id))) {
        return res.status(400).json({ error: 'Currency cannot be changed after transactions, prices, or dividends have been recorded for this asset.' });
      }
    }

    if (table === 'accounts' && req.body.currency) {
      const prior = db.prepare('SELECT currency FROM accounts WHERE id=?').get(id);
      if (prior && prior.currency !== req.body.currency
        && ['transactions', 'cash_balances', 'dividends'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE account_id=? LIMIT 1`).get(id))) {
        return res.status(400).json({ error: 'Currency cannot be changed after transactions, cash balances, or dividends have been recorded for this account.' });
      }
    }

    if (table === 'transactions') {
      const existing = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
      if (existing) {
        const updates = Object.fromEntries(fields.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]]));
        const merged = { ...existing, ...updates };
        if (merged.kind === 'sell' && Number(merged.quantity) > heldQuantity(db, merged.asset_id, existing.id) + EPSILON) {
          return res.status(400).json({ error: 'Sale quantity exceeds shares held' });
        }
      }
    }

    if (table === 'cash_balances') {
      const existing = db.prepare('SELECT * FROM cash_balances WHERE id=?').get(id);
      if (existing) {
        const updates = Object.fromEntries(fields.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]]));
        const error = cashBalanceError(db, { ...existing, ...updates }, Number(id));
        if (error) return res.status(400).json({ error });
      }
    }

    if (table === 'dividends') {
      const existing = db.prepare('SELECT * FROM dividends WHERE id=?').get(id);
      if (existing) {
        const updates = Object.fromEntries(fields.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]]));
        const merged = { ...existing, ...updates };
        if (!(Number(merged.amount) > 0)) return res.status(400).json({ error: 'Dividend amount must be positive' });
        const asset = db.prepare('SELECT currency FROM assets WHERE id=?').get(merged.asset_id);
        if (!asset || asset.currency !== merged.currency) return res.status(400).json({ error: 'Dividend currency must match the asset currency' });
      }
    }

    if (table === 'physical_valuations' || table === 'liability_balances') {
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      if (existing) {
        const updates = Object.fromEntries(fields.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]]));
        const merged = { ...existing, ...updates };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.date || '')) || !(Number(table === 'physical_valuations' ? merged.value : merged.balance) >= 0)) return res.status(400).json({ error: 'Enter a valid date and non-negative value.' });
        if (table === 'physical_valuations') {
          const asset = db.prepare('SELECT currency FROM physical_assets WHERE id=?').get(merged.physical_asset_id);
          if (!asset || asset.currency !== merged.currency) return res.status(400).json({ error: 'Valuation currency must match the physical asset currency.' });
        } else if (!db.prepare('SELECT 1 FROM liabilities WHERE id=?').get(merged.liability_id)) return res.status(400).json({ error: 'Choose an existing loan.' });
      }
    }
    if (table === 'liabilities') {
      const existing = db.prepare('SELECT * FROM liabilities WHERE id=?').get(id);
      if (existing) {
        const merged = { ...existing, ...Object.fromEntries(fields.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]])) };
        if (merged.physical_asset_id) {
          const asset = db.prepare('SELECT currency FROM physical_assets WHERE id=?').get(merged.physical_asset_id);
          if (!asset || asset.currency !== merged.currency) return res.status(400).json({ error: 'A linked loan must use the physical asset currency. Leave it unlinked if it uses a different currency.' });
        }
      }
    }

    const keys = fields.filter((k) => req.body[k] !== undefined);
    if (!keys.length) return res.status(400).json({ error: 'No valid fields supplied' });
    try {
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...req.body, id });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/api/:table/:id', (req, res) => {
    const { table, id } = req.params;
    if (!ALLOWED_TABLES.has(table)) return res.sendStatus(404);
    if (table === 'accounts' && ['transactions','cash_balances'].some((child) => db.prepare(`SELECT 1 FROM ${child} WHERE account_id=? LIMIT 1`).get(id))) {
      return res.status(400).json({ error: 'This account has history. Remove its transactions and cash balances first, or keep the account for historical records.' });
    }
    if (table === 'assets' && ['transactions', 'prices', 'dividends', 'cash_balances'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE asset_id=? LIMIT 1`).get(id))) {
      return res.status(400).json({ error: 'This asset has related records. Remove its transactions, prices, and dividends first, or keep it for historical records.' });
    }
    if (table === 'physical_assets' && (db.prepare('SELECT 1 FROM physical_valuations WHERE physical_asset_id=? LIMIT 1').get(id) || db.prepare('SELECT 1 FROM liabilities WHERE physical_asset_id=? LIMIT 1').get(id))) return res.status(400).json({ error: 'This physical asset has valuation or loan records. Remove those records first, or keep the asset for history.' });
    if (table === 'liabilities' && db.prepare('SELECT 1 FROM liability_balances WHERE liability_id=? LIMIT 1').get(id)) return res.status(400).json({ error: 'This loan has balance history. Remove those records first, or keep the loan for history.' });
    try {
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/api/fx/sync', async (req, res) => {
    const provider = req.body?.provider || 'frankfurter';
    if (!['frankfurter', 'ecb'].includes(provider)) return res.status(400).json({ error: 'Unsupported FX provider' });
    const activityDates = db.prepare('SELECT date FROM transactions UNION SELECT date FROM prices UNION SELECT date FROM dividends UNION SELECT date FROM cash_balances ORDER BY date').all().map((row) => row.date);
    if (!activityDates.length) return res.json({ ok: true, stored: 0, dates: 0, message: 'Add transactions, prices, or dividends first.' });
    const from = activityDates[0];
    const to = new Date().toISOString().slice(0, 10);
    try {
      const rows = await fetchFx({ provider, from, to });
      const source = provider === 'ecb' ? 'Frankfurter · ECB' : 'Frankfurter';
      // Refresh provider rows on every sync, even from the same provider (rates get revised);
      // never overwrite a Manual entry for the same date/pair.
      const upsert = db.prepare(`INSERT INTO fx_rates(date,base,quote,rate,source) VALUES(@date,@base,@quote,@rate,@source)
        ON CONFLICT(date,base,quote) DO UPDATE SET rate=excluded.rate, source=excluded.source WHERE fx_rates.source != 'Manual'`);
      const save = db.transaction((data) => {
        let stored = 0;
        for (const row of data) {
          if (row.base !== 'EUR' || !['SEK', 'USD', 'BRL'].includes(row.quote) || !(Number(row.rate) > 0)) continue;
          stored += upsert.run({ ...row, source }).changes;
        }
        return stored;
      });
      const stored = save(rows);
      res.json({ ok: true, stored, dates: new Set(rows.map((row) => row.date)).size, from, to, source });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.publicMessage || `Could not fetch historical FX rates: ${error.message}` });
    }
  });

  return router;
}

function isHeld(db, assetId) {
  return heldQuantity(db, assetId) > EPSILON;
}

module.exports = { createPortfolioRouter, heldQuantity, isHeld, summaryResponse };
