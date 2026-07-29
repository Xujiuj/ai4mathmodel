const test = require('node:test');
const assert = require('node:assert/strict');

const {
  providerEndpoint,
  providerHeaders,
  runDirectAgent,
} = require('../electron/supervisor/direct-provider.cjs');

function jsonResponse(payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(body.length) : null },
    arrayBuffer: async () => body,
  };
}

function streamResponse(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
  let cursor = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (cursor < chunks.length ? { done: false, value: chunks[cursor++] } : { done: true }),
      }),
    },
  };
}

const tool = [{
  name: 'read_workspace_file',
  description: 'Read a text file.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
}];

test('builds direct provider endpoints and provider-specific credentials', () => {
  assert.equal(providerEndpoint({ protocol: 'openai', baseUrl: 'https://api.example/v1' }), 'https://api.example/v1/chat/completions');
  assert.equal(providerEndpoint({ protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434/api' }), 'http://127.0.0.1:11434/api/chat');
  assert.equal(providerEndpoint({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/messages');
  assert.equal(providerEndpoint({ protocol: 'anthropic', baseUrl: 'https://gateway.example/v1' }), 'https://gateway.example/v1/messages');
  assert.deepEqual(providerHeaders('anthropic', 'anthropic-secret'), {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': 'anthropic-secret',
  });
  assert.deepEqual(providerHeaders('anthropic', 'anthropic-auth-token', 'bearer'), {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    Authorization: 'Bearer anthropic-auth-token',
  });
});

test('runs an OpenAI-compatible tool loop through the configured endpoint', async () => {
  const requests = [];
  const result = await runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'openai-secret',
    systemPrompt: 'private instructions',
    prompt: 'analyze the problem',
    tools: tool,
    executeTool: async ({ name, input }) => ({ ok: true, name, input, content: 'source text' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return jsonResponse({
          choices: [{ message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"inputs/problem.txt"}' } }],
          } }],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: '阶段完成。' } }] });
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '阶段完成。');
  assert.equal(result.toolCallCount, 1);
  assert.equal(requests[0].url, 'https://models.example/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer openai-secret');
  assert.equal(requests[0].body.messages[0].role, 'system');
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  assert.match(requests[1].body.messages.at(-1).content, /source text/);
});

test('reassembles a streamed tool loop and reports streamed usage', async () => {
  const requests = [];
  const result = await runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://gw.example/v1', model: 'hosted-model' },
    apiKey: 'access-token',
    systemPrompt: '@@PB1|analysis....|rw|@@',
    prompt: '开始执行 analysis 阶段。',
    tools: tool,
    stream: true,
    extraHeaders: { 'X-Stage': 'analysis', 'X-Forbidden': 'drop-me' },
    executeTool: async () => ({ ok: true, content: 'source text' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return streamResponse([
          { choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_workspace', arguments: '{"path":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '_file', arguments: '"inputs/a.txt"}' } }] } }] },
          '[DONE]',
        ]);
      }
      return streamResponse([
        { choices: [{ delta: { content: '阶段' } }] },
        { choices: [{ delta: { content: '完成。' } }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
        '[DONE]',
      ]);
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '阶段完成。');
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(requests[0].options.headers.Accept, 'text/event-stream');
  assert.equal(requests[0].options.headers['X-Stage'], 'analysis');
  assert.equal('X-Forbidden' in requests[0].options.headers, false);
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
});

test('runs an Anthropic Messages tool loop with native tool results', async () => {
  const requests = [];
  const result = await runDirectAgent({
    connection: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-test' },
    apiKey: 'anthropic-secret',
    systemPrompt: 'private instructions',
    prompt: 'plan the work',
    tools: tool,
    executeTool: async () => ({ ok: true, content: 'workspace content' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_workspace_file', input: { path: 'inputs/problem.txt' } }],
          stop_reason: 'tool_use',
        });
      }
      return jsonResponse({ content: [{ type: 'text', text: '规划完成。' }], stop_reason: 'end_turn' });
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '规划完成。');
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].options.headers['x-api-key'], 'anthropic-secret');
  assert.equal(requests[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[0].body.tools[0].input_schema.type, 'object');
  assert.equal(requests[1].body.messages.at(-1).role, 'user');
  assert.equal(requests[1].body.messages.at(-1).content[0].type, 'tool_result');
});

test('returns sanitized provider failures without exposing internal instructions', async () => {
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'test-secret',
    systemPrompt: 'PRIVATE_INTERNAL_PROMPT_SENTINEL',
    prompt: 'task',
    tools: tool,
    executeTool: async () => ({ ok: true }),
    fetchImpl: async () => jsonResponse({ error: { message: 'PRIVATE_INTERNAL_PROMPT_SENTINEL' } }, 500),
  }), (error) => error.code === 'MODEL_UNAVAILABLE'
    && !error.message.includes('PRIVATE_INTERNAL_PROMPT_SENTINEL'));
});
