const crypto = require('node:crypto');

const LEDGER_REFERENCE_LIMIT = 160;
const DEFAULT_CURRENCY = 'PTS';
const DEFAULT_FIXED_RUN_CREDITS = 2000;
const DEFAULT_CREDITS_PER_USD = 7200;
const MAX_ACTUAL_COST_USD = 999999.99999999;

function accountApiError(code, status = 502) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function cleanCurrency(value, fallback = DEFAULT_CURRENCY) {
  const currency = String(value || fallback).trim().toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function cleanReference(value, prefix = 'ledger') {
  const text = String(value || '').trim().replace(/[^\w:-]/g, '-').slice(0, LEDGER_REFERENCE_LIMIT);
  if (text) return text;
  return `${prefix}:${crypto.randomUUID()}`.slice(0, LEDGER_REFERENCE_LIMIT);
}

function requiredId(value, code = 'ACCOUNT_API_ID_INVALID') {
  const id = String(value || '').trim();
  if (!id || id.length > LEDGER_REFERENCE_LIMIT || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) {
    throw accountApiError(code, 400);
  }
  return id;
}

function stableReference(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}:${digest}`;
}

function pipelineReference(userId, pipelineId) {
  return stableReference('pipeline', userId, pipelineId);
}

function cleanAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw accountApiError('ACCOUNT_API_AMOUNT_INVALID', 400);
  return Number(amount.toFixed(4));
}

function cleanActualCostUsd(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(text)) throw accountApiError('ACCOUNT_API_AMOUNT_INVALID', 400);
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_ACTUAL_COST_USD) {
    throw accountApiError('ACCOUNT_API_AMOUNT_INVALID', 400);
  }
  return amount;
}

function signedAmount(kind, amount) {
  const magnitude = Math.abs(cleanAmount(amount));
  if (kind === 'credit') return magnitude;
  if (kind === 'debit') return -magnitude;
  return cleanAmount(amount);
}

function toRowNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function fetchUser(client, userId) {
  const result = await client.query(
    'SELECT id, email, role, status FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  return result.rows[0] || null;
}

async function ensureActiveUser(client, userId) {
  const user = await fetchUser(client, userId);
  if (!user || user.status !== 'active') throw accountApiError('ACCOUNT_API_USER_INACTIVE', 403);
  return user;
}

async function latestCurrency(client, userId, defaultCurrency) {
  const result = await client.query(
    'SELECT currency FROM ledger_entries WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [userId],
  );
  return cleanCurrency(result.rows[0]?.currency || defaultCurrency, defaultCurrency);
}

async function ensureCurrency(client, userId, currency, defaultCurrency) {
  const normalized = cleanCurrency(currency, defaultCurrency);
  const current = await latestCurrency(client, userId, defaultCurrency);
  if (current !== normalized) throw accountApiError('ACCOUNT_API_CURRENCY_MISMATCH', 409);
  return normalized;
}

async function insertLedgerEntry(client, {
  userId, amount, currency, kind, reference, defaultCurrency = DEFAULT_CURRENCY,
}) {
  const normalizedKind = String(kind || '').trim();
  if (!['credit', 'debit', 'adjustment'].includes(normalizedKind)) {
    throw accountApiError('ACCOUNT_API_LEDGER_KIND_INVALID', 400);
  }
  const normalizedCurrency = await ensureCurrency(client, userId, currency, defaultCurrency);
  const normalizedAmount = signedAmount(normalizedKind, amount);
  const normalizedReference = cleanReference(reference, normalizedKind);
  const inserted = await client.query(
    'INSERT INTO ledger_entries(user_id, amount, currency, kind, reference) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reference) DO NOTHING RETURNING id, user_id, amount, currency, kind, reference, created_at',
    [userId, normalizedAmount.toFixed(4), normalizedCurrency, normalizedKind, normalizedReference],
  );
  if (inserted.rowCount) return { inserted: true, row: inserted.rows[0] };
  const existing = await client.query(
    'SELECT id, user_id, amount, currency, kind, reference, created_at FROM ledger_entries WHERE reference = $1',
    [normalizedReference],
  );
  const row = existing.rows[0] || null;
  if (!row) throw accountApiError('ACCOUNT_API_LEDGER_CONFLICT', 409);
  if (String(row.user_id) !== String(userId)
    || cleanCurrency(row.currency, defaultCurrency) !== normalizedCurrency
    || String(row.kind) !== normalizedKind
    || Number(row.amount).toFixed(4) !== normalizedAmount.toFixed(4)) {
    throw accountApiError('ACCOUNT_API_LEDGER_CONFLICT', 409);
  }
  return { inserted: false, row };
}

async function snapshotAccount(clientOrPool, userId, defaultCurrency = DEFAULT_CURRENCY) {
  const run = async (client) => {
    const result = await client.query(
      `SELECT u.id, u.email, u.role, u.status,
              COALESCE(SUM(l.amount), 0) AS balance,
              COALESCE(SUM(CASE WHEN l.kind = 'debit' THEN -l.amount ELSE 0 END), 0) AS total_spend,
              COALESCE(MAX(l.currency), $2) AS currency
         FROM users u LEFT JOIN ledger_entries l ON l.user_id = u.id
        WHERE u.id = $1 GROUP BY u.id`,
      [userId, cleanCurrency(defaultCurrency)],
    );
    const row = result.rows[0] || null;
    if (!row) throw accountApiError('ACCOUNT_API_USER_NOT_FOUND', 404);
    return {
      id: String(row.id), email: String(row.email || ''), role: String(row.role || 'user'),
      status: String(row.status || 'active'), balance: toRowNumber(row.balance),
      totalSpend: toRowNumber(row.total_spend), currency: cleanCurrency(row.currency, defaultCurrency),
    };
  };
  return clientOrPool.connect ? withTransaction(clientOrPool, run) : run(clientOrPool);
}

function normalizeBillingOptions(options = {}) {
  const fixedRunCredits = Number(options.fixedRunCredits ?? DEFAULT_FIXED_RUN_CREDITS);
  const creditsPerUsd = Number(options.creditsPerUsd ?? DEFAULT_CREDITS_PER_USD);
  if (!Number.isInteger(fixedRunCredits) || fixedRunCredits < 0) throw accountApiError('ACCOUNT_API_CONFIG_INVALID', 500);
  if (!Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0) throw accountApiError('ACCOUNT_API_CONFIG_INVALID', 500);
  const currency = cleanCurrency(options.currency, DEFAULT_CURRENCY);
  if (currency !== DEFAULT_CURRENCY) throw accountApiError('ACCOUNT_API_CONFIG_INVALID', 500);
  return { fixedRunCredits, creditsPerUsd, currency };
}

async function billingRequest(client, requestId) {
  const result = await client.query(
    'SELECT request_id, user_id, pipeline_id, upstream_cost_usd, charged_credits, settled_at FROM billing_requests WHERE request_id = $1 FOR UPDATE',
    [requestId],
  );
  return result.rows[0] || null;
}

function createBillingService({ pool, fixedRunCredits = DEFAULT_FIXED_RUN_CREDITS, creditsPerUsd = DEFAULT_CREDITS_PER_USD, currency = DEFAULT_CURRENCY, audit } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw accountApiError('ACCOUNT_API_POOL_INVALID', 500);
  const config = normalizeBillingOptions({ fixedRunCredits, creditsPerUsd, currency });
  const recordAudit = typeof audit === 'function' ? audit : async () => {};

  async function startRun(userId, pipelineId) {
    const normalizedPipelineId = requiredId(pipelineId, 'ACCOUNT_API_PIPELINE_ID_INVALID');
    return withTransaction(pool, async (client) => {
      const user = await ensureActiveUser(client, userId);
      const reference = pipelineReference(user.id, normalizedPipelineId);
      const existing = await client.query('SELECT id, user_id FROM ledger_entries WHERE reference = $1 FOR UPDATE', [reference]);
      if (existing.rowCount && String(existing.rows[0].user_id) !== String(user.id)) {
        throw accountApiError('ACCOUNT_API_BILLING_PIPELINE_CONFLICT', 409);
      }
      const snapshot = await snapshotAccount(client, user.id, config.currency);
      if (!existing.rowCount && snapshot.balance < config.fixedRunCredits) {
        throw accountApiError('ACCOUNT_API_BALANCE_EXHAUSTED', 402);
      }
      const entry = existing.rowCount ? { inserted: false } : await insertLedgerEntry(client, {
        userId: user.id, amount: config.fixedRunCredits, currency: config.currency,
        kind: 'debit', reference, defaultCurrency: config.currency,
      });
      const after = await snapshotAccount(client, user.id, config.currency);
      const result = {
        charged: Boolean(entry.inserted), fixedRunCredits: config.fixedRunCredits,
        actualCost: entry.inserted ? config.fixedRunCredits : 0,
        balance: after.balance, totalSpend: after.totalSpend, currency: config.currency,
      };
      await recordAudit(client, null, user.id, 'billing_run_started', {
        pipelineId: normalizedPipelineId,
        charged: result.charged,
        fixedRunCredits: result.fixedRunCredits,
      });
      return result;
    });
  }

  async function claimRequest(userId, pipelineId, requestId) {
    const normalizedPipelineId = requiredId(pipelineId, 'ACCOUNT_API_PIPELINE_ID_INVALID');
    const normalizedRequestId = requiredId(requestId, 'ACCOUNT_API_REQUEST_ID_INVALID');
    return withTransaction(pool, async (client) => {
      await ensureActiveUser(client, userId);
      const started = await client.query(
        'SELECT id, user_id FROM ledger_entries WHERE reference = $1 FOR UPDATE',
        [pipelineReference(userId, normalizedPipelineId)],
      );
      if (!started.rowCount || String(started.rows[0].user_id) !== String(userId)) {
        throw accountApiError('ACCOUNT_API_BILLING_PIPELINE_CONFLICT', 409);
      }
      const inserted = await client.query(
        'INSERT INTO billing_requests(request_id, user_id, pipeline_id) VALUES ($1,$2,$3) ON CONFLICT (request_id) DO NOTHING RETURNING request_id',
        [normalizedRequestId, userId, normalizedPipelineId],
      );
      if (inserted.rowCount) {
        const result = { requestId: normalizedRequestId, claimed: true };
        await recordAudit(client, null, userId, 'billing_request_claimed', {
          pipelineId: normalizedPipelineId,
          requestId: result.requestId,
          claimed: result.claimed,
        });
        return result;
      }
      const existing = await billingRequest(client, normalizedRequestId);
      if (!existing || String(existing.user_id) !== String(userId) || String(existing.pipeline_id) !== normalizedPipelineId) {
        throw accountApiError('ACCOUNT_API_BILLING_REQUEST_CONFLICT', 409);
      }
      const result = { requestId: normalizedRequestId, claimed: false };
      await recordAudit(client, null, userId, 'billing_request_claimed', {
        pipelineId: normalizedPipelineId,
        requestId: result.requestId,
        claimed: result.claimed,
      });
      return result;
    });
  }

  async function settleUsage(userId, pipelineId, requestCosts = []) {
    const normalizedPipelineId = requiredId(pipelineId, 'ACCOUNT_API_PIPELINE_ID_INVALID');
    if (!Array.isArray(requestCosts)) throw accountApiError('ACCOUNT_API_REQUEST_COSTS_INVALID', 400);
    return withTransaction(pool, async (client) => {
      await ensureActiveUser(client, userId);
      let totalCredits = 0;
      const requestResults = [];
      const seenRequestCosts = new Map();
      for (const raw of requestCosts) {
        const requestId = requiredId(raw?.requestId, 'ACCOUNT_API_REQUEST_ID_INVALID');
        const actualCostUsd = cleanActualCostUsd(raw?.actualCostUsd);
        if (seenRequestCosts.has(requestId)) {
          if (seenRequestCosts.get(requestId) !== actualCostUsd) {
            throw accountApiError('ACCOUNT_API_REQUEST_COSTS_INVALID', 400);
          }
          continue;
        }
        seenRequestCosts.set(requestId, actualCostUsd);
        const request = await billingRequest(client, requestId);
        if (!request || String(request.user_id) !== String(userId) || String(request.pipeline_id) !== normalizedPipelineId) {
          throw accountApiError('ACCOUNT_API_BILLING_REQUEST_CONFLICT', 409);
        }
        let chargedCredits;
        let settled = Boolean(request.settled_at);
        let effectiveActualCostUsd = actualCostUsd;
        if (settled) {
          chargedCredits = toRowNumber(request.charged_credits);
          effectiveActualCostUsd = toRowNumber(request.upstream_cost_usd);
        } else {
          chargedCredits = Math.ceil(actualCostUsd * config.creditsPerUsd);
          await insertLedgerEntry(client, {
            userId, amount: chargedCredits, currency: config.currency, kind: 'debit',
            reference: `request:${requestId}`, defaultCurrency: config.currency,
          });
          await client.query(
            'UPDATE billing_requests SET upstream_cost_usd = $2, charged_credits = $3, settled_at = now() WHERE request_id = $1',
            [requestId, actualCostUsd, chargedCredits],
          );
          settled = true;
        }
        totalCredits += chargedCredits;
        requestResults.push({ requestId, actualCostUsd: effectiveActualCostUsd, chargedCredits, settled });
      }
      const snapshot = await snapshotAccount(client, userId, config.currency);
      const result = {
        chargedCredits: totalCredits,
        actualCost: totalCredits,
        balance: snapshot.balance,
        totalSpend: snapshot.totalSpend,
        currency: config.currency,
        complete: true,
        missingRequestIds: [],
        requestCosts: requestResults,
      };
      await recordAudit(client, null, userId, 'billing_settled', {
        pipelineId: normalizedPipelineId,
        requestCount: result.requestCosts.length,
        chargedCredits: result.chargedCredits,
      });
      return result;
    });
  }

  return { startRun, claimRequest, settleUsage };
}

async function applyAdminLedgerEntry(pool, {
  userId,
  amount,
  kind = 'adjustment',
  currency = DEFAULT_CURRENCY,
  reference = '',
  defaultCurrency = DEFAULT_CURRENCY,
  audit,
  auditActorId = null,
} = {}) {
  return withTransaction(pool, async (client) => {
    const user = await fetchUser(client, userId);
    if (!user) throw accountApiError('ACCOUNT_API_USER_NOT_FOUND', 404);
    await insertLedgerEntry(client, { userId, amount, currency, kind, reference, defaultCurrency });
    if (typeof audit === 'function') {
      await audit(client, auditActorId, userId, 'admin_ledger_adjusted', {
        amount: Number(amount) || 0,
        kind: String(kind || 'adjustment'),
        currency: cleanCurrency(currency, defaultCurrency),
        reference: String(reference || ''),
      });
    }
    return snapshotAccount(client, userId, defaultCurrency);
  });
}

async function listLedgerEntries(pool, { userId, limit = 50, offset = 0, defaultCurrency = DEFAULT_CURRENCY } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return withTransaction(pool, async (client) => {
    const user = await fetchUser(client, userId);
    if (!user) throw accountApiError('ACCOUNT_API_USER_NOT_FOUND', 404);
    const rows = await client.query(
      `SELECT id, user_id, amount, currency, kind, reference, created_at FROM ledger_entries
       WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [userId, safeLimit, safeOffset],
    );
    return {
      entries: rows.rows.map((row) => ({ id: Number(row.id), userId: String(row.user_id), amount: toRowNumber(row.amount), currency: cleanCurrency(row.currency, defaultCurrency), kind: String(row.kind), reference: String(row.reference), createdAt: row.created_at })),
      limit: safeLimit, offset: safeOffset,
    };
  });
}

module.exports = {
  accountApiError,
  applyAdminLedgerEntry,
  cleanCurrency,
  cleanReference,
  cleanActualCostUsd,
  createBillingService,
  listLedgerEntries,
  snapshotAccount,
  withTransaction,
};
