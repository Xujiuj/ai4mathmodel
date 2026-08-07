const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { applySchema } = require('./migrate.cjs');

const {
  accountApiError,
  applyAdminLedgerEntry,
  cleanCurrency,
  createBillingService,
  listLedgerEntries,
  snapshotAccount,
  withTransaction,
} = require('./billing.cjs');

const PORT = Number(process.env.ACCOUNT_API_PORT || 18090);
const DEFAULT_CURRENCY = 'PTS';
const FIXED_RUN_CREDITS = Number(process.env.ACCOUNT_API_FIXED_RUN_CREDITS || 2000);
const CREDITS_PER_USD = Number(process.env.ACCOUNT_API_CREDITS_PER_USD || 7200);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const BODY_TOTAL_TIMEOUT_MS = 15_000;
const BODY_INACTIVITY_TIMEOUT_MS = 5_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_SIGNUP_GRANT_CREDITS = 0;
const DEFAULT_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ACCOUNT_API_BIND_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
const SECURE_DATABASE_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);
const LOCAL_DATABASE_HOSTS = new Set(['localhost', 'local', '127.0.0.1', '::1', 'account-postgres']);

const PLACEHOLDER_SECRET_RE = /(?:replace[-_ ]?with|change[-_ ]?me|changeme|your[-_ ]?(?:password|secret|token)|example[-_ ]?(?:password|secret|token))/i;
const RESERVED_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net']);

function rejectShippedPlaceholder(name, value) {
  if (PLACEHOLDER_SECRET_RE.test(String(value || '').trim())) {
    throw new Error(`${name} must not use a shipped placeholder`);
  }
}

function parseSignupGrantCredits(env = process.env) {
  const raw = env.ACCOUNT_API_SIGNUP_GRANT_CREDITS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SIGNUP_GRANT_CREDITS;
  const credits = Number(raw);
  if (!Number.isInteger(credits) || credits < 0) {
    throw new Error('ACCOUNT_API_SIGNUP_GRANT_CREDITS must be a non-negative integer');
  }
  return credits;
}

function parseBindHost(env = process.env) {
  const host = String(env.ACCOUNT_API_BIND_HOST || '127.0.0.1').trim();
  if (!ACCOUNT_API_BIND_HOSTS.has(host)) {
    throw new Error('ACCOUNT_API_BIND_HOST must be a loopback or wildcard IP address');
  }
  return host;
}

function isPrivateDatabaseHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_DATABASE_HOSTS.has(host) || host.endsWith('.local')) return true;
  const octets = host.split('.').map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

function validateDatabaseTransport(parsedDatabaseUrl) {
  const sslmode = String(parsedDatabaseUrl.searchParams.get('sslmode') || '').trim().toLowerCase();
  if (isPrivateDatabaseHost(parsedDatabaseUrl.hostname)) return { sslmode, sslRequired: false };
  if (!SECURE_DATABASE_SSLMODES.has(sslmode)) {
    throw new Error('DATABASE_URL must require TLS for non-private PostgreSQL hosts (set sslmode=require or sslmode=verify-full)');
  }
  return { sslmode, sslRequired: true };
}

function validateConfig(env = process.env) {
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  rejectShippedPlaceholder('DATABASE_URL', databaseUrl);
  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  }
  validateDatabaseTransport(parsedDatabaseUrl);
  rejectShippedPlaceholder('DATABASE_URL username', decodeURIComponent(parsedDatabaseUrl.username || ''));
  rejectShippedPlaceholder('DATABASE_URL password', decodeURIComponent(parsedDatabaseUrl.password || ''));
  for (const name of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
    if (env[name] !== undefined && String(env[name]).trim()) rejectShippedPlaceholder(name, env[name]);
  }

  const serviceToken = String(env.ACCOUNT_API_SERVICE_TOKEN || '').trim();
  if (serviceToken.length < 32) throw new Error('ACCOUNT_API_SERVICE_TOKEN must contain at least 32 characters');
  rejectShippedPlaceholder('ACCOUNT_API_SERVICE_TOKEN', serviceToken);

  const bootstrapPassword = String(env.BOOTSTRAP_ADMIN_PASSWORD || '').trim();
  const bootstrapEmail = String(env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  if (bootstrapEmail || bootstrapPassword) {
    rejectShippedPlaceholder('BOOTSTRAP_ADMIN_PASSWORD', bootstrapPassword);
    if (bootstrapPassword.length < 16) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 16 characters when set');
    if (!EMAIL_RE.test(bootstrapEmail)) throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address when bootstrap credentials are set');
    if (RESERVED_EMAIL_DOMAINS.has(bootstrapEmail.split('@').at(-1))) {
      throw new Error('BOOTSTRAP_ADMIN_EMAIL must not use a reserved example domain');
    }
  }

  parseSignupGrantCredits(env);
  parseBindHost(env);

  return { databaseUrl, serviceToken };
}

function createAttemptLimiter({
  windowMs = 15 * 60_000,
  maxAttempts = 8,
  maxEntries = 10_000,
  cleanupIntervalMs = Math.min(windowMs, 60_000),
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const capacity = Math.max(1, Number(maxEntries) || 1);
  const cleanupInterval = Math.max(1, Number(cleanupIntervalMs) || 1);
  let nextCleanupAt = 0;

  function cleanup(current) {
    if (current < nextCleanupAt) return;
    for (const [key, entry] of entries) {
      if (entry.reset <= current) entries.delete(key);
    }
    nextCleanupAt = current + cleanupInterval;
  }

  function check(key) {
    const current = now();
    cleanup(current);
    const normalizedKey = String(key || 'unknown').slice(0, 240);
    const entry = entries.get(normalizedKey) || { count: 0, reset: current + windowMs };
    entry.count += 1;
    if (!entries.has(normalizedKey) && entries.size >= capacity) entries.delete(entries.keys().next().value);
    entries.set(normalizedKey, entry);
    return entry.count <= maxAttempts;
  }

  function clear(key) {
    entries.delete(String(key || 'unknown').slice(0, 240));
  }

  return { check, clear, size: () => entries.size };
}

function createAuthRateLimiter({
  identityLimiter = createAttemptLimiter(),
  registrationSourceLimiter = createAttemptLimiter({ maxAttempts: 8 }),
  loginSourceLimiter = createAttemptLimiter({ maxAttempts: 40 }),
} = {}) {
  const identityKey = (source, route, email) => `${source}:${route}:${email}`;
  return {
    checkRegistration(source, email) {
      return registrationSourceLimiter.check(source)
        && identityLimiter.check(identityKey(source, 'register', email));
    },
    checkLogin(source, email) {
      return loginSourceLimiter.check(source)
        && identityLimiter.check(identityKey(source, 'login', email));
    },
    clearRegistrationIdentity(source, email) {
      identityLimiter.clear(identityKey(source, 'register', email));
    },
    clearLoginIdentity(source, email) {
      identityLimiter.clear(identityKey(source, 'login', email));
    },
  };
}

const { databaseUrl: DATABASE_URL, serviceToken: SERVICE_TOKEN } = validateConfig(process.env);
const SIGNUP_GRANT_CREDITS = parseSignupGrantCredits(process.env);
const BIND_HOST = parseBindHost(process.env);
const { Pool } = require('pg');
const authAttempts = createAuthRateLimiter();

const pool = new Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
const billing = createBillingService({
  pool,
  currency: DEFAULT_CURRENCY,
  fixedRunCredits: FIXED_RUN_CREDITS,
  creditsPerUsd: CREDITS_PER_USD,
  audit,
});

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 160);
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !/^[0-9a-f]{128}$/i.test(expected || '')) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      const actual = derivedKey.toString('hex');
      resolve(actual.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')));
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (status === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(body));
}

function requestId(request) {
  const supplied = String(request.headers['x-request-id'] || '').trim();
  return REQUEST_ID_RE.test(supplied) ? supplied : crypto.randomUUID();
}

function logStructuredError(response, error, status, event = 'account_api_error') {
  const id = response.getHeader('X-Request-Id') || 'unknown';
  console.error(JSON.stringify({ event, requestId: id, status, error }));
}

function clientIp(request) {
  const remoteAddress = String(request.socket.remoteAddress || 'unknown').slice(0, 80);
  const trustedProxyIps = new Set(String(process.env.ACCOUNT_API_TRUSTED_PROXY_IPS || '')
    .split(',').map((value) => value.trim()).filter(Boolean));
  if (!trustedProxyIps.has(remoteAddress)) return remoteAddress;
  const forwarded = String(request.headers['x-forwarded-for'] || '').trim();
  return net.isIP(forwarded) ? forwarded.slice(0, 80) : remoteAddress;
}

function createSessionReaper(sessionPool, {
  intervalMs = DEFAULT_SESSION_CLEANUP_INTERVAL_MS,
  logger = console,
} = {}) {
  if (!sessionPool || typeof sessionPool.query !== 'function') throw new TypeError('session pool must expose query()');
  let timer = null;
  let inFlight = null;
  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = sessionPool.query('DELETE FROM sessions WHERE expires_at <= now()')
      .catch((error) => {
        logger.error?.(JSON.stringify({ event: 'account_api_session_cleanup_failed', error: error.message }));
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }
  function start() {
    if (timer) return;
    const delay = Math.max(1_000, Number(intervalMs) || DEFAULT_SESSION_CLEANUP_INTERVAL_MS);
    timer = setInterval(() => { void runOnce(); }, delay);
    timer.unref?.();
  }
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }
  return { runOnce, start, stop };
}

function readJson(request, {
  totalTimeoutMs = BODY_TOTAL_TIMEOUT_MS,
  inactivityTimeoutMs = BODY_INACTIVITY_TIMEOUT_MS,
  } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let ended = false;
    let totalTimer;
    let inactivityTimer;
    const timeoutError = (code, status) => Object.assign(new Error(code), { code, status });
    const clearTimers = () => {
      clearTimeout(totalTimer);
      clearTimeout(inactivityTimer);
    };
    const settle = (error, value) => {
      if (settled) return false;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(value);
      return true;
    };
    const abort = (error) => {
      if (!settle(error)) return;
      request.destroy();
    };
    const totalDelay = Math.max(100, Number(totalTimeoutMs) || BODY_TOTAL_TIMEOUT_MS);
    const inactivityDelay = Math.max(100, Number(inactivityTimeoutMs) || BODY_INACTIVITY_TIMEOUT_MS);
    totalTimer = setTimeout(() => abort(timeoutError('BODY_TIMEOUT', 408)), totalDelay);
    inactivityTimer = setTimeout(() => abort(timeoutError('BODY_TIMEOUT', 408)), inactivityDelay);
    request.on('data', (chunk) => {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => abort(timeoutError('BODY_TIMEOUT', 408)), inactivityDelay);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        abort(timeoutError('BODY_TOO_LARGE', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      ended = true;
      try {
        settle(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        settle(new Error('INVALID_JSON'));
      }
    });
    request.on('error', (error) => {
      settle(error);
    });
    request.once('aborted', () => abort(timeoutError('REQUEST_ABORTED', 408)));
    request.once('close', () => {
      if (!ended) abort(timeoutError('REQUEST_ABORTED', 408));
    });
  });
}

async function audit(client, actorId, subjectId, action, metadata = {}) {
  await client.query('INSERT INTO audit_events(actor_user_id, subject_user_id, action, metadata) VALUES ($1,$2,$3,$4)', [actorId, subjectId, action, metadata]);
}

async function authenticate(request) {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || token.length > 256) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.role, u.status, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  const user = result.rows[0] || null;
  if (user?.status === 'active') await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [user.session_id]);
  return user?.status === 'active' ? user : null;
}

async function authorizeService(request) {
  const header = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!header || header.length !== SERVICE_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(SERVICE_TOKEN));
}

function cleanUserId(value) {
  const userId = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw accountApiError('ACCOUNT_API_USER_ID_INVALID', 400);
  }
  return userId;
}

function publicUser(base, snapshot) {
  return {
    id: base.id,
    email: base.email,
    role: base.role,
    status: base.status,
    balance: snapshot?.balance ?? 0,
    currency: snapshot?.currency || DEFAULT_CURRENCY,
    totalSpend: snapshot?.totalSpend ?? 0,
  };
}

async function createSession(client, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await client.query(
    'INSERT INTO sessions(id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
    [crypto.randomUUID(), userId, tokenHash(token), new Date(Date.now() + SESSION_TTL_MS)],
  );
  return token;
}

async function bootstrapAdmin() {
  const email = cleanEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  if (!EMAIL_RE.test(email) || password.length < 16) return;
  await withTransaction(pool, async (client) => {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount) return;
    const id = crypto.randomUUID();
    await client.query("INSERT INTO users(id,email,password_hash,role) VALUES ($1,$2,$3,'admin')", [id, email, await passwordHash(password)]);
    await audit(client, id, id, 'bootstrap_admin_created');
  });
}

async function loadAdminUsers() {
  const result = await pool.query('SELECT id,email,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 500');
  const users = await Promise.all(result.rows.map(async (user) => {
    const snapshot = await snapshotAccount(pool, user.id, DEFAULT_CURRENCY);
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      created_at: user.created_at,
      balance: snapshot.balance,
      currency: snapshot.currency,
      totalSpend: snapshot.totalSpend,
    };
  }));
  return users;
}

async function handler(request, response) {
  const id = requestId(request);
  response.setHeader('X-Request-Id', id);
  const parsedUrl = new URL(request.url || '/', 'http://127.0.0.1');
  const route = parsedUrl.pathname;

  if (request.method === 'GET' && route === '/health') return json(response, 200, { ok: true });
  if (request.method === 'GET' && route === '/health/ready') {
    try {
      await pool.query('SELECT 1');
      return json(response, 200, { ok: true });
    } catch {
      logStructuredError(response, 'database_unavailable', 503, 'account_api_readiness_failed');
      return json(response, 503, { ok: false });
    }
  }
  if (!['POST', 'GET', 'PATCH'].includes(request.method || '')) return json(response, 405, { error: 'method_not_allowed' });

  if (request.method === 'POST' && route === '/register') {
    const body = await readJson(request);
    const email = cleanEmail(body.email);
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email) || password.length < 12 || password.length > 200) return json(response, 400, { error: 'invalid_registration' });
    const source = clientIp(request);
    if (!authAttempts.checkRegistration(source, email)) return json(response, 429, { error: 'rate_limited' });
    const id = crypto.randomUUID();
    let token;
    try {
      await withTransaction(pool, async (client) => {
        await client.query('INSERT INTO users(id,email,password_hash) VALUES ($1,$2,$3)', [id, email, await passwordHash(password)]);
        if (SIGNUP_GRANT_CREDITS > 0) {
          await client.query(
            'INSERT INTO ledger_entries(user_id, amount, currency, kind, reference) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reference) DO NOTHING',
            [id, SIGNUP_GRANT_CREDITS.toFixed(4), DEFAULT_CURRENCY, 'credit', `signup:${id}`],
          );
          await audit(client, id, id, 'signup_grant_issued', { credits: SIGNUP_GRANT_CREDITS, currency: DEFAULT_CURRENCY });
        }
        await audit(client, id, id, 'user_registered');
        token = await createSession(client, id);
      });
    } catch (error) {
      if (error.code === '23505') return json(response, 409, { error: 'email_exists' });
      throw error;
    }
    authAttempts.clearRegistrationIdentity(source, email);
    const snapshot = await snapshotAccount(pool, id, DEFAULT_CURRENCY);
    return json(response, 201, { token, user: publicUser({ id, email, role: 'user', status: 'active' }, snapshot) });
  }

  if (request.method === 'POST' && route === '/login') {
    const body = await readJson(request);
    const email = cleanEmail(body.email);
    const password = String(body.password || '');
    const source = clientIp(request);
    if (!authAttempts.checkLogin(source, email)) return json(response, 429, { error: 'rate_limited' });
    let user;
    let token;
    let credentialsValid = false;
    await withTransaction(pool, async (client) => {
      const result = await client.query('SELECT id,email,password_hash,role,status FROM users WHERE email = $1', [email]);
      user = result.rows[0];
      credentialsValid = Boolean(user && user.status === 'active' && await verifyPassword(password, user.password_hash));
      if (!credentialsValid) return;
      token = await createSession(client, user.id);
      await audit(client, user.id, user.id, 'user_logged_in');
    });
    if (!credentialsValid) return json(response, 401, { error: 'invalid_credentials' });
    authAttempts.clearLoginIdentity(source, email);
    const snapshot = await snapshotAccount(pool, user.id, DEFAULT_CURRENCY);
    return json(response, 200, { token, user: publicUser(user, snapshot) });
  }

  if (route.startsWith('/internal/billing/')) {
    if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' });
    if (!(await authorizeService(request))) return json(response, 403, { error: 'forbidden' });
    const body = await readJson(request);
    const userId = cleanUserId(body.userId);

    if (route === '/internal/billing/start') {
      const result = await billing.startRun(userId, body.pipelineId);
      return json(response, 200, result);
    }

    if (route === '/internal/billing/claim') {
      const result = await billing.claimRequest(userId, body.pipelineId, body.requestId);
      return json(response, 200, result);
    }

    if (route === '/internal/billing/settle') {
      const requestCosts = Array.isArray(body.requestCosts) ? body.requestCosts : null;
      if (!requestCosts || !requestCosts.length || requestCosts.length > 72) {
        return json(response, 400, { error: 'request_costs_invalid' });
      }
      const result = await billing.settleUsage(userId, body.pipelineId, requestCosts);
      return json(response, 200, result);
    }

    return json(response, 404, { error: 'not_found' });
  }

  const user = await authenticate(request);
  if (!user) return json(response, 401, { error: 'unauthorized' });

  if (request.method === 'POST' && route === '/logout') {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM sessions WHERE id = $1', [user.session_id]);
      await audit(client, user.id, user.id, 'user_logged_out');
    });
    return json(response, 204, {});
  }

  if (request.method === 'GET' && route === '/me') {
    const snapshot = await snapshotAccount(pool, user.id, DEFAULT_CURRENCY);
    return json(response, 200, { user: publicUser(user, snapshot) });
  }

  if (user.role !== 'admin') return json(response, 403, { error: 'admin_required' });

  if (request.method === 'GET' && route === '/admin/users') {
    return json(response, 200, { users: await loadAdminUsers() });
  }

  const adminUserMatch = route.match(/^\/admin\/users\/([0-9a-f-]{36})$/i);
  if (request.method === 'PATCH' && adminUserMatch) {
    const body = await readJson(request);
    const role = ['user', 'admin'].includes(body.role) ? body.role : null;
    const status = ['active', 'disabled'].includes(body.status) ? body.status : null;
    if (!role && !status) return json(response, 400, { error: 'invalid_update' });
    if (adminUserMatch[1] === user.id && status === 'disabled') return json(response, 400, { error: 'cannot_disable_self' });
    let result;
    await withTransaction(pool, async (client) => {
      result = await client.query(
        'UPDATE users SET role = COALESCE($1,role), status = COALESCE($2,status), updated_at = now() WHERE id = $3 RETURNING id,email,role,status',
        [role, status, adminUserMatch[1]],
      );
      if (!result.rowCount) return;
      await audit(client, user.id, adminUserMatch[1], 'admin_user_updated', { role, status });
    });
    if (!result.rowCount) return json(response, 404, { error: 'user_not_found' });
    return json(response, 200, { user: result.rows[0] });
  }

  const ledgerMatch = route.match(/^\/admin\/users\/([0-9a-f-]{36})\/ledger$/i);
  if (ledgerMatch && request.method === 'GET') {
    const limit = Number(parsedUrl.searchParams.get('limit') || 50);
    const offset = Number(parsedUrl.searchParams.get('offset') || 0);
    const ledger = await listLedgerEntries(pool, { userId: ledgerMatch[1], limit, offset, defaultCurrency: DEFAULT_CURRENCY });
    const snapshot = await snapshotAccount(pool, ledgerMatch[1], DEFAULT_CURRENCY);
    return json(response, 200, { user: publicUser({ id: snapshot.id, email: snapshot.email, role: snapshot.role, status: snapshot.status }, snapshot), ledger });
  }
  if (ledgerMatch && request.method === 'POST') {
    const body = await readJson(request);
    const snapshot = await applyAdminLedgerEntry(pool, {
      userId: ledgerMatch[1],
      amount: body.amount,
      kind: body.kind,
      currency: body.currency || DEFAULT_CURRENCY,
      reference: body.reference,
      defaultCurrency: DEFAULT_CURRENCY,
      audit,
      auditActorId: user.id,
    });
    return json(response, 200, { user: publicUser({ id: snapshot.id, email: snapshot.email, role: snapshot.role, status: snapshot.status }, snapshot) });
  }

  return json(response, 404, { error: 'not_found' });
}

async function main() {
  await applySchema(pool);
  await bootstrapAdmin();
  const sessionReaper = createSessionReaper(pool);
  await sessionReaper.runOnce();
  sessionReaper.start();
  http.createServer((request, response) => handler(request, response).catch((error) => {
    logStructuredError(response, error.code || 'internal_error', error.status || 500);
    json(response, error.status || 500, { error: error.code || 'internal_error' });
  })).listen(PORT, BIND_HOST);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  authorizeService,
  clientIp,
  cleanUserId,
  createAuthRateLimiter,
  createAttemptLimiter,
  createSessionReaper,
  handler,
  isPrivateDatabaseHost,
  main,
  parseBindHost,
  parseSignupGrantCredits,
  readJson,
  requestId,
  validateConfig,
  validateDatabaseTransport,
};
