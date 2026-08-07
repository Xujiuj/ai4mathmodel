const APPEARANCES = new Set(['light', 'dark', 'system']);
const CONNECTION_KEYS = Object.freeze(['coordinator', 'modeler', 'coder', 'writer', 'image']);
const LEGACY_CONNECTION_KEYS = Object.freeze(['reasoning', 'coding', 'writing', 'image']);
const CONNECTION_ALIASES = Object.freeze({
  coordinator: ['coordinator', 'supervisor', 'reasoning'],
  modeler: ['modeler', 'analysis', 'reasoning'],
  coder: ['coder', 'coding'],
  writer: ['writer', 'writing'],
  image: ['image'],
});
const PROTOCOLS = new Set(['openai', 'openai-responses', 'ollama', 'anthropic']);
const AUTH_MODES = new Set(['api-key', 'bearer']);
const MODES = new Set(['hosted', 'byok']);

const { DEFAULT_AGENT_POLICY, normalizeAgentPolicy } = require('./supervisor/contracts.cjs');

const EMPTY_CONNECTION = Object.freeze({
  provider: '',
  baseUrl: '',
  protocol: 'openai',
  model: '',
  allowInsecureRemote: false,
});

const EMPTY_TIERS = Object.freeze(Object.fromEntries([...CONNECTION_KEYS, ...LEGACY_CONNECTION_KEYS].map((key) => [key, ''])));

const DEFAULT_SETTINGS = Object.freeze({
  appearance: 'light',
  autoSave: true,
  compactMode: false,
  skipBudgetPrompt: false,
  mode: 'hosted',
  tiers: EMPTY_TIERS,
  agentPolicy: Object.freeze({ ...DEFAULT_AGENT_POLICY, researchEnabled: false }),
  pricingOverrides: Object.freeze({}),
  pythonSandbox: Object.freeze({ memoryLimitMB: 4096, allowNetwork: false }),
  connections: Object.freeze(Object.fromEntries([...CONNECTION_KEYS, ...LEGACY_CONNECTION_KEYS].map((key) => [key, EMPTY_CONNECTION]))),
});

function normalizePythonSandbox(raw = {}) {
  const memoryLimitMB = Number(raw.memoryLimitMB);
  return {
    memoryLimitMB: Number.isFinite(memoryLimitMB) ? Math.min(Math.max(memoryLimitMB, 256), 16384) : DEFAULT_SETTINGS.pythonSandbox.memoryLimitMB,
    allowNetwork: Boolean(raw.allowNetwork),
  };
}

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

function normalizeAuthMode(value) {
  return AUTH_MODES.has(value) ? value : 'api-key';
}

function normalizeConnection(source = {}) {
  return {
    provider: cleanText(source.provider, '', 80),
    baseUrl: cleanText(source.baseUrl, '', 2048),
    protocol: normalizeProtocol(source.protocol),
    model: cleanText(source.model, '', 160),
    authMode: normalizeAuthMode(source.authMode),
    allowInsecureRemote: Boolean(source.allowInsecureRemote),
  };
}

function normalizePricingOverrides(raw = {}) {
  const overrides = {};
  if (!raw || typeof raw !== 'object') return overrides;
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') continue;
    overrides[String(key).slice(0, 160)] = [Number(value[0]), Number(value[1]), typeof value[2] === 'number' ? Number(value[2]) : 0];
  }
  return overrides;
}

function normalizeTiers(raw = {}) {
  const tiers = {};
  for (const key of CONNECTION_KEYS) {
    tiers[key] = cleanText(CONNECTION_ALIASES[key].map((alias) => raw?.[alias]).find(Boolean), '', 40);
  }
  for (const key of LEGACY_CONNECTION_KEYS) tiers[key] = cleanText(raw?.[key], '', 40);
  return tiers;
}

function normalizeMode(raw = {}) {
  if (MODES.has(raw.mode)) return raw.mode;
  const configured = (source = {}) => Boolean(source.baseUrl || source.model || source.provider);
  const legacyConfigured = configured(raw) || [...CONNECTION_KEYS, ...LEGACY_CONNECTION_KEYS].some((key) => configured(raw.connections?.[key]));
  return legacyConfigured ? 'byok' : DEFAULT_SETTINGS.mode;
}

function normalizeSettings(raw = {}) {
  const appearance = APPEARANCES.has(raw.appearance) ? raw.appearance : DEFAULT_SETTINGS.appearance;
  const mode = normalizeMode(raw);
  const rawConnections = raw.connections || {};
  const legacyReasoning = rawConnections.reasoning || {
    provider: raw.provider,
    baseUrl: raw.baseUrl,
    model: raw.model,
    protocol: raw.protocol,
    allowInsecureRemote: raw.allowInsecureRemote,
  };
  const sourceFor = (key) => {
    for (const alias of CONNECTION_ALIASES[key]) {
      if (Object.prototype.hasOwnProperty.call(rawConnections, alias)) return rawConnections[alias] || {};
    }
    return ['coordinator', 'modeler', 'coder'].includes(key) ? legacyReasoning : {};
  };
  const canonicalConnections = Object.fromEntries(CONNECTION_KEYS.map((key) => [key, normalizeConnection(sourceFor(key))]));
  const connections = {
    ...canonicalConnections,
    // Keep persisted legacy names readable for older renderer/main-process callers.
    reasoning: canonicalConnections.modeler,
    coding: canonicalConnections.coder,
    writing: canonicalConnections.writer,
    image: canonicalConnections.image,
  };
  const pricingOverrides = normalizePricingOverrides(raw.pricingOverrides);
  const normalizedAgentPolicy = normalizeAgentPolicy({
    ...(raw.agentPolicy || {}),
    budget: {
      ...(raw.agentPolicy?.budget || {}),
      pricingOverrides: { ...pricingOverrides, ...(raw.agentPolicy?.budget?.pricingOverrides || {}) },
    },
  });
  return {
    appearance,
    autoSave: raw.autoSave !== false,
    compactMode: Boolean(raw.compactMode),
    skipBudgetPrompt: Boolean(raw.skipBudgetPrompt),
    mode,
    tiers: normalizeTiers(raw.tiers),
    agentPolicy: { ...normalizedAgentPolicy, researchEnabled: raw.agentPolicy?.researchEnabled === true },
    pricingOverrides,
    pythonSandbox: normalizePythonSandbox(raw.pythonSandbox),
    connections,
  };
}

function catalogModel(models, key) {
  return CONNECTION_ALIASES[key].map((alias) => models?.[alias]).find((value) => value) || '';
}

function catalogTierId(settings, catalog, key) {
  return settings.tiers[key]
    || CONNECTION_ALIASES[key].map((alias) => cleanText(catalog.defaultTiers?.[alias], '', 40)).find(Boolean)
    || '';
}

// Hosted connections are rebuilt from the signed service catalog.
function applyHostedCatalog(settings, catalog = {}) {
  const normalized = normalizeSettings(settings);
  if (normalized.mode !== 'hosted') return normalized;
  const baseUrl = cleanText(catalog.baseUrl, '', 2048);
  const canonicalConnections = Object.fromEntries(CONNECTION_KEYS.map((key) => {
    const tierId = catalogTierId(normalized, catalog, key);
    const tier = (Array.isArray(catalog.tiers) ? catalog.tiers : []).find((item) => item?.id === tierId);
    return [key, normalizeConnection({
      provider: 'hosted',
      baseUrl,
      protocol: 'openai',
      model: catalogModel(tier?.models, key) || tier?.model || '',
      authMode: 'bearer',
    })];
  }));
  return {
    ...normalized,
    connections: {
      ...canonicalConnections,
      reasoning: canonicalConnections.modeler,
      coding: canonicalConnections.coder,
      writing: canonicalConnections.writer,
      image: canonicalConnections.image,
    },
    pricingOverrides: {},
  };
}

function connectionKeyForStage(stage, { supervisor = false } = {}) {
  if (supervisor || stage === 'supervisor') return 'coordinator';
  if (stage === 'analysis' || stage === 'review') return 'modeler';
  if (stage === 'solving') return 'coder';
  if (stage === 'paper') return 'writer';
  return 'modeler';
}

function resolveModel(settings, stage) {
  const normalized = normalizeSettings(settings);
  return normalized.connections[connectionKeyForStage(stage)].model;
}

module.exports = {
  CONNECTION_KEYS,
  LEGACY_CONNECTION_KEYS,
  CONNECTION_ALIASES,
  DEFAULT_SETTINGS,
  MODES,
  applyHostedCatalog,
  connectionKeyForStage,
  normalizeSettings,
  resolveModel,
};
