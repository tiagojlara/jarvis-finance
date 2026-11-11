// The failure codes the assistant emits, spelled for the browser.
//
// These are the server's, not new names: `src/assistant/errors.js` owns the vocabulary and the transport
// puts those strings on the wire as `RUN_ERROR.code`. This file exists because a CommonJS module cannot be
// imported into the Vite client, and because branching on a regex over the message text (which the old
// hand-rolled page did: `/disclosure/i.test(e.message)`) breaks the moment a model answers with the word
// "disclosure" in an ordinary sentence.
//
// test/copilotClientCodes.test.js asserts this table is identical to the server's, so the two cannot drift.
export const JARVIS_CODES = {
  threadRequired: 'jarvis_thread_required',
  threadUnknown: 'jarvis_thread_unknown',
  disclosureRequired: 'jarvis_disclosure_required',
  inputInvalid: 'jarvis_input_invalid',
  modelNotConfigured: 'jarvis_model_not_configured',
  mcpUnreachable: 'jarvis_mcp_unreachable',
  modelRequestFailed: 'jarvis_model_request_failed',
  runStopped: 'jarvis_run_stopped',
  runFailed: 'jarvis_run_failed',
};
