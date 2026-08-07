const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gatewayRoot = path.join(__dirname, '..', 'deploy', 'hermes', 'gateway');

test('production gateway templates overwrite forwarded client identity with the direct peer address', () => {
  for (const filename of ['math-model-gateway.nginx.conf', 'math-model-gateway.pinned.nginx.conf']) {
    const source = fs.readFileSync(path.join(gatewayRoot, filename), 'utf8');
    assert.match(source, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/, filename);
    assert.doesNotMatch(source, /X-Forwarded-For\s+\$proxy_add_x_forwarded_for\b/, filename);
  }
});

test('ACME-only gateway template does not introduce a forwarded-header proxy path', () => {
  const source = fs.readFileSync(path.join(gatewayRoot, 'math-model-gateway.acme.nginx.conf'), 'utf8');
  assert.doesNotMatch(source, /proxy_set_header\s+X-Forwarded-For\b/);
  assert.doesNotMatch(source, /\$proxy_add_x_forwarded_for\b/);
});
