const emptyConnection = {
  provider: '',
  baseUrl: '',
  protocol: 'openai',
  model: '',
  allowInsecureRemote: false,
  apiKey: '',
  apiKeyConfigured: false,
  clearApiKey: false,
};

export const DEFAULT_SETTINGS = {
  appearance: 'light',
  autoSave: true,
  compactMode: false,
  connections: {
    reasoning: { ...emptyConnection },
    writing: { ...emptyConnection },
    image: { ...emptyConnection },
  },
};

export const MODEL_CONNECTIONS = [
  ['reasoning', '推理与代码模型'],
  ['writing', '文本模型'],
  ['image', '生图模型（可选）'],
];

export function modelForStage(settings, stage) {
  const connection = settings?.connections?.[stage === 'paper' ? 'writing' : 'reasoning'];
  return connection?.model || '未配置模型';
}

export function modelSummary(settings, stage) {
  const connection = settings?.connections?.[stage === 'paper' ? 'writing' : 'reasoning'];
  let endpoint = connection?.provider || '未配置服务';
  try {
    if (!connection?.provider && connection?.baseUrl) endpoint = new URL(connection.baseUrl).host;
  } catch {
    endpoint = '自定义服务';
  }
  return `${endpoint} · ${modelForStage(settings, stage)}`;
}
