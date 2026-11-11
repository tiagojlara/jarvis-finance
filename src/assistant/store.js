// The assistant's own settings records, in the `assistant_settings` table.
//
// This table is separate from the finance `settings` table on purpose: the browser loads
// /api/settings on every start and /api/backup dumps it, so anything stored there is by
// definition client-visible and backup-carried. The model token must be neither
// (docs/agent-product-requirements.md 6.2.1 and FR: "the dedicated encrypted settings record
// is the only database location for the token"). The token gets its own row, encrypted,
// and nothing here ever returns it — Settings shows whether one is saved, not what it is.

const { encryptSecret, decryptSecret, describeKeySource } = require('./secrets');
const { normalizeEndpointUrl } = require('./endpoints');
const { AssistantInputError } = require('./errors');

const KEYS = {
  baseUrl: 'model.base_url',
  model: 'model.id',
  token: 'model.token',
  tokenSavedAt: 'model.token_saved_at',
  allowInsecure: 'model.allow_insecure_http',
  disabledTools: 'mcp.disabled_tools',
  serverEnabled: 'mcp.enabled',
  disclosureAcknowledgedAt: 'disclosure.acknowledged_at',
};

const KEY_SOURCE_TTL_MS = 30_000;

function createAssistantStore(db, { keyOptions = {} } = {}) {
  const read = (key) => db.prepare('SELECT value FROM assistant_settings WHERE key = ?').get(key)?.value;
  const write = (key, value) => db.prepare(`INSERT INTO assistant_settings(key, value, updated_at) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);
  const readJson = (key, fallback) => {
    const raw = read(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };

  // Keychain access can block for seconds on a locked keychain, and Settings only needs a
  // label, so cache it per process.
  let keySourceCache = null;
  let keySourceAt = 0;
  async function keySource() {
    if (keySourceCache && Date.now() - keySourceAt < KEY_SOURCE_TTL_MS) return keySourceCache;
    keySourceCache = await describeKeySource({ ...keyOptions });
    keySourceAt = Date.now();
    return keySourceCache;
  }

  function rawModelSettings() {
    const baseUrl = read(KEYS.baseUrl) || '';
    const model = read(KEYS.model) || '';
    const allowInsecure = readJson(KEYS.allowInsecure, false) === true;
    let effective = null;
    let invalid = null;
    if (baseUrl) {
      try {
        effective = normalizeEndpointUrl(baseUrl, { allowInsecureRemoteHttp: allowInsecure }).effectiveUrl;
      } catch (error) {
        invalid = error.message;
      }
    }
    // `ready` lives here rather than in publicSettings so that internal callers (the summary
    // card, the agent) can check it without awaiting the key-source label.
    return {
      baseUrl,
      model,
      allowInsecure,
      effectiveUrl: effective,
      invalidTokenUrl: invalid,
      tokenConfigured: read(KEYS.token) !== undefined,
      tokenSavedAt: read(KEYS.tokenSavedAt) || null,
      ready: Boolean(baseUrl && model && read(KEYS.token) !== undefined && !invalid),
    };
  }

  async function publicSettings() {
    const settings = rawModelSettings();
    return {
      ...settings,
      keySource: await keySource(),
      disabledTools: readJson(KEYS.disabledTools, []),
      mcpEnabled: readJson(KEYS.serverEnabled, true) !== false,
      disclosureAcknowledgedAt: read(KEYS.disclosureAcknowledgedAt) || null,
    };
  }

  // Any string is accepted as a token and stored encrypted. Passing `token` replaces it;
  // `clearToken` removes the row. Neither can read back the stored value.
  async function saveModelSettings({ baseUrl, model, token, clearToken, allowInsecureHttp }) {
    if (baseUrl !== undefined) {
      const allowInsecure = allowInsecureHttp === undefined ? readJson(KEYS.allowInsecure, false) === true : allowInsecureHttp === true;
      write(KEYS.baseUrl, normalizeEndpointUrl(baseUrl, { allowInsecureRemoteHttp: allowInsecure }).url);
    }
    if (model !== undefined) {
      const trimmed = String(model || '').trim();
      if (trimmed.length > 200) throw new AssistantInputError('That model identifier is too long.');
      write(KEYS.model, trimmed);
    }
    if (allowInsecureHttp !== undefined) {
      // Re-validate a URL that was saved while the override was on and is now off.
      const nextAllowInsecure = allowInsecureHttp === true;
      write(KEYS.allowInsecure, JSON.stringify(nextAllowInsecure));
      if (read(KEYS.baseUrl)) normalizeEndpointUrl(read(KEYS.baseUrl), { allowInsecureRemoteHttp: nextAllowInsecure });
    }
    if (clearToken === true) {
      db.prepare('DELETE FROM assistant_settings WHERE key IN (?,?)').run(KEYS.token, KEYS.tokenSavedAt);
    } else if (token !== undefined && token !== '') {
      const value = String(token);
      if (value.length > 4096) throw new AssistantInputError('That token is too long.');
      write(KEYS.token, await encryptSecret(value, keyOptions));
      write(KEYS.tokenSavedAt, new Date().toISOString());
    }
    return publicSettings();
  }

  // For the model client only. Never call this on a path that answers the browser.
  async function modelConfig() {
    const settings = rawModelSettings();
    if (!settings.baseUrl || !settings.model) throw new Error('No model endpoint is configured. Open Settings & backup → Model endpoint and enter a base URL, a model identifier and a token.');
    if (!settings.tokenConfigured) throw new Error('This endpoint needs an API token. Add it under Settings & backup → Model endpoint.');
    if (settings.invalidTokenUrl) throw new Error(settings.invalidTokenUrl);
    const token = await decryptSecret(read(KEYS.token), keyOptions);
    return { baseUrl: settings.effectiveUrl, model: settings.model, token };
  }

  function acknowledgement() {
    return { acknowledgedAt: read(KEYS.disclosureAcknowledgedAt) || null };
  }

  function acknowledgeDisclosure() {
    const stamp = new Date().toISOString();
    write(KEYS.disclosureAcknowledgedAt, stamp);
    return { acknowledgedAt: stamp };
  }

  function toolState() {
    const disabled = new Set(readJson(KEYS.disabledTools, []));
    return { disabled, enabled: readJson(KEYS.serverEnabled, true) !== false };
  }

  function setToolEnabled(name, enabled) {
    const { disabled } = toolState();
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    write(KEYS.disabledTools, JSON.stringify([...disabled].sort()));
    return toolState();
  }

  function setMcpEnabled(enabled) {
    write(KEYS.serverEnabled, JSON.stringify(enabled === true));
    return toolState();
  }

  return { rawModelSettings, publicSettings, saveModelSettings, modelConfig, acknowledgement, acknowledgeDisclosure, toolState, setToolEnabled, setMcpEnabled, KEYS, read };
}

module.exports = { createAssistantStore, KEYS };
