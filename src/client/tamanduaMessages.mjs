// SQLite history rows (GET /api/assistant/conversations/:id) → messages CopilotKit's chat renders.
//
// Why this exists at all: the chat's own thread store only holds the turn it watched. Reading an old
// conversation back through `agent.setMessages()` is what makes FR-8 ("users can see which tools ran")
// apply to history rather than only to the answer currently on screen — otherwise a conversation that
// was reopened would show answers with no evidence behind them.
//
// The shape is not invented here; it is what @ag-ui/client's own `defaultApplyEvents` builds while a
// run streams (an assistant message carrying `toolCalls`, plus one `role: "tool"` message per call), and
// what the v2 view then reads. Measured in 1.85.0:
//   - `getToolCallLayouts` / `CopilotChatToolCallsView` read `toolCall.id`, `toolCall.function.name` and
//     `toolCall.function.arguments` (a JSON *string*), and pair results by scanning messages for
//     `role === "tool" && toolCallId === call.id`;
//   - a call with no tool message next to it is drawn as "in progress" forever, which is why every entry
//     in `toolActivity` gets a result message, refused ones included;
//   - nothing paints at all unless a tool-call renderer is registered (components/TamanduaChat.jsx does).
//
// Ids are derived from the persisted row id so React keys stay stable across re-reads of the same
// conversation, and a row that arrives twice from two renders cannot duplicate a bubble.

// One entry of a persisted assistant row's `toolActivity` → the call + its result message.
function toolCallPair(activity, rowId, index) {
  const callId = String(activity.id ?? `${rowId}-tool-${index}`);
  const args = typeof activity.args === 'string' ? activity.args : JSON.stringify(activity.args ?? {});
  return {
    call: { id: callId, type: 'function', function: { name: String(activity.tool || 'tool'), arguments: args } },
    // The same redaction rule the AG-UI bridge uses on the live path (`aguiBridge.toolResultContent`):
    // status, timing, and why it failed — never the records the tool read. The row's own `toolActivity`
    // is the only place full detail lives, and the aside is where a person reads it.
    result: {
      id: `${callId}-result`,
      role: 'tool',
      toolCallId: callId,
      content: JSON.stringify({
        status: activity.status || 'ok',
        ms: Number(activity.ms) || 0,
        ...(activity.message ? { reason: String(activity.message).slice(0, 400) } : {}),
      }),
    },
  };
}

export function historyToMessages(rows = []) {
  const messages = [];
  for (const row of rows) {
    const id = `tamandua-${row.id}`;
    if (row.role === 'user') {
      messages.push({ id, role: 'user', content: row.content || '' });
      continue;
    }
    const activity = Array.isArray(row.toolActivity) ? row.toolActivity : [];
    const pairs = activity.map((entry, index) => toolCallPair(entry, id, index));
    // An answer with no text still has to exist, or its calls would have nothing to hang off: the view
    // only draws tool calls that belong to an assistant message.
    messages.push({
      id,
      role: 'assistant',
      content: row.content || '',
      ...(pairs.length ? { toolCalls: pairs.map((pair) => pair.call) } : {}),
    });
    messages.push(...pairs.map((pair) => pair.result));
    // A persisted failure keeps its own line, the way the live run reports it through RUN_ERROR. Folding
    // it into `content` would put our own sentence inside the model's answer and make a partial read as
    // complete, which is the one thing FR-9 says not to do.
    if (row.error) messages.push({ id: `${id}-failure`, role: 'assistant', content: `⚠ ${row.error}` });
  }
  return messages;
}

// `result` as the tool-call renderer receives it: the JSON above, already parsed by the library
// (`contentToText` on the tool message). Tolerant by design — this is display data, and a row written by
// an older build may carry none of it.
export function readToolResult(result) {
  if (!result) return {};
  if (typeof result === 'object') return result;
  try { return JSON.parse(String(result)); } catch { return { reason: String(result).slice(0, 400) }; }
}
