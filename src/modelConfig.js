const emptyConnection = {
  provider: '',
  baseUrl: '',
  protocol: 'openai',
  model: '',
  authMode: 'api-key',
  allowInsecureRemote: false,
  apiKey: '',
  apiKeyConfigured: false,
  clearApiKey: false,
};

export const DEFAULT_SETTINGS = {
  appearance: 'light',
  autoSave: true,
  compactMode: false,
  skipBudgetPrompt: false,
  mode: 'hosted',
  agentPolicy: { researchEnabled: false },
  tiers: {
    coordinator: '', modeler: '', coder: '', writer: '', image: '',
    reasoning: '', coding: '', writing: '',
  },
  pythonSandbox: {
    memoryLimitMB: 4096,
    allowNetwork: false,
  },
  connections: {
    coordinator: { ...emptyConnection },
    modeler: { ...emptyConnection },
    coder: { ...emptyConnection },
    writer: { ...emptyConnection },
    image: { ...emptyConnection },
    reasoning: { ...emptyConnection },
    coding: { ...emptyConnection },
    writing: { ...emptyConnection },
  },
};

export const MODEL_CONNECTIONS = [
  ['coordinator', '协调与总控模型'],
  ['modeler', '分析与评审模型'],
  ['coder', '代码求解模型'],
  ['writer', '论文写作模型'],
  ['image', '生图模型（可选）'],
];

export const MODEL_PROTOCOLS = [
  ['openai', 'OpenAI 兼容'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic', 'Anthropic'],
  ['ollama', 'Ollama'],
];

export function modelProtocolsForConnection(connectionKey) {
  return MODEL_PROTOCOLS.filter(([protocol]) => connectionKey !== 'image' || protocol === 'openai');
}

export const CONNECTION_ALIASES = {
  coordinator: ['coordinator', 'supervisor', 'reasoning'],
  modeler: ['modeler', 'analysis', 'reasoning'],
  coder: ['coder', 'coding'],
  writer: ['writer', 'writing'],
  image: ['image'],
};

export function canonicalConnectionKey(key) {
  return MODEL_CONNECTIONS.some(([item]) => item === key)
    ? key
    : Object.entries(CONNECTION_ALIASES).find(([, aliases]) => aliases.includes(key))?.[0] || '';
}

function stageConnectionKey(stage) {
  if (stage === 'supervisor') return 'coordinator';
  if (stage === 'analysis' || stage === 'review') return 'modeler';
  if (stage === 'solving') return 'coder';
  if (stage === 'paper') return 'writer';
  return 'modeler';
}

function connectionForStage(settings, stage) {
  const key = stageConnectionKey(stage);
  const direct = settings?.connections?.[key];
  if (direct?.model || direct?.baseUrl || direct?.provider) return direct;
  return CONNECTION_ALIASES[key]
    .map((alias) => settings?.connections?.[alias])
    .find((connection) => connection?.model || connection?.baseUrl || connection?.provider) || direct;
}

export function modelForStage(settings, stage) {
  return connectionForStage(settings, stage)?.model || '未配置模型';
}

export function modelSummary(settings, stage) {
  const connection = connectionForStage(settings, stage);
  let endpoint = connection?.provider || '未配置服务';
  try {
    if (!connection?.provider && connection?.baseUrl) endpoint = new URL(connection.baseUrl).host;
  } catch {
    endpoint = '自定义服务';
  }
  return `${endpoint} · ${modelForStage(settings, stage)}`;
}
