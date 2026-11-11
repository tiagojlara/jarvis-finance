// The app-managed connection from the assistant to Tamanduá's own MCP endpoint (§10 item 3).
//
// §13 is explicit that these are two separate capabilities: the /mcp server keeps its own
// descriptions and safety semantics for external agents like Hermes, and here the app is
// merely an MCP *client* of that same endpoint. Nothing about adding chat changes what
// /mcp exposes — the assistant simply asks for the tool list and calls the reads.
//
// The endpoint is this process's own loopback URL, so the client is created lazily and
// reused. `url` may be a function, resolved on each connect, because a test that listens on
// an ephemeral port only knows the number after createApp has run.

const { MultiServerMCPClient } = require('@langchain/mcp-adapters');
const { bareToolName } = require('./toolMiddleware');

const SERVER_KEY = 'tamandua';

function defaultMcpUrl() {
  if (process.env.TAMANDUA_MCP_URL) return process.env.TAMANDUA_MCP_URL;
  const port = Number(process.env.PORT || 3000);
  return `http://127.0.0.1:${port}/mcp`;
}

// `store` supplies the master connection switch.
function createMcpConnection({ url, store } = {}) {
  const resolveUrl = () => (typeof url === 'function' ? url() : url) || defaultMcpUrl();
  let client = null;
  let tools = null;          // cached adapter tools, unfiltered
  let pending = null;        // one connect at a time, shared by concurrent requests
  let lastError = null;
  let checkedAt = null;

  async function disconnect() {
    const current = client;
    client = null;
    tools = null;
    if (current) await current.close().catch(() => {});
  }

  async function connect() {
    if (client && tools) return tools;
    if (pending) return pending;
    const endpoint = resolveUrl();
    pending = (async () => {
      try {
        const next = new MultiServerMCPClient({ [SERVER_KEY]: { transport: 'http', url: endpoint } });
        const loaded = await next.getTools();
        await disconnect();          // a reconnect replaced the old session; drop it cleanly
        client = next;
        tools = loaded;
        lastError = null;
        checkedAt = new Date().toISOString();
        return loaded;
      } catch (error) {
        await disconnect().catch(() => {});
        lastError = error?.message || String(error);
        checkedAt = new Date().toISOString();
        throw new Error(`The app could not reach its own Tamanduá MCP endpoint at ${endpoint}. ${lastError}`);
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  // Every tool published by the local MCP server is available to the internal agent.
  async function activeTools() {
    const enabled = store?.read?.('mcp.enabled') !== 'false';
    if (!enabled) return [];
    const loaded = await connect();
    return loaded;
  }

  async function status() {
    const endpoint = resolveUrl();
    const enabled = store?.read?.('mcp.enabled') !== 'false';
    let loaded = null;
    let error = lastError;
    if (enabled) {
      try {
        loaded = await connect();
      } catch (connectError) {
        error = connectError.message;
      }
    }
    const inventory = (loaded || []).map((tool) => ({
      name: bareToolName(tool.name),
      description: tool.description || '',
    })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      url: endpoint,
      enabled,
      connected: Boolean(loaded),
      checkedAt,
      error: enabled ? error : 'The built-in Tamanduá connection is turned off.',
      tools: inventory,
      exposed: inventory.length,
    };
  }

  async function reconnect() {
    await disconnect();
    return status();
  }

  return { connect, activeTools, status, reconnect, disconnect, resolveUrl };
}

module.exports = { createMcpConnection, defaultMcpUrl };
