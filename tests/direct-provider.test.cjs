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

function streamResponse(events, requestId = '') {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
  let cursor = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'x-request-id' ? requestId : null },
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
  assert.equal(providerEndpoint({ protocol: 'openai-responses', baseUrl: 'https://api.example/v1' }), 'https://api.example/v1/responses');
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

test('runs an OpenAI Responses tool loop with native input items', async () => {
  const requests = [];
  const result = await runDirectAgent({
    connection: { protocol: 'openai-responses', baseUrl: 'https://api.example/v1', model: 'reasoner' },
    apiKey: 'responses-secret',
    systemPrompt: 'private instructions',
    prompt: 'inspect the file',
    tools: tool,
    executeTool: async () => ({ ok: true, content: 'source text' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) return jsonResponse({ output: [{ type: 'function_call', call_id: 'call-1', name: 'read_workspace_file', arguments: '{"path":"inputs/problem.txt"}' }], usage: { input_tokens: 3, output_tokens: 2 } });
      return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] });
    },
  });
  assert.equal(result.stdout, 'done');
  assert.equal(requests[0].url, 'https://api.example/v1/responses');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer responses-secret');
  assert.equal(requests[0].body.input[0].role, 'developer');
  assert.equal(requests[1].body.input.at(-1).type, 'function_call_output');
});

test('reassembles streamed OpenAI Responses text and usage', async () => {
  const result = await runDirectAgent({
    connection: { protocol: 'openai-responses', baseUrl: 'https://gw.example/v1', model: 'hosted-model' },
    prompt: 'say hello',
    tools: tool,
    stream: true,
    executeTool: async () => ({ ok: true }),
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2 } } },
      ]);
    },
  });
  assert.equal(result.stdout, 'hello');
  assert.equal(result.usage.inputTokens, 4);
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
    extraHeaders: { 'X-Stage': 'analysis', 'X-Pipeline-Id': 'pipeline-1', 'X-Forbidden': 'drop-me' },
    executeTool: async () => ({ ok: true, content: 'source text' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return streamResponse([
          { choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_workspace', arguments: '{"path":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '_file', arguments: '"inputs/a.txt"}' } }] } }] },
          '[DONE]',
        ], 'req-tool');
      }
      return streamResponse([
        { choices: [{ delta: { content: '阶段' } }] },
        { choices: [{ delta: { content: '完成。' } }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
        '[DONE]',
      ], 'req-final');
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '阶段完成。');
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 30);
  assert.deepEqual(result.requestIds, ['req-tool', 'req-final']);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(requests[0].options.headers.Accept, 'text/event-stream');
  assert.equal(requests[0].options.headers['X-Stage'], 'analysis');
  assert.equal(requests[0].options.headers['X-Pipeline-Id'], 'pipeline-1');
  assert.equal('X-Forbidden' in requests[0].options.headers, false);
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
});

test('maps an in-band OpenAI upstream 502 to a retryable provider failure', async () => {
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://gw.example/v1', model: 'hosted-model' },
    apiKey: 'access-token',
    systemPrompt: '@@PB1|analysis....|rw|@@',
    prompt: 'start analysis',
    tools: tool,
    stream: true,
    executeTool: async () => ({ ok: true }),
    fetchImpl: async () => streamResponse([{
      error: {
        type: 'upstream_error',
        code: 'upstream_error',
        message: 'Recovered upstream error 502: temporarily overloaded.',
      },
    }], 'req-in-band-502'),
  }), (error) => error.code === 'MODEL_UNAVAILABLE'
    && error.status === 502
    && error.requestId === 'req-in-band-502');
});

test('reconnects a retryable provider request without restarting the tool loop', async () => {
  const requests = [];
  let toolExecutions = 0;
  const result = await runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://gw.example/v1', model: 'hosted-model' },
    apiKey: 'access-token',
    systemPrompt: '@@PB1|analysis....|rw|@@',
    prompt: 'start analysis',
    tools: tool,
    stream: false,
    maxProviderAttempts: 5,
    executeTool: async () => {
      toolExecutions += 1;
      return { ok: true, content: 'source text' };
    },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length <= 2) {
        return jsonResponse({ error: { message: 'temporarily overloaded' } }, 502);
      }
      if (requests.length === 3) {
        return jsonResponse({ choices: [{ message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"inputs/problem.txt"}' } }],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'complete' } }] });
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'complete');
  assert.equal(result.toolCallCount, 1);
  assert.equal(toolExecutions, 1);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].messages.at(-1).role, 'user');
  assert.equal(requests[1].messages.at(-1).role, 'user');
  assert.equal(requests[3].messages.at(-1).role, 'tool');
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

test('keeps the upstream request id when a streamed response is invalid', async () => {
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://gw.example/v1', model: 'hosted-model' },
    apiKey: 'access-token',
    systemPrompt: '@@PB1|analysis....|rw|@@',
    prompt: '开始执行 analysis 阶段。',
    tools: tool,
    stream: true,
    executeTool: async () => ({ ok: true }),
    fetchImpl: async () => streamResponse(['[DONE]'], 'req-invalid'),
  }), (error) => error.code === 'MODEL_RESPONSE_INVALID'
    && error.requestId === 'req-invalid'
    && error.requestIds?.[0] === 'req-invalid');
});

test('compacts OpenAI history without splitting tool call groups or leaking old tool output', async () => {
  const requests = [];
  const toolOutput = 'OPENAI_TOOL_OUTPUT_SENTINEL '.repeat(1200);
  let turn = 0;
  const result = await runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'openai-secret',
    systemPrompt: 'private instructions',
    prompt: 'long-running analysis',
    tools: tool,
    executeTool: async () => ({ ok: true, content: toolOutput }),
    maxTurns: 24,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (turn < 16) {
        const id = `call-${turn}`;
        turn += 1;
        return jsonResponse({ choices: [{ message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"inputs/problem.txt"}' } }],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'complete' } }] });
    },
  });

  assert.equal(result.code, 0);
  const messages = requests.at(-1).messages.slice(1);
  assert.ok(messages.length <= 28);
  const summary = messages.find((message) => message.role === 'user' && typeof message.content === 'string'
    && message.content.includes('Earlier context compacted'));
  assert.ok(summary);
  assert.equal(summary.content.includes('OPENAI_TOOL_OUTPUT_SENTINEL'), false);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    const previous = messages[index - 1];
    assert.equal(previous?.role, 'assistant');
    assert.ok(previous.tool_calls?.some((call) => call.id === message.tool_call_id));
  }
});

test('compacts Anthropic history without splitting tool_use and tool_result groups', async () => {
  const requests = [];
  const toolOutput = 'ANTHROPIC_TOOL_OUTPUT_SENTINEL '.repeat(1200);
  let turn = 0;
  const result = await runDirectAgent({
    connection: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-test' },
    apiKey: 'anthropic-secret',
    systemPrompt: 'private instructions',
    prompt: 'long-running analysis',
    tools: tool,
    executeTool: async () => ({ ok: true, content: toolOutput }),
    maxTurns: 24,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (turn < 16) {
        const id = `toolu-${turn}`;
        turn += 1;
        return jsonResponse({
          content: [{ type: 'tool_use', id, name: 'read_workspace_file', input: { path: 'inputs/problem.txt' } }],
          stop_reason: 'tool_use',
        });
      }
      return jsonResponse({ content: [{ type: 'text', text: 'complete' }], stop_reason: 'end_turn' });
    },
  });

  assert.equal(result.code, 0);
  const messages = requests.at(-1).messages;
  assert.ok(messages.length <= 28);
  const firstUserText = messages[0].content;
  const summaryText = Array.isArray(firstUserText)
    ? firstUserText.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    : String(firstUserText || '');
  assert.match(summaryText, /Earlier context compacted/);
  assert.equal(summaryText.includes('ANTHROPIC_TOOL_OUTPUT_SENTINEL'), false);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const toolResults = message.content.filter((item) => item.type === 'tool_result');
    if (!toolResults.length) continue;
    const previous = messages[index - 1];
    assert.equal(previous?.role, 'assistant');
    const toolUseIds = new Set((previous.content || []).filter((item) => item.type === 'tool_use').map((item) => item.id));
    for (const resultBlock of toolResults) assert.equal(toolUseIds.has(resultBlock.tool_use_id), true);
  }
});
