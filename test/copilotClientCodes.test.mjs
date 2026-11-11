// The client's failure codes must be the server's, spelled identically.
//
// `src/assistant/errors.js` owns the vocabulary and the transport puts those strings on the wire; the
// browser keeps its own copy only because a CommonJS module cannot be imported into the Vite client. A
// copy with nothing checking it is how a code becomes a silent no-op: `handleError` would fall through to
// the generic message and a person would read "Jarvis could not answer" where the app knew they had not
// accepted the disclosure, or had just pressed Stop.
//
// This is the drift guard that comment promises. It is an .mjs file because it has to import a .mjs module;
// `node --test` picks up both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JARVIS_CODES } from '../src/client/jarvisCodes.mjs';

const require = createRequire(import.meta.url);
const { ERROR_CODES } = require('../src/assistant/errors');

test('the client codes are the server codes', () => {
  assert.deepEqual(Object.keys(JARVIS_CODES).sort(), Object.keys(ERROR_CODES).sort(),
    'a code added on one side is missing on the other');
  for (const [name, value] of Object.entries(ERROR_CODES)) {
    assert.equal(JARVIS_CODES[name], value, `${name} differs: client says ${JARVIS_CODES[name]}`);
  }
});

test('every code is a jarvis_-prefixed snake_case name', () => {
  // The prefix is what makes a code recognisable in a log line next to CopilotKit's own
  // (`agent_run_failed`, `agent_connect_failed`), and it is what keeps our vocabulary from colliding with
  // a code the library adds in a future release.
  for (const [name, value] of Object.entries(JARVIS_CODES)) {
    assert.match(value, /^jarvis_[a-z_]+$/, `${name} is not prefixed: ${value}`);
    assert.ok(!value.includes('__') && !value.endsWith('_'), `${name} → ${value} is malformed`);
  }
});

test('the codes module stays dependency-free', () => {
  // It sits in the entry bundle's reach and is imported by the lazily loaded chat. If it ever grows an
  // import of CopilotKit — or of anything server-side — the 258 kB that is only fetched on the first click
  // would start arriving on every page load, which is the thing the lazy split exists to prevent.
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/client/jarvisCodes.mjs'), 'utf8');
  assert.doesNotMatch(source, /^\s*(import|export \{[^}]*\} from|const .*require\()/m, 'it must be a plain table');
  assert.doesNotMatch(source, /copilotkit/i, 'it must not pull the library into the entry chunk');
});
