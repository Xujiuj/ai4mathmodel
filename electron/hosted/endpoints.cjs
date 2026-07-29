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
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

// 打包后不存在开发环境变量，发布构建把地址写入同目录 endpoints.json（已 gitignore）。
function bakedEndpoints() {
  try {
    return require('./endpoints.json');
  } catch {
    return {};
  }
}

function hostedEndpoints(env = process.env) {
  const baked = bakedEndpoints();
  return {
    gateway: cleanUrl(env.MODELING_HOSTED_GATEWAY || baked.gateway),
    portal: cleanUrl(env.MODELING_HOSTED_PORTAL || baked.portal),
  };
}

function hostedConfigured(endpoints = hostedEndpoints()) {
  return Boolean(endpoints.gateway && endpoints.portal);
}

module.exports = { cleanUrl, hostedConfigured, hostedEndpoints };
