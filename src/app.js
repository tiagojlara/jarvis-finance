const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { createPortfolioRouter } = require('./routes/portfolio');
const { createMcpRouter } = require('./mcp/server');

// App factory: pass a dataDir (and, in tests, fetch overrides). No listening here — server.js owns that.
function createApp(options = {}) {
  const db = options.db || openDatabase(options.dataDir || path.join(__dirname, '..', 'data'));
  const app = express();

  // Mounted before the global body parser: the MCP transport reads and parses raw
  // JSON-RPC bodies itself, so /mcp requests must not be consumed by express.json.
  // Localhost-only and unauthenticated by design (see src/mcp/server.js).
  app.use(createMcpRouter({ db }));

  app.use(express.json({ limit: '20mb' }));
  app.use(createPortfolioRouter({ db, fetchFxRates: options.fetchFxRates }));

  app.use(express.static(path.join(__dirname, '..', 'dist')));
  // Express 4 catch-all for client-side routes; Express 5 requires the '/{*path}' syntax instead.
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

  return { app, db };
}

module.exports = { createApp };
