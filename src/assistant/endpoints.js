// Endpoint URL policy for the model connection (docs/agent-product-requirements.md 6.2.1).
// Plain HTTP is fine for a local inference server on this machine and blocked everywhere else
// unless the user turns the insecure-HTTP override on, because a token over plain HTTP to a
// remote host is a token anyone on the path can read.

const { AssistantInputError } = require('./errors');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '[::ffff:127.0.0.1]']);

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  // IPv4 loopback range 127.0.0.0/8, and the IPv6-mapped form.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || /^::f{4}:127\./.test(host);
}

// Returns { url, effectiveUrl, insecure } or throws Error with a user-facing message.
// `effectiveUrl` is what the client will actually POST to, so the UI can show the truth
// instead of the raw text someone typed.
function normalizeEndpointUrl(input, { allowInsecureRemoteHttp = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new AssistantInputError('Enter the API base URL of your model endpoint.');
  if (raw.length > 2048) throw new AssistantInputError('That endpoint URL is too long.');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AssistantInputError('Enter a full endpoint URL, for example https://api.example.com/v1.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AssistantInputError('The endpoint must be an http or https URL.');
  if (!parsed.hostname) throw new AssistantInputError('The endpoint URL has no host name.');
  if (parsed.username || parsed.password) throw new AssistantInputError('Put credentials in the token field, not in the endpoint URL.');
  if (parsed.search || parsed.hash) throw new AssistantInputError('The endpoint URL must not carry a query string or fragment.');

  const insecure = parsed.protocol === 'http:';
  if (insecure && !isLoopbackHostname(parsed.hostname) && !allowInsecureRemoteHttp) {
    throw new AssistantInputError(`Plain HTTP is only allowed for a localhost endpoint. Use https:// for ${parsed.hostname}, or turn on "allow insecure HTTP" if you are sure the network path is yours.`);
  }
  const trailingPath = parsed.pathname.replace(/\/+$/, '');
  const effective = `${parsed.protocol}//${parsed.host}${trailingPath || '/v1'}`;
  const stored = `${parsed.protocol}//${parsed.host}${trailingPath}`;
  return { url: stored, effectiveUrl: effective, insecure, loopback: isLoopbackHostname(parsed.hostname) };
}

module.exports = { normalizeEndpointUrl, isLoopbackHostname };
