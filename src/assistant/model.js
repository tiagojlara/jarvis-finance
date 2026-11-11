// The model client: an OpenAI-compatible chat endpoint the user configures (§6.2).
//
// Requests are made *server-side* (the browser only ever sees "the endpoint answered" or a
// sanitised failure), which is what keeps the token out of client-visible responses, and the
// token is decrypted from its own row only here, at call time.
//
// Verified against a live local endpoint rather than assumed: the outgoing body is
// { messages, model, stream } — no temperature or max_tokens unless a caller sets them, so
// strict reasoning endpoints are not fed parameters they reject — and the token travels as
// `Authorization: Bearer <token>` to `<baseURL>/chat/completions`.
//
// That probe also showed why sanitising is not cosmetic: a 401 body from a real provider
// echoed the bearer token back into the error message. Anything matching that shape is
// redacted before it leaves this module.

const { ChatOpenAI } = require('@langchain/openai');

const CHAT_TIMEOUT_MS = Number(process.env.TAMANDUA_ASSISTANT_TIMEOUT_MS || process.env.JARVIS_ASSISTANT_TIMEOUT_MS || 120000);
const TEST_TIMEOUT_MS = 20000;
const MAX_ERROR_LENGTH = 400;

const SECRET_PATTERNS = [
  /Bearer\s+\S+/gi,
  /\bsk-[A-Za-z0-9_\-]{6,}/g,
  /\b(?:api[_-]?key|token|authorization)["']?\s*[:=]\s*\S+/gi,
];

// Turns provider/network errors into something the user can act on (FR-9), and strips any
// credential the provider put in its own message.
function sanitizeError(error, { token, model, baseUrl, timeoutMs } = {}) {
  const raw = [error?.message, error?.cause?.message].filter(Boolean).join(' ');
  let text = raw.replace(/\s+/g, ' ').trim();
  if (token && text.includes(token)) text = text.split(token).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(/https?:\/\/\S*\/chat\/completions\S*/g, '[endpoint]').slice(0, MAX_ERROR_LENGTH);

  const status = Number(error?.status) || Number(text.match(/^\s*(\d{3})/)?.[1]) || 0;
  const host = (() => {
    try { return new URL(baseUrl || '').host; } catch { return 'the configured endpoint'; }
  })();
  const named = String(model || '').trim() || 'this model';

  if (/ECONNREFUSED/i.test(raw)) return `Nothing is listening at ${host}. Start the model server, or fix the base URL in Settings & backup → Model endpoint.`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `The host in ${host} could not be resolved. Check the endpoint URL and your network.`;
  if (/ETIMEDOUT|timed out|timeout|abort/i.test(raw)) return `The endpoint did not answer within ${Math.round((error?.timeoutMs || timeoutMs || CHAT_TIMEOUT_MS) / 1000)}s. A local model that is still loading can cause this — try again, or raise the timeout by starting the app with TAMANDUA_ASSISTANT_TIMEOUT_MS.`;
  if (status === 401 || status === 403) return `The endpoint rejected the token (${status}). Re-enter the API token in Settings & backup → Model endpoint; some local servers expect a placeholder value here rather than a real key.`;
  if (status === 404) return `The endpoint has no model "${named}" at this path (404). Check the model identifier, and make sure the base URL points at the API root, for example https://host/v1.`;
  if (status === 429) return 'The endpoint is rate limited (429). Wait a moment and try again.';
  if (status >= 500) return `The endpoint returned a server error (${status}). It may be down, out of memory, or still loading the model.`;
  if (!text) return 'The model endpoint could not be reached.';
  return `The model endpoint failed: ${text}`;
}

// Builds a client from the saved settings. Throws an actionable Error when the assistant is
// not configured yet, so callers never see an undefined key path.
async function createChatModel(store, { streaming = false, maxRetries = 1, timeoutMs = CHAT_TIMEOUT_MS, maxTokens } = {}) {
  const { baseUrl, model, token } = await store.modelConfig();
  const client = new ChatOpenAI({
    model,
    apiKey: token,
    configuration: { baseURL: baseUrl },
    maxRetries,
    timeout: timeoutMs,
    streaming,
    ...(maxTokens ? { maxTokens } : {}),
  });
  return { client, baseUrl, model, token };
}

// "Test connection" (§6.2.1): a minimal request that carries no financial data and no tools,
// and answers with a sanitised result. Never retries, so one click means one request.
async function testConnection(store) {
  const settings = store.rawModelSettings();
  const { client, baseUrl, model, token } = await createChatModel(store, { maxRetries: 0, timeoutMs: TEST_TIMEOUT_MS });
  const started = Date.now();
  try {
    const reply = await client.invoke('Connection test. Reply with exactly the word: ok');
    const text = typeof reply?.content === 'string' ? reply.content.trim().slice(0, 120) : '';
    return {
      ok: true,
      baseUrl,
      effectiveUrl: settings.effectiveUrl,
      model,
      latencyMs: Date.now() - started,
      reply: text,
      tokens: reply?.usage_metadata?.total_tokens ?? null,
    };
  } catch (error) {
    throw new Error(sanitizeError(error, { token, model, baseUrl }));
  }
}

module.exports = { createChatModel, testConnection, sanitizeError, CHAT_TIMEOUT_MS, TEST_TIMEOUT_MS, SECRET_PATTERNS };
