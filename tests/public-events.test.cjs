const test = require('node:test');
const assert = require('node:assert/strict');

const { toPublicPipelineEvent } = require('../electron/public-events.cjs');

test('public pipeline events normalize history without exposing private payloads', () => {
  const event = toPublicPipelineEvent({
    type: 'run.started',
    runId: 'run-private',
    createdAt: '2026-08-04T00:00:00.000Z',
    payload: {
      prompt: 'PRIVATE_PROMPT_SENTINEL',
      apiKey: 'PRIVATE_API_KEY_SENTINEL',
      toolArgs: { command: 'PRIVATE_TOOL_SENTINEL' },
    },
  });

  assert.equal(event.type, 'pipeline-progress');
  assert.equal(event.status, 'running');
  assert.equal(Object.hasOwn(event, 'payload'), false);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_(PROMPT|API_KEY|TOOL)_SENTINEL/);
});

test('unsupported private event types are omitted from public history', () => {
  assert.equal(toPublicPipelineEvent({ type: 'tool.output', payload: { stdout: 'PRIVATE_STDOUT_SENTINEL' } }), null);
});
