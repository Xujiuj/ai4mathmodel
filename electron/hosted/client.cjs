const { hostedConfigured } = require('./endpoints.cjs');

const CATALOG_TTL_MS = 10 * 60 * 1000;
const TOKEN_SKEW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function hostedError(code, status = 0) {
  const messages = {
    HOSTED_NOT_CONFIGURED: '未配置托管服务地址。',
    HOSTED_SIGNED_OUT: '尚未登录托管账户。',
    HOSTED_AUTH_FAILED: '托管账户登录失败或凭据已失效。',
    HOSTED_BALANCE_EXHAUSTED: '账户余额不足，请先充值。',
    HOSTED_RATE_LIMITED: '当前排队人数较多，请稍后重试。',
    HOSTED_UNAVAILABLE: '托管服务暂时不可用。',
    HOSTED_NETWORK_ERROR: '无法连接托管服务。',
    HOSTED_RESPONSE_INVALID: '托管服务返回了无法识别的响应。',
  };
  const error = new Error(messages[code] || '托管服务请求失败。');
  error.code = code;
  error.status = status;
  return error;
}

function statusError(status) {
  if (status === 401 || status === 403) return hostedError('HOSTED_AUTH_FAILED', status);
  if (status === 402) return hostedError('HOSTED_BALANCE_EXHAUSTED', status);
  if (status === 429) return hostedError('HOSTED_RATE_LIMITED', status);
  return hostedError('HOSTED_UNAVAILABLE', status);
}

function cleanTier(raw = {}) {
  const models = raw.models && typeof raw.models === 'object' ? raw.models : {};
  return {
    id: String(raw.id || '').slice(0, 40),
    label: String(raw.label || '').slice(0, 60),
    models: {
      reasoning: String(models.reasoning || raw.model || '').slice(0, 160),
      writing: String(models.writing || raw.model || '').slice(0, 160),
      image: String(models.image || '').slice(0, 160),
    },
  };
}

function cleanCatalog(payload = {}, gateway = '') {
  const tiers = (Array.isArray(payload.tiers) ? payload.tiers : []).map(cleanTier).filter((tier) => tier.id);
  const defaults = payload.defaultTiers && typeof payload.defaultTiers === 'object' ? payload.defaultTiers : {};
  return {
    baseUrl: String(payload.baseUrl || `${gateway}/v1`).slice(0, 2048),
    tiers,
    defaultTiers: {
      reasoning: String(defaults.reasoning || tiers[0]?.id || '').slice(0, 40),
      writing: String(defaults.writing || defaults.reasoning || tiers[0]?.id || '').slice(0, 40),
      image: String(defaults.image || '').slice(0, 40),
    },
    imageEnabled: payload.imageEnabled !== false,
    maxImagesPerStage: Math.min(Math.max(Number(payload.maxImagesPerStage) || 1, 0), 4),
    playbookVersion: String(payload.playbookVersion || '').slice(0, 40),
  };
}

function cleanAccount(payload = {}) {
  return {
    email: String(payload.email || '').slice(0, 160),
    currency: String(payload.currency || 'CNY').toUpperCase().slice(0, 3),
    balance: Number(payload.balance) || 0,
    totalSpend: Number(payload.totalSpend) || 0,
  };
}

function createHostedClient({
  endpoints,
  session,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!endpoints || !session || typeof fetchImpl !== 'function') {
    throw new Error('托管客户端配置不完整。');
  }
  let catalogCache = null;
  let tokenCache = null;

  async function request(path, { method = 'GET', body, token } = {}) {
    if (!hostedConfigured(endpoints)) throw hostedError('HOSTED_NOT_CONFIGURED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${endpoints.gateway}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw hostedError('HOSTED_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw statusError(Number(response?.status) || 0);
    const raw = Buffer.from(await response.arrayBuffer());
    if (!raw.length || raw.length > MAX_RESPONSE_BYTES) throw hostedError('HOSTED_RESPONSE_INVALID');
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw hostedError('HOSTED_RESPONSE_INVALID');
    }
  }

  async function credential() {
    if (!hostedConfigured(endpoints)) throw hostedError('HOSTED_NOT_CONFIGURED');
    const value = await session.credential();
    if (!value) throw hostedError('HOSTED_SIGNED_OUT');
    return value;
  }

  return {
    configured: () => hostedConfigured(endpoints),

    async signedIn() {
      return Boolean(await session.credential());
    },

    async login({ email, password }) {
      const payload = await request('/auth/login', {
        method: 'POST',
        body: {
          email: String(email || '').slice(0, 160),
          password: String(password || '').slice(0, 200),
          deviceId: await session.deviceId(),
        },
      });
      const value = String(payload?.credential || '');
      if (!value) throw hostedError('HOSTED_AUTH_FAILED');
      await session.setCredential(value, payload?.email || email);
      tokenCache = null;
      catalogCache = null;
      return cleanAccount(payload?.account || {});
    },

    async logout() {
      tokenCache = null;
      catalogCache = null;
      await session.clear();
    },

    // 短期访问令牌只驻留内存，不经 IPC 下发到渲染层。
    async accessToken({ force = false } = {}) {
      if (!force && tokenCache && tokenCache.expiresAt - TOKEN_SKEW_MS > now()) return tokenCache.token;
      const payload = await request('/auth/token', {
        method: 'POST',
        token: await credential(),
        body: { deviceId: await session.deviceId() },
      });
      const token = String(payload?.accessToken || '');
      if (!token) throw hostedError('HOSTED_AUTH_FAILED');
      tokenCache = { token, expiresAt: Number(payload?.expiresAt) || now() + 15 * 60 * 1000 };
      return token;
    },

    async catalog({ force = false } = {}) {
      if (!force && catalogCache && catalogCache.fetchedAt + CATALOG_TTL_MS > now()) return catalogCache.value;
      const payload = await request('/catalog', { token: await this.accessToken() });
      const value = cleanCatalog(payload, endpoints.gateway);
      catalogCache = { value, fetchedAt: now() };
      return value;
    },

    async account() {
      return cleanAccount(await request('/account', { token: await this.accessToken() }));
    },

    async topUpUrl() {
      const payload = await request('/topup', { token: await this.accessToken() });
      const url = String(payload?.url || '');
      if (!url.startsWith(endpoints.portal)) throw hostedError('HOSTED_RESPONSE_INVALID');
      return url;
    },
  };
}

module.exports = { createHostedClient, hostedError };
