// README.md says "No cloud account, telemetry, or analytics are configured." CopilotKit's default is
// the opposite: the runtime constructor fires an event and every run captures
// `oss.runtime.copilot_request_created`, both of which POST to https://telemetry.copilotkit.ai/ingest.
// src/assistant/copilotRuntime.js and server.js set the documented kill switch, and this file is what
// keeps that claim honest — including proof that the measurement would notice if it weren't.
//
// Each case runs in a child process on purpose. The telemetry client is a process-wide singleton and the
// env defaults are applied at require time, so a parent that flipped them mid-suite would be testing its
// own bookkeeping rather than the library's behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Boots the real endpoint, drives one HTTP run and one runLocal, and reports every host a fetch call
// tried to reach. Non-loopback calls are answered from the stub and never leave the process — the point
// is to see the attempt, not to make it. `node -e` evaluates CommonJS, so there is no top-level await:
// the whole probe runs inside an async IIFE.
const PROBE_BODY = [
  "const recorder = { hosts: [], urls: [] };",
  "const realFetch = globalThis.fetch;",
  // hostname, not host: `new URL('http://127.0.0.1:57090/x').host` carries the port, which would make
  // the app's own request to itself look like an outbound one.
  "const isLoopback = (hostname) => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';",
  "globalThis.fetch = async (input, init) => {",
  "  const url = typeof input === 'string' ? input : (input && input.url) || String(input);",
  "  let hostname = 'unparsable';",
  "  try { hostname = new URL(url).hostname; } catch { /* record it anyway */ }",
  "  recorder.hosts.push(hostname); recorder.urls.push(url);",
  "  if (isLoopback(hostname)) return realFetch(input, init);",
  "  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });",
  "};",
  // An explicit key so nothing in the child touches the macOS Keychain of whoever runs the suite.
  "process.env.JARVIS_ASSISTANT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';",
  "delete process.env.JARVIS_ASSISTANT_KEY_FILE;",
  "const fs = require('node:fs'); const os = require('node:os');",
  "const { createApp } = require('" + path.join(ROOT, 'src/app.js') + "');",
  "const copilot = require('" + path.join(ROOT, 'src/assistant/copilotRuntime.js') + "');",
  "const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-telemetry-'));",
  "const { app, db } = createApp({ dataDir, assistantMcpUrl: () => 'http://127.0.0.1:1/mcp' });",
  "const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });",
  "const url = 'http://127.0.0.1:' + server.address().port + copilot.COPILOT_BASE_PATH;",
  "const frame = JSON.stringify({ method: 'agent/run', params: { agentId: 'jarvis' }, body: { threadId: '1', runId: 'probe-1', tools: [], context: [], state: {}, forwardedProps: {}, messages: [{ id: 'm', role: 'user', content: 'any funds this month?' }] } });",
  "await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: frame }).then((r) => r.text());",
  // The card path: the same runtime, no socket. It raises the same capture, so it is covered too.
  "await copilot.createCopilotModule().runLocal({ agentId: 'echo', threadId: 'local-1', message: 'card', forwardedProps: { placement: 'overview', period: '2026-01' } });",
  // Sends are fire-and-forget inside the library; give them a chance to reach the stub.
  "await new Promise((resolve) => setTimeout(resolve, 500));",
  "server.closeAllConnections && server.closeAllConnections();",
  "await new Promise((resolve) => server.close(resolve));",
  "db.close();",
  "fs.rmSync(dataDir, { recursive: true, force: true });",
  "console.log(JSON.stringify({ hosts: recorder.hosts, urls: recorder.urls, disabled: process.env.COPILOTKIT_TELEMETRY_DISABLED, dnt: process.env.DO_NOT_TRACK }));",
].join('\n');

const PROBE = `(async () => {\n${PROBE_BODY}\n})().catch((error) => { console.error(error); process.exit(1); });`;

// The child starts from a known environment: the variables under test are absent unless a case says
// otherwise, so "absent" means what a plain `npm start` would see rather than whatever this shell holds.
function childEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.JARVIS_ASSISTANT_KEY;
  delete env.JARVIS_ASSISTANT_KEY_FILE;
  delete env.COPILOTKIT_TELEMETRY_DISABLED;
  delete env.DO_NOT_TRACK;
  return { ...env, ...overrides };
}

function runProbe(overrides) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['-e', PROBE], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, env: childEnv(overrides), stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    assert.fail(`the telemetry probe did not finish: ${error.message}\n${error.stderr || ''}`);
  }
  return JSON.parse(stdout.trim().split('\n').pop());
}

const isLoopback = (hostname) => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
const outboundOf = (probe) => probe.urls.filter((url) => { try { return !isLoopback(new URL(url).hostname); } catch { return true; } });

test('nothing leaves the machine while the assistant runs', () => {
  const probe = runProbe({});
  // The guard applied its own default because nothing said otherwise.
  assert.equal(probe.disabled, '1');
  // The chat has to have actually run for the absence of outbound traffic to mean anything.
  assert.ok(probe.urls.some((url) => url.endsWith('/api/copilotkit')), `the probe never reached the endpoint: ${JSON.stringify(probe.urls)}`);
  assert.deepEqual(outboundOf(probe), [], `outbound requests: ${JSON.stringify(outboundOf(probe))}`);
});

test('the recorder is not deaf: with the kill switch overridden off, CopilotKit does phone home', () => {
  // The negative control, and the reason the case above means anything. If `fetch` were stubbed in a
  // place the library never calls, or the send had moved to another host, both tests would "pass".
  const probe = runProbe({ COPILOTKIT_TELEMETRY_DISABLED: 'false', DO_NOT_TRACK: 'false' });
  const outbound = outboundOf(probe);
  assert.ok(outbound.length > 0, 'no outbound request even with telemetry enabled — the recorder needs fixing');
  assert.match(outbound.join(' '), /telemetry\.copilotkit\.ai\/ingest/);
});

test('the default is applied only when the operator said nothing', () => {
  // `??=` semantics, in both directions. The override case is also what makes the negative control
  // above work, but asserting the value keeps a future hard assignment from sneaking in: an operator
  // who turns telemetry on must be able to.
  assert.deepEqual(
    [runProbe({}).disabled, runProbe({}).dnt],
    ['1', '1'],
    'unset should default to disabled',
  );
  const overridden = runProbe({ COPILOTKIT_TELEMETRY_DISABLED: 'false', DO_NOT_TRACK: 'false' });
  assert.equal(overridden.disabled, 'false', 'the module overwrote an explicit operator setting');
  assert.equal(overridden.dnt, 'false');
});
