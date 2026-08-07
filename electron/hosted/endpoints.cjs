function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return '';
  if (url.username || url.password) return '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function cleanGatewayUrl(value) {
  const cleaned = cleanUrl(value);
  if (!cleaned) return '';
  const url = new URL(cleaned);
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '/agent') return '';
  url.pathname = '/agent';
  return url.toString().replace(/\/+$/, '');
}

function trustedLocalDevUrl(value, { isPackaged = true } = {}) {
  if (isPackaged) return '';
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return '';
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function cleanFingerprint256(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-F0-9]/g, '');
  if (!/^[A-F0-9]{64}$/.test(normalized)) return '';
  return normalized.match(/.{2}/g).join(':');
}

// Production builds trust only this packaged file. Development overrides must
// be passed explicitly by the main process after it validates development mode.
function bakedEndpoints() {
  try {
    return require('./endpoints.json');
  } catch {
    return {};
  }
}

function hostedEndpoints(environmentOverrides, baked = bakedEndpoints()) {
  const env = environmentOverrides && typeof environmentOverrides === 'object' ? environmentOverrides : {};
  return {
    gateway: cleanGatewayUrl(env.MODELING_HOSTED_GATEWAY || baked.gateway),
    portal: cleanUrl(env.MODELING_HOSTED_PORTAL || baked.portal),
    gatewayCertificateFingerprint256: cleanFingerprint256(
      env.MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256
      || baked.gatewayCertificateFingerprint256,
    ),
  };
}

function hostedConfigured(endpoints = hostedEndpoints()) {
  return Boolean(endpoints.gateway && endpoints.portal);
}

function isPinnedGatewayCertificate({ url, fingerprint256, endpoints = hostedEndpoints() } = {}) {
  const expectedFingerprint = cleanFingerprint256(endpoints.gatewayCertificateFingerprint256);
  if (!expectedFingerprint) return false;
  try {
    return new URL(String(url || '')).origin === new URL(String(endpoints.gateway || '')).origin
      && cleanFingerprint256(fingerprint256) === expectedFingerprint;
  } catch {
    return false;
  }
}

module.exports = {
  cleanFingerprint256,
  cleanGatewayUrl,
  cleanUrl,
  hostedConfigured,
  hostedEndpoints,
  isPinnedGatewayCertificate,
  trustedLocalDevUrl,
};
