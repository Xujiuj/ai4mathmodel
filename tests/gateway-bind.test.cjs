const test = require('node:test');
const assert = require('node:assert/strict');

const { assertLoopbackBindHost } = require('../gateway/server.cjs');

test('gateway HTTP listener defaults to IPv4 loopback', () => {
  assert.equal(assertLoopbackBindHost(), '127.0.0.1');
  assert.equal(assertLoopbackBindHost(''), '127.0.0.1');
});

test('gateway HTTP listener accepts only explicit loopback addresses', () => {
  assert.equal(assertLoopbackBindHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertLoopbackBindHost('::1'), '::1');
  for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.10', 'gateway.internal']) {
    assert.throws(() => assertLoopbackBindHost(host), /loopback address/);
  }
});
