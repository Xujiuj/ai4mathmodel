const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertRuntimeAvailable,
  requiredRuntimes,
  runtimePreflight,
} = require('../electron/runtime-preflight.cjs');

test('runtime requirements are stage-specific and deduplicated', () => {
  assert.deepEqual(requiredRuntimes(['analysis', 'solving']), ['python']);
  assert.deepEqual(requiredRuntimes(['paper', 'compile']), ['python', 'tectonic']);
  assert.deepEqual(runtimePreflight({ python: true, tectonic: false }, ['analysis']), {
    ok: true,
    required: ['python'],
    missing: [],
  });
});

test('runtime preflight blocks before paid stages when a required component is absent', () => {
  assert.throws(
    () => assertRuntimeAvailable({ python: true, tectonic: false }, ['analysis', 'solving', 'paper', 'review']),
    (error) => error.code === 'RUNTIME_PREFLIGHT_FAILED'
      && error.missing.length === 1
      && error.missing[0] === 'tectonic',
  );
});
