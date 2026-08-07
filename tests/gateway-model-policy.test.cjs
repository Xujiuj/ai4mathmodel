const test = require('node:test');
const assert = require('node:assert/strict');

const { createModelResolver, normalizeCatalog } = require('../gateway/server.cjs');

test('gateway catalog normalizes canonical roles while retaining migration aliases', () => {
  const catalog = normalizeCatalog({
    tiers: [{ id: 'standard', models: { reasoning: 'reasoning-model', coding: 'coding-model', writing: 'writing-model', image: 'image-model' } }],
    defaultTiers: { reasoning: 'standard', coding: 'standard', writing: 'standard', image: 'standard' },
  });
  assert.deepEqual(catalog.tiers[0].models, {
    coordinator: 'reasoning-model',
    modeler: 'reasoning-model',
    coder: 'coding-model',
    writer: 'writing-model',
    image: 'image-model',
    reasoning: 'reasoning-model',
    coding: 'coding-model',
    writing: 'writing-model',
  });
  assert.deepEqual(catalog.defaultTiers, {
    coordinator: 'standard',
    modeler: 'standard',
    coder: 'standard',
    writer: 'standard',
    image: 'standard',
    reasoning: 'standard',
    coding: 'standard',
    writing: 'standard',
  });
});

test('gateway model policy accepts configured models and falls back unknown or absent requests', () => {
  const resolver = createModelResolver({
    tiers: [
      { id: 'standard', models: { coordinator: 'coord-default', modeler: 'model-default', coder: 'code-default', writer: 'write-default', image: 'image-default' } },
      { id: 'premium', models: { coordinator: 'coord-premium', modeler: 'model-premium', coder: 'code-premium', writer: 'write-premium', image: 'image-premium' } },
    ],
    defaultTiers: { coordinator: 'standard', modeler: 'standard', coder: 'standard', writer: 'standard', image: 'standard' },
  });
  assert.equal(resolver.resolve({ role: 'modeler', requestedModel: 'model-premium' }), 'model-premium');
  assert.equal(resolver.resolve({ role: 'modeler', requestedModel: 'https://attacker.example/model' }), 'model-default');
  assert.equal(resolver.resolve({ role: 'coder' }), 'code-default');
  assert.equal(resolver.resolve({ role: 'image', requestedModel: 'other-provider-model' }), 'image-default');
});

test('gateway model policy fails closed when a role has no configured model', () => {
  const resolver = createModelResolver({ tiers: [{ id: 'standard', models: { image: 'image-model' } }], defaultTiers: { image: 'standard' } });
  assert.throws(() => resolver.resolve({ role: 'modeler', requestedModel: 'arbitrary-model' }), (error) => error.message === 'MODEL_UNAVAILABLE' && error.status === 503);
});
