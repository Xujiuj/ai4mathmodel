const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');

const SERVICE_TOKEN = 'local-http-test-service-token-0123456789';
const originalEnvironment = { ...process.env };
process.env.DATABASE_URL = 'postgresql://local/test';
process.env.ACCOUNT_API_SERVICE_TOKEN = SERVICE_TOKEN;
process.env.ACCOUNT_API_SIGNUP_GRANT_CREDITS = '2000';

class FakePool {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.auditEvents = [];
    this.ledger = [];
    this.billingRequests = new Map();
  }

  async connect() {
    const snapshot = {
      users: new Map([...this.users].map(([email, user]) => [email, { ...user }])),
      sessions: new Map([...this.sessions].map(([id, session]) => [id, { ...session }])),
      auditEvents: this.auditEvents.map((event) => ({ ...event })),
      ledger: this.ledger.map((entry) => ({ ...entry })),
      billingRequests: new Map([...this.billingRequests].map(([id, request]) => [id, { ...request }])),
    };
    return {
      query: async (sql, params = []) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (text === 'ROLLBACK') {
          const restoreMap = (target, source) => {
            for (const key of target.keys()) if (!source.has(key)) target.delete(key);
            for (const [key, value] of source) {
              const current = target.get(key);
              if (current) Object.assign(current, value);
              else target.set(key, { ...value });
            }
          };
          restoreMap(this.users, snapshot.users);
          restoreMap(this.sessions, snapshot.sessions);
          restoreMap(this.billingRequests, snapshot.billingRequests);
          this.auditEvents.splice(0, this.auditEvents.length, ...snapshot.auditEvents.map((event) => ({ ...event })));
          this.ledger.splice(0, this.ledger.length, ...snapshot.ledger.map((entry) => ({ ...entry })));
          return { rows: [], rowCount: 0 };
        }
        return this.query(sql, params);
      },
      release: () => {},
    };
  }
  release() {}

  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (text === 'SELECT 1') {
      if (this.ready === false) throw new Error('database unavailable');
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock)/.test(text)) return { rows: [], rowCount: 0 };
    if (text.startsWith('CREATE TABLE') || text.startsWith('ALTER TABLE')) return { rows: [], rowCount: 0 };
    if (text.startsWith('INSERT INTO audit_events')) {
      if (this.failAudit) throw this.failAudit;
      this.auditEvents.push({ actorId: params[0], subjectId: params[1], action: params[2], metadata: params[3] });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO users')) {
      const [id, email, passwordHash] = params;
      if (this.users.has(email)) { const error = new Error('duplicate'); error.code = '23505'; throw error; }
      this.users.set(email, { id, email, password_hash: passwordHash, role: 'user', status: 'active' });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT id,email,password_hash,role,status FROM users WHERE email')) {
      const user = this.users.get(params[0]);
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    }
    if (text.startsWith('SELECT id FROM users WHERE email')) {
      const user = this.users.get(params[0]);
      return { rows: user ? [{ id: user.id }] : [], rowCount: user ? 1 : 0 };
    }
    if (text.startsWith('INSERT INTO sessions')) {
      const [id, userId, tokenHash, expiresAt] = params;
      this.sessions.set(id, { id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO ledger_entries(user_id, amount, currency, kind, reference)')) {
      const [userId, amount, currency, kind, reference] = params;
      if (this.ledger.some((entry) => entry.reference === reference)) return { rows: [], rowCount: 0 };
      this.ledger.push({ id: this.ledger.length + 1, user_id: userId, amount: Number(amount), currency, kind, reference });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT u.id, u.email, u.role, u.status, s.id AS session_id')) {
      const session = [...this.sessions.values()].find((entry) => entry.token_hash === params[0] && new Date(entry.expires_at) > new Date());
      const user = session && [...this.users.values()].find((entry) => entry.id === session.user_id);
      return { rows: user ? [{ id: user.id, email: user.email, role: user.role, status: user.status, session_id: session.id }] : [], rowCount: user ? 1 : 0 };
    }
    if (text.startsWith('UPDATE sessions SET last_seen_at')) return { rows: [], rowCount: 1 };
    if (text.startsWith('DELETE FROM sessions')) { this.sessions.delete(params[0]); return { rows: [], rowCount: 1 }; }
    if (text.includes('FROM users u LEFT JOIN ledger_entries')) {
      const user = [...this.users.values()].find((entry) => entry.id === params[0]);
      if (!user) return { rows: [], rowCount: 0 };
      const entries = this.ledger.filter((entry) => entry.user_id === user.id);
      const balance = entries.reduce((sum, entry) => sum + Number(entry.amount), 0);
      const totalSpend = entries.filter((entry) => entry.kind === 'debit').reduce((sum, entry) => sum - Number(entry.amount), 0);
      return { rows: [{ id: user.id, email: user.email, role: user.role, status: user.status, balance, total_spend: totalSpend, currency: entries.at(-1)?.currency || params[1] }], rowCount: 1 };
    }
    if (text.startsWith('SELECT id, email, role, status FROM users WHERE id = $1 FOR UPDATE')) {
      const user = [...this.users.values()].find((entry) => entry.id === params[0]);
      return { rows: user ? [{ id: user.id, email: user.email, role: user.role, status: user.status }] : [], rowCount: user ? 1 : 0 };
    }
    if (text.startsWith('SELECT id, user_id FROM ledger_entries WHERE reference')) {
      const row = this.ledger.find((entry) => entry.reference === params[0]);
      return { rows: row ? [{ id: row.id, user_id: row.user_id }] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`FakePool query not implemented: ${text}`);
  }
}

const fakePool = new FakePool();
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'pg') return { Pool: class InjectedPool { constructor() { return fakePool; } } };
  return originalLoad.call(this, request, parent, isMain);
};
const { handler } = require('../deploy/hermes/account-api/server.cjs');
Module._load = originalLoad;
process.env = originalEnvironment;

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer((request, response) => handler(request, response).catch((error) => {
    response.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: error.code || 'internal_error' }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

function jsonPost(path, body, headers = {}) {
  return request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('health endpoint responds over HTTP', async () => {
  const { response, body } = await request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('readiness endpoint verifies database availability and preserves request id', async () => {
  const ready = await request('/health/ready', { headers: { 'x-request-id': 'readiness-check-1' } });
  assert.equal(ready.response.status, 200);
  assert.deepEqual(ready.body, { ok: true });
  assert.equal(ready.response.headers.get('x-request-id'), 'readiness-check-1');
  fakePool.ready = false;
  const unavailable = await request('/health/ready', { headers: { 'x-request-id': 'readiness-check-2' } });
  assert.equal(unavailable.response.status, 503);
  assert.deepEqual(unavailable.body, { ok: false });
  assert.equal(unavailable.response.headers.get('x-request-id'), 'readiness-check-2');
  fakePool.ready = true;
});

test('invalid request id is replaced with a generated id', async () => {
  const { response } = await request('/health', { headers: { 'x-request-id': 'bad id with spaces' } });
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('register login me and logout form a usable session lifecycle', async () => {
  const registered = await jsonPost('/register', { email: 'User@Example.com', password: 'correct horse battery' });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.user.email, 'user@example.com');
  assert.equal(registered.body.user.balance, 2000);
  assert.equal(fakePool.auditEvents.some((event) => event.action === 'signup_grant_issued'), true);
  const token = registered.body.token;
  const me = await request('/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.id, registered.body.user.id);
  const loggedOut = await jsonPost('/logout', {}, { authorization: `Bearer ${token}` });
  assert.equal(loggedOut.response.status, 204);
  const afterLogout = await request('/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(afterLogout.response.status, 401);
});

test('login rejects a duplicate registration and accepts the original password', async () => {
  const duplicate = await jsonPost('/register', { email: 'user@example.com', password: 'another password' });
  assert.equal(duplicate.response.status, 409);
  assert.deepEqual(duplicate.body, { error: 'email_exists' });
  assert.equal(fakePool.ledger.filter((entry) => entry.reference.startsWith('signup:')).length, 1);
  const login = await jsonPost('/login', { email: 'USER@example.com', password: 'correct horse battery' });
  assert.equal(login.response.status, 200);
  assert.ok(login.body.token);
});

test('audit failure rolls back registration, grant, and session for a retry', async () => {
  const originalFailure = fakePool.failAudit;
  const initialSignupCount = fakePool.ledger.filter((entry) => entry.reference.startsWith('signup:')).length;
  const initialSessionCount = fakePool.sessions.size;
  fakePool.failAudit = new Error('audit unavailable');
  const failed = await jsonPost('/register', { email: 'rollback@example.com', password: 'correct horse battery' });
  assert.equal(failed.response.status, 500);
  fakePool.failAudit = originalFailure;
  assert.equal(fakePool.users.has('rollback@example.com'), false);
  assert.equal(fakePool.ledger.filter((entry) => entry.reference.startsWith('signup:')).length, initialSignupCount);
  assert.equal(fakePool.sessions.size, initialSessionCount);

  const retried = await jsonPost('/register', { email: 'rollback@example.com', password: 'correct horse battery' });
  assert.equal(retried.response.status, 201);
  assert.equal(fakePool.users.has('rollback@example.com'), true);
  assert.equal(fakePool.ledger.filter((entry) => entry.reference.startsWith('signup:')).length, 2);
});

test('disabled and suspended users cannot authenticate', async () => {
  const user = fakePool.users.get('user@example.com');
  for (const status of ['disabled', 'suspended']) {
    user.status = status;
    const login = await jsonPost('/login', { email: user.email, password: 'correct horse battery' });
    assert.equal(login.response.status, 401);
  }
  const unauthorized = await request('/me', { headers: { authorization: 'Bearer invalid' } });
  assert.equal(unauthorized.response.status, 401);
  user.status = 'active';
});

test('billing routes require service token and map inactive users to billing errors', async () => {
  const user = fakePool.users.get('user@example.com');
  const forbidden = await jsonPost('/internal/billing/start', { userId: user.id, pipelineId: 'pipeline-a' });
  assert.equal(forbidden.response.status, 403);
  assert.deepEqual(forbidden.body, { error: 'forbidden' });
  const invalidId = await jsonPost('/internal/billing/start', { userId: 'bad', pipelineId: 'pipeline-a' }, { authorization: `Bearer ${SERVICE_TOKEN}` });
  assert.equal(invalidId.response.status, 400);
  assert.deepEqual(invalidId.body, { error: 'ACCOUNT_API_USER_ID_INVALID' });
  user.status = 'disabled';
  const inactive = await jsonPost('/internal/billing/start', { userId: user.id, pipelineId: 'pipeline-a' }, { authorization: `Bearer ${SERVICE_TOKEN}` });
  assert.equal(inactive.response.status, 403);
  assert.deepEqual(inactive.body, { error: 'ACCOUNT_API_USER_INACTIVE' });
  user.status = 'active';
});

test('invalid JSON returns an internal JSON error response', async () => {
  const { response, body } = await request('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
});

test('oversized request body is rejected by the HTTP connection', async () => {
  await assert.rejects(request('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(32 * 1024 + 1) }));
});

test('unsupported methods and unknown paths return route errors', async () => {
  const method = await request('/internal/billing/start', { method: 'GET', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
  assert.equal(method.response.status, 405);
  const login = await jsonPost('/login', { email: 'user@example.com', password: 'correct horse battery' });
  fakePool.users.get('user@example.com').role = 'admin';
  const missing = await request('/missing', { headers: { authorization: `Bearer ${login.body.token}` } });
  assert.equal(missing.response.status, 404);
  fakePool.users.get('user@example.com').role = 'user';
});
