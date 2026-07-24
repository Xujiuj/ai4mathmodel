const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  importAnthropicConnection,
  importCodexConnection,
  parseToml,
} = require('../electron/local-model-config.cjs');

function virtualReader(files) {
  return async (file) => {
    if (Object.hasOwn(files, file)) return files[file];
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };
}

test('parses the direct connection fields from a Codex TOML provider', async () => {
  const home = path.join(process.cwd(), 'test-home');
  const configFile = path.join(home, '.codex', 'config.toml');
  const result = await importCodexConnection({
    home,
    environment: { TEST_DIRECT_KEY: 'direct-test-secret' },
    readFile: virtualReader({
      [configFile]: [
        'model_provider = "custom"',
        'model = "reasoning-model"',
        '[model_providers.custom]',
        'name = "Private gateway"',
        'base_url = "https://models.example/v1"',
        'wire_api = "responses"',
        'env_key = "TEST_DIRECT_KEY"',
      ].join('\n'),
    }),
  });

  assert.equal(result.connectionKey, 'reasoning');
  assert.equal(result.connection.provider, 'Private gateway');
  assert.equal(result.connection.protocol, 'openai');
  assert.equal(result.connection.baseUrl, 'https://models.example/v1');
  assert.equal(result.connection.model, 'reasoning-model');
  assert.equal(result.apiKey, 'direct-test-secret');
});

test('keeps only declared TOML values and rejects missing direct endpoints', async () => {
  const parsed = parseToml('model = "test"\n[model_providers.custom]\nbase_url = "https://example.test/v1"');
  assert.equal(parsed.root.model, 'test');
  assert.equal(parsed.sections['model_providers.custom'].base_url, 'https://example.test/v1');

  const home = path.join(process.cwd(), 'test-home-missing-url');
  await assert.rejects(
    importCodexConnection({
      home,
      environment: { UNDECLARED_SECRET: 'must-not-be-read' },
      readFile: virtualReader({ [path.join(home, '.codex', 'config.toml')]: 'model_provider = "custom"\nmodel = "x"' }),
    }),
    /Base URL/,
  );
});

test('imports Anthropic API keys and bearer tokens with the matching auth mode', async () => {
  const home = path.join(process.cwd(), 'anthropic-home');
  const apiKeyResult = await importAnthropicConnection({
    home,
    environment: {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-test',
      ANTHROPIC_API_KEY: 'anthropic-api-key',
    },
    readFile: virtualReader({}),
  });
  assert.equal(apiKeyResult.connectionKey, 'writing');
  assert.equal(apiKeyResult.connection.authMode, 'api-key');
  assert.equal(apiKeyResult.apiKey, 'anthropic-api-key');

  const bearerResult = await importAnthropicConnection({
    home,
    environment: {
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-token',
    },
    readFile: virtualReader({}),
  });
  assert.equal(bearerResult.connection.authMode, 'bearer');
  assert.equal(bearerResult.apiKey, 'anthropic-auth-token');
});
