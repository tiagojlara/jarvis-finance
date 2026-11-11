// Error types for the assistant. An input error is something the user can fix in the form —
// a bad URL, a missing month, an over-long title — so it answers 400 with its message.
// Anything else that escapes is an internal failure and answers 500, because turning a bug
// into "400: cannot read properties of undefined" teaches the user nothing.
class AssistantInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssistantInputError';
    this.status = 400;
  }
}

// Named failures, so the UI branches on a code instead of matching the prose of an error message.
//
// FR-9 asks for actionable failures, and the actionable part is often not the text but *where* to send
// the user: a disclosure gate opens a modal, a model-configuration gate opens Settings, a refused thread
// starts a new conversation. Before CopilotKit the client got an HTTP status for the first two and string
// matching for the rest; the AG-UI stream carries a code and no status at all (measured), so the code has
// to be produced where the failure is produced.
//
// The vocabulary lives here rather than in the transport because both halves own entries: `agent.js` names
// what went wrong with the model or the MCP connection, and the CopilotKit seam names what went wrong with
// the run request. A module in one layer importing them from the other would put the wire format in the
// brain (§13:203), which is the thing this migration is trying not to do again.
const ERROR_CODES = {
  // The run request itself — rejected before any model is called.
  threadRequired: 'jarvis_thread_required',
  threadUnknown: 'jarvis_thread_unknown',
  disclosureRequired: 'jarvis_disclosure_required',
  inputInvalid: 'jarvis_input_invalid',
  // What the assistant could not do.
  modelNotConfigured: 'jarvis_model_not_configured',
  mcpUnreachable: 'jarvis_mcp_unreachable',
  modelRequestFailed: 'jarvis_model_request_failed',
  // The user stopped it, or a newer run on the same conversation took its place. Not a failure: the
  // partial answer is already saved, and a red error card for a Stop button is FR-9's definition of an
  // unactionable message.
  runStopped: 'jarvis_run_stopped',
  runFailed: 'jarvis_run_failed',
};

module.exports = { AssistantInputError, ERROR_CODES };
