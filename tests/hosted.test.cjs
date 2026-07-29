const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { applyHostedCatalog, normalizeSettings } = require('../electron/runtime-config.cjs');
const { PLACEHOLDER_LENGTH, parsePlaceholder, playbookPlaceholder } = require('../electron/hosted/playbook-ref.cjs');
const { createHostedSession } = require('../electron/hosted/session.cjs');
const { createHostedClient } = require('../electron/hosted/client.cjs');
const { hostedEndpoints } = require('../electron/hosted/endpoints.cjs');
const { openKey, sealKey, sign, verify } = require('../gateway/tokens.cjs');
const { spliceHead } = require('../gateway/server.cjs');

const CATALOG = {
  baseUrl: 'https://gw.example.com/v1',
  tiers: [{ id: 'standard', label: '标准', models: { reasoning: 'r-model', writing: 'w-model', image: 'i-model' } }],
  defaultTiers: { reasoning: 'standard', writing: 'standard', image: 'standard' },
};

function jsonResponse(payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => body };
}

test('hosted runs ignore locally configured endpoints and pricing overrides', () => {
  const raw = {
    mode: 'hosted',
    tiers: { reasoning: 'standard', writing: 'standard', image: 'standard' },
    connections: { reasoning: { baseUrl: 'https://attacker.example/v1', model: 'evil', protocol: 'anthropic' } },
    pricingOverrides: { 'openai:x': [1, 2, 3] },
  };
  // 配置期仍保留用户输入，便于随时切回自带模型。
  assert.equal(normalizeSettings(raw).connections.reasoning.baseUrl, 'https://attacker.example/v1');

  const effective = applyHostedCatalog(raw, CATALOG);
  for (const key of ['reasoning', 'writing', 'image']) {
    assert.equal(effective.connections[key].baseUrl, 'https://gw.example.com/v1');
    assert.equal(effective.connections[key].protocol, 'openai');
  }
  assert.equal(effective.connections.reasoning.model, 'r-model');
  assert.deepEqual(effective.pricingOverrides, {});
});

test('legacy configured installs stay on their own models', () => {
  const settings = normalizeSettings({ connections: { reasoning: { baseUrl: 'https://api.example/v1', model: 'm' } } });
  assert.equal(settings.mode, 'byok');
  assert.equal(settings.connections.reasoning.model, 'm');
});

test('hosted catalog supplies the effective connections', () => {
  const settings = applyHostedCatalog({ mode: 'hosted', tiers: { reasoning: 'standard' } }, CATALOG);
  assert.equal(settings.connections.reasoning.baseUrl, 'https://gw.example.com/v1');
  assert.equal(settings.connections.reasoning.model, 'r-model');
  assert.equal(settings.connections.writing.model, 'w-model');
  assert.equal(settings.connections.reasoning.protocol, 'openai');
});

test('playbook placeholder keeps a constant length and round-trips', () => {
  for (const stage of ['analysis', 'solving', 'paper', 'review', 'supervisor']) {
    const value = playbookPlaceholder({ stage, readOnly: stage === 'supervisor' });
    assert.equal(value.length, PLACEHOLDER_LENGTH);
    assert.deepEqual(parsePlaceholder(value), { stage, readOnly: stage === 'supervisor' });
  }
  assert.equal(parsePlaceholder('@@PB1|analysis...|xx|@@'), null);
  assert.equal(parsePlaceholder('not-a-placeholder'), null);
});

test('gateway splices the placeholder without parsing the whole body', () => {
  const placeholder = playbookPlaceholder({ stage: 'solving' });
  const body = Buffer.from(JSON.stringify({
    model: 'r-model',
    messages: [{ role: 'system', content: placeholder }, { role: 'user', content: '开始' }],
  }));
  const spliced = spliceHead(body, ({ stage, readOnly }) => `真实 playbook ${stage} ${readOnly}`);
  const parsed = JSON.parse(spliced.toString('utf8'));
  assert.equal(parsed.messages[0].content, '真实 playbook solving false');
  assert.equal(parsed.messages[1].content, '开始');
});

test('gateway rejects a body without a valid placeholder', () => {
  const body = Buffer.from(JSON.stringify({ messages: [{ role: 'system', content: '自定义提示词' }] }));
  assert.equal(spliceHead(body, () => 'x'), null);
});

test('sealed upstream keys survive a signed token round-trip and reject tampering', () => {
  const sealed = sealKey('sk-upstream', 'key-secret');
  assert.equal(openKey(sealed, 'key-secret'), 'sk-upstream');
  assert.throws(() => openKey(sealed, 'other-secret'));

  const token = sign({ exp: Math.floor(Date.now() / 1000) + 60, k: sealed, dev: 'device' }, 'token-secret');
  assert.equal(verify(token, 'token-secret').k, sealed);
  assert.throws(() => verify(token, 'wrong-secret'), /TOKEN_SIGNATURE_INVALID/);
  assert.throws(() => verify(sign({ exp: 1, k: sealed }, 'token-secret'), 'token-secret'), /TOKEN_EXPIRED/);
});

test('hosted session encrypts the credential and keeps a stable device id', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hosted-session-'));
  const file = path.join(directory, 'hosted-session.json');
  const codec = {
    seal: (value) => Buffer.from(value, 'utf8').toString('base64'),
    open: (value) => Buffer.from(value, 'base64').toString('utf8'),
  };
  try {
    const session = createHostedSession({ file, codec });
    await session.setCredential('jwt-value', 'user@example.com');
    const deviceId = await session.deviceId();
    assert.equal(deviceId.length, 64);

    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(raw.credential.includes('jwt-value'), false);

    const reopened = createHostedSession({ file, codec });
    assert.equal(await reopened.credential(), 'jwt-value');
    assert.equal(await reopened.deviceId(), deviceId);

    await reopened.clear();
    assert.equal(await createHostedSession({ file, codec }).credential(), '');
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('hosted client caches access tokens and maps upstream failures', async () => {
  const endpoints = hostedEndpoints({
    MODELING_HOSTED_GATEWAY: 'https://gw.example.com',
    MODELING_HOSTED_PORTAL: 'https://portal.example.com',
  });
  let issued = 0;
  let clock = 1_000_000;
  const session = {
    deviceId: async () => 'device',
    credential: async () => 'credential',
    setCredential: async () => {},
    clear: async () => {},
  };
  const client = createHostedClient({
    endpoints,
    session,
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/token')) {
        issued += 1;
        return jsonResponse({ accessToken: `token-${issued}`, expiresAt: clock + 15 * 60 * 1000 });
      }
      if (url.endsWith('/catalog')) return jsonResponse(CATALOG);
      if (url.endsWith('/account')) return jsonResponse({ balance: 12.5, currency: 'cny', email: 'a@b.c' });
      return jsonResponse({ error: 'x' }, 402);
    },
  });

  assert.equal(await client.accessToken(), 'token-1');
  assert.equal(await client.accessToken(), 'token-1');
  clock += 20 * 60 * 1000;
  assert.equal(await client.accessToken(), 'token-2');

  const catalog = await client.catalog();
  assert.equal(catalog.tiers[0].models.reasoning, 'r-model');

  const account = await client.account();
  assert.equal(account.balance, 12.5);
  assert.equal(account.currency, 'CNY');

  await assert.rejects(client.topUpUrl(), (error) => error.code === 'HOSTED_BALANCE_EXHAUSTED');
});

test('hosted client refuses to run without configured endpoints', async () => {
  const client = createHostedClient({
    endpoints: hostedEndpoints({}),
    session: { deviceId: async () => 'device', credential: async () => '' },
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(client.configured(), false);
  await assert.rejects(client.catalog(), (error) => error.code === 'HOSTED_NOT_CONFIGURED');
});
