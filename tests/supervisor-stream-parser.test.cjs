const test = require('node:test');
const assert = require('node:assert/strict');

const { runDirectAgent } = require('../electron/supervisor/direct-provider.cjs');

function eofStreamResponse(payload, tracker = { cancelCalls: 0 }) {
  const encoder = new TextEncoder();
  const chunk = encoder.encode(`data: ${JSON.stringify(payload)}`);
  let consumed = false;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (consumed) return { done: true };
          consumed = true;
          return { done: false, value: chunk };
        },
        cancel: async () => { tracker.cancelCalls += 1; },
      }),
    },
  };
}

function trackedStreamResponse({ chunks = [], readError, cancelError } = {}, tracker = { cancelCalls: 0 }) {
  let cursor = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (readError) throw readError;
          if (cursor >= chunks.length) return { done: true };
          return { done: false, value: chunks[cursor++] };
        },
        cancel: async () => {
          tracker.cancelCalls += 1;
          if (cancelError) throw cancelError;
        },
      }),
    },
  };
}

function sseChunk(event) {
  return new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
}

test('SSE parser accepts a final data record without a trailing newline', async () => {
  const tracker = { cancelCalls: 0 };
  const result = await runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'test-secret',
    systemPrompt: 'system',
    prompt: 'finish',
    tools: [],
    executeTool: async () => ({ ok: true }),
    stream: true,
    fetchImpl: async () => eofStreamResponse({ choices: [{ delta: { content: 'complete' } }] }, tracker),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'complete');
  assert.equal(tracker.cancelCalls, 0);
});

test('SSE parser cancels the reader after an in-band provider error and preserves the provider error', async () => {
  const tracker = { cancelCalls: 0 };
  const primaryError = new Error('cancel failed');
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'test-secret',
    systemPrompt: 'system',
    prompt: 'fail',
    tools: [],
    executeTool: async () => ({ ok: true }),
    stream: true,
    fetchImpl: async () => trackedStreamResponse({
      chunks: [sseChunk({ error: { status: 502, message: 'upstream unavailable' } })],
      cancelError: primaryError,
    }, tracker),
  }), (error) => error.code === 'MODEL_UNAVAILABLE' && error.status === 502);
  assert.equal(tracker.cancelCalls, 1);
});

test('SSE parser cancels the reader after malformed data', async () => {
  const tracker = { cancelCalls: 0 };
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'test-secret',
    systemPrompt: 'system',
    prompt: 'malformed',
    tools: [],
    executeTool: async () => ({ ok: true }),
    stream: true,
    fetchImpl: async () => trackedStreamResponse({ chunks: [sseChunk('{not-json')] }, tracker),
  }), (error) => error.code === 'MODEL_RESPONSE_INVALID');
  assert.equal(tracker.cancelCalls, 1);
});

test('SSE parser cancels the reader when the response exceeds the size limit', async () => {
  const tracker = { cancelCalls: 0 };
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'test-secret',
    systemPrompt: 'system',
    prompt: 'oversized',
    tools: [],
    executeTool: async () => ({ ok: true }),
    stream: true,
    fetchImpl: async () => trackedStreamResponse({
      chunks: [{ length: 10 * 1024 * 1024 + 1 }],
    }, tracker),
  }), (error) => error.code === 'MODEL_RESPONSE_INVALID');
  assert.equal(tracker.cancelCalls, 1);
});

test('SSE parser cancels the reader after a read exception without masking it', async () => {
  const tracker = { cancelCalls: 0 };
  const readError = new Error('read failed');
  await assert.rejects(runDirectAgent({
    connection: { protocol: 'openai', baseUrl: 'https://models.example/v1', model: 'reasoner' },
    apiKey: 'test-secret',
    systemPrompt: 'system',
    prompt: 'read failure',
    tools: [],
    executeTool: async () => ({ ok: true }),
    stream: true,
    fetchImpl: async () => trackedStreamResponse({ readError }, tracker),
  }), (error) => error.code === 'MODEL_NETWORK_ERROR' && error.message.includes('网络连接异常'));
  assert.equal(tracker.cancelCalls, 1);
});
