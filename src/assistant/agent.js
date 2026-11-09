// The LangChain agent: model client + Jarvis MCP read tools + the read-only guard.
//
// `stream()` with `streamMode: 'messages'` yields `[messageChunk, meta]` pairs (verified
// against a local fake endpoint): model text arrives from the `model_request` node as
// AIMessageChunk/ChatMessageChunk, and tool results arrive from the `tools` node as
// ToolMessage. Only model text is shown as a streaming answer; tool activity is reported
// separately from the guard's own log, which is what the UI renders as "which tools were
// consulted" (FR-8).
//
// Nothing here holds the token longer than the request, and the token is never part of an
// event or a persisted row — failures are pushed through sanitizeError first, which exists
// because a real provider puts the bearer token inside its own 401 message.

const { createAgent } = require('langchain');
const { createChatModel, sanitizeError } = require('./model');
const { createReadOnlyGuard } = require('./readOnlyGuard');
const { chatSystemPrompt } = require('./prompts');
const { AssistantInputError } = require('./errors');

// Model turns per question. Each turn may request tools, so this bounds the loop without
// limiting how many records a single answer may read.
const MAX_AGENT_STEPS = 16;

function today() {
  return new Date().toISOString().slice(0, 10);
}

// One run of the agent, as an async generator of UI events. The caller (routes.js) turns
// events into SSE frames and owns the HTTP response; this module never touches Express.
function createAssistant({ store, connection, history }) {
  async function* run({ conversationId, message, signal } = {}) {
    const text = String(message || '').trim();
    if (!text) throw new AssistantInputError('Ask something first.');
    if (text.length > 8000) throw new AssistantInputError('That message is too long for one request (8000 characters max).');

    // A conversation is created on first use, so the UI can just send a message.
    let conversation = conversationId ? history.get(Number(conversationId)) : null;
    if (!conversation) conversation = history.create();
    const chatId = conversation.id;

    // Replayed turns (excluding the one being sent now), oldest first.
    const prior = history.contextMessages(chatId);
    const userMessage = history.addMessage({ conversationId: chatId, role: 'user', content: text });
    yield { type: 'user', message: userMessage, conversationId: chatId };

    let model;
    try {
      model = await createChatModel(store, { streaming: true });
    } catch (error) {
      const failure = error?.message || 'The model endpoint is not usable.';
      const saved = history.addMessage({ conversationId: chatId, role: 'assistant', content: '', model: store.rawModelSettings().model, error: failure });
      yield { type: 'error', message: failure, messageId: saved.id, conversationId: chatId };
      return;
    }

    const status = await connection.status();
    if (!status.enabled || !status.connected) {
      const failure = status.error || `The local Jarvis MCP endpoint at ${status.url} is not reachable.`;
      const message2 = `I could not read your records, so I will not guess at numbers. ${failure} Open Settings & backup → Assistant and turn the connection on or use Reconnect.`;
      const saved = history.addMessage({ conversationId: chatId, role: 'assistant', content: '', model: model.model, error: message2 });
      yield { type: 'error', message: message2, messageId: saved.id, conversationId: chatId };
      return;
    }

    let tools = [];
    try {
      tools = await connection.activeTools();
    } catch (error) {
      tools = [];
    }
    if (!tools.length) {
      yield { type: 'notice', message: 'Every Jarvis tool is switched off in Settings, so I have no access to your records and cannot state any figures. Re-enable at least one tool to get grounded answers.' };
    }

    // Per-message activity: the guard records as it runs, and the same array is what the UI
    // sees live and what gets persisted with the answer for later inspection (FR-8, FR-10).
    const live = [];
    const guard = createReadOnlyGuard({ onActivity: (entry) => live.push(entry) });
    const agent = createAgent({
      model: model.client,
      tools,
      systemPrompt: chatSystemPrompt({ today: today(), toolNames: tools.map((tool) => tool.name) }),
      middleware: [guard.middleware],
    });

    const parts = [];
    let aborted = false;
    try {
      const stream = await agent.stream(
        { messages: [...prior, { role: 'user', content: text }] },
        { streamMode: 'messages', recursionLimit: MAX_AGENT_STEPS, signal },
      );
      for await (const pair of stream) {
        if (signal?.aborted) { aborted = true; break; }
        const [chunk, meta] = Array.isArray(pair) ? pair : [pair, null];
        // Tool results (node "tools") carry JSON records, not an answer.
        if (chunk?._getType?.() === 'tool' || meta?.langgraph_node === 'tools') continue;
        const delta = typeof chunk?.content === 'string' ? chunk.content : '';
        if (delta) {
          parts.push(delta);
          yield { type: 'delta', text: delta, step: meta?.langgraph_step ?? null };
        }
        // Surface each completed tool call as soon as the guard records it.
        while (live.length > 0) yield { type: 'tool', activity: live.shift() };
      }
    } catch (error) {
      while (live.length > 0) yield { type: 'tool', activity: live.shift() };
      const failure = sanitizeError(error, { token: model.token, model: model.model, baseUrl: model.baseUrl });
      const content = parts.join('');
      const saved = history.addMessage({
        conversationId: chatId,
        role: 'assistant',
        content,
        toolActivity: guard.activity,
        model: model.model,
        error: content ? `Stopped: ${failure}` : failure,
      });
      yield { type: 'error', message: failure, messageId: saved.id, conversationId: chatId, partial: content };
      return;
    }

    while (live.length > 0) yield { type: 'tool', activity: live.shift() };
    const content = parts.join('');
    const refusals = guard.refusals;
    if (refusals.length) {
      // §9: an attempted write — by the model or provoked by text inside the records — is
      // reported to the user rather than swallowed.
      yield { type: 'notice', message: `${refusals.length} tool call${refusals.length === 1 ? '' : 's'} outside the read-only allowlist ${refusals.length === 1 ? 'was' : 'were'} refused: ${refusals.map((item) => item.tool).join(', ')}. Nothing was changed.` };
    }
    const saved = history.addMessage({
      conversationId: chatId,
      role: 'assistant',
      content,
      toolActivity: guard.activity,
      model: model.model,
      error: content ? '' : 'The model answered with no text.',
    });
    yield {
      type: 'done',
      messageId: saved.id,
      conversationId: chatId,
      text: content,
      model: model.model,
      activity: guard.activity,
      refusals,
      aborted,
    };
  }

  return { run };
}

module.exports = { createAssistant, MAX_AGENT_STEPS };
