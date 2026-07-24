const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_CONFIG_BYTES = 256 * 1024;
const VALID_ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;

function cleanText(value, limit = 2048) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function safeSecret(value) {
  const secret = String(value || '').trim();
  return secret && secret.length <= 8192 && !/[\r\n\u0000]/.test(secret) ? secret : '';
}

function stripTomlComment(value) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && !escaped) quote = '';
      escaped = character === '\\' && !escaped;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') return value.slice(0, index);
  }
  return value;
}

function parseTomlValue(value) {
  const text = cleanText(value, 8192);
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

function parseToml(text) {
  const root = {};
  const sections = {};
  let current = root;
  for (const originalLine of String(text || '').split(/\r?\n/)) {
    const line = stripTomlComment(originalLine).trim();
    if (!line) continue;
    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (section) {
      current = sections[section[1]] || {};
      sections[section[1]] = current;
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (assignment) current[assignment[1]] = parseTomlValue(assignment[2]);
  }
  return { root, sections };
}

async function readOptional(file, readFile = fs.readFile) {
  try {
    const content = await readFile(file, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw new Error('本地配置文件过大，已拒绝导入。');
    return content;
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function readJsonEnvironment(content) {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content);
    const environment = parsed?.env || parsed?.environment || {};
    return environment && typeof environment === 'object' && !Array.isArray(environment) ? environment : {};
  } catch {
    return {};
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

function environmentValue(environment, name) {
  return VALID_ENV_KEY.test(String(name || '')) ? safeSecret(environment?.[name]) : '';
}

async function importCodexConnection({ home = os.homedir(), environment = process.env, readFile = fs.readFile } = {}) {
  const file = path.join(home, '.codex', 'config.toml');
  const content = await readOptional(file, readFile);
  if (!content) throw new Error('未找到本地 Codex 配置文件。');

  const config = parseToml(content);
  const providerId = cleanText(config.root.model_provider, 80);
  const provider = config.sections[`model_providers.${providerId}`] || {};
  const wireApi = cleanText(provider.wire_api || config.root.wire_api, 80).toLowerCase();
  const protocol = wireApi.includes('anthropic') ? 'anthropic' : wireApi.includes('ollama') ? 'ollama' : 'openai';
  const baseUrl = firstText(provider.base_url, config.root.base_url);
  if (!baseUrl) throw new Error('本地 Codex 配置中未找到可直连的 Base URL。');

  const envKey = firstText(provider.env_key, config.root.env_key);
  const apiKey = environmentValue(environment, envKey) || safeSecret(provider.api_key || config.root.api_key);
  return {
    connectionKey: 'reasoning',
    connection: {
      provider: firstText(provider.name, providerId, '本地 Codex 配置'),
      protocol,
      baseUrl,
      model: firstText(config.root.model, provider.model),
      allowInsecureRemote: false,
      authMode: protocol === 'anthropic' && wireApi.includes('bearer') ? 'bearer' : 'api-key',
    },
    apiKey,
    message: apiKey ? '已导入本地 Codex 连接与密钥，保存后生效。' : '已导入本地 Codex 连接，请补充密钥后保存。',
  };
}

async function importAnthropicConnection({ home = os.homedir(), environment = process.env, readFile = fs.readFile } = {}) {
  const files = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude.json'),
  ];
  const environments = [environment];
  for (const file of files) environments.push(readJsonEnvironment(await readOptional(file, readFile)));

  const fromEnvironment = (key) => firstText(...environments.map((item) => item?.[key]));
  const baseUrl = fromEnvironment('ANTHROPIC_BASE_URL');
  if (!baseUrl) throw new Error('本地 Anthropic 配置中未找到可直连的 Base URL。');

  const apiKey = safeSecret(fromEnvironment('ANTHROPIC_API_KEY'));
  const authToken = safeSecret(fromEnvironment('ANTHROPIC_AUTH_TOKEN'));
  return {
    connectionKey: 'writing',
    connection: {
      provider: '本地 Anthropic 配置',
      protocol: 'anthropic',
      baseUrl,
      model: firstText(fromEnvironment('ANTHROPIC_MODEL'), fromEnvironment('ANTHROPIC_DEFAULT_SONNET_MODEL')),
      allowInsecureRemote: false,
      authMode: apiKey ? 'api-key' : authToken ? 'bearer' : 'api-key',
    },
    apiKey: apiKey || authToken,
    message: apiKey || authToken ? '已导入本地 Anthropic 连接与凭据，保存后生效。' : '已导入本地 Anthropic 连接，请补充密钥后保存。',
  };
}

async function importLocalModelConfig(source, options = {}) {
  if (source === 'codex') return importCodexConnection(options);
  if (source === 'anthropic') return importAnthropicConnection(options);
  throw new Error('不支持的本地配置来源。');
}

module.exports = {
  importAnthropicConnection,
  importCodexConnection,
  importLocalModelConfig,
  parseToml,
};
