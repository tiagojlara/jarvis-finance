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
};

// Order matters: parents before children for inserts, children before parents for deletes.
const TABLE_ORDER = Object.keys(TABLE_FIELDS);
const CHILD_FIRST = [...TABLE_ORDER].reverse();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, ticker TEXT, type TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), asset_id INTEGER REFERENCES assets(id), kind TEXT NOT NULL, date TEXT NOT NULL, quantity REAL DEFAULT 0, unit_price REAL DEFAULT 0, amount REAL DEFAULT 0, fees REAL DEFAULT 0, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS prices(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), date TEXT NOT NULL, price REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), source TEXT NOT NULL DEFAULT 'Manual');
CREATE TABLE IF NOT EXISTS dividends(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), account_id INTEGER REFERENCES accounts(id), date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('EUR','SEK','USD','BRL')), shares REAL, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS fx_rates(id INTEGER PRIMARY KEY, date TEXT NOT NULL, base TEXT NOT NULL CHECK(base IN ('EUR','SEK','USD','BRL')), quote TEXT NOT NULL CHECK(quote IN ('EUR','SEK','USD','BRL')), rate REAL NOT NULL CHECK(rate > 0), source TEXT NOT NULL DEFAULT 'Manual', UNIQUE(date,base,quote));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'portfolio.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  if (!hasColumn(db, 'assets', 'price_symbol')) db.exec("ALTER TABLE assets ADD COLUMN price_symbol TEXT NOT NULL DEFAULT ''");
  for (const [column, type] of [['marketstack_symbol', "TEXT NOT NULL DEFAULT ''"], ['alphavantage_symbol', "TEXT NOT NULL DEFAULT ''"], ['alphavantage_currency', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!hasColumn(db, 'assets', column)) db.exec(`ALTER TABLE assets ADD COLUMN ${column} ${type}`);
  }
  db.exec("UPDATE assets SET marketstack_symbol=price_symbol WHERE marketstack_symbol='' AND price_symbol!=''");
  if (!hasColumn(db, 'fx_rates', 'source')) db.exec("ALTER TABLE fx_rates ADD COLUMN source TEXT NOT NULL DEFAULT 'Manual'");
  return db;
}

module.exports = { openDatabase, TABLE_FIELDS, TABLE_ORDER, CHILD_FIRST };
