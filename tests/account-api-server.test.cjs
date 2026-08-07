const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalEnvironment = { ...process.env };
process.env.DATABASE_URL = 'postgresql://modeling_accounts:local-test-password@127.0.0.1:5432/modeling_accounts';
process.env.ACCOUNT_API_SERVICE_TOKEN = 'local-test-service-token-012345678901234567';
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'pg') return { Pool: class FakePool { async connect() {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  clientIp,
  createAuthRateLimiter,
  createAttemptLimiter,
  createSessionReaper,
  isPrivateDatabaseHost,
  parseBindHost,
  parseSignupGrantCredits,
  readJson,
  validateConfig,
  validateDatabaseTransport,
} = require('../deploy/hermes/account-api/server.cjs');
Module._load = originalLoad;
process.env = originalEnvironment;

const validEnvironment = {
  DATABASE_URL: 'postgresql://modeling_accounts:local-test-password@127.0.0.1:5432/modeling_accounts',
  ACCOUNT_API_SERVICE_TOKEN: 'local-test-service-token-012345678901234567',
};

test('account API config rejects shipped secret and database placeholders', () => {
  assert.throws(
    () => validateConfig({ ...validEnvironment, BOOTSTRAP_ADMIN_PASSWORD: 'replace-with-a-long-random-password' }),
    /BOOTSTRAP_ADMIN_PASSWORD.*placeholder/,
  );
  assert.throws(
    () => validateConfig({ ...validEnvironment, ACCOUNT_API_SERVICE_TOKEN: 'replace-with-a-shared-random-token-at-least-32-characters' }),
    /ACCOUNT_API_SERVICE_TOKEN.*placeholder/,
  );
  assert.throws(
    () => validateConfig({ ...validEnvironment, POSTGRES_PASSWORD: 'replace-with-random-postgres-password' }),
    /POSTGRES_PASSWORD.*placeholder/,
  );
  assert.throws(
    () => validateConfig({ ...validEnvironment, DATABASE_URL: 'postgresql://modeling_accounts:replace-with-random-postgres-password@account-postgres:5432/modeling_accounts' }),
    /DATABASE_URL.*placeholder/,
  );
  assert.throws(
    () => validateConfig({ ...validEnvironment, ACCOUNT_API_SERVICE_TOKEN: 'change-me-service-token-0123456789012345' }),
    /ACCOUNT_API_SERVICE_TOKEN.*placeholder/,
  );
  assert.throws(
    () => validateConfig({
      ...validEnvironment,
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'legitimate-long-admin-password',
    }),
    /BOOTSTRAP_ADMIN_EMAIL.*example domain/,
  );
  assert.throws(
    () => validateConfig({ ...validEnvironment, DATABASE_URL: 'https://database.internal/accounts' }),
    /PostgreSQL protocol/,
  );
});

test('account API config accepts legitimate injected development credentials', () => {
  assert.deepEqual(validateConfig({
    ...validEnvironment,
    POSTGRES_PASSWORD: 'local-development-password',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@local.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'local-development-admin-password',
  }), {
    databaseUrl: validEnvironment.DATABASE_URL,
    serviceToken: validEnvironment.ACCOUNT_API_SERVICE_TOKEN,
  });
  assert.deepEqual(validateConfig({ ...validEnvironment }), {
    databaseUrl: validEnvironment.DATABASE_URL,
    serviceToken: validEnvironment.ACCOUNT_API_SERVICE_TOKEN,
  });
});

test('account API requires TLS for non-private PostgreSQL hosts', () => {
  assert.equal(isPrivateDatabaseHost('account-postgres'), true);
  assert.equal(isPrivateDatabaseHost('10.20.30.40'), true);
  assert.equal(isPrivateDatabaseHost('db.internal.example'), false);
  assert.throws(
    () => validateConfig({ ...validEnvironment, DATABASE_URL: 'postgresql://user:password@db.internal.example:5432/accounts' }),
    /must require TLS/,
  );
  assert.deepEqual(validateDatabaseTransport(new URL('postgresql://user:password@db.internal.example:5432/accounts?sslmode=require')), {
    sslmode: 'require',
    sslRequired: true,
  });
  assert.deepEqual(validateDatabaseTransport(new URL(validEnvironment.DATABASE_URL)), {
    sslmode: '',
    sslRequired: false,
  });
});

test('rate limiting ignores forwarded addresses unless the TCP peer is explicitly trusted', () => {
  const request = {
    socket: { remoteAddress: '10.0.0.9' },
    headers: { 'x-forwarded-for': '203.0.113.7' },
  };
  delete process.env.ACCOUNT_API_TRUSTED_PROXY_IPS;
  assert.equal(clientIp(request), '10.0.0.9');
  process.env.ACCOUNT_API_TRUSTED_PROXY_IPS = '10.0.0.9';
  assert.equal(clientIp(request), '203.0.113.7');
  request.headers['x-forwarded-for'] = '203.0.113.7, 10.0.0.8';
  assert.equal(clientIp(request), '10.0.0.9');
  delete process.env.ACCOUNT_API_TRUSTED_PROXY_IPS;
});

test('session reaper removes expired sessions through a serialized cleanup query', async () => {
  const calls = [];
  let release;
  const reaper = createSessionReaper({
    query: async (sql) => {
      calls.push(sql);
      await new Promise((resolve) => { release = resolve; });
    },
  }, { intervalMs: 1000, logger: { error() {} } });
  const first = reaper.runOnce();
  reaper.runOnce();
  assert.equal(calls.length, 1);
  release();
  await first;
  reaper.start();
  reaper.stop();
  assert.deepEqual(calls, ['DELETE FROM sessions WHERE expires_at <= now()']);
});

test('account API attempt limiter expires entries and bounds global identity capacity', () => {
  let current = 0;
  const limiter = createAttemptLimiter({ windowMs: 100, maxAttempts: 2, maxEntries: 2, cleanupIntervalMs: 100, now: () => current });

  assert.equal(limiter.check('identity-a'), true);
  assert.equal(limiter.check('identity-b'), true);
  assert.equal(limiter.check('identity-c'), true);
  assert.equal(limiter.size(), 2);

  current = 101;
  assert.equal(limiter.check('identity-d'), true);
  assert.equal(limiter.size(), 1);
  assert.equal(limiter.check('identity-d'), true);
  assert.equal(limiter.check('identity-d'), false);
  limiter.clear('identity-d');
  assert.equal(limiter.size(), 0);
});

test('account API auth limiter caps source attempts across changing email identities', () => {
  const identityLimiter = createAttemptLimiter({ maxAttempts: 2 });
  const registrationSourceLimiter = createAttemptLimiter({ maxAttempts: 3 });
  const loginSourceLimiter = createAttemptLimiter({ maxAttempts: 2 });
  const limiter = createAuthRateLimiter({ identityLimiter, registrationSourceLimiter, loginSourceLimiter });

  assert.equal(limiter.checkRegistration('198.51.100.8', 'one@example.test'), true);
  assert.equal(limiter.checkRegistration('198.51.100.8', 'two@example.test'), true);
  assert.equal(limiter.checkRegistration('198.51.100.8', 'three@example.test'), true);
  limiter.clearRegistrationIdentity('198.51.100.8', 'one@example.test');
  assert.equal(limiter.checkRegistration('198.51.100.8', 'four@example.test'), false);
  assert.equal(limiter.checkRegistration('198.51.100.9', 'four@example.test'), true);

  assert.equal(limiter.checkLogin('203.0.113.4', 'one@example.test'), true);
  assert.equal(limiter.checkLogin('203.0.113.4', 'two@example.test'), true);
  limiter.clearLoginIdentity('203.0.113.4', 'one@example.test');
  assert.equal(limiter.checkLogin('203.0.113.4', 'three@example.test'), false);
});

test('signup grant credits default conservatively and allow explicit disable', () => {
  assert.equal(parseSignupGrantCredits({}), 0);
  assert.equal(parseSignupGrantCredits({ ACCOUNT_API_SIGNUP_GRANT_CREDITS: '0' }), 0);
  assert.equal(parseSignupGrantCredits({ ACCOUNT_API_SIGNUP_GRANT_CREDITS: '2500' }), 2500);
  assert.throws(() => parseSignupGrantCredits({ ACCOUNT_API_SIGNUP_GRANT_CREDITS: '-1' }), /non-negative integer/);
  assert.throws(() => parseSignupGrantCredits({ ACCOUNT_API_SIGNUP_GRANT_CREDITS: '1.5' }), /non-negative integer/);
});

test('account API binds to loopback by default and requires an explicit container wildcard', () => {
  assert.equal(parseBindHost({}), '127.0.0.1');
  assert.equal(parseBindHost({ ACCOUNT_API_BIND_HOST: '::1' }), '::1');
  assert.equal(parseBindHost({ ACCOUNT_API_BIND_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.throws(() => parseBindHost({ ACCOUNT_API_BIND_HOST: '192.0.2.10' }), /loopback or wildcard/);
  assert.throws(() => parseBindHost({ ACCOUNT_API_BIND_HOST: 'account-api' }), /loopback or wildcard/);
});

test('account API body reads fail closed for slow clients', async () => {
  const { EventEmitter } = require('node:events');
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; };
  await assert.rejects(
    readJson(request, { totalTimeoutMs: 20, inactivityTimeoutMs: 20 }),
    (error) => error.code === 'BODY_TIMEOUT' && error.status === 408,
  );
  assert.equal(request.destroyed, true);
});

test('account API body reads release timers when a client closes early', async () => {
  const { EventEmitter } = require('node:events');
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; };
  const pending = readJson(request, { totalTimeoutMs: 10_000, inactivityTimeoutMs: 10_000 });
  request.emit('close');
  await assert.rejects(pending, (error) => error.code === 'REQUEST_ABORTED' && error.status === 408);
  assert.equal(request.destroyed, true);
});
