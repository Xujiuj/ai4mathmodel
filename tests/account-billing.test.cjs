const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyAdminLedgerEntry,
  cleanActualCostUsd,
  createBillingService,
  snapshotAccount,
} = require('../deploy/hermes/account-api/billing.cjs');

test('actual USD cost matches NUMERIC(14,8) bounds and precision', () => {
  assert.equal(cleanActualCostUsd('0.00000001'), 0.00000001);
  assert.equal(cleanActualCostUsd('999999.99999999'), 999999.99999999);
  for (const value of ['1000000', '0.000000001', '1e-8', 'Infinity', '-1', '']) {
    assert.throws(() => cleanActualCostUsd(value), (error) => error.code === 'ACCOUNT_API_AMOUNT_INVALID');
  }
});

function createPool({ users = [], ledger = [], requests = [] } = {}) {
  const state = {
    users: new Map(users.map((user) => [String(user.id), { ...user }])),
    ledger: ledger.map((entry, index) => ({
      id: index + 1,
      user_id: String(entry.user_id || entry.userId),
      amount: Number(entry.amount),
      currency: String(entry.currency || 'PTS'),
      kind: String(entry.kind || 'adjustment'),
      reference: String(entry.reference || `seed:${index + 1}`),
      created_at: entry.created_at || new Date().toISOString(),
    })),
    requests: new Map(requests.map((entry) => [String(entry.request_id || entry.requestId), { ...entry }])),
    nextLedgerId: ledger.length + 1,
  };

  function currentCurrency(userId, fallback = 'PTS') {
    const row = [...state.ledger].reverse().find((entry) => entry.user_id === String(userId));
    return row ? row.currency : fallback;
  }

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rowCount: 0, rows: [] };
    if (text === 'SELECT id, email, role, status FROM users WHERE id = $1 FOR UPDATE') {
      const user = state.users.get(String(params[0]));
      return { rowCount: user ? 1 : 0, rows: user ? [{ ...user }] : [] };
    }
    if (text === 'SELECT currency FROM ledger_entries WHERE user_id = $1 ORDER BY id DESC LIMIT 1') {
      const currency = currentCurrency(params[0]);
      return { rowCount: currency ? 1 : 0, rows: currency ? [{ currency }] : [] };
    }
    if (text === 'SELECT id FROM ledger_entries WHERE reference = $1 FOR UPDATE') {
      const row = state.ledger.find((entry) => entry.reference === String(params[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
    }
    if (text === 'SELECT id, user_id FROM ledger_entries WHERE reference = $1 FOR UPDATE') {
      const row = state.ledger.find((entry) => entry.reference === String(params[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
    }
    if (text === 'SELECT 1 FROM billing_requests WHERE user_id = $1 AND pipeline_id = $2 LIMIT 1') {
      const row = [...state.requests.values()].find((entry) => String(entry.user_id) === String(params[0]) && String(entry.pipeline_id) === String(params[1]));
      return { rowCount: row ? 1 : 0, rows: row ? [{ '?column?': 1 }] : [] };
    }
    if (text.startsWith('INSERT INTO ledger_entries(')) {
      const [userId, amount, currency, kind, reference] = params;
      const existing = state.ledger.find((entry) => entry.reference === String(reference));
      if (existing) return { rowCount: 0, rows: [] };
      const row = { id: ++state.nextLedgerId, user_id: String(userId), amount: Number(amount), currency: String(currency), kind: String(kind), reference: String(reference), created_at: new Date().toISOString() };
      state.ledger.push(row);
      return { rowCount: 1, rows: [{ ...row }] };
    }
    if (text === 'SELECT id, user_id, amount, currency, kind, reference, created_at FROM ledger_entries WHERE reference = $1') {
      const row = state.ledger.find((entry) => entry.reference === String(params[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }
    if (text.startsWith('SELECT u.id, u.email, u.role, u.status, COALESCE(SUM(l.amount), 0) AS balance')) {
      const user = state.users.get(String(params[0]));
      if (!user) return { rowCount: 0, rows: [] };
      const entries = state.ledger.filter((entry) => entry.user_id === String(params[0]));
      return { rowCount: 1, rows: [{ ...user, balance: entries.reduce((sum, entry) => sum + entry.amount, 0), total_spend: entries.filter((entry) => entry.kind === 'debit').reduce((sum, entry) => sum + Math.abs(entry.amount), 0), currency: entries.at(-1)?.currency || String(params[1] || 'PTS') }] };
    }
    if (text.startsWith('SELECT request_id, user_id, pipeline_id, upstream_cost_usd, charged_credits, settled_at FROM billing_requests')) {
      const row = state.requests.get(String(params[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }
    if (text.startsWith('INSERT INTO billing_requests(')) {
      const [requestId, userId, pipelineId] = params;
      if (state.requests.has(String(requestId))) return { rowCount: 0, rows: [] };
      state.requests.set(String(requestId), { request_id: String(requestId), user_id: String(userId), pipeline_id: String(pipelineId), upstream_cost_usd: null, charged_credits: null, settled_at: null });
      return { rowCount: 1, rows: [] };
    }
    if (text.startsWith('UPDATE billing_requests SET upstream_cost_usd')) {
      const [requestId, usd, credits] = params;
      const row = state.requests.get(String(requestId));
      if (!row) return { rowCount: 0, rows: [] };
      row.upstream_cost_usd = Number(usd); row.charged_credits = Number(credits); row.settled_at = new Date().toISOString();
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  return {
    state,
    connect: async () => {
      const snapshot = {
        users: new Map([...state.users].map(([id, user]) => [id, { ...user }])),
        ledger: state.ledger.map((entry) => ({ ...entry })),
        requests: new Map([...state.requests].map(([id, request]) => [id, { ...request }])),
        nextLedgerId: state.nextLedgerId,
      };
      return {
        query: async (sql, params = []) => {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          if (text === 'ROLLBACK') {
            state.users = snapshot.users;
            state.ledger = snapshot.ledger;
            state.requests = snapshot.requests;
            state.nextLedgerId = snapshot.nextLedgerId;
            return { rowCount: 0, rows: [] };
          }
          return query(sql, params);
        },
        release: async () => {},
      };
    },
    query,
  };
}

function activeUser(id = 'user-1') {
  return { id, email: `${id}@example.com`, role: 'user', status: 'active' };
}

test('startRun charges fixed credits once per pipeline and replay is idempotent', async () => {
  const pool = createPool({ users: [activeUser()], ledger: [{ user_id: 'user-1', amount: 5000, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }] });
  const billing = createBillingService({ pool });
  const first = await billing.startRun('user-1', 'run-1');
  const replay = await billing.startRun('user-1', 'run-1');
  assert.equal(first.charged, true);
  assert.equal(first.fixedRunCredits, 2000);
  assert.equal(first.balance, 3000);
  assert.equal(replay.charged, false);
  assert.equal(replay.balance, 3000);
  assert.equal(pool.state.ledger.filter((entry) => entry.reference.startsWith('pipeline:')).length, 1);
});

test('startRun rejects insufficient balance and blocks later requests at zero', async () => {
  const pool = createPool({ users: [activeUser()], ledger: [{ user_id: 'user-1', amount: 1999, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }] });
  const billing = createBillingService({ pool });
  await assert.rejects(() => billing.startRun('user-1', 'run-1'), (error) => error.status === 402);

  const exact = createPool({ users: [activeUser()], ledger: [{ user_id: 'user-1', amount: 2000, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }] });
  const exactBilling = createBillingService({ pool: exact });
  await exactBilling.startRun('user-1', 'run-1');
  assert.equal((await exactBilling.startRun('user-1', 'run-1')).charged, false);
  await assert.rejects(() => exactBilling.startRun('user-1', 'run-2'), (error) => error.status === 402);
});

test('startRun replay remains idempotent after the pipeline has claimed requests and exhausted balance', async () => {
  const pool = createPool({
    users: [activeUser()],
    ledger: [{ user_id: 'user-1', amount: 2000, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }],
    requests: [{ request_id: 'req-1', user_id: 'user-1', pipeline_id: 'run-1' }],
  });
  const billing = createBillingService({ pool });
  const first = await billing.startRun('user-1', 'run-1');
  const replay = await billing.startRun('user-1', 'run-1');
  assert.equal(first.charged, true);
  assert.equal(first.balance, 0);
  assert.equal(replay.charged, false);
  assert.equal(replay.balance, 0);
});

test('claimRequest persists ownership and rejects cross-user or cross-pipeline collisions', async () => {
  const pool = createPool({
    users: [activeUser('user-1'), activeUser('user-2')],
    ledger: [
      { user_id: 'user-1', amount: 10000, currency: 'PTS', kind: 'credit', reference: 'seed:user-1' },
      { user_id: 'user-2', amount: 10000, currency: 'PTS', kind: 'credit', reference: 'seed:user-2' },
    ],
  });
  const billing = createBillingService({ pool });
  await billing.startRun('user-1', 'run-1');
  await billing.startRun('user-1', 'run-2');
  await billing.startRun('user-2', 'run-1');
  assert.deepEqual(await billing.claimRequest('user-1', 'run-1', 'req-1'), { requestId: 'req-1', claimed: true });
  assert.deepEqual(await billing.claimRequest('user-1', 'run-1', 'req-1'), { requestId: 'req-1', claimed: false });
  await assert.rejects(() => billing.claimRequest('user-1', 'run-2', 'req-1'), (error) => error.status === 409);
  await assert.rejects(() => billing.claimRequest('user-2', 'run-1', 'req-1'), (error) => error.status === 409);
  await assert.rejects(() => billing.claimRequest('user-1', 'run-1', ''), (error) => error.status === 400);
});

test('settleUsage charges claimed requests with ceiling conversion and replays idempotently', async () => {
  const pool = createPool({ users: [activeUser()], ledger: [{ user_id: 'user-1', amount: 10000, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }] });
  const billing = createBillingService({ pool });
  await billing.startRun('user-1', 'run-1');
  await billing.claimRequest('user-1', 'run-1', 'req-1');
  await billing.claimRequest('user-1', 'run-1', 'req-2');
  const first = await billing.settleUsage('user-1', 'run-1', [{ requestId: 'req-1', actualCostUsd: 0.0001 }, { requestId: 'req-2', actualCostUsd: 0.5 }]);
  const replay = await billing.settleUsage('user-1', 'run-1', [{ requestId: 'req-1', actualCostUsd: 99 }, { requestId: 'req-2', actualCostUsd: 99 }, { requestId: 'req-1', actualCostUsd: 99 }]);
  assert.equal(first.chargedCredits, 3601);
  assert.equal(replay.chargedCredits, 3601);
  assert.equal(replay.requestCosts[0].actualCostUsd, 0.0001);
  assert.equal(first.balance, 4399);
  assert.equal(pool.state.ledger.filter((entry) => entry.reference.startsWith('request:')).length, 2);
  await assert.rejects(() => billing.settleUsage('user-1', 'run-1', [{ requestId: 'unknown', actualCostUsd: 1 }]), (error) => error.status === 409);
});

test('admin ledger helpers remain compatible with PTS accounts', async () => {
  const pool = createPool({ users: [activeUser('user-3')] });
  await applyAdminLedgerEntry(pool, { userId: 'user-3', amount: 5, kind: 'credit', reference: 'admin:credit' });
  await applyAdminLedgerEntry(pool, { userId: 'user-3', amount: -2, kind: 'adjustment', reference: 'admin:adjustment' });
  const snapshot = await snapshotAccount(pool, 'user-3');
  assert.equal(snapshot.balance, 3);
  assert.equal(snapshot.totalSpend, 0);
  assert.equal(snapshot.currency, 'PTS');
});

test('audit failure rolls back a fixed billing debit and preserves replay behavior', async () => {
  const pool = createPool({ users: [activeUser()], ledger: [{ user_id: 'user-1', amount: 5000, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }] });
  const error = new Error('audit unavailable');
  const billing = createBillingService({ pool, audit: async () => { throw error; } });

  await assert.rejects(() => billing.startRun('user-1', 'run-a'), (actual) => actual === error);
  assert.equal(pool.state.ledger.some((entry) => entry.reference.startsWith('pipeline:')), false);

  const recovered = createBillingService({ pool });
  const result = await recovered.startRun('user-1', 'run-a');
  assert.equal(result.charged, true);
  assert.equal(pool.state.ledger.filter((entry) => entry.reference.startsWith('pipeline:')).length, 1);
});

test('audit failure rolls back billing claims and settlements', async () => {
  const pool = createPool({ users: [activeUser()], ledger: [{ user_id: 'user-1', amount: 10000, currency: 'PTS', kind: 'credit', reference: 'seed:credit' }] });
  const normal = createBillingService({ pool });
  await normal.startRun('user-1', 'run-a');

  const error = new Error('audit unavailable');
  const failing = createBillingService({ pool, audit: async () => { throw error; } });
  await assert.rejects(() => failing.claimRequest('user-1', 'run-a', 'req-a'), (actual) => actual === error);
  assert.equal(pool.state.requests.has('req-a'), false);

  await normal.claimRequest('user-1', 'run-a', 'req-a');
  await assert.rejects(() => failing.settleUsage('user-1', 'run-a', [{ requestId: 'req-a', actualCostUsd: 0.5 }]), (actual) => actual === error);
  const request = pool.state.requests.get('req-a');
  assert.equal(request.settled_at, null);
  assert.equal(pool.state.ledger.some((entry) => entry.reference === 'request:req-a'), false);
});

test('audit failure rolls back an administrator ledger adjustment and preserves its reference', async () => {
  const pool = createPool({ users: [activeUser('user-admin')] });
  const error = new Error('audit unavailable');
  await assert.rejects(() => applyAdminLedgerEntry(pool, {
    userId: 'user-admin',
    amount: 25,
    kind: 'credit',
    reference: 'admin:rollback',
    audit: async () => { throw error; },
    auditActorId: 'admin-1',
  }), (actual) => actual === error);
  assert.equal(pool.state.ledger.some((entry) => entry.reference === 'admin:rollback'), false);

  await applyAdminLedgerEntry(pool, { userId: 'user-admin', amount: 25, kind: 'credit', reference: 'admin:rollback' });
  assert.equal(pool.state.ledger.filter((entry) => entry.reference === 'admin:rollback').length, 1);
});
