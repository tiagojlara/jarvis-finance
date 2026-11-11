// MCP server for external agents (e.g. Nous Research Hermes Agent), served at /mcp.
// Portfolio reads plus writes: manual prices, manual FX rates, dividend registration,
// and the full cash-flow ledger (list, monthly summary, record/edit/delete entries,
// manage categories) — the same dated rows the UI creates, validated by the same
// rules as the REST routes. No deletes outside the cash-flow ledger, no restores,
// no settings writes.
// Deliberately unauthenticated: everything runs locally and the Express app binds to
// 127.0.0.1, so only this machine can reach it. See README "MCP server".
const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { summaryResponse, cashFlowEntryError, cashFlowCategoryError } = require('../routes/portfolio');
const { cashFlowMonthSummary } = require('../cashflow-summary');

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM');
const CASH_FLOW_KINDS = ['income', 'expense'];
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
    { name: 'tamandua', version: '1.0.0' },
    {
      instructions: 'Local-first personal portfolio and retirement planner. Prices, FX rates, and valuations are dated manual or provider snapshots, never live quotes; amounts in different currencies are not converted unless stated. The data supports scenario tracking, not financial advice — do not present outputs as guarantees.',
    },
  );

  server.registerTool('get_summary', {
    description: 'Current portfolio overview: per-asset holdings (quantity, cost basis, latest price and date, current value, unrealized and realized gain), cash balances as rows, and totals by currency. Currency totals are NOT converted — use list_fx_rates if you need a single-currency figure.',
    inputSchema: {},
  }, async () => jsonContent(summaryResponse(db).summary));

  server.registerTool('list_accounts', {
    description: 'Brokerage/cash/bank/card accounts with id, name, and currency. These are shared: the same accounts hold investments and receive cash-flow entries.',
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

  // --- Cash-flow ledger -------------------------------------------------------------
  // A separate domain from the investment ledger: these rows never change holdings,
  // dividends, or net worth, and portfolio activity never writes them implicitly.
  // Validation is shared with the REST routes (cashFlowEntryError/cashFlowCategoryError),
  // so the MCP surface cannot accept a row the UI would reject, or the other way round.

  server.registerTool('list_cash_flow_categories', {
    description: 'Cash-flow income/expense categories with id, name, kind (income|expense), active flag, and entry_count (how many ledger rows use it). Deactivated categories stay readable for history but reject new entries.',
    inputSchema: {
      kind: z.enum(CASH_FLOW_KINDS).optional(),
      active_only: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ kind, active_only }) => {
    const where = []; const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (active_only) { where.push('active = 1'); }
    const sql = `SELECT c.*, (SELECT COUNT(*) FROM cash_flow_transactions t WHERE t.category_id = c.id) AS entry_count
      FROM cash_flow_categories c${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.kind, c.name`;
    return jsonContent(db.prepare(sql).all(...params));
  });

  server.registerTool('list_cash_flow_transactions', {
    description: 'Recorded cash-flow entries (income and spending), newest first, with optional date range, account, category, and kind filters. Each entry carries the currency of its account. This is recorded activity only — unrecorded movement is absent, and investment transactions/dividends are NOT listed here.',
    inputSchema: {
      date_from: DATE.optional(), date_to: DATE.optional(),
      account_id: z.number().int().positive().optional(),
      category_id: z.number().int().positive().optional(),
      kind: z.enum(CASH_FLOW_KINDS).optional(),
      limit: z.number().int().positive().max(2000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const where = []; const params = [];
    dateClauses(where, params, args);
    if (args.account_id) { where.push('account_id = ?'); params.push(args.account_id); }
    if (args.category_id) { where.push('category_id = ?'); params.push(args.category_id); }
    if (args.kind) { where.push('kind = ?'); params.push(args.kind); }
    const sql = `SELECT * FROM cash_flow_transactions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    return jsonContent(db.prepare(sql).all(...params, args.limit ?? 200));
  });

  server.registerTool('get_cash_flow_summary', {
    description: 'One month of cash flow: income, spending, and net per currency (never converted), plus per-category breakdowns. month is YYYY-MM; defaults to the current month. Counts only recorded cash-flow entries — investment transactions and dividends are not included.',
    inputSchema: { month: MONTH.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ month }) => jsonContent(cashFlowMonthSummary(db, month)));

  server.registerTool('save_cash_flow_entry', {
    description: 'Record one cash-flow entry (income or spending) against a shared account, like the UI form. The entry currency is ALWAYS the account currency (from list_accounts) — do not pass or convert it. category_id must be an active category of the same kind (list_cash_flow_categories). NOT idempotent: every call inserts a new row, and legitimate same-day/same-amount duplicates exist, so before retrying an unclear response check list_cash_flow_transactions instead of blind-saving.',
    inputSchema: {
      account_id: z.number().int().positive(),
      category_id: z.number().int().positive(),
      kind: z.enum(CASH_FLOW_KINDS),
      date: DATE,
      amount: z.number().positive(),
      payee: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ account_id, category_id, kind, date, amount, payee, description }) => {
    const account = db.prepare('SELECT currency FROM accounts WHERE id = ?').get(account_id);
    if (!account) return errorContent(`No account with id ${account_id}. Cash flow uses the same accounts as the portfolio — call list_accounts to find ids.`);
    const error = cashFlowEntryError(db, { account_id, category_id, kind, date, amount, currency: account.currency });
    if (error) return errorContent(`${error} Check account and category ids with list_accounts / list_cash_flow_categories.`);
    const info = db.prepare('INSERT INTO cash_flow_transactions(account_id, category_id, kind, date, amount, currency, payee, description) VALUES(?,?,?,?,?,?,?,?)')
      .run(account_id, category_id, kind, date, amount, account.currency, payee ?? '', description ?? '');
    return jsonContent({ action: 'inserted', entry: db.prepare('SELECT * FROM cash_flow_transactions WHERE id = ?').get(info.lastInsertRowid) });
  });

  server.registerTool('update_cash_flow_entry', {
    description: 'Edit an existing cash-flow entry by id (from list_cash_flow_transactions). Only the fields passed are changed; the merged row is re-validated with the same rules as save_cash_flow_entry, and the entry keeps its currency from the account when you change accounts.',
    inputSchema: {
      id: z.number().int().positive(),
      account_id: z.number().int().positive().optional(),
      category_id: z.number().int().positive().optional(),
      kind: z.enum(CASH_FLOW_KINDS).optional(),
      date: DATE.optional(),
      amount: z.number().positive().optional(),
      payee: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const { id, ...updates } = args;
    const existing = db.prepare('SELECT * FROM cash_flow_transactions WHERE id = ?').get(id);
    if (!existing) return errorContent(`No cash-flow entry with id ${id}. Call list_cash_flow_transactions to find ids.`);
    const merged = { ...existing };
    for (const [key, value] of Object.entries(updates)) if (value !== undefined) merged[key] = value;
    // Currency always follows the (possibly new) account, mirroring the UI form.
    const account = db.prepare('SELECT currency FROM accounts WHERE id = ?').get(merged.account_id);
    if (!account) return errorContent(`No account with id ${merged.account_id}. Call list_accounts to find ids.`);
    merged.currency = account.currency;
    const error = cashFlowEntryError(db, merged);
    if (error) return errorContent(error);
    db.prepare('UPDATE cash_flow_transactions SET account_id = ?, category_id = ?, kind = ?, date = ?, amount = ?, currency = ?, payee = ?, description = ? WHERE id = ?')
      .run(merged.account_id, merged.category_id, merged.kind, merged.date, merged.amount, merged.currency, merged.payee, merged.description, id);
    return jsonContent({ action: 'updated', entry: db.prepare('SELECT * FROM cash_flow_transactions WHERE id = ?').get(id) });
  });

  server.registerTool('delete_cash_flow_entry', {
    description: 'Delete one cash-flow entry by id (from list_cash_flow_transactions). Cash-flow rows are the user\'s own records: confirm the date, amount, and category with the user before deleting. Only cash-flow entries can be deleted through MCP — investment rows, accounts, and assets cannot.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ id }) => {
    const existing = db.prepare('SELECT * FROM cash_flow_transactions WHERE id = ?').get(id);
    if (!existing) return errorContent(`No cash-flow entry with id ${id}. Call list_cash_flow_transactions to find ids.`);
    db.prepare('DELETE FROM cash_flow_transactions WHERE id = ?').run(id);
    return jsonContent({ action: 'deleted', entry: existing });
  });

  server.registerTool('save_cash_flow_category', {
    description: 'Create a cash-flow category (name + kind income|expense), or reuse an existing one: the same name + kind returns that category with action "exists" (idempotent). Prefer the default categories (Salary, Housing, Food, ...) when one fits; names are unique per kind.',
    inputSchema: {
      name: z.string().min(1).max(80),
      kind: z.enum(CASH_FLOW_KINDS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name, kind }) => {
    const trimmed = name.trim();
    const existing = db.prepare('SELECT * FROM cash_flow_categories WHERE name = ? AND kind = ?').get(trimmed, kind);
    if (existing) return jsonContent({ action: 'exists', category: existing });
    const error = cashFlowCategoryError(db, { name: trimmed, kind });
    if (error) return errorContent(error);
    const info = db.prepare('INSERT INTO cash_flow_categories(name, kind) VALUES(?, ?)').run(trimmed, kind);
    return jsonContent({ action: 'created', category: db.prepare('SELECT * FROM cash_flow_categories WHERE id = ?').get(info.lastInsertRowid) });
  });

  server.registerTool('update_cash_flow_category', {
    description: 'Rename and/or activate/deactivate a cash-flow category by id (from list_cash_flow_categories). A category already used by entries cannot switch kind — create a new one and move entries instead. Deactivate with active=false rather than deleting history; entries with a deactivated category keep showing in reports but new save_cash_flow_entry calls reject it.',
    inputSchema: {
      id: z.number().int().positive(),
      name: z.string().min(1).max(80).optional(),
      kind: z.enum(CASH_FLOW_KINDS).optional(),
      active: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, name, kind, active }) => {
    const existing = db.prepare('SELECT * FROM cash_flow_categories WHERE id = ?').get(id);
    if (!existing) return errorContent(`No cash-flow category with id ${id}. Call list_cash_flow_categories to find ids.`);
    const merged = { name: name?.trim() || existing.name, kind: kind || existing.kind, active: active === undefined ? existing.active : (active ? 1 : 0) };
    if (merged.kind !== existing.kind && db.prepare('SELECT 1 FROM cash_flow_transactions WHERE category_id = ? LIMIT 1').get(id)) {
      return errorContent(`Category "${existing.name}" already has cash-flow entries; its kind cannot change. Keep it, or create a ${merged.kind} category and reassign new entries.`);
    }
    const error = cashFlowCategoryError(db, merged, Number(id));
    if (error) return errorContent(error);
    db.prepare('UPDATE cash_flow_categories SET name = ?, kind = ?, active = ? WHERE id = ?').run(merged.name, merged.kind, merged.active, id);
    return jsonContent({ action: 'updated', category: db.prepare('SELECT * FROM cash_flow_categories WHERE id = ?').get(id) });
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
    if (!transport) {
      // A sessionless GET is what a browser probe looks like. Per Streamable HTTP a server
      // without an SSE push channel answers 405 — with a body that explains itself, so
      // "is it down?" answers itself too.
      return res.status(405).json({
        error: 'tamandua MCP endpoint: not a web page. Agents connect by POSTing JSON-RPC to this URL (initialize → notifications/initialized → tools/*). If you are here from a browser, the API server is up — nothing is wrong.',
        transport: 'streamable-http',
        mcp_version: '2025-06-18',
      });
    }
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
