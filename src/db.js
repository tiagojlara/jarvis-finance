const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TABLE_FIELDS = {
  accounts: ['name', 'currency'],
  assets: ['name', 'ticker', 'type', 'currency', 'notes', 'price_symbol', 'marketstack_symbol', 'alphavantage_symbol', 'alphavantage_currency'],
  transactions: ['account_id', 'asset_id', 'kind', 'date', 'quantity', 'unit_price', 'amount', 'fees', 'currency', 'notes'],
  prices: ['asset_id', 'date', 'price', 'currency', 'source'],
  dividends: ['asset_id', 'account_id', 'date', 'amount', 'currency', 'shares', 'notes'],
  fx_rates: ['date', 'base', 'quote', 'rate', 'source'],
  cash_balances: ['account_id', 'asset_id', 'date', 'balance', 'currency', 'notes'],
  physical_assets: ['name', 'type', 'purchase_date', 'purchase_price', 'currency', 'notes'],
  physical_valuations: ['physical_asset_id', 'date', 'value', 'currency', 'source', 'notes'],
  liabilities: ['name', 'type', 'physical_asset_id', 'original_amount', 'currency', 'interest_rate', 'notes'],
  liability_balances: ['liability_id', 'date', 'balance', 'notes'],
  // Cash-flow ledger: a separate domain from investment transactions. Rows here never
  // feed holdings, dividends, or net-worth calculations — only the Cash Flow page and
  // the MCP cash-flow tools read or write them.
  // It reuses the shared `accounts` table: the same accounts (brokerage, bank, card) that
  // hold investments also receive income and spending entries.
  cash_flow_categories: ['name', 'kind', 'active'],
  cash_flow_transactions: ['account_id', 'category_id', 'kind', 'date', 'amount', 'currency', 'payee', 'description'],
};

// Order matters: parents before children for inserts, children before parents for deletes.
const TABLE_ORDER = Object.keys(TABLE_FIELDS);
const CHILD_FIRST = [...TABLE_ORDER].reverse();

// Cash-flow transactions reuse the shared `accounts` registry (id references accounts(id)).
// The definition and auxiliary objects live here so the unification migration below can
// rebuild the table with exactly the same shape.
const CASH_FLOW_TX_DEF = `id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), category_id INTEGER NOT NULL REFERENCES cash_flow_categories(id), kind TEXT NOT NULL CHECK(kind IN ('income','expense')), date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), payee TEXT DEFAULT '', description TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP`;
const CASH_FLOW_TX_AUX = `
CREATE INDEX IF NOT EXISTS idx_cash_flow_tx_date ON cash_flow_transactions(date);
CREATE INDEX IF NOT EXISTS idx_cash_flow_tx_account ON cash_flow_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_cash_flow_tx_category ON cash_flow_transactions(category_id);
CREATE TRIGGER IF NOT EXISTS trg_cash_flow_tx_updated AFTER UPDATE ON cash_flow_transactions BEGIN UPDATE cash_flow_transactions SET updated_at=CURRENT_TIMESTAMP WHERE id=NEW.id; END;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, ticker TEXT, type TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), asset_id INTEGER REFERENCES assets(id), kind TEXT NOT NULL, date TEXT NOT NULL, quantity REAL DEFAULT 0, unit_price REAL DEFAULT 0, amount REAL DEFAULT 0, fees REAL DEFAULT 0, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS prices(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), date TEXT NOT NULL, price REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), source TEXT NOT NULL DEFAULT 'Manual');
CREATE TABLE IF NOT EXISTS dividends(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), account_id INTEGER REFERENCES accounts(id), date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), shares REAL, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS fx_rates(id INTEGER PRIMARY KEY, date TEXT NOT NULL, base TEXT NOT NULL CHECK(base IN ('EUR','SEK','USD','BRL')), quote TEXT NOT NULL CHECK(quote IN ('EUR','SEK','USD','BRL')), rate REAL NOT NULL CHECK(rate > 0), source TEXT NOT NULL DEFAULT 'Manual', UNIQUE(date,base,quote));
CREATE TABLE IF NOT EXISTS cash_balances(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), asset_id INTEGER REFERENCES assets(id), date TEXT NOT NULL, balance REAL NOT NULL CHECK(balance >= 0), currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS physical_assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('Property','Vehicle','Other')), purchase_date TEXT, purchase_price REAL CHECK(purchase_price IS NULL OR purchase_price >= 0), currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS physical_valuations(id INTEGER PRIMARY KEY, physical_asset_id INTEGER NOT NULL REFERENCES physical_assets(id), date TEXT NOT NULL, value REAL NOT NULL CHECK(value >= 0), currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), source TEXT NOT NULL DEFAULT 'Manual estimate', notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS liabilities(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('Mortgage','Vehicle finance','Personal loan','Other')), physical_asset_id INTEGER REFERENCES physical_assets(id), original_amount REAL NOT NULL CHECK(original_amount >= 0), currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), interest_rate REAL CHECK(interest_rate IS NULL OR interest_rate >= 0), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS liability_balances(id INTEGER PRIMARY KEY, liability_id INTEGER NOT NULL REFERENCES liabilities(id), date TEXT NOT NULL, balance REAL NOT NULL CHECK(balance >= 0), notes TEXT DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_balance_account_date ON cash_balances(account_id,date) WHERE asset_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_balance_asset_date ON cash_balances(account_id,asset_id,date) WHERE asset_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cash_flow_categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cash_flow_transactions(${CASH_FLOW_TX_DEF});
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_flow_category_name ON cash_flow_categories(name,kind);
${CASH_FLOW_TX_AUX}

-- Assistant (phase one) tables. Deliberately NOT in TABLE_FIELDS/TABLE_ORDER:
-- that keeps them off the generic /api/:table routes and out of /api/backup, so chat
-- history and the encrypted model token never ride along in a backup meant for sharing.
-- assistant_settings holds the model endpoint config; the token lives in its own row,
-- encrypted, and the key lives outside this file (see src/assistant/secrets.js).
CREATE TABLE IF NOT EXISTS assistant_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assistant_conversations(id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assistant_messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '', tool_activity TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation ON assistant_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS assistant_summaries(id INTEGER PRIMARY KEY, placement TEXT NOT NULL, period TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}', fingerprint TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', generated_at TEXT NOT NULL, UNIQUE(placement,period));`;

// Default categories are seeded only while the table is empty, so renaming or
// clearing defaults is respected on later starts instead of silently reverted.
// The unique (name,kind) index keeps restore and seeding from duplicating them.
const DEFAULT_CATEGORIES = [
  ['Salary', 'income'], ['Other income', 'income'],
  ['Housing', 'expense'], ['Food', 'expense'], ['Transport', 'expense'], ['Utilities', 'expense'],
  ['Health', 'expense'], ['Shopping', 'expense'], ['Entertainment', 'expense'], ['Fees', 'expense'],
  ['Other expense', 'expense'],
];

function seedCashFlowCategories(db) {
  if (db.prepare('SELECT 1 FROM cash_flow_categories LIMIT 1').get()) return;
  const insert = db.prepare('INSERT INTO cash_flow_categories(name,kind) VALUES(?,?)');
  db.transaction(() => { for (const [name, kind] of DEFAULT_CATEGORIES) insert.run(name, kind); })();
}

// Early builds of the cash-flow feature kept a separate `cash_flow_accounts` table.
// Accounts are now shared with the portfolio: fold each legacy cash-flow account into
// `accounts` (matching by name+currency, then name, else inserting), repoint the entries,
// rebuild cash_flow_transactions against the shared FK, and drop the legacy table.
function unifyCashFlowAccounts(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cash_flow_accounts'").get()) return;
  db.transaction(() => {
    const findAccount = db.prepare('SELECT id FROM accounts WHERE name=? AND currency=?');
    const findByName = db.prepare('SELECT id FROM accounts WHERE name=? LIMIT 1');
    const createAccount = db.prepare('INSERT INTO accounts(name, currency) VALUES(?, ?)');
    const repoint = db.prepare('UPDATE cash_flow_transactions SET account_id=? WHERE account_id=?');
    for (const legacy of db.prepare('SELECT * FROM cash_flow_accounts ORDER BY id').all()) {
      const target = findAccount.get(legacy.name, legacy.currency)
        || findByName.get(legacy.name)
        || { id: createAccount.run(legacy.name, legacy.currency).lastInsertRowid };
      repoint.run(target.id, legacy.id);
    }
    const columns = 'id, account_id, category_id, kind, date, amount, currency, payee, description, created_at, updated_at';
    db.exec(`CREATE TABLE cash_flow_transactions_unified(${CASH_FLOW_TX_DEF});`);
    db.exec(`INSERT INTO cash_flow_transactions_unified(${columns}) SELECT ${columns} FROM cash_flow_transactions;`);
    // Children first, then the parent: DROP with FK enforcement errors on remaining references.
    db.exec('DROP TABLE cash_flow_transactions; DROP TABLE cash_flow_accounts;');
    db.exec('ALTER TABLE cash_flow_transactions_unified RENAME TO cash_flow_transactions;');
    db.exec(CASH_FLOW_TX_AUX);
  })();
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'portfolio.sqlite'));
  db.pragma('journal_mode = WAL');
  // Set explicitly: restore ordering and delete guards rely on foreign keys,
  // and we must not inherit that guarantee from a dependency default.
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  if (!hasColumn(db, 'assets', 'price_symbol')) db.exec("ALTER TABLE assets ADD COLUMN price_symbol TEXT NOT NULL DEFAULT ''");
  for (const [column, type] of [['marketstack_symbol', "TEXT NOT NULL DEFAULT ''"], ['alphavantage_symbol', "TEXT NOT NULL DEFAULT ''"], ['alphavantage_currency', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!hasColumn(db, 'assets', column)) db.exec(`ALTER TABLE assets ADD COLUMN ${column} ${type}`);
  }
  db.exec("UPDATE assets SET marketstack_symbol=price_symbol WHERE marketstack_symbol='' AND price_symbol!=''");
  if (!hasColumn(db, 'fx_rates', 'source')) db.exec("ALTER TABLE fx_rates ADD COLUMN source TEXT NOT NULL DEFAULT 'Manual'");
  // CREATE TABLE IF NOT EXISTS above already brings the cash-flow tables into older databases.
  unifyCashFlowAccounts(db);
  seedCashFlowCategories(db);
  return db;
}

module.exports = { openDatabase, seedCashFlowCategories, TABLE_FIELDS, TABLE_ORDER, CHILD_FIRST, DEFAULT_CATEGORIES };
