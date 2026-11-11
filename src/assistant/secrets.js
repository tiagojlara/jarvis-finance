// Encryption for the model endpoint token at rest.
//
// The database row holds only ciphertext; the key lives outside it, in one of three places,
// tried in this order (docs/agent-product-requirements.md 6.2.1: OS credential store
// preferred, a documented local provisioning method if not, and never the key beside the
// ciphertext):
//
//   env      — the configured assistant key, for headless machines, CI, or a chosen secret manager.
//              First, because setting it is an explicit statement of intent: honouring it
//              before the Keychain keeps a provisioned machine from silently creating a
//              Keychain item nobody asked for (and keeps tests off the user's keychain).
//   keychain — macOS Keychain item, via /usr/bin/security. Nothing is written to disk.
//   file     — the configured key file (default ~/.config/jarvis-finance/assistant.key),
//              created 0600 on first use. Refused if it would sit inside the data directory.
//
// Every encrypted value records which source made its key, and decrypting asks *that* source
// — never the current preference order. Otherwise a Keychain item lost and silently replaced
// on the next start would make an existing token undecryptable with a confusing error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const KEYCHAIN_SERVICE = 'jarvis-finance-assistant';
const KEYCHAIN_ACCOUNT = 'model-endpoint-key';
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.config', 'jarvis-finance', 'assistant.key');
const SOURCE_LABELS = { keychain: 'macOS Keychain', env: 'TAMANDUA_ASSISTANT_KEY', file: 'local key file' };

class SecretKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

function normalizeKey(raw, source) {
  const text = String(raw || '').trim();
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) key = Buffer.from(text, 'base64');
  else if (text.length >= 32) key = crypto.createHash('sha256').update(text).digest();
  if (!key || key.length !== KEY_BYTES) {
    throw new SecretKeyError(`The ${source} encryption key must be 64 hex characters (or 32 base64 bytes).`);
  }
  return key;
}

function isMissingKeychainItem(error) {
  // `security find-generic-password` exits 44 when the item does not exist. Anything else
  // (denied access, no binary, timeout) must not be answered by overwriting the item.
  return error?.code === 44 || /could not be found/i.test(String(error?.stderr || error?.message || ''));
}

async function keyFromKeychain({ create }) {
  try {
    const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeout: 8000, maxBuffer: 64 * 1024 });
    return normalizeKey(stdout, 'macOS Keychain');
  } catch (error) {
    if (!create || !isMissingKeychainItem(error)) {
      throw new Error(create ? 'item exists but could not be read' : 'no item yet, or access is not available');
    }
    const secret = crypto.randomBytes(KEY_BYTES).toString('hex');
    await run('/usr/bin/security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', secret,
      '-D', 'jarvis-finance', '-l', 'jarvis-finance assistant model endpoint key'], { timeout: 8000 });
    return normalizeKey(secret, 'macOS Keychain');
  }
}

async function keyFromFile(filePath, { create }) {
  const absolute = path.resolve(filePath);
  try {
    return normalizeKey(fs.readFileSync(absolute, 'utf8'), 'key file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`could not be read (${error.code || error.message})`);
    if (!create) throw new Error('does not exist yet');
    const secret = crypto.randomBytes(KEY_BYTES).toString('hex');
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(absolute, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw new Error(`could not be created (${writeError.code || writeError.message})`);
    }
    return normalizeKey(fs.readFileSync(absolute, 'utf8'), 'key file');
  }
}

// Resolves the key for a recorded source, or (no source) the best available one.
// `create: false` makes it read-only, for the Settings display. Returns { key, source } and
// never puts key material in a return value or an error message.
async function resolveKey({ source, env = process.env, dataDir, platform = os.platform(), create = true } = {}) {
  const environment = env || {};
  // Keep the original Keychain item and default file path stable across the brand rename.
  const keyFile = environment.TAMANDUA_ASSISTANT_KEY_FILE || environment.JARVIS_ASSISTANT_KEY_FILE || DEFAULT_KEY_FILE;
  if (dataDir) {
    const relative = path.relative(path.resolve(dataDir), path.resolve(keyFile));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      throw new SecretKeyError(`The key file ${keyFile} sits inside the data directory, where the database lives. Set TAMANDUA_ASSISTANT_KEY_FILE to a path outside it.`);
    }
  }

  const order = source ? [source] : ['env', 'keychain', 'file'];
  const failures = [];
  for (const candidate of order) {
    try {
      if (candidate === 'keychain') {
        if (platform !== 'darwin') throw new Error('the macOS Keychain is only available on macOS');
        return { key: await keyFromKeychain({ create }), source: 'keychain' };
      }
      if (candidate === 'env') {
        const configuredKey = environment.JARVIS_ASSISTANT_KEY || environment.TAMANDUA_ASSISTANT_KEY;
        if (!configuredKey) throw new Error('TAMANDUA_ASSISTANT_KEY is not set');
        return { key: normalizeKey(configuredKey, 'assistant'), source: 'env' };
      }
      if (candidate === 'file') return { key: await keyFromFile(keyFile, { create }), source: 'file' };
      throw new Error(`"${candidate}" is not a known key source`);
    } catch (error) {
      const reason = error instanceof SecretKeyError
        ? error.message
        : (candidate === 'file' ? `the key file ${keyFile} ${error.message}` : error.message);
      failures.push(`${candidate}: ${reason}`);
      // A recorded source that fails is fatal — a different key would only produce a
      // padding/auth-tag error later and blame the token.
      if (source) {
        if (error instanceof SecretKeyError) throw error;
        throw new SecretKeyError(`Could not load the ${candidate} encryption key the saved token needs (${reason}).`);
      }
    }
  }
  throw new SecretKeyError(`No usable encryption key (${failures.join('; ')}). Set TAMANDUA_ASSISTANT_KEY or TAMANDUA_ASSISTANT_KEY_FILE, or allow Keychain access for Tamanduá.`);
}

async function encryptSecret(plaintext, options = {}) {
  const { key, source } = await resolveKey(options);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: VERSION,
    alg: ALGORITHM,
    keySource: source,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  });
}

async function decryptSecret(record, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(record);
  } catch {
    throw new SecretKeyError('The stored token is not a valid encrypted value. Save the token again in Settings.');
  }
  if (!parsed || parsed.v !== VERSION || parsed.alg !== ALGORITHM) throw new SecretKeyError('The stored token uses an unsupported encryption format. Save the token again in Settings.');
  const { key } = await resolveKey({ ...options, source: parsed.keySource });
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretKeyError(`The stored token could not be decrypted with the current ${SOURCE_LABELS[parsed.keySource] || parsed.keySource} key. If that key changed, save the token again in Settings.`);
  }
}

// Where the key would come from, for the Settings display. Read-only: the UI must not
// create a Keychain item or a key file as a side effect of loading the page.
async function describeKeySource(options = {}) {
  try {
    const { source } = await resolveKey({ ...options, create: false });
    const detail = source === 'file' ? (options.env?.TAMANDUA_ASSISTANT_KEY_FILE || options.env?.JARVIS_ASSISTANT_KEY_FILE || DEFAULT_KEY_FILE) : '';
    return { source, label: detail ? `${SOURCE_LABELS[source]} · ${detail}` : SOURCE_LABELS[source] };
  } catch (error) {
    return { source: null, label: null, error: error.message };
  }
}

module.exports = {
  encryptSecret, decryptSecret, resolveKey, describeKeySource, SecretKeyError,
  KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, DEFAULT_KEY_FILE, SOURCE_LABELS,
};
