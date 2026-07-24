const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanBaseUrl,
  discoverModels,
  modelsEndpoint,
  parseModelIds,
} = require('../electron/model-discovery.cjs');

test('builds protocol-specific model endpoints from a configured Base URL', () => {
  assert.equal(modelsEndpoint({ protocol: 'openai', baseUrl: 'https://example.com/v1/' }), 'https://example.com/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'ollama', baseUrl: 'http://localhost:11434' }), 'http://localhost:11434/api/tags');
  assert.equal(modelsEndpoint({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'anthropic', baseUrl: 'https://gateway.example/v1' }), 'https://gateway.example/v1/models');
  assert.equal(cleanBaseUrl('http://user:secret@localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(modelsEndpoint({ protocol: 'auto', baseUrl: 'https://custom.example/api/v1' }), 'https://custom.example/api/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'ollama', baseUrl: 'http://localhost:11434/api' }), 'http://localhost:11434/api/tags');
  assert.equal(modelsEndpoint({ protocol: 'openai', baseUrl: '' }), '');
  assert.throws(() => cleanBaseUrl('file:///tmp/models'), /HTTP/);
});

test('parses OpenAI-compatible and Ollama model payloads', () => {
  assert.deepEqual(parseModelIds('openai', { data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }), ['a-model', 'z-model']);
  assert.deepEqual(parseModelIds('ollama', { models: [{ name: 'qwen3:32b' }, { model: 'gemma3:27b' }] }), ['gemma3:27b', 'qwen3:32b']);
});

test('queries models with the configured bearer credential', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-b' }, { id: 'model-a' }] }) };
  };
  const result = await discoverModels(
    { protocol: 'openai', baseUrl: 'https://models.example/v1' },
    { fetchImpl, apiKey: 'test-secret' },
  );
  assert.deepEqual(result.models, ['model-a', 'model-b']);
  assert.equal(request.url, 'https://models.example/v1/models');
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
});

test('queries Anthropic models with native API headers', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] }) };
  };
  const result = await discoverModels(
    { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    { fetchImpl, apiKey: 'anthropic-test-secret' },
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
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-test' }] }) };
  };
  const result = await discoverModels(
    { protocol: 'anthropic', authMode: 'bearer', baseUrl: 'https://gateway.example/v1' },
    { fetchImpl, apiKey: 'anthropic-auth-token' },
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
      ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-b' }], has_more: true, last_id: 'claude-b' }) }
      : { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-a' }], has_more: false }) };
  };
  const result = await discoverModels(
    { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    { fetchImpl, apiKey: 'test-secret' },
  );
  assert.deepEqual(result.models, ['claude-a', 'claude-b']);
  assert.match(requests[1], /after_id=claude-b/);
});
