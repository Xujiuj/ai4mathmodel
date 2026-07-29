const APPEARANCES = new Set(['light', 'dark', 'system']);
const CONNECTION_KEYS = Object.freeze(['reasoning', 'writing', 'image']);
const PROTOCOLS = new Set(['openai', 'ollama', 'anthropic']);
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

const EMPTY_TIERS = Object.freeze(Object.fromEntries(CONNECTION_KEYS.map((key) => [key, ''])));

const DEFAULT_SETTINGS = Object.freeze({
  appearance: 'light',
  autoSave: true,
  compactMode: false,
  skipBudgetPrompt: false,
  mode: 'hosted',
  tiers: EMPTY_TIERS,
  agentPolicy: DEFAULT_AGENT_POLICY,
  pricingOverrides: Object.freeze({}),
  pythonSandbox: Object.freeze({ memoryLimitMB: 4096, allowNetwork: false }),
  connections: Object.freeze(Object.fromEntries(CONNECTION_KEYS.map((key) => [key, EMPTY_CONNECTION]))),
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
  const protocol = normalizeProtocol(source.protocol);
  return {
    provider: cleanText(source.provider, '', 80),
    baseUrl: cleanText(source.baseUrl, '', 2048),
    protocol,
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
    overrides[String(key).slice(0, 160)] = [
      Number(value[0]),
      Number(value[1]),
      typeof value[2] === 'number' ? Number(value[2]) : 0,
    ];
  }
  return overrides;
}

function normalizeTiers(raw = {}) {
  return Object.fromEntries(CONNECTION_KEYS.map((key) => [key, cleanText(raw?.[key], '', 40)]));
}

function normalizeMode(raw = {}) {
  if (MODES.has(raw.mode)) return raw.mode;
  const configured = (source = {}) => Boolean(source.baseUrl || source.model || source.provider);
  const legacyConfigured = configured(raw)
    || CONNECTION_KEYS.some((key) => configured(raw.connections?.[key]));
  return legacyConfigured ? 'byok' : DEFAULT_SETTINGS.mode;
}

function normalizeSettings(raw = {}) {
  const appearance = APPEARANCES.has(raw.appearance) ? raw.appearance : DEFAULT_SETTINGS.appearance;
  const mode = normalizeMode(raw);
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
  const pricingOverrides = normalizePricingOverrides(raw.pricingOverrides);
  const agentPolicy = normalizeAgentPolicy({
    ...(raw.agentPolicy || {}),
    budget: {
      ...(raw.agentPolicy?.budget || {}),
      pricingOverrides: {
        ...pricingOverrides,
        ...(raw.agentPolicy?.budget?.pricingOverrides || {}),
      },
    },
  });

  return {
    appearance,
    autoSave: raw.autoSave !== false,
    compactMode: Boolean(raw.compactMode),
    skipBudgetPrompt: Boolean(raw.skipBudgetPrompt),
    mode,
    tiers: normalizeTiers(raw.tiers),
    agentPolicy,
    pricingOverrides,
    pythonSandbox: normalizePythonSandbox(raw.pythonSandbox),
    connections,
  };
}

// 托管态的三类连接完全由服务端 catalog 重建，本地填写的地址、模型与定价覆盖不参与托管链路。
function applyHostedCatalog(settings, catalog = {}) {
  const normalized = normalizeSettings(settings);
  if (normalized.mode !== 'hosted') return normalized;
  const baseUrl = cleanText(catalog.baseUrl, '', 2048);
  const connections = Object.fromEntries(CONNECTION_KEYS.map((key) => {
    const tierId = normalized.tiers[key] || cleanText(catalog.defaultTiers?.[key], '', 40);
    const tier = (Array.isArray(catalog.tiers) ? catalog.tiers : []).find((item) => item?.id === tierId);
    return [key, normalizeConnection({
      provider: 'hosted',
      baseUrl,
      protocol: 'openai',
      model: tier?.models?.[key] || tier?.model || '',
      authMode: 'bearer',
    })];
  }));
  return { ...normalized, connections, pricingOverrides: {} };
}

function resolveModel(settings, stage) {
  const normalized = normalizeSettings(settings);
  return normalized.connections[stage === 'paper' ? 'writing' : 'reasoning'].model;
}

module.exports = {
  CONNECTION_KEYS,
  DEFAULT_SETTINGS,
  MODES,
  applyHostedCatalog,
  normalizeSettings,
  resolveModel,
};
