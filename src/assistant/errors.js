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

module.exports = { AssistantInputError };
