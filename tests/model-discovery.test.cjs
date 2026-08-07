const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanBaseUrl,
  discoverModels,
  modelsEndpoint,
  parseModelIds,
} = require('../electron/model-discovery.cjs');

function streamResponse(value, { contentLength, chunkSize = Infinity } = {}) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  let offset = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const reader = {
    async read() {
      if (offset >= bytes.length) return { done: true };
      const end = Math.min(offset + chunkSize, bytes.length);
      const value = bytes.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    async cancel() {
      cancelCalls += 1;
      offset = bytes.length;
    },
    releaseLock() {
      releaseCalls += 1;
    },
  };
  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null },
      body: { getReader: () => reader },
    },
    state: { get cancelCalls() { return cancelCalls; }, get releaseCalls() { return releaseCalls; } },
  };
}

function jsonResponse(payload, options) {
  return streamResponse(payload, options).response;
}

test('builds protocol-specific model endpoints from a configured Base URL', () => {
  assert.equal(modelsEndpoint({ protocol: 'openai', baseUrl: 'https://example.com/v1/' }), 'https://example.com/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'ollama', baseUrl: 'http://localhost:11434' }), 'http://localhost:11434/api/tags');
  assert.equal(modelsEndpoint({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'anthropic', baseUrl: 'https://gateway.example/v1' }), 'https://gateway.example/v1/models');
  assert.equal(cleanBaseUrl('http://user:secret@localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(modelsEndpoint({ protocol: 'auto', baseUrl: 'https://custom.example/api/v1' }), 'https://custom.example/api/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'ollama', baseUrl: 'http://localhost:11434/api' }), 'http://localhost:11434/api/tags');
  assert.equal(modelsEndpoint({ protocol: 'openai', baseUrl: '' }), '');
  assert.equal(modelsEndpoint({ protocol: 'openai-responses', baseUrl: 'https://api.example/v1' }), 'https://api.example/v1/models');
  assert.throws(() => cleanBaseUrl('file:///tmp/models'), /HTTP/);
});

test('runs an opt-in minimal Responses inference after model discovery', async () => {
  const requests = [];
  const result = await discoverModels({ protocol: 'openai-responses', baseUrl: 'https://api.example/v1' }, {
    apiKey: 'secret',
    testInference: true,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') return jsonResponse({ data: [{ id: 'responses-model' }] });
      return streamResponse('{}').response;
    },
  });
  assert.equal(result.tested, true);
  assert.equal(requests[1].url, 'https://api.example/v1/responses');
  assert.equal(JSON.parse(requests[1].options.body).max_output_tokens, 1);
});

test('probes each text protocol with its native inference request', async () => {
  const cases = [
    ['openai', 'https://api.example/v1', 'https://api.example/v1/chat/completions', 'Bearer key'],
    ['openai-responses', 'https://api.example/v1', 'https://api.example/v1/responses', 'Bearer key'],
    ['anthropic', 'https://api.anthropic.com', 'https://api.anthropic.com/v1/messages', undefined],
    ['ollama', 'http://127.0.0.1:11434', 'http://127.0.0.1:11434/api/chat', 'Bearer key'],
  ];
  for (const [protocol, baseUrl, expectedUrl, authorization] of cases) {
    let request;
    await discoverModels({ protocol, baseUrl }, {
      apiKey: 'key',
      testInference: true,
      fetchImpl: async (url, options) => {
        if (options.method === 'GET') return jsonResponse(protocol === 'ollama' ? { models: [{ name: 'model' }] } : { data: [{ id: 'model' }] });
        request = { url, options, body: JSON.parse(options.body) };
        return streamResponse('{}').response;
      },
    });
    assert.equal(request.url, expectedUrl);
    assert.equal(request.options.headers.Authorization, authorization);
    assert.equal(request.body.model, 'model');
    assert.equal(request.body.max_tokens === 1 || request.body.max_output_tokens === 1 || request.body.options?.num_predict === 1, true);
  }
});

test('skips the paid inference probe for image discovery', async () => {
  const methods = [];
  const result = await discoverModels({ protocol: 'openai-responses', baseUrl: 'https://api.example/v1' }, {
    connectionType: 'image',
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return jsonResponse({ data: [{ id: 'image-model' }] });
    },
  });
  assert.equal('tested' in result, false);
  assert.deepEqual(methods, ['GET']);
});

test('parses OpenAI-compatible and Ollama model payloads', () => {
  assert.deepEqual(parseModelIds('openai', { data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }), ['a-model', 'z-model']);
  assert.deepEqual(parseModelIds('ollama', { models: [{ name: 'qwen3:32b' }, { model: 'gemma3:27b' }] }), ['gemma3:27b', 'qwen3:32b']);
});

test('queries models with the configured bearer credential', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: [{ id: 'model-b' }, { id: 'model-a' }] });
  };
  const result = await discoverModels(
    { protocol: 'openai', baseUrl: 'https://models.example/v1' },
    { fetchImpl, apiKey: 'test-secret', testInference: false },
  );
  assert.deepEqual(result.models, ['model-a', 'model-b']);
  assert.equal(request.url, 'https://models.example/v1/models');
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
});

test('queries Anthropic models with native API headers', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] });
  };
  const result = await discoverModels(
    { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    { fetchImpl, apiKey: 'anthropic-test-secret', testInference: false },
  );
  assert.deepEqual(result.models, ['claude-a', 'claude-b']);
  assert.equal(request.url, 'https://api.anthropic.com/v1/models');
  assert.equal(request.options.headers['x-api-key'], 'anthropic-test-secret');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  assert.equal('Authorization' in request.options.headers, false);
});

test('queries Anthropic models with a bearer credential when configured', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: [{ id: 'claude-test' }] });
  };
  const result = await discoverModels(
    { protocol: 'anthropic', authMode: 'bearer', baseUrl: 'https://gateway.example/v1' },
    { fetchImpl, apiKey: 'anthropic-auth-token', testInference: false },
  );
  assert.deepEqual(result.models, ['claude-test']);
  assert.equal(request.options.headers.Authorization, 'Bearer anthropic-auth-token');
  assert.equal('x-api-key' in request.options.headers, false);
});

test('follows bounded Anthropic model pagination', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return requests.length === 1
      ? jsonResponse({ data: [{ id: 'claude-b' }], has_more: true, last_id: 'claude-b' })
      : jsonResponse({ data: [{ id: 'claude-a' }], has_more: false });
  };
  const result = await discoverModels(
    { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    { fetchImpl, apiKey: 'test-secret', testInference: false },
  );
  assert.deepEqual(result.models, ['claude-a', 'claude-b']);
  assert.match(requests[1], /after_id=claude-b/);
});

test('rejects a declared oversized model-list response before opening its reader', async () => {
  let readerOpened = false;
  let requestSignal;
  await assert.rejects(
    discoverModels(
      { protocol: 'openai', baseUrl: 'https://models.example/v1' },
      {
        fetchImpl: async (_url, options) => {
          requestSignal = options.signal;
          return {
            ok: true,
            status: 200,
            headers: { get: () => String(2 * 1024 * 1024 + 1) },
            body: { getReader: () => { readerOpened = true; throw new Error('reader should not open'); } },
          };
        },
        testInference: false,
      },
    ),
    /模型服务响应过大/,
  );
  assert.equal(readerOpened, false);
  assert.equal(requestSignal.aborted, true);
});

test('bounds chunked probe responses and cleans up the reader on overflow', async () => {
  const modelList = jsonResponse({ data: [{ id: 'model' }] });
  const oversizedProbe = streamResponse('x'.repeat(2 * 1024 * 1024 + 1), { chunkSize: 64 * 1024 });
  let requestSignal;
  await assert.rejects(
    discoverModels(
      { protocol: 'openai', baseUrl: 'https://models.example/v1' },
      {
        fetchImpl: async (_url, options) => {
          requestSignal = options.signal;
          return options.method === 'GET' ? modelList : oversizedProbe.response;
        },
        testInference: true,
      },
    ),
    /模型推理测试响应过大/,
  );
  assert.equal(requestSignal.aborted, true);
  assert.equal(oversizedProbe.state.cancelCalls, 1);
  assert.equal(oversizedProbe.state.releaseCalls, 1);
});

test('rejects a single oversized chunk before copying it', async () => {
  const modelList = jsonResponse({ data: [{ id: 'model' }] });
  const oversizedProbe = streamResponse('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(
    discoverModels(
      { protocol: 'openai', baseUrl: 'https://models.example/v1' },
      {
        fetchImpl: async (_url, options) => options.method === 'GET' ? modelList : oversizedProbe.response,
        testInference: true,
      },
    ),
    /模型推理测试响应过大/,
  );
  assert.equal(oversizedProbe.state.cancelCalls, 1);
  assert.equal(oversizedProbe.state.releaseCalls, 1);
});

test('reads valid JSON model lists and text probe bodies through the bounded stream', async () => {
  const requests = [];
  const result = await discoverModels(
    { protocol: 'openai', baseUrl: 'https://models.example/v1' },
    {
      testInference: true,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return options.method === 'GET'
          ? jsonResponse({ data: [{ id: 'stream-model' }] })
          : streamResponse('OK').response;
      },
    },
  );
  assert.deepEqual(result.models, ['stream-model']);
  assert.equal(result.tested, true);
  assert.equal(requests.length, 2);
});
