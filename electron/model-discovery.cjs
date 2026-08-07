const MAX_PROBE_RESPONSE_BYTES = 2 * 1024 * 1024;

function responseContentLength(response) {
  const value = response?.headers?.get?.('content-length');
  if (value === undefined || value === null || value === '') return 0;
  const length = Number(value);
  return Number.isNaN(length) || length < 0 ? 0 : length;
}

async function readBoundedResponse(response, { controller, parseJson = false, errorMessage }) {
  const rejectOversized = () => {
    controller?.abort();
    throw new Error(errorMessage);
  };
  if (responseContentLength(response) > MAX_PROBE_RESPONSE_BYTES) rejectOversized();
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error('模型服务响应读取失败。');

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result?.done) break;
      const value = result?.value || [];
      const chunkBytes = typeof value === 'string'
        ? Buffer.byteLength(value)
        : Number(value?.byteLength ?? value?.length ?? 0);
      if (!Number.isFinite(chunkBytes) || chunkBytes < 0) throw new Error('模型服务响应读取失败。');
      totalBytes += chunkBytes;
      if (totalBytes > MAX_PROBE_RESPONSE_BYTES) {
        controller?.abort();
        try {
          await reader.cancel?.();
        } catch {
          // The request is already being aborted; cleanup is best effort.
        }
        throw new Error(errorMessage);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }

  const text = Buffer.concat(chunks, totalBytes).toString('utf8');
  return parseJson ? JSON.parse(text) : text;
}

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
  if (['openai-responses', 'openai_responses', 'responses'].includes(settings.protocol)) return 'openai-responses';
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

async function discoverModels(settings, {
  fetchImpl,
  apiKey = '',
  timeoutMs = 10000,
  testInference,
  connectionType = '',
  isImage = false,
} = {}) {
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
      headers['anthropic-version'] = '2023-06-01';
      if (settings.authMode === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
      else headers['x-api-key'] = apiKey;
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
      const payload = await readBoundedResponse(response, {
        controller,
        parseJson: true,
        errorMessage: '模型服务响应过大。',
      });
      models.push(...parseModelIds(provider, payload));
      if (provider !== 'anthropic' || !payload?.has_more || !payload?.last_id) break;
      const next = new URL(endpoint);
      next.searchParams.set('after_id', String(payload.last_id));
      requestUrl = next.toString();
    }
    const uniqueModels = [...new Set(models)].sort((a, b) => a.localeCompare(b, 'en'));
    if (!uniqueModels.length) throw new Error('服务已连接，但没有返回可用模型。');
    // A model list only proves metadata access. Text connections also perform a
    // bounded one-token native probe; image discovery explicitly leaves it off.
    const shouldTestInference = testInference === undefined ? connectionType !== 'image' && !isImage : Boolean(testInference);
    if (shouldTestInference && connectionType !== 'image' && !isImage) {
      const model = uniqueModels[0];
      const baseUrl = cleanBaseUrl(settings.baseUrl, { allowInsecureRemote: Boolean(settings.allowInsecureRemote) });
      const probeEndpoint = provider === 'openai-responses'
        ? `${baseUrl.replace(/\/v1(?:\/.*)?$/i, '')}/v1/responses`
        : provider === 'anthropic'
          ? `${baseUrl.replace(/\/v1(?:\/.*)?$/i, '')}/v1/messages`
          : provider === 'ollama'
            ? `${baseUrl.replace(/\/api(?:\/.*)?$/i, '')}/api/chat`
            : `${baseUrl.replace(/\/chat\/completions$|\/models$/i, '')}/chat/completions`;
      const body = provider === 'openai-responses'
        ? { model, input: [{ role: 'user', content: 'Reply with OK.' }], max_output_tokens: 1 }
        : provider === 'anthropic'
          ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] }
          : provider === 'ollama'
            ? { model, stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }], options: { num_predict: 1 } }
            : { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 };
      const probe = await fetchImpl(probeEndpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!probe.ok) throw new Error(`模型推理测试返回 HTTP ${probe.status}。`);
      await readBoundedResponse(probe, {
        controller,
        errorMessage: '模型推理测试响应过大。',
      });
    }
    const tested = Boolean(shouldTestInference && connectionType !== 'image' && !isImage);
    return tested ? { models: uniqueModels, endpoint, tested: true } : { models: uniqueModels, endpoint };
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
