const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { createPortfolioRouter } = require('./routes/portfolio');
const { createMcpRouter } = require('./mcp/server');
const { createAssistantModule } = require('./assistant');

// App factory: pass a dataDir (and, in tests, fetch overrides). No listening here — server.js owns that.
function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const db = options.db || openDatabase(dataDir);
  const app = express();

  // Mounted before the global body parser: the MCP transport reads and parses raw
  // JSON-RPC bodies itself, so /mcp requests must not be consumed by express.json.
  // Localhost-only and unauthenticated by design (see src/mcp/server.js).
  app.use(createMcpRouter({ db }));

  app.use(express.json({ limit: '20mb' }));

  // Mounted before the portfolio router: its generic /api/:table and /api/:table/:id routes
  // would otherwise swallow /api/assistant/model or /api/assistant/mcp as a table named
  // "assistant", and answer 404. Express matches in registration order, so the more specific
  // surface has to be registered first.
  //
  // The assistant is also a client of the /mcp endpoint mounted above; `assistantMcpUrl` lets
  // a test that listens on an ephemeral port point it at the real address once known.
  const assistant = createAssistantModule({
    db,
    dataDir,
    mcpUrl: options.assistantMcpUrl,
    keyOptions: options.assistantKeyOptions,
  });
  app.use(assistant.router);

  app.use(createPortfolioRouter({ db, fetchFxRates: options.fetchFxRates }));

  app.use(express.static(path.join(__dirname, '..', 'dist')));
  // Express 4 catch-all for client-side routes; Express 5 requires the '/{*path}' syntax instead.
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

  return { app, db, assistant };
}

module.exports = { createApp };
