const crypto = require('node:crypto');

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function derive(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

// 上游 API Key 以密文形式随访问令牌下发：客户端持有但无法解密，注入层无需任何状态存储。
function sealKey(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(secret), iv);
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return base64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

function openKey(value, secret) {
  const raw = fromBase64url(value);
  if (raw.length < 29) throw new Error('SEALED_KEY_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derive(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

function sign(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const mac = base64url(crypto.createHmac('sha256', derive(secret)).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token, secret, now = Date.now()) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) throw new Error('TOKEN_MALFORMED');
  const expected = base64url(crypto.createHmac('sha256', derive(secret)).update(body).digest());
  const provided = Buffer.from(mac);
  const candidate = Buffer.from(expected);
  if (provided.length !== candidate.length || !crypto.timingSafeEqual(provided, candidate)) throw new Error('TOKEN_SIGNATURE_INVALID');
  let payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf8'));
  } catch {
    throw new Error('TOKEN_MALFORMED');
  }
  if (!payload || typeof payload !== 'object' || Number(payload.exp) * 1000 <= now) throw new Error('TOKEN_EXPIRED');
  return payload;
}

module.exports = { openKey, sealKey, sign, verify };
