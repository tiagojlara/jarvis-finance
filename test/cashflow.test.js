const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');

// Boots the real app against a throwaway database (same harness shape as api.test.js).
async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-cashflow-test-'));
  const { app, db } = createApp({ dataDir });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    return { status: response.status, payload };
  };
  return {
    request,
    db,
    close: () => new Promise((resolve) => { db.close(); server.close(resolve); }),
  };
}

// Cash flow shares the portfolio `accounts` table: any account can hold entries.
async function seedAccount(request, name = 'Everyday banking', currency = 'EUR') {
  const account = await request('accounts', { method: 'POST', body: { name, currency } });
  assert.equal(account.status, 200, account.payload?.error);
  return account.payload;
}

async function categoriesOf(request) {
  return (await request('cash_flow_categories')).payload;
}

test('default cash-flow categories are seeded only while the table is empty', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-cashflow-seed-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let db = openDatabase(dataDir);
  const seeded = db.prepare('SELECT * FROM cash_flow_categories').all();
  assert.equal(seeded.length, 11);
  assert.ok(seeded.some((row) => row.name === 'Salary' && row.kind === 'income'));
  assert.ok(seeded.some((row) => row.name === 'Food' && row.kind === 'expense'));
  db.close();

  // A renamed default must not be resurrected by the next app start.
  db = openDatabase(dataDir);
  db.prepare('UPDATE cash_flow_categories SET name=? WHERE name=?').run('Groceries', 'Food');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cash_flow_categories').get().n, 11, 'restart adds nothing while categories exist');
  db.close();
  db = openDatabase(dataDir);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cash_flow_categories').get().n, 11, 'renamed defaults are not duplicated back');
  assert.ok(!db.prepare("SELECT 1 FROM cash_flow_categories WHERE name='Food'").get());
  db.close();
});

test('cash-flow entries are validated against shared accounts and never touch the portfolio', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const accountId = (await seedAccount(request)).id;
  const categories = await categoriesOf(request);
  const salary = categories.find((row) => row.name === 'Salary').id;
  const food = categories.find((row) => row.name === 'Food').id;
  // Snapshot after setup: creating accounts legitimately changes the summary payload.
  const summaryBefore = JSON.stringify((await request('summary')).payload);

  const income = await request('cash_flow_transactions', { method: 'POST', body: { account_id: accountId, category_id: salary, kind: 'income', date: '2026-11-01', amount: 2400, currency: 'EUR', payee: 'Employer' } });
  assert.equal(income.status, 200, income.payload?.error);
  const expense = await request('cash_flow_transactions', { method: 'POST', body: { account_id: accountId, category_id: food, kind: 'expense', date: '2026-11-03', amount: 80.5, currency: 'EUR', description: 'weekly shop' } });
  assert.equal(expense.status, 200, expense.payload?.error);
  assert.ok(expense.payload.created_at, 'entries carry created/updated timestamps');

  // Required-field and consistency rules from the PRD.
  const rejections = [
    { account_id: accountId, category_id: food, kind: 'expense', date: '2026-11-04', amount: 0, currency: 'EUR' },
    { account_id: accountId, category_id: food, kind: 'expense', date: '2026-11', amount: 10, currency: 'EUR' },
    { account_id: accountId, category_id: food, kind: 'expense', date: '2026-11-04', amount: 10, currency: 'SEK' },
    { account_id: accountId, category_id: food, kind: 'income', date: '2026-11-04', amount: 10, currency: 'EUR' },
    { account_id: accountId, category_id: 9999, kind: 'expense', date: '2026-11-04', amount: 10, currency: 'EUR' },
    { account_id: 9999, category_id: food, kind: 'expense', date: '2026-11-04', amount: 10, currency: 'EUR' },
  ];
  for (const body of rejections) {
    const rejected = await request('cash_flow_transactions', { method: 'POST', body });
    assert.equal(rejected.status, 400, `should reject ${JSON.stringify(body)}`);
  }
  const kindMismatch = await request('cash_flow_transactions', { method: 'POST', body: rejections[3] });
  assert.match(kindMismatch.payload.error, /records expense/i, 'kind must match the category type');
  const unknownAccount = await request('cash_flow_transactions', { method: 'POST', body: rejections[5] });
  assert.match(unknownAccount.payload.error, /Choose an existing account/i);

  // Editing works and re-validates the merged row.
  assert.equal((await request(`cash_flow_transactions/${expense.payload.id}`, { method: 'PUT', body: { amount: 92 } })).status, 200);
  const edited = (await request('cash_flow_transactions')).payload.find((row) => row.id === expense.payload.id);
  assert.equal(edited.amount, 92);
  assert.equal((await request(`cash_flow_transactions/${expense.payload.id}`, { method: 'PUT', body: { kind: 'income' } })).status, 400, 'an edit cannot flip an expense into income under an expense category');

  // Shared-account guards: deletion and currency change consider cash-flow entries too.
  const blockedAccount = await request(`accounts/${accountId}`, { method: 'DELETE' });
  assert.equal(blockedAccount.status, 400);
  assert.match(blockedAccount.payload.error, /cash-flow entries/i);
  const pinnedCurrency = await request(`accounts/${accountId}`, { method: 'PUT', body: { currency: 'SEK' } });
  assert.equal(pinnedCurrency.status, 400);
  assert.match(pinnedCurrency.payload.error, /Currency cannot be changed/i);

  // Categories in use: deactivate, never delete.
  const blockedCategory = await request(`cash_flow_categories/${food}`, { method: 'DELETE' });
  assert.equal(blockedCategory.status, 400);
  assert.match(blockedCategory.payload.error, /Deactivate/i);
  assert.equal((await request(`cash_flow_categories/${food}`, { method: 'PUT', body: { active: 0 } })).status, 200);
  const deactivatedUse = await request('cash_flow_transactions', { method: 'POST', body: { account_id: accountId, category_id: food, kind: 'expense', date: '2026-11-05', amount: 10, currency: 'EUR' } });
  assert.equal(deactivatedUse.status, 400);
  assert.match(deactivatedUse.payload.error, /deactivated/i);

  // Category duplicate names are rejected with a friendly message.
  const duplicate = await request('cash_flow_categories', { method: 'POST', body: { name: 'Food', kind: 'expense' } });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.payload.error, /already exists/i);

  // Acceptance criterion: cash flow never changes holdings, dividends, or net worth.
  assert.equal(JSON.stringify((await request('summary')).payload), summaryBefore, 'the portfolio summary is byte-identical after cash-flow activity');
});

test('cash-flow edits and deletes keep the investment ledger untouched', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const broker = await seedAccount(request, 'Brokerage');
  const asset = await request('assets', { method: 'POST', body: { name: 'Index Fund', type: 'ETF', currency: 'EUR' } });
  await request('transactions', { method: 'POST', body: { account_id: broker.id, asset_id: asset.payload.id, kind: 'buy', date: '2026-11-02', quantity: 10, unit_price: 10, currency: 'EUR' } });
  const card = await seedAccount(request, 'Card', 'SEK');
  const categories = await categoriesOf(request);
  const rent = categories.find((row) => row.name === 'Housing').id;
  const entry = await request('cash_flow_transactions', { method: 'POST', body: { account_id: broker.id, category_id: rent, kind: 'expense', date: '2026-11-01', amount: 900, currency: 'EUR' } });
  assert.equal(entry.status, 200, entry.payload?.error);
  const summaryBefore = JSON.stringify((await request('summary')).payload);

  // Same brokerage account, two ledgers: a cash-flow edit and delete, plus a SEK card entry.
  await request(`cash_flow_transactions/${entry.payload.id}`, { method: 'PUT', body: { amount: 950 } });
  const sekEntry = await request('cash_flow_transactions', { method: 'POST', body: { account_id: card.id, category_id: categories.find((row) => row.name === 'Food').id, kind: 'expense', date: '2026-11-03', amount: 300, currency: 'SEK' } });
  assert.equal(sekEntry.status, 200, sekEntry.payload?.error);
  await request(`cash_flow_transactions/${entry.payload.id}`, { method: 'DELETE' });

  assert.equal(JSON.stringify((await request('summary')).payload), summaryBefore);
});

test('full backup carries cash flow, and older backups without it still restore', async (t) => {
  const { request, close } = await startServer();
  t.after(close);
  const euro = await seedAccount(request);
  const categories = await categoriesOf(request);
  const salary = categories.find((row) => row.name === 'Salary').id;
  await request('cash_flow_transactions', { method: 'POST', body: { account_id: euro.id, category_id: salary, kind: 'income', date: '2026-11-01', amount: 2400, currency: 'EUR' } });
  const sekAccount = await seedAccount(request, 'SEK card', 'SEK');
  const food = categories.find((row) => row.name === 'Food').id;
  await request('cash_flow_transactions', { method: 'POST', body: { account_id: sekAccount.id, category_id: food, kind: 'expense', date: '2026-11-02', amount: 300, currency: 'SEK' } });

  const backup = (await request('backup')).payload;
  assert.equal(backup.data.accounts.length, 2, 'cash-flow entries live on the shared accounts');
  assert.equal(backup.data.cash_flow_transactions.length, 2);

  const restored = await request('restore', { method: 'POST', body: backup });
  assert.equal(restored.status, 200, restored.payload?.error);
  assert.equal((await request('cash_flow_transactions')).payload.length, 2);
  assert.equal((await request('cash_flow_categories')).payload.length, 11, 'restore does not duplicate default categories');

  // A backup taken before the cash-flow feature exists has no cash-flow keys at all.
  const legacy = { version: 1, exportedAt: new Date().toISOString(), data: { settings: [] } };
  const legacyRestored = await request('restore', { method: 'POST', body: legacy });
  assert.equal(legacyRestored.status, 200, legacyRestored.payload?.error);
  assert.equal((await request('cash_flow_transactions')).payload.length, 0);
  const restoredCategories = (await request('cash_flow_categories')).payload;
  assert.equal(restoredCategories.length, 11, 'defaults come back so the ledger stays usable after a legacy restore');
  const usable = await seedAccount(request, 'Checking');
  const entry = await request('cash_flow_transactions', { method: 'POST', body: { account_id: usable.id, category_id: restoredCategories[0].id, kind: restoredCategories[0].kind, date: '2026-11-03', amount: 10, currency: 'EUR' } });
  assert.equal(entry.status, 200, entry.payload?.error);
});

test('databases with the old separate cash-flow accounts are unified on open', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-cashflow-unify-'));
  try {
    // Build the pre-unification shape by hand: cash_flow_accounts + entries referencing it.
    const raw = new Database(path.join(dataDir, 'portfolio.sqlite'));
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO accounts(name,currency) VALUES('Nordnet','EUR');
      CREATE TABLE cash_flow_accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO cash_flow_accounts(name,currency) VALUES('Nordnet','EUR'),('Everyday banking','SEK');
      CREATE TABLE cash_flow_categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense')), active INTEGER NOT NULL DEFAULT 1);
      INSERT INTO cash_flow_categories(name,kind) VALUES('Food','expense');
      CREATE TABLE cash_flow_transactions(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES cash_flow_accounts(id), category_id INTEGER NOT NULL REFERENCES cash_flow_categories(id), kind TEXT NOT NULL CHECK(kind IN ('income','expense')), date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL, payee TEXT DEFAULT '', description TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO cash_flow_transactions(account_id,category_id,kind,date,amount,currency) VALUES(1,1,'expense','2026-11-02',50,'EUR'),(2,1,'expense','2026-11-03',20,'SEK');
    `);
    raw.close();

    const db = openDatabase(dataDir);
    assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cash_flow_accounts'").get(), 'legacy table is dropped after unification');
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
    assert.deepEqual(accounts.map((a) => a.name), ['Nordnet', 'Everyday banking'], 'name matches reuse the portfolio account; the rest are merged in');
    const entries = db.prepare('SELECT * FROM cash_flow_transactions ORDER BY id').all();
    assert.deepEqual(entries.map((e) => e.account_id), [1, 2], 'entries repointed to shared account ids');
    assert.deepEqual(entries.map((e) => [e.amount, e.currency]), [[50, 'EUR'], [20, 'SEK']], 'entry data survives the rebuild');

    // The rebuilt table references accounts(id): ids 1 and 2 exist now, id 99 does not...
    assert.throws(() => db.prepare("INSERT INTO cash_flow_transactions(account_id,category_id,kind,date,amount,currency) VALUES(99,1,'expense','2026-11-04',10,'EUR')").run(), /FOREIGN KEY/i);
    // ...while a shared account works, and the updated_at trigger was recreated with the table.
    db.prepare("INSERT INTO cash_flow_transactions(account_id,category_id,kind,date,amount,currency) VALUES(1,1,'expense','2026-11-04',10,'EUR')").run();
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_cash_flow_tx_updated'").get());
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
