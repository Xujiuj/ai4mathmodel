const { requestJson } = require('./sub2api.cjs');

function accountApiError(code, status = 502) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function cleanUser(value) {
  if (!value || typeof value !== 'object') throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
  const id = String(value.id || '').slice(0, 64);
  const email = String(value.email || '').trim().toLowerCase().slice(0, 160);
  const role = String(value.role || 'user').slice(0, 32);
  const status = String(value.status || 'active').slice(0, 32);
  if (!id || !email || status !== 'active') throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
  const currency = String(value.currency || 'PTS').toUpperCase().slice(0, 3);
  if (currency !== 'PTS') throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
  return {
    id,
    email,
    role,
    status,
    balance: Number(value.balance) || 0,
    currency,
    totalSpend: Number(value.totalSpend) || 0,
  };
}

function cleanBillingResult(value) {
  if (!value || typeof value !== 'object') throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
  const currency = String(value.currency || 'PTS').toUpperCase().slice(0, 3);
  if (currency !== 'PTS') throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
  return {
    actualCost: Number(value.actualCost) || 0,
    balance: Number(value.balance) || 0,
    totalSpend: Number(value.totalSpend) || 0,
    currency,
    ...(typeof value.charged === 'boolean' ? { charged: value.charged } : {}),
    ...(Number.isFinite(Number(value.fixedRunCredits)) ? { fixedRunCredits: Number(value.fixedRunCredits) } : {}),
  };
}

function createAccountApiAdapter({ base, serviceToken = '' }) {
  if (!base) throw new Error('ACCOUNT_API_CONFIG_INVALID');

  async function request(path, options = {}) {
    const response = await requestJson(base, path, options);
    if (response.status === 401 || response.status === 403) throw accountApiError('ACCOUNT_API_AUTH_FAILED', response.status);
    if (response.status === 402) throw accountApiError('ACCOUNT_API_BALANCE_EXHAUSTED', response.status);
    if (response.status === 409) throw accountApiError('ACCOUNT_API_CONFLICT', response.status);
    if (response.status < 200 || response.status >= 300) throw accountApiError('ACCOUNT_API_UNAVAILABLE', response.status || 502);
    if (!response.body || typeof response.body !== 'object') throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
    return response.body;
  }

  async function signIn(path, email, password) {
    const body = await request(path, {
      method: 'POST',
      body: {
        email: String(email || '').trim().toLowerCase().slice(0, 160),
        password: String(password || '').slice(0, 200),
      },
    });
    const token = String(body.token || '').trim();
    if (!token || token.length > 256) throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
    return { token, user: cleanUser(body.user) };
  }

  async function internal(path, body) {
    if (String(serviceToken).length < 32) throw accountApiError('ACCOUNT_API_SERVICE_CONFIG_INVALID', 500);
    return request(path, { method: 'POST', token: serviceToken, body });
  }

  return {
    async ready() {
      const response = await requestJson(base, '/health/ready', { timeoutMs: 3_000 });
      if (response.status !== 200 || response.body?.ok !== true) {
        throw accountApiError('ACCOUNT_API_UNAVAILABLE', response.status || 502);
      }
      return true;
    },
    login(email, password) {
      return signIn('/login', email, password);
    },
    register(email, password) {
      return signIn('/register', email, password);
    },
    async profile(token) {
      const body = await request('/me', { token });
      return cleanUser(body.user);
    },
    async logout(token) {
      const response = await requestJson(base, '/logout', { method: 'POST', token });
      if ([200, 204, 401, 403].includes(response.status)) return true;
      throw accountApiError('ACCOUNT_API_UNAVAILABLE', response.status || 502);
    },
    async startRun(userId, pipelineId) {
      return cleanBillingResult(await internal('/internal/billing/start', { userId, pipelineId }));
    },
    async claimRequest(userId, pipelineId, requestId) {
      const body = await internal('/internal/billing/claim', { userId, pipelineId, requestId });
      if (String(body.requestId || '') !== String(requestId)) throw accountApiError('ACCOUNT_API_RESPONSE_INVALID');
      return { claimed: body.claimed === true, requestId: String(body.requestId) };
    },
    async settleUsage(userId, pipelineId, requestCosts) {
      return cleanBillingResult(await internal('/internal/billing/settle', { userId, pipelineId, requestCosts }));
    },
  };
}

module.exports = { accountApiError, cleanBillingResult, cleanUser, createAccountApiAdapter };
