const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  cleanGatewayUrl,
  hostedEndpoints,
  trustedLocalDevUrl,
} = require('../electron/hosted/endpoints.cjs');
const { createHostedClient } = require('../electron/hosted/client.cjs');
const { buildConfig } = require('../deploy/hermes/gateway/provision-config.cjs');

const root = path.resolve(__dirname, '..');

function jsonResponse(payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return { ok: true, status: 200, arrayBuffer: async () => bytes };
}

test('packaged builds reject malicious development URLs and load only local files', () => {
  assert.equal(trustedLocalDevUrl('https://attacker.example/app', { isPackaged: true }), '');
  assert.equal(trustedLocalDevUrl('http://127.0.0.1:5173', { isPackaged: true }), '');
  assert.equal(trustedLocalDevUrl('https://127.0.0.1:5173', { isPackaged: false }), '');
  assert.equal(trustedLocalDevUrl('http://localhost:5173', { isPackaged: false }), '');
  assert.equal(trustedLocalDevUrl('http://127.0.0.1:5173', { isPackaged: false }), 'http://127.0.0.1:5173');

  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /trustedLocalDevUrl\(process\.env\.VITE_DEV_SERVER_URL, \{ isPackaged: app\.isPackaged \}\)/);
  assert.match(main, /loadURL\(devServerUrl\)/);
  assert.doesNotMatch(main, /loadURL\(process\.env\.VITE_DEV_SERVER_URL\)/);
});

test('production hosted endpoints ignore environment values unless explicitly injected', () => {
  const baked = {
    gateway: 'https://gateway.example.com/agent',
    portal: 'https://portal.example.com',
    gatewayCertificateFingerprint256: 'AA'.repeat(32),
  };
  const maliciousEnvironment = {
    MODELING_HOSTED_GATEWAY: 'https://attacker.example/agent',
    MODELING_HOSTED_PORTAL: 'https://attacker.example',
    MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256: 'BB'.repeat(32),
  };
  const production = hostedEndpoints(undefined, baked);
  assert.equal(production.gateway, 'https://gateway.example.com/agent');
  assert.equal(production.portal, 'https://portal.example.com');
  assert.equal(production.gatewayCertificateFingerprint256, Array(32).fill('AA').join(':'));

  const explicitlyInjected = hostedEndpoints(maliciousEnvironment, baked);
  assert.equal(explicitlyInjected.gateway, 'https://attacker.example/agent');
});

test('gateway base path matches the Nginx prefix and prevents root-path 404 regressions', async () => {
  assert.equal(cleanGatewayUrl('https://gateway.example.com'), '');
  assert.equal(cleanGatewayUrl('https://gateway.example.com/api'), '');
  assert.equal(cleanGatewayUrl('https://gateway.example.com/agent/'), 'https://gateway.example.com/agent');

  const requested = [];
  const client = createHostedClient({
    endpoints: { gateway: 'https://gateway.example.com/agent', portal: 'https://portal.example.com' },
    session: { credential: async () => '', deviceId: async () => 'device' },
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse({ ok: true });
    },
  });
  await client.health();
  assert.deepEqual(requested, ['https://gateway.example.com/agent/ready']);

  for (const filename of ['math-model-gateway.nginx.conf', 'math-model-gateway.pinned.nginx.conf']) {
    const source = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'gateway', filename), 'utf8');
    assert.match(source, /location \/agent\/ \{/);
    assert.match(source, /proxy_pass\s+http:\/\/127\.0\.0\.1:8788\/;/);
  }
});

test('gateway provisioning requires the externally routed /agent base', () => {
  const credentials = {
    ACCOUNT_API_SERVICE_TOKEN: 's'.repeat(48),
    SUB2API_BILLING_EMAIL: 'billing-service@example.com',
    SUB2API_BILLING_PASSWORD: 'billing-password-strong',
  };
  assert.throws(() => buildConfig({
    env: { ...credentials, PUBLIC_BASE_URL: 'https://gateway.example.com' },
    serviceApiKey: 'sk-service',
  }), /ending in \/agent/);
  assert.throws(() => buildConfig({
    env: { ...credentials, PUBLIC_BASE_URL: 'https://gateway.example.com/api' },
    serviceApiKey: 'sk-service',
  }), /ending in \/agent/);

  const example = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'hosted', 'endpoints.example.json'), 'utf8'));
  assert.equal(example.gateway, 'https://gw.example.com/agent');
});
