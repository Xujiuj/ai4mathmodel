const APPEARANCES = new Set(['light', 'dark', 'system']);
const CONNECTION_KEYS = Object.freeze(['reasoning', 'writing', 'image']);
const PROTOCOLS = new Set(['openai', 'ollama', 'anthropic']);

const EMPTY_CONNECTION = Object.freeze({
  provider: '',
  baseUrl: '',
  protocol: 'openai',
  model: '',
  allowInsecureRemote: false,
});

const DEFAULT_SETTINGS = Object.freeze({
  appearance: 'light',
  autoSave: true,
  compactMode: false,
  connections: Object.freeze(Object.fromEntries(CONNECTION_KEYS.map((key) => [key, EMPTY_CONNECTION]))),
});

function cleanText(value, fallback = '', limit = 512) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
  return text || fallback;
}

function normalizeProtocol(value) {
  if (value === 'auto') return 'openai';
  if (PROTOCOLS.has(value)) return value;
  return 'openai';
}

function normalizeConnection(source = {}) {
  const protocol = normalizeProtocol(source.protocol);
  return {
    provider: cleanText(source.provider, '', 80),
    baseUrl: cleanText(source.baseUrl, '', 2048),
    protocol,
    model: cleanText(source.model, '', 160),
    allowInsecureRemote: Boolean(source.allowInsecureRemote),
  };
}

function normalizeSettings(raw = {}) {
  const appearance = APPEARANCES.has(raw.appearance) ? raw.appearance : DEFAULT_SETTINGS.appearance;
  const legacyReasoning = {
    provider: raw.provider,
    baseUrl: raw.baseUrl,
    model: raw.model,
    protocol: raw.protocol,
    allowInsecureRemote: raw.allowInsecureRemote,
  };
  const connections = Object.fromEntries(CONNECTION_KEYS.map((key) => {
    const source = raw.connections?.[key] || (key === 'reasoning' ? legacyReasoning : {});
    return [key, normalizeConnection(source)];
  }));

  return {
    appearance,
    autoSave: raw.autoSave !== false,
    compactMode: Boolean(raw.compactMode),
    connections,
  };
}

function resolveModel(settings, stage) {
  const normalized = normalizeSettings(settings);
  return normalized.connections[stage === 'paper' ? 'writing' : 'reasoning'].model;
}

module.exports = {
  CONNECTION_KEYS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveModel,
};
