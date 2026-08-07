const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT = '/etc/math-model-gateway/config.json';
const PLACEHOLDER_SECRET_RE = /(?:replace[-_ ]?with|change[-_ ]?me|changeme|your[-_ ]?(?:password|secret|token|key)|example[-_ ]?(?:password|secret|token|key))/i;

function requiredEnvironment(env, name, minimumLength = 1, { trim = true, rejectPlaceholder = false } = {}) {
  const raw = String(env?.[name] || '');
  const value = trim ? raw.trim() : raw;
  if (value.length < minimumLength || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${name} is missing, too short, or contains control characters`);
  }
  if (rejectPlaceholder && PLACEHOLDER_SECRET_RE.test(value)) {
    throw new Error(`${name} must not use a shipped placeholder`);
  }
  return value;
}

function readServiceApiKey(execImpl = execFileSync) {
  const sql = [
    'SELECT key FROM api_keys',
    'WHERE status = chr(97)||chr(99)||chr(116)||chr(105)||chr(118)||chr(101)',
    'AND deleted_at IS NULL',
    'AND (expires_at IS NULL OR expires_at > now())',
    'ORDER BY id DESC LIMIT 1',
  ].join(' ');
  const serviceApiKey = execImpl('docker', [
    'exec',
    'sub2api-postgres',
    'sh',
    '-lc',
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c '${sql}'`,
  ], { encoding: 'utf8' }).trim();
  if (!serviceApiKey) throw new Error('No active Sub2API service key is available');
  return serviceApiKey;
}

function normalizePublicBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS URL ending in /agent');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || pathname !== '/agent') {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS URL ending in /agent');
  }
  return `${url.origin}/agent`;
}

function buildConfig({ env = process.env, serviceApiKey, secret = () => crypto.randomBytes(48).toString('base64url') } = {}) {
  const publicBaseUrl = normalizePublicBaseUrl(env.PUBLIC_BASE_URL);
  const accountApiServiceToken = requiredEnvironment(env, 'ACCOUNT_API_SERVICE_TOKEN', 32, { rejectPlaceholder: true });
  const billingServiceEmail = requiredEnvironment(env, 'SUB2API_BILLING_EMAIL', 3);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingServiceEmail)) throw new Error('SUB2API_BILLING_EMAIL must be an email address');
  const billingServicePassword = requiredEnvironment(env, 'SUB2API_BILLING_PASSWORD', 12, { trim: false, rejectPlaceholder: true });
  const relayKey = String(serviceApiKey || '').trim();
  if (!relayKey) throw new Error('No active Sub2API service key is available');
  if (PLACEHOLDER_SECRET_RE.test(relayKey)) throw new Error('Sub2API service key must not use a shipped placeholder');

  return {
    host: '127.0.0.1',
    port: 8788,
    upstream: 'http://127.0.0.1:18080',
    publicBaseUrl,
    portal: publicBaseUrl,
    tokenSecret: secret(),
    keySecret: secret(),
    identityProvider: {
      mode: 'account-api',
      baseUrl: 'http://127.0.0.1:18090',
      serviceToken: accountApiServiceToken,
    },
    serviceApiKey: relayKey,
    imageGatewayBaseUrl: 'http://127.0.0.1:8000',
    accessTokenTtlSeconds: 900,
    requestTimeoutMs: 600000,
    imageRequestTimeoutMs: 120000,
    requestBodyTimeoutMs: 15000,
    requestBodyInactivityTimeoutMs: 5000,
    maxBodyBytes: 8388608,
    operations: {
      rateLimit: { windowMs: 60000, maxRequests: 30, maxTrackedDevices: 10000 },
      loginRateLimit: { windowMs: 900000, maxAttempts: 8, maxTrackedIdentities: 10000, trustProxy: true },
      tokenRateLimit: { windowMs: 900000, maxAttempts: 8, maxTrackedIdentities: 10000 },
      billingRateLimit: { windowMs: 60000, maxRequests: 30, maxTrackedDevices: 10000 },
      accountRateLimit: { windowMs: 60000, maxRequests: 30, maxTrackedDevices: 10000 },
      billingAccountRateLimit: { windowMs: 60000, maxRequests: 30, maxTrackedDevices: 10000 },
      admission: { maxConcurrent: 4, maxQueued: 24, queueTimeoutMs: 300000 },
      billingAdmission: { maxConcurrent: 2, maxQueued: 8, queueTimeoutMs: 10000 },
      shutdownGraceMs: 30000,
      metrics: { enabled: false, path: '/metrics', token: '' },
    },
    imageEnabled: true,
    maxImagesPerStage: 1,
    tiers: [{
      id: 'standard',
      label: '标准',
      models: {
        coordinator: 'gpt-5.6-sol',
        modeler: 'gpt-5.6-sol',
        coder: 'gpt-5.6-terra',
        writer: 'claude-sonnet-5',
        image: 'gpt-image-2',
        reasoning: 'gpt-5.6-sol',
        coding: 'gpt-5.6-terra',
        writing: 'claude-sonnet-5',
      },
    }],
    defaultTiers: {
      coordinator: 'standard',
      modeler: 'standard',
      coder: 'standard',
      writer: 'standard',
      image: 'standard',
      reasoning: 'standard',
      coding: 'standard',
      writing: 'standard',
    },
    sub2api: {
      loginPath: '/api/v1/auth/login',
      profilePath: '/api/v1/user/profile',
      usagePath: '/api/v1/usage/dashboard/stats',
      usageListPath: '/api/v1/usage',
      apiKeysPath: '/api/v1/keys',
      topUpPath: '/purchase',
      topUpEnabled: false,
      billingConcurrency: 4,
      billingService: {
        email: billingServiceEmail,
        password: billingServicePassword,
      },
    },
  };
}

function writeConfig(config, { output = DEFAULT_OUTPUT, fsImpl = fs, execImpl = execFileSync } = {}) {
  fsImpl.mkdirSync(path.dirname(output), { recursive: true, mode: 0o750 });
  fsImpl.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
  fsImpl.chmodSync(output, 0o640);
  execImpl('chown', ['root:mathgateway', output]);
}

function main() {
  const config = buildConfig({ serviceApiKey: readServiceApiKey() });
  writeConfig(config);
  process.stdout.write('math-model gateway configuration created\n');
}

if (require.main === module) main();

module.exports = { DEFAULT_OUTPUT, buildConfig, normalizePublicBaseUrl, readServiceApiKey, requiredEnvironment, writeConfig };
