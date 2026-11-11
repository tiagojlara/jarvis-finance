// HTTP surface for the assistant. Everything under /api/assistant is local: the browser
// never sees the token, and model requests are proxied through this server (§6.2.1).
//
// These paths are deliberately outside the generic /api/:table routes, and the assistant
// tables are outside TABLE_ORDER, so no chat history or encrypted token can be read, written
// or exported through the portfolio CRUD surface or /api/backup.

const express = require('express');
const { createAssistantStore } = require('./store');
const { READ_ONLY_TOOLS } = require('./readOnlyGuard');
const { createMcpConnection } = require('./mcpConnection');
const { createHistory } = require('./history');
const { createSummaries } = require('./summaries');
const { createAssistant } = require('./agent');
const { testConnection } = require('./model');
const { normalizeEndpointUrl } = require('./endpoints');
const { AssistantInputError } = require('./errors');

const MONTH = /^\d{4}-\d{2}$/;

// §9: the user must be told what leaves the machine before the first request goes out. This
// is the text that disclosure shows, kept server-side so the wording the user agreed to is
// the wording the app states.
const DISCLOSURE = {
  title: 'What the assistant sends to your model endpoint',
  body: [
    'Tamanduá keeps all financial records on this machine, and the assistant reads them through this app\'s own local MCP connection.',
    'To answer a question or write a summary, the app sends to the model endpoint you configured: your question, the earlier messages of that conversation, and the records the model reads back from the local Tamanduá tools (account, asset, transaction, price and cash-flow figures). Model endpoints are usually remote, so those figures leave this machine when you ask a question.',
    'The app does not send your records to any other service, and it never sends the API token anywhere except the endpoint you configured.',
    'Chat history, settings and summaries are stored in this app\'s database only, and you can delete them at any time. Deleting a conversation does not delete any financial record.',
    'The assistant is read-only: it cannot add, change or remove anything. It is not financial or tax advice.',
  ],
};

function clientError(response, error, status = 400) {
  return response.status(status).json({ error: error?.message || 'The assistant request failed.' });
}

// Express 4 does not catch a rejected promise from an async handler, and several assistant
// calls are async (token decryption, MCP connect, model requests). Without this, a Keychain
// refusal or a dead endpoint would be an unhandled rejection instead of an answer the user
// can read.
const handle = (handler) => (req, res, next) => {
  try {
    Promise.resolve(handler(req, res, next)).catch((error) => clientError(res, error, error?.status || 500));
  } catch (error) {
    clientError(res, error);
  }
};

function createAssistantRouter({ db, dataDir, mcpUrl, keyOptions = {} } = {}) {
  const store = createAssistantStore(db, { keyOptions: { dataDir, ...keyOptions } });
  const history = createHistory(db);
  const connection = createMcpConnection({ url: mcpUrl, store });
  const summaries = createSummaries({ db, store });
  const assistant = createAssistant({ store, connection, history });

  const router = express.Router();

  // ---- model endpoint ---------------------------------------------------------------
  router.get('/api/assistant/model', handle(async (req, res) => {
    res.json(await store.publicSettings());
  }));

  // baseUrl/model/token are optional so the UI can save one field at a time; an omitted
  // token means "keep the saved one", and clearToken means "forget it".
  router.put('/api/assistant/model', handle(async (req, res) => {
    const { baseUrl, model, token, clearToken, allowInsecureHttp } = req.body || {};
    res.json(await store.saveModelSettings({ baseUrl, model, token, clearToken, allowInsecureHttp }));
  }));

  // A minimal request with no financial data (§6.2.1), for the "Test connection" button.
  router.post('/api/assistant/model/test', handle(async (req, res) => {
    try {
      res.json(await testConnection(store));
    } catch (error) {
      res.status(502).json({ ok: false, error: error?.message || 'The endpoint could not be reached.' });
    }
  }));

  // The URL is validated and normalised as the user types, so the form can show where
  // requests will actually go before anything is saved.
  router.post('/api/assistant/model/validate', (req, res) => {
    try {
      res.json(normalizeEndpointUrl((req.body || {}).baseUrl, { allowInsecureRemoteHttp: (req.body || {}).allowInsecureHttp === true }));
    } catch (error) {
      clientError(res, error);
    }
  });

  // ---- disclosure (§9) --------------------------------------------------------------
  router.get('/api/assistant/disclosure', (req, res) => {
    res.json({ ...DISCLOSURE, ...store.acknowledgement(), endpoint: store.rawModelSettings().effectiveUrl || null });
  });

  router.post('/api/assistant/disclosure', (req, res) => {
    res.json({ ...DISCLOSURE, ...store.acknowledgeDisclosure() });
  });

  // ---- the local MCP connection (§10 item 3) ----------------------------------------
  router.get('/api/assistant/mcp', handle(async (req, res) => {
    res.json(await connection.status());
  }));

  router.post('/api/assistant/mcp/reconnect', handle(async (req, res) => {
    try {
      res.json(await connection.reconnect());
    } catch (error) {
      clientError(res, error, 502);
    }
  }));

  router.put('/api/assistant/mcp', handle(async (req, res) => {
    store.setMcpEnabled((req.body || {}).enabled === true);
    res.json(await connection.status());
  }));

  // Per-tool switches. A tool outside the read-only allowlist cannot be enabled at all —
  // this surface only ever narrows what the assistant is given.
  router.put('/api/assistant/mcp/tools/:name', (req, res) => {
    const name = req.params.name.startsWith('tamandua_') ? req.params.name.slice('tamandua_'.length) : req.params.name;
    if (!READ_ONLY_TOOLS.includes(name)) {
      return res.status(400).json({ error: `"${name}" is not a read-only Tamanduá tool, so the assistant cannot expose it. Phase one reads records only.` });
    }
    store.setToolEnabled(name, (req.body || {}).enabled === true);
    res.json({ ok: true, disabledTools: [...store.toolState().disabled] });
  });

  // ---- history (§10 item 4, FR-10) --------------------------------------------------
  router.get('/api/assistant/conversations', (req, res) => {
    res.json({ conversations: history.list() });
  });

  router.post('/api/assistant/conversations', (req, res) => {
    const conversation = history.create((req.body || {}).title);
    res.status(201).json({ conversation: history.get(conversation.id) });
  });

  router.get('/api/assistant/conversations/:id', (req, res) => {
    const conversation = history.get(Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'No such conversation.' });
    res.json({ conversation });
  });

  router.put('/api/assistant/conversations/:id', (req, res) => {
    try {
      const conversation = history.rename(Number(req.params.id), (req.body || {}).title);
      if (!conversation) return res.status(404).json({ error: 'No such conversation.' });
      return res.json({ conversation });
    } catch (error) {
      return clientError(res, error);
    }
  });

  // Deleting history can never delete a financial record: these tables have no foreign keys
  // into the portfolio, and the cascade is scoped to assistant_messages.
  router.delete('/api/assistant/conversations/:id', (req, res) => {
    const removed = history.remove(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'No such conversation.' });
    res.json({ ok: true });
  });

  router.delete('/api/assistant/conversations/:id/messages/:messageId', (req, res) => {
    const removed = history.deleteMessage(Number(req.params.id), Number(req.params.messageId));
    if (!removed) return res.status(404).json({ error: 'No such message in that conversation.' });
    res.json({ ok: true });
  });

  // ---- chat (§10 item 2) ------------------------------------------------------------
  // There is no chat route here any more. The conversation is served by the CopilotKit endpoint
  // (src/assistant/copilotRuntime.js + copilotAgents.js), which answers AG-UI events on one URL and is
  // mounted in src/app.js. What stays on this router is everything that is not a stream: the conversation
  // list, the per-message inspect/delete surface (FR-10), the disclosure, the settings and the cards.
  //
  // The one behaviour the deleted route owned that has no REST equivalent is the 428 disclosure refusal;
  // it moved to `createPolicyHooks`, which gates the single copilot endpoint for the same condition and
  // the same payload (see copilotAgents.js). `assistant` is still returned below because the copilot
  // module is built from it in src/app.js.

  // ---- AI summary cards (§10 item 5) ------------------------------------------------
  router.get('/api/assistant/summaries', handle(async (req, res) => {
    const { placement, period } = req.query;
    if (placement === 'cashflow' && !MONTH.test(String(period || ''))) throw new AssistantInputError('A cash-flow summary needs a month, as period=YYYY-MM.');
    res.json(summaries.read(String(placement || ''), period ? String(period) : ''));
  }));

  router.post('/api/assistant/summaries', handle(async (req, res) => {
    const { placement, period } = req.body || {};
    if (placement === 'cashflow' && !MONTH.test(String(period || ''))) throw new AssistantInputError('A cash-flow summary needs a month, as period=YYYY-MM.');
    try {
      res.json(await summaries.generate(String(placement || ''), period ? String(period) : ''));
    } catch (error) {
      res.status(error?.status || 502).json({ error: error?.message || 'The summary could not be generated.', ...(error?.code ? { code: error.code } : {}) });
    }
  }));

  router.delete('/api/assistant/summaries', (req, res) => {
    const { placement, period } = req.query;
    if (!placement) return res.json({ cleared: summaries.clearAll() });
    summaries.remove(String(placement), period ? String(period) : '');
    res.json({ cleared: 1 });
  });

  return { router, store, connection, history, summaries, assistant };
}

module.exports = { createAssistantRouter, DISCLOSURE };
