// Assistant entry point. Kept separate from the UI and from the portfolio routes on purpose,
// so the provider can be swapped without touching views and
// the views hold no provider logic.

const { createAssistantRouter, DISCLOSURE } = require('./routes');
const { createAssistantStore } = require('./store');
const { createHistory } = require('./history');
const { createMcpConnection, defaultMcpUrl } = require('./mcpConnection');
const { createToolMiddleware } = require('./toolMiddleware');
const { createSummaries } = require('./summaries');
const { normalizeEndpointUrl } = require('./endpoints');
const { AssistantInputError } = require('./errors');
const secrets = require('./secrets');
const model = require('./model');
const prompts = require('./prompts');

// `mcpUrl` may be a string or a function: a test that listens on an ephemeral port only knows
// the number after createApp has run, and the assistant connects to the app's own endpoint.
function createAssistantModule(options = {}) {
  const mcpUrl = options.mcpUrl || defaultMcpUrl();
  return createAssistantRouter({ ...options, mcpUrl });
}

module.exports = {
  createAssistantModule,
  createAssistantStore,
  createHistory,
  createMcpConnection,
  createToolMiddleware,
  createSummaries,
  normalizeEndpointUrl, AssistantInputError,
  defaultMcpUrl,
  DISCLOSURE,
  secrets,
  model,
  prompts,
};
