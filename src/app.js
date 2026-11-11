const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { createPortfolioRouter } = require('./routes/portfolio');
const { createMcpRouter } = require('./mcp/server');
const { createAssistantModule, DISCLOSURE } = require('./assistant');
const { createCopilotModule } = require('./assistant/copilotRuntime');
const { createJarvisAgent, createPolicyHooks } = require('./assistant/copilotAgents');

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

  // The CopilotKit endpoint, mounted the same way for the same reason: it speaks /api/copilotkit only.
  //
  // Mounted with NO path argument. In single-route mode the handler registers its own
  // `router.post('/api/copilotkit')` and rebuilds the request from `req.url`, which is the path *after*
  // whatever prefix a mount matched — `app.use('/api/copilotkit', handler)` would leave `req.url` as
  // `/`, miss the registration, and fall through to the SPA catch-all with a 200 of HTML.
  // The real `jarvis` agent replaces the transport stand-in, and is built from the same collaborators the
  // REST assistant uses — so the disclosure gate, the read-only guard and the SQLite history are one
  // implementation serving two transports, not two that can drift apart. Registered per request, because
  // the model token is decrypted for the request that needs it.
  // `hooks` carry the §9 disclosure gate. Both entry points are built from one options object, so this
  // guard sits in front of the browser's run *and* the cards' in-process run: an unacknowledged client
  // cannot reach `assistant.run()` by either route, which is what the legacy SSE route guarantees today
  // (routes.js:174-177).
  const copilot = createCopilotModule({
    hooks: createPolicyHooks({ store: assistant.store, disclosure: DISCLOSURE }),
    extraAgents: async () => ({
      jarvis: createJarvisAgent({ assistant: assistant.assistant, history: assistant.history, store: assistant.store }),
    }),
  });
  app.use(copilot.router);

  app.use(createPortfolioRouter({ db, fetchFxRates: options.fetchFxRates }));

  app.use(express.static(path.join(__dirname, '..', 'dist')));
  // Express 4 catch-all for client-side routes; Express 5 requires the '/{*path}' syntax instead.
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

  // `copilot` is returned so the summary cards can run a completion through the same runtime without a
  // socket (runLocal), and so a test can drive the endpoint and the in-process path against one app.
  return { app, db, assistant, copilot };
}

module.exports = { createApp };
