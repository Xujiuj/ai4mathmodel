const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { applyHostedCatalog, normalizeSettings } = require('../electron/runtime-config.cjs');
const { PLACEHOLDER_LENGTH, parsePlaceholder, playbookPlaceholder } = require('../electron/hosted/playbook-ref.cjs');
const { createHostedSession } = require('../electron/hosted/session.cjs');
const { createHostedClient } = require('../electron/hosted/client.cjs');
const { hostedEndpoints, isPinnedGatewayCertificate } = require('../electron/hosted/endpoints.cjs');
const { certificateVerificationResult, registerHostedCertificatePin } = require('../electron/hosted/tls-pinning.cjs');
const { openKey, sealKey, sign, verify } = require('../gateway/tokens.cjs');
const { spliceHead } = require('../gateway/server.cjs');
const { createGateway } = require('../gateway/server.cjs');

const CATALOG = {
  baseUrl: 'https://gw.example.com/v1',
  tiers: [{ id: 'standard', label: '标准', models: { reasoning: 'r-model', coding: 'c-model', writing: 'w-model', image: 'i-model' } }],
  defaultTiers: { reasoning: 'standard', coding: 'standard', writing: 'standard', image: 'standard' },
  topUpEnabled: false,
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
  for (const key of ['reasoning', 'coding', 'writing', 'image']) {
    assert.equal(effective.connections[key].baseUrl, 'https://gw.example.com/v1');
    assert.equal(effective.connections[key].protocol, 'openai');
  }
  assert.equal(effective.connections.reasoning.model, 'r-model');
  assert.equal(effective.connections.coding.model, 'c-model');
  assert.deepEqual(effective.pricingOverrides, {});
});

test('legacy configured installs stay on their own models', () => {
  const settings = normalizeSettings({ connections: { reasoning: { baseUrl: 'https://api.example/v1', model: 'm' } } });
  assert.equal(settings.mode, 'byok');
  assert.equal(settings.connections.reasoning.model, 'm');
});

test('accepts a self-signed gateway certificate only when its origin and SHA-256 fingerprint match', () => {
  const fingerprint = 'AA'.repeat(32);
  const endpoints = hostedEndpoints({
    MODELING_HOSTED_GATEWAY: 'https://124.221.155.102:8080/agent',
    MODELING_HOSTED_PORTAL: 'https://124.221.155.102:8080/agent',
    MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256: fingerprint,
  });
  assert.equal(endpoints.gatewayCertificateFingerprint256, Array(32).fill('AA').join(':'));
  assert.equal(isPinnedGatewayCertificate({
    url: 'https://124.221.155.102:8080/agent/health',
    fingerprint256: endpoints.gatewayCertificateFingerprint256,
    endpoints,
  }), true);
  assert.equal(isPinnedGatewayCertificate({
    url: 'https://124.221.155.102/agent/health',
    fingerprint256: endpoints.gatewayCertificateFingerprint256,
    endpoints,
  }), false);
  assert.equal(isPinnedGatewayCertificate({
    url: 'https://124.221.155.102:8080/agent/health',
    fingerprint256: 'BB'.repeat(32),
    endpoints,
  }), false);
});

test('certificate pin handler permits only the configured self-signed gateway certificate', () => {
  let handler;
  const app = { on: (event, callback) => { if (event === 'certificate-error') handler = callback; } };
  const endpoints = hostedEndpoints({
    MODELING_HOSTED_GATEWAY: 'https://124.221.155.102:8080/agent',
    MODELING_HOSTED_PORTAL: 'https://124.221.155.102:8080/agent',
    MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256: 'AA'.repeat(32),
  });
  registerHostedCertificatePin(app, () => endpoints);
  let prevented = false;
  let accepted = null;
  handler({ preventDefault: () => { prevented = true; } }, null, 'https://124.221.155.102:8080/agent/health', 'net::ERR_CERT_AUTHORITY_INVALID', {
    fingerprint256: Array(32).fill('AA').join(':'),
  }, (value) => { accepted = value; });
  assert.equal(prevented, true);
  assert.equal(accepted, true);

  prevented = false;
  accepted = null;
  handler({ preventDefault: () => { prevented = true; } }, null, 'https://124.221.155.102:8080/agent/health', 'net::ERR_CERT_DATE_INVALID', {
    fingerprint256: Array(32).fill('AA').join(':'),
  }, (value) => { accepted = value; });
  assert.equal(prevented, false);
  assert.equal(accepted, false);
});

test('session certificate verifier preserves trusted certificates and pins only the hosted gateway', () => {
  const endpoints = hostedEndpoints({
    MODELING_HOSTED_GATEWAY: 'https://124.221.155.102:8080/agent',
    MODELING_HOSTED_PORTAL: 'https://124.221.155.102:8080/agent',
    MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256: 'AA'.repeat(32),
  });
  const getEndpoints = () => endpoints;

  assert.equal(certificateVerificationResult({ verificationResult: 'OK' }, getEndpoints), 0);
  assert.equal(certificateVerificationResult({
    verificationResult: 'ERR_CERT_AUTHORITY_INVALID',
    hostname: '124.221.155.102',
    certificate: { fingerprint256: Array(32).fill('AA').join(':') },
  }, getEndpoints), 0);
  assert.equal(certificateVerificationResult({
    verificationResult: 'ERR_CERT_AUTHORITY_INVALID',
    hostname: 'other.example',
    certificate: { fingerprint256: Array(32).fill('AA').join(':') },
  }, getEndpoints), -2);
  assert.equal(certificateVerificationResult({
    verificationResult: 'ERR_CERT_DATE_INVALID',
    hostname: '124.221.155.102',
    certificate: { fingerprint256: Array(32).fill('AA').join(':') },
  }, getEndpoints), -2);
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

test('gateway binds short tokens to devices and reconciles usage by request id', async () => {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      upstreamRequests.push({ url: request.url, authorization: request.headers.authorization || '' });
      let payload;
      if (request.url === '/api/v1/auth/login') {
        payload = { code: 0, data: { access_token: 'jwt-token', user: { email: 'user@example.com' } } };
      } else if (request.url === '/api/v1/keys') {
        payload = { code: 0, data: { items: [{ key: 'sk-active', status: 'active' }] } };
      } else if (request.url === '/api/v1/user/profile') {
        payload = { code: 0, data: { email: 'user@example.com', balance: 7.5 } };
      } else if (request.url === '/api/v1/usage/dashboard/stats') {
        payload = { code: 0, data: { total_actual_cost: 2.5 } };
      } else if (request.url === '/api/v1/usage?request_id=req-live&page=1&page_size=20') {
        payload = { code: 0, data: { items: [{ request_id: 'req-live', actual_cost: 0.25 }] } };
      } else if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-live' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        return;
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = createGateway({
    upstream: upstreamBase,
    portal: 'https://portal.example.com',
    publicBaseUrl: 'https://gw.example.com',
    tokenSecret: 'token-secret-long-enough-for-tests',
    keySecret: 'key-secret-long-enough-for-tests',
    accessTokenTtlSeconds: 900,
    tiers: CATALOG.tiers,
    defaultTiers: CATALOG.defaultTiers,
    imageEnabled: true,
    imageGatewayBaseUrl: upstreamBase,
    maxImagesPerStage: 1,
    sub2api: {
      loginPath: '/api/v1/auth/login',
      profilePath: '/api/v1/user/profile',
      usagePath: '/api/v1/usage/dashboard/stats',
      usageListPath: '/api/v1/usage',
      apiKeysPath: '/api/v1/keys',
      topUpPath: '/purchase',
      topUpEnabled: false,
    },
  }, { expandPlaybook: () => 'server playbook' });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'password' }),
    }).then((response) => response.json());
    const tokenResult = await fetch(`${base}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.credential}` },
      body: JSON.stringify({ deviceId: 'device-1' }),
    }).then((response) => response.json());
    const authHeaders = { Authorization: `Bearer ${tokenResult.accessToken}`, 'X-Device-Id': 'device-1' };

    const wrongDevice = await fetch(`${base}/account`, {
      headers: { ...authHeaders, 'X-Device-Id': 'device-2' },
    });
    assert.equal(wrongDevice.status, 401);

    const account = await fetch(`${base}/account`, { headers: authHeaders }).then((response) => response.json());
    assert.equal(account.balance, 7.5);

    const modelResponse = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: playbookPlaceholder({ stage: 'analysis' }) }] }),
    });
    assert.equal(modelResponse.headers.get('x-request-id'), 'req-live');

    const billing = await fetch(`${base}/billing`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestIds: ['req-live'] }),
    }).then((response) => response.json());
    assert.deepEqual(billing, {
      actualCost: 0.25,
      balance: 7.5,
      currency: 'USD',
      complete: true,
      missingRequestIds: [],
    });

    const topUp = await fetch(`${base}/topup`, { headers: authHeaders });
    assert.equal(topUp.status, 409);
    assert.equal(upstreamRequests.some((request) => request.url === '/v1/chat/completions' && request.authorization === 'Bearer sk-active'), true);
    assert.equal(upstreamRequests.filter((request) => request.url === '/api/v1/user/profile')
      .every((request) => request.authorization === 'Bearer jwt-token'), true);
  } finally {
    await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
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
    MODELING_HOSTED_GATEWAY: 'https://gw.example.com/agent',
    MODELING_HOSTED_PORTAL: 'https://portal.example.com',
  });
  let issued = 0;
  let clock = 1_000_000;
  let cleared = 0;
  let logoutAuthorization = '';
  const session = {
    deviceId: async () => 'device',
    credential: async () => 'credential',
    setCredential: async () => {},
    clear: async () => { cleared += 1; },
  };
  const client = createHostedClient({
    endpoints,
    session,
    now: () => clock,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/ready')) return jsonResponse({ ok: true });
      if (url.endsWith('/auth/token')) {
        issued += 1;
        return jsonResponse({ accessToken: `token-${issued}`, expiresAt: clock + 15 * 60 * 1000 });
      }
      if (url.endsWith('/catalog')) return jsonResponse(CATALOG);
      if (url.endsWith('/account')) return jsonResponse({ balance: 12.5, currency: 'cny', email: 'a@b.c' });
      if (url.endsWith('/billing')) return jsonResponse({ actualCost: 0.75, balance: 11.75, currency: 'usd', complete: true });
      if (url.endsWith('/auth/logout')) {
        logoutAuthorization = options.headers.Authorization;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'x' }, 402);
    },
  });

  assert.deepEqual(await client.health(), { available: true, checkedAt: clock });

  assert.equal(await client.accessToken(), 'token-1');
  assert.equal(await client.accessToken(), 'token-1');
  clock += 20 * 60 * 1000;
  assert.equal(await client.accessToken(), 'token-2');

  const catalog = await client.catalog();
  assert.equal(catalog.tiers[0].models.reasoning, 'r-model');

  const account = await client.account();
  assert.equal(account.balance, 12.5);
  assert.equal(account.currency, 'CNY');

  assert.deepEqual(await client.billing(['req-1', 'req-1'], 'pipeline-1'), {
    actualCost: 0.75,
    balance: 11.75,
    currency: 'USD',
    complete: true,
    missingRequestIds: [],
  });

  await assert.rejects(client.topUpUrl(), (error) => error.code === 'HOSTED_TOPUP_UNAVAILABLE');
  await client.logout();
  assert.equal(logoutAuthorization, 'Bearer credential');
  assert.equal(cleared, 1);
});

test('hosted client refuses to run without configured endpoints', async () => {
  const client = createHostedClient({
    endpoints: {
      gateway: '',
      portal: '',
      gatewayCertificateFingerprint256: '',
    },
    session: { deviceId: async () => 'device', credential: async () => '' },
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(client.configured(), false);
  await assert.rejects(client.catalog(), (error) => error.code === 'HOSTED_NOT_CONFIGURED');
});
