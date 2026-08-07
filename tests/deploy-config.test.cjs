const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildConfig } = require('../deploy/hermes/gateway/provision-config.cjs');

const root = path.join(__dirname, '..');
const validEnvironment = {
  PUBLIC_BASE_URL: 'https://gateway.example.com/agent/',
  ACCOUNT_API_SERVICE_TOKEN: 's'.repeat(48),
  SUB2API_BILLING_EMAIL: 'billing-service@example.com',
  SUB2API_BILLING_PASSWORD: 'billing-password-strong',
};

test('production gateway config includes account and billing service credentials', () => {
  let secretIndex = 0;
  const config = buildConfig({
    env: validEnvironment,
    serviceApiKey: 'sk-service-relay',
    secret: () => `generated-secret-${++secretIndex}`,
  });

  assert.equal(config.publicBaseUrl, 'https://gateway.example.com/agent');
  assert.equal(config.identityProvider.serviceToken, validEnvironment.ACCOUNT_API_SERVICE_TOKEN);
  assert.deepEqual(config.sub2api.billingService, {
    email: validEnvironment.SUB2API_BILLING_EMAIL,
    password: validEnvironment.SUB2API_BILLING_PASSWORD,
  });
  assert.equal(config.serviceApiKey, 'sk-service-relay');
  assert.notEqual(config.tokenSecret, config.keySecret);
  assert.deepEqual(config.tiers[0].models, {
    coordinator: 'gpt-5.6-sol',
    modeler: 'gpt-5.6-sol',
    coder: 'gpt-5.6-terra',
    writer: 'claude-sonnet-5',
    image: 'gpt-image-2',
    reasoning: 'gpt-5.6-sol',
    coding: 'gpt-5.6-terra',
    writing: 'claude-sonnet-5',
  });
  assert.deepEqual(config.defaultTiers, {
    coordinator: 'standard',
    modeler: 'standard',
    coder: 'standard',
    writer: 'standard',
    image: 'standard',
    reasoning: 'standard',
    coding: 'standard',
    writing: 'standard',
  });
});

test('production gateway config fails closed when an internal credential is missing', () => {
  assert.throws(
    () => buildConfig({ env: { ...validEnvironment, ACCOUNT_API_SERVICE_TOKEN: '' }, serviceApiKey: 'sk-service' }),
    /ACCOUNT_API_SERVICE_TOKEN/,
  );
  assert.throws(
    () => buildConfig({ env: { ...validEnvironment, SUB2API_BILLING_PASSWORD: '' }, serviceApiKey: 'sk-service' }),
    /SUB2API_BILLING_PASSWORD/,
  );
});

test('production gateway config rejects shipped placeholders for every server-owned credential', () => {
  assert.throws(
    () => buildConfig({ env: { ...validEnvironment, ACCOUNT_API_SERVICE_TOKEN: 'replace-with-a-shared-random-token-at-least-32-characters' }, serviceApiKey: 'sk-service' }),
    /ACCOUNT_API_SERVICE_TOKEN.*placeholder/,
  );
  assert.throws(
    () => buildConfig({ env: { ...validEnvironment, SUB2API_BILLING_PASSWORD: 'replace-with-a-long-random-password' }, serviceApiKey: 'sk-service' }),
    /SUB2API_BILLING_PASSWORD.*placeholder/,
  );
  assert.throws(
    () => buildConfig({ env: validEnvironment, serviceApiKey: 'replace-with-a-service-key' }),
    /service key.*placeholder/,
  );
});

test('account API image contains billing implementation and rotation SQL uses psql variables', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'Dockerfile'), 'utf8');
  const rotation = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'rotate-secrets.sh'), 'utf8');
  assert.match(dockerfile, /^COPY .*\bbilling\.cjs\b.* \.\/$/m);
  assert.match(rotation, /:'postgres_password'/);
  assert.match(rotation, /:'admin_email'/);
  assert.doesNotMatch(rotation, /WHERE email = '\$\{BOOTSTRAP_ADMIN_EMAIL\}'/);
});

test('account API deployment uses database readiness, an internal network, log rotation, and digest image contract', () => {
  const compose = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'docker-compose.yml'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'schema.sql'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', '.env.example'), 'utf8');
  assert.match(compose, /health\/ready/);
  assert.match(compose, /ACCOUNT_API_BIND_HOST:\s*0\.0\.0\.0/);
  assert.match(compose, /127\.0\.0\.1:\$\{ACCOUNT_API_PORT:-18090\}:18090/);
  assert.match(compose, /POSTGRES_IMAGE:\?POSTGRES_IMAGE must be pinned by digest/);
  assert.match(compose, /account-internal:\s*\n\s*internal:\s*true/);
  assert.equal((compose.match(/driver: json-file/g) || []).length, 2);
  assert.equal((compose.match(/max-size: "10m"/g) || []).length, 2);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events\(created_at DESC\)/);
  assert.match(envExample, /POSTGRES_IMAGE must match .*@sha256:/);
  assert.doesNotMatch(compose, /image:\s*[^$\n]+postgres[^\n]*:/);
});

test('secret rotation derives passwords from environment and does not pass them as arguments', () => {
  const rotation = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'rotate-secrets.sh'), 'utf8');
  assert.match(rotation, /\\getenv postgres_password POSTGRES_PASSWORD/);
  assert.match(rotation, /process\.env\.ADMIN_PASSWORD/);
  assert.doesNotMatch(rotation, /process\.argv\[1\]/);
  assert.doesNotMatch(rotation, /--set=postgres_password=/);
  assert.doesNotMatch(rotation, /--set=admin_hash=/);
});

test('account API deployment disables signup grants by default and documents explicit opt-in', () => {
  const compose = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', '.env.example'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'deploy', 'hermes', 'account-api', 'README.md'), 'utf8');
  assert.match(compose, /ACCOUNT_API_SIGNUP_GRANT_CREDITS/);
  assert.match(compose, /ACCOUNT_API_SIGNUP_GRANT_CREDITS:-0/);
  assert.match(envExample, /ACCOUNT_API_SIGNUP_GRANT_CREDITS=0/);
  assert.match(readme, /ACCOUNT_API_SIGNUP_GRANT_CREDITS/);
  assert.match(readme, /does not grant PTS by default/);
  assert.match(readme, /per-source attempt windows/);
});
