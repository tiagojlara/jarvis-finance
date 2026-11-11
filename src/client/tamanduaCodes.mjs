// The failure codes the assistant emits, spelled for the browser.
//
// These are the server's, not new names: `src/assistant/errors.js` owns the vocabulary and the transport
// puts those strings on the wire as `RUN_ERROR.code`. This file exists because a CommonJS module cannot be
// imported into the Vite client, and because branching on a regex over the message text (which the old
// hand-rolled page did: `/disclosure/i.test(e.message)`) breaks the moment a model answers with the word
// "disclosure" in an ordinary sentence.
//
// test/copilotClientCodes.test.js asserts this table is identical to the server's, so the two cannot drift.
export const TAMANDUA_CODES = {
  threadRequired: 'tamandua_thread_required',
  threadUnknown: 'tamandua_thread_unknown',
  disclosureRequired: 'tamandua_disclosure_required',
  inputInvalid: 'tamandua_input_invalid',
  modelNotConfigured: 'tamandua_model_not_configured',
  mcpUnreachable: 'tamandua_mcp_unreachable',
  modelRequestFailed: 'tamandua_model_request_failed',
  runStopped: 'tamandua_run_stopped',
  runFailed: 'tamandua_run_failed',
};
