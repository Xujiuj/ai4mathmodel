function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function isBlockedMetadataHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === '169.254.169.254'
    || host === 'metadata.google.internal'
    || host === 'metadata.aws.internal'
    || host.startsWith('fe80:')
    || host === '0.0.0.0'
    || host === '::';
}

function cleanBaseUrl(value, { allowInsecureRemote = false } = {}) {
  const input = String(value || '').trim();
  if (!input) return '';
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Base URL 格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL 仅支持 HTTP 或 HTTPS。');
  }
  if (isBlockedMetadataHost(parsed.hostname)) throw new Error('Base URL 指向受保护的系统元数据地址。');
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname) && !allowInsecureRemote) {
    throw new Error('远程模型服务必须使用 HTTPS；局域网 HTTP 需要显式启用明文连接。');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString().replace(/\/$/, '');
}

function connectionProtocol(settings = {}) {
  if (settings.protocol === 'anthropic') return 'anthropic';
  if (settings.protocol === 'ollama') return 'ollama';
  return 'openai';
}

function modelsEndpoint(settings = {}) {
  const provider = connectionProtocol(settings);
  const baseUrl = cleanBaseUrl(settings.baseUrl, { allowInsecureRemote: Boolean(settings.allowInsecureRemote) });
  if (!baseUrl) return '';
  if (provider === 'ollama') {
    return `${baseUrl.replace(/\/api(?:\/.*)?$/i, '')}/api/tags`;
  }
  if (provider === 'anthropic') {
    const root = /\/v1(?:\/.*)?$/i.test(baseUrl) ? baseUrl.replace(/\/v1(?:\/.*)?$/i, '') : baseUrl;
    return `${root}/v1/models`;
  }
  return `${baseUrl.replace(/\/models$/i, '')}/models`;
}

function parseModelIds(provider, payload) {
  const records = provider === 'ollama' ? payload?.models : payload?.data;
  if (!Array.isArray(records)) return [];
  return [...new Set(records
    .map((item) => provider === 'ollama' ? item?.name || item?.model : item?.id)
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'en'));
}

async function discoverModels(settings, { fetchImpl, apiKey = '', timeoutMs = 10000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持模型查询。');
  const provider = connectionProtocol(settings);
  const endpoint = modelsEndpoint(settings);
  if (!endpoint) {
    throw new Error('请先填写 Base URL，再查询模型。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (apiKey && provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const models = [];
    let requestUrl = endpoint;
    for (let page = 0; page < 5; page += 1) {
      const response = await fetchImpl(requestUrl, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('模型服务鉴权失败，请检查密钥。');
        }
        throw new Error(`模型服务返回 HTTP ${response.status}。`);
      }
      const payload = await response.json();
      models.push(...parseModelIds(provider, payload));
      if (provider !== 'anthropic' || !payload?.has_more || !payload?.last_id) break;
      const next = new URL(endpoint);
      next.searchParams.set('after_id', String(payload.last_id));
      requestUrl = next.toString();
    }
    const uniqueModels = [...new Set(models)].sort((a, b) => a.localeCompare(b, 'en'));
    if (!uniqueModels.length) throw new Error('服务已连接，但没有返回可用模型。');
    return { models: uniqueModels, endpoint };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模型查询超时，请检查 Base URL 和服务状态。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  cleanBaseUrl,
  connectionProtocol,
  discoverModels,
  isBlockedMetadataHost,
  isLoopbackHost,
  modelsEndpoint,
  parseModelIds,
};
