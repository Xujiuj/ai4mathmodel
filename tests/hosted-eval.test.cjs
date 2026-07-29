const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatMarkdown,
  parseArgs,
  requiredEnvironment,
  runPhase0Evaluation,
  validateConfig,
} = require('../scripts/eval-hosted-models.cjs');

function streamResponse(events, headers = {}) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
  let cursor = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: { getReader: () => ({ read: async () => (cursor < chunks.length ? { done: false, value: chunks[cursor++] } : { done: true }) }) },
  };
}

const rawConfig = {
  models: [{
    id: 'standard',
    protocol: 'openai',
    baseUrl: 'https://gw.example.com/v1/',
    model: 'reasoner',
    apiKeyEnv: 'HOSTED_EVAL_KEY',
  }],
};

test('validates Phase 0 config without accepting remote plaintext endpoints', () => {
  const config = validateConfig(rawConfig);
  assert.equal(config.models[0].baseUrl, 'https://gw.example.com/v1');
  assert.throws(() => validateConfig({
    ...rawConfig,
    models: [{ ...rawConfig.models[0], baseUrl: 'http://remote.example/v1' }],
  }), /HTTPS/);
  assert.deepEqual(requiredEnvironment(config, {}), [{ model: 'standard', variable: 'HOSTED_EVAL_KEY', configured: false }]);
});

test('parses explicit expensive-probe and output options', () => {
  assert.deepEqual(parseArgs(['--config', 'a.json', '--output', 'b.md', '--include-expensive']), {
    config: 'a.json',
    output: 'b.md',
    checkConfig: false,
    includeExpensive: true,
  });
});

test('runs a streamed tool and usage probe and emits an evidence matrix', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return streamResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'phase0_echo', arguments: '{"marker":"PHASE0_TOOL_OK"}' } }] } }] },
        '[DONE]',
      ], { 'x-cost': '0.01', 'x-balance': '9.99' });
    }
    return streamResponse([
      { choices: [{ delta: { content: 'PHASE0_TOOL_OK' } }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 8 } },
      '[DONE]',
    ]);
  };
  const report = await runPhase0Evaluation(validateConfig(rawConfig), {
    environment: { HOSTED_EVAL_KEY: 'test-key' },
    fetchImpl,
  });
  assert.equal(report.results[0].core.ok, true);
  assert.equal(report.results[0].core.toolCalling, true);
  assert.equal(report.results[0].core.usageReturned, true);
  assert.equal(report.results[0].core.authoritativeCostReturned, true);
  assert.equal(report.results[0].core.authoritativeBalanceReturned, true);
  assert.match(formatMarkdown(report), /standard \(reasoner\).*PASS.*PASS.*PASS.*PASS/);
});
