// MCP server for external agents (e.g. Nous Research Hermes Agent), served at /mcp.
// Portfolio reads plus three writes: manual prices, manual FX rates, and dividend
// registration — the same dated entries the UI creates. No deletes, no restores,
// no settings writes. The cash-flow ledger is deliberately not exposed here.
// Deliberately unauthenticated: everything runs locally and the Express app binds to
// 127.0.0.1, so only this machine can reach it. See README "MCP server".
const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { summaryResponse } = require('../routes/portfolio');

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const CURRENCIES = ['EUR', 'SEK', 'USD', 'BRL'];

function jsonContent(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Appends date-range clauses shared by the list_* tools.
function dateClauses(where, params, args) {
  if (args.date_from) { where.push('date >= ?'); params.push(args.date_from); }
  if (args.date_to) { where.push('date <= ?'); params.push(args.date_to); }
}

function buildToolServer(db) {
  const server = new McpServer(
    { name: 'jarvis-finance', version: '1.0.0' },
    {
      instructions: 'Local-first personal portfolio and retirement planner. Prices, FX rates, and valuations are dated manual or provider snapshots, never live quotes; amounts in different currencies are not converted unless stated. The data supports scenario tracking, not financial advice — do not present outputs as guarantees.',
    },
  );

  server.registerTool('get_summary', {
    description: 'Current portfolio overview: per-asset holdings (quantity, cost basis, latest price and date, current value, unrealized and realized gain), cash balances as rows, and totals by currency. Currency totals are NOT converted — use list_fx_rates if you need a single-currency figure.',
    inputSchema: {},
  }, async () => jsonContent(summaryResponse(db).summary));

  server.registerTool('list_accounts', {
    description: 'Brokerage/cash accounts with id, name, and currency.',
    inputSchema: {},
  }, async () => jsonContent(db.prepare('SELECT * FROM accounts ORDER BY id').all()));

  server.registerTool('list_assets', {
    description: 'Assets (funds, stocks, cash assets) with id, name, ticker, type, currency, and notes. Use these ids for list_transactions, list_prices, save_price, etc.',
    inputSchema: {},
  }, async () => jsonContent(db.prepare('SELECT * FROM assets ORDER BY id').all()));

  server.registerTool('list_transactions', {
    description: 'Buys, sells, deposits, withdrawals, and fees, newest first, with optional date range, account, asset, and kind filters.',
    inputSchema: {
      date_from: DATE.optional(), date_to: DATE.optional(),
      account_id: z.number().int().positive().optional(),
      asset_id: z.number().int().positive().optional(),
      kind: z.enum(['buy', 'sell', 'deposit', 'withdrawal', 'fee']).optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
  }, async (args) => {
    const where = []; const params = [];
    dateClauses(where, params, args);
    if (args.account_id) { where.push('account_id = ?'); params.push(args.account_id); }
    if (args.asset_id) { where.push('asset_id = ?'); params.push(args.asset_id); }
    if (args.kind) { where.push('kind = ?'); params.push(args.kind); }
    const sql = `SELECT * FROM transactions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    return jsonContent(db.prepare(sql).all(...params, args.limit ?? 200));
  });

  server.registerTool('list_dividends', {
    description: 'Recorded dividend payments (actual entries only), newest first, with optional asset and date filters.',
    inputSchema: {
      asset_id: z.number().int().positive().optional(),
      date_from: DATE.optional(), date_to: DATE.optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
  }, async (args) => {
    const where = []; const params = [];
    dateClauses(where, params, args);
    if (args.asset_id) { where.push('asset_id = ?'); params.push(args.asset_id); }
    const sql = `SELECT * FROM dividends${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    return jsonContent(db.prepare(sql).all(...params, args.limit ?? 200));
  });

  server.registerTool('list_prices', {
    description: 'Dated price entries per asset with source (Manual or provider label). These are end-of-day or weekly closes, not live quotes.',
    inputSchema: {
      asset_id: z.number().int().positive().optional(),
      date_from: DATE.optional(), date_to: DATE.optional(),
      limit: z.number().int().positive().max(2000).optional(),
    },
  }, async (args) => {
    const where = []; const params = [];
    if (args.asset_id) { where.push('asset_id = ?'); params.push(args.asset_id); }
    dateClauses(where, params, args);
    const sql = `SELECT * FROM prices${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    return jsonContent(db.prepare(sql).all(...params, args.limit ?? 500));
  });

  server.registerTool('list_fx_rates', {
    description: 'Stored dated FX rates (base, quote, rate, source). Rates are daily reference values, not trading quotes.',
    inputSchema: {
      base: z.enum(CURRENCIES).optional(), quote: z.enum(CURRENCIES).optional(),
      date_from: DATE.optional(), date_to: DATE.optional(),
      limit: z.number().int().positive().max(5000).optional(),
    },
  }, async (args) => {
    const where = []; const params = [];
    if (args.base) { where.push('base = ?'); params.push(args.base); }
    if (args.quote) { where.push('quote = ?'); params.push(args.quote); }
    dateClauses(where, params, args);
    const sql = `SELECT * FROM fx_rates${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    return jsonContent(db.prepare(sql).all(...params, args.limit ?? 1000));
  });

  server.registerTool('list_cash_balances', {
    description: 'Dated cash balance snapshots per account or cash asset.',
    inputSchema: {
      account_id: z.number().int().positive().optional(),
      date_from: DATE.optional(), date_to: DATE.optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
  }, async (args) => {
    const where = []; const params = [];
    if (args.account_id) { where.push('account_id = ?'); params.push(args.account_id); }
    dateClauses(where, params, args);
    const sql = `SELECT * FROM cash_balances${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    return jsonContent(db.prepare(sql).all(...params, args.limit ?? 200));
  });

  server.registerTool('get_net_worth', {
    description: 'Net worth inputs in their original currencies: investment and cash holdings by currency (from get_summary), physical assets with their latest valuation, and loans with their latest remaining balance. Values are manual snapshots, not appraisals or live lender balances, and are not currency-converted.',
    inputSchema: {},
  }, async () => {
    const latestBy = (rows, parentId, dateKey, mapKey) => {
      const latest = new Map();
      for (const row of rows) {
        const prior = latest.get(row[parentId]);
        if (!prior || row[dateKey] > prior[dateKey] || (row[dateKey] === prior[dateKey] && row.id > prior.id)) latest.set(row[parentId], row);
      }
      return latest;
    };
    const { summary } = summaryResponse(db);
    const valuations = latestBy(db.prepare('SELECT * FROM physical_valuations').all(), 'physical_asset_id', 'date');
    const balances = latestBy(db.prepare('SELECT * FROM liability_balances').all(), 'liability_id', 'date');
    return jsonContent({
      investments_value_by_currency: summary.valueByCurrency,
      physical_assets: db.prepare('SELECT * FROM physical_assets ORDER BY id').all()
        .map((asset) => ({ ...asset, latest_valuation: valuations.get(asset.id) ?? null })),
      liabilities: db.prepare('SELECT * FROM liabilities ORDER BY id').all()
        .map((loan) => ({ ...loan, latest_balance: balances.get(loan.id) ?? null })),
    });
  });

  server.registerTool('save_price', {
    description: 'Record a dated manual price for an asset, like the UI price dialog. A positive price for the asset\'s own currency and a YYYY-MM-DD date are required. Replaces a Manual entry for the same asset and date; never touches provider-sourced rows.',
    inputSchema: {
      asset_id: z.number().int().positive(),
      date: DATE,
      price: z.number().positive(),
      currency: z.enum(CURRENCIES).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ asset_id, date, price, currency }) => {
    const asset = db.prepare('SELECT name, currency FROM assets WHERE id = ?').get(asset_id);
    if (!asset) return errorContent(`No asset with id ${asset_id}. Call list_assets to find ids.`);
    if (currency && currency !== asset.currency) {
      return errorContent(`Price currency must match the asset currency (${asset.currency} for "${asset.name}").`);
    }
    const existing = db.prepare("SELECT id FROM prices WHERE asset_id = ? AND date = ? AND source = 'Manual'").get(asset_id, date);
    if (existing) {
      db.prepare("UPDATE prices SET price = ?, source = 'Manual' WHERE id = ?").run(price, existing.id);
      return jsonContent({ action: 'updated', price: db.prepare('SELECT * FROM prices WHERE id = ?').get(existing.id) });
    }
    const info = db.prepare("INSERT INTO prices(asset_id, date, price, currency, source) VALUES(?,?,?, ?, 'Manual')")
      .run(asset_id, date, price, asset.currency);
    return jsonContent({ action: 'inserted', price: db.prepare('SELECT * FROM prices WHERE id = ?').get(info.lastInsertRowid) });
  });

  server.registerTool('save_fx_rate', {
    description: 'Record a dated manual FX rate between two supported currencies, like the UI FX dialog. Stored with source Manual, which later provider syncs will not overwrite. Use the same pair direction the UI uses (for example base EUR, quote SEK).',
    inputSchema: {
      date: DATE,
      base: z.enum(CURRENCIES),
      quote: z.enum(CURRENCIES),
      rate: z.number().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ date, base, quote, rate }) => {
    if (base === quote) return errorContent('Base and quote must be different currencies.');
    db.prepare(`INSERT INTO fx_rates(date, base, quote, rate, source) VALUES(@date, @base, @quote, @rate, 'Manual')
      ON CONFLICT(date, base, quote) DO UPDATE SET rate = excluded.rate, source = 'Manual'`)
      .run({ date, base, quote, rate });
    return jsonContent({ fx_rate: db.prepare('SELECT * FROM fx_rates WHERE date = ? AND base = ? AND quote = ?').get(date, base, quote) });
  });

  server.registerTool('save_dividend', {
    description: 'Record a dated actual dividend payment for an asset, like the UI dividend dialog. Record on the pay date with the settled amount. Currency defaults to (and must match) the asset currency. Idempotent: re-saving the same asset + date with the same amount returns the existing row instead of duplicating it. A DIFFERENT amount for an already-recorded asset + date is refused unless replace=true is passed after confirming the correction with the user.',
    inputSchema: {
      asset_id: z.number().int().positive(),
      date: DATE,
      amount: z.number().positive(),
      account_id: z.number().int().positive().optional(),
      currency: z.enum(CURRENCIES).optional(),
      shares: z.number().positive().optional(),
      notes: z.string().max(500).optional(),
      replace: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ asset_id, date, amount, account_id, currency, shares, notes, replace }) => {
    const asset = db.prepare('SELECT name, currency FROM assets WHERE id = ?').get(asset_id);
    if (!asset) return errorContent(`No asset with id ${asset_id}. Call list_assets to find ids.`);
    if (currency && currency !== asset.currency) {
      return errorContent(`Dividend currency must match the asset currency (${asset.currency} for "${asset.name}").`);
    }
    if (account_id && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account_id)) {
      return errorContent(`No account with id ${account_id}. Call list_accounts to find ids.`);
    }
    const existing = db.prepare('SELECT * FROM dividends WHERE asset_id = ? AND date = ? ORDER BY id').get(asset_id, date);
    if (existing) {
      if (Number(existing.amount) === Number(amount) && !replace) {
        return jsonContent({ action: 'exists', dividend: existing });
      }
      if (!replace) {
        return errorContent(`A dividend for "${asset.name}" on ${date} is already recorded (id ${existing.id}, amount ${existing.amount} ${existing.currency}). Confirm with the user; to correct it, call again with replace=true, or edit/delete the row in the app UI.`);
      }
      db.prepare('UPDATE dividends SET account_id = ?, amount = ?, currency = ?, shares = ?, notes = ? WHERE id = ?')
        .run(account_id ?? existing.account_id, amount, asset.currency, shares ?? existing.shares, notes ?? existing.notes, existing.id);
      return jsonContent({ action: 'replaced', dividend: db.prepare('SELECT * FROM dividends WHERE id = ?').get(existing.id) });
    }
    const info = db.prepare('INSERT INTO dividends(asset_id, account_id, date, amount, currency, shares, notes) VALUES(?,?,?,?,?,?,?)')
      .run(asset_id, account_id ?? null, date, amount, asset.currency, shares ?? null, notes ?? '');
    return jsonContent({ action: 'inserted', dividend: db.prepare('SELECT * FROM dividends WHERE id = ?').get(info.lastInsertRowid) });
  });

  return server;
}

function isInitializeRequest(body) {
  return Array.isArray(body)
    ? body.some((message) => message?.method === 'initialize')
    : body?.method === 'initialize';
}

// Express router serving MCP over Streamable HTTP at /mcp. One MCP server + transport
// per session, created on initialize and dropped on close or DELETE.
function createMcpRouter({ db }) {
  const router = express.Router();
  const sessions = new Map();

  const sessionFor = (req) => sessions.get(req.headers['mcp-session-id']) || null;

  router.post('/mcp', express.json({ limit: '2mb' }), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    try {
      if (!sessionId && isInitializeRequest(req.body)) {
        let transport;
        const server = buildToolServer(db);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          // Fires when the transport assigns the id during initialize — the map must be
          // populated before the client's next (notifications/initialized) POST arrives.
          onsessioninitialized: (id) => { sessions.set(id, transport); },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          server.close().catch(() => {});
        };
        await server.connect(transport);
        return transport.handleRequest(req, res, req.body);
      }
      const transport = sessionFor(req);
      if (!transport) {
        return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Not found: unknown or expired session. POST initialize first.' }, id: null });
      }
      return transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
      return undefined;
    }
  });

  router.get('/mcp', async (req, res) => {
    const transport = sessionFor(req);
    if (!transport) return res.sendStatus(404);
    return transport.handleRequest(req, res);
  });

  router.delete('/mcp', async (req, res) => {
    const transport = sessionFor(req);
    if (!transport) return res.sendStatus(404);
    return transport.handleDeleteRequest(req, res);
  });

  return router;
}

module.exports = { createMcpRouter, buildToolServer };
