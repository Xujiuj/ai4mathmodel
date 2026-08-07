const test = require('node:test');
const assert = require('node:assert/strict');

const { buildModelRoutes, imageModelForAttempt } = require('../electron/supervisor/model-router.cjs');

test('uses explicit four-agent roles without cross-role fallback', () => {
  const settings = {
    connections: {
      coordinator: { baseUrl: 'https://coord.example/v1', model: 'coordinator-model' },
      modeler: { baseUrl: 'https://modeler.example/v1', model: 'modeler-model' },
      coder: { baseUrl: 'https://coder.example/v1', model: 'coder-model' },
      writer: { baseUrl: 'https://writer.example/v1', protocol: 'anthropic', model: 'writer-model' },
    },
  };
  assert.deepEqual(buildModelRoutes(settings, 'solving').map((route) => route.connectionKey), ['coder']);
  assert.deepEqual(buildModelRoutes(settings, 'paper').map((route) => route.connectionKey), ['writer']);
  assert.deepEqual(buildModelRoutes(settings, 'analysis').map((route) => route.connectionKey), ['modeler']);
  assert.deepEqual(buildModelRoutes(settings, 'review').map((route) => route.connectionKey), ['modeler']);
  assert.deepEqual(buildModelRoutes(settings, 'supervisor', { supervisor: true }).map((route) => route.connectionKey), ['coordinator']);
});

test('routes legacy connections through canonical role aliases', () => {
  const settings = {
    connections: {
      reasoning: { baseUrl: 'https://legacy.example/v1', model: 'legacy-model' },
      writing: { baseUrl: 'https://writer.example/v1', model: 'legacy-writer' },
    },
  };
  assert.equal(buildModelRoutes(settings, 'analysis')[0].connectionKey, 'modeler');
  assert.equal(buildModelRoutes(settings, 'analysis')[0].model, 'legacy-model');
  assert.equal(buildModelRoutes(settings, 'solving')[0].connectionKey, 'coder');
  assert.equal(buildModelRoutes(settings, 'solving')[0].model, 'legacy-model');
  assert.equal(buildModelRoutes(settings, 'paper')[0].connectionKey, 'writer');
  assert.equal(buildModelRoutes(settings, 'paper')[0].model, 'legacy-writer');
});

test('routes image generation through the dedicated image connection', () => {
  const settings = {
    connections: {
      image: { baseUrl: 'http://127.0.0.1:11434', model: 'image-model' },
      reasoning: { model: 'legacy-reasoning-model' },
    },
  };
  assert.equal(imageModelForAttempt(settings), 'image-model');
  assert.equal(buildModelRoutes(settings, 'paper')[0].connectionKey, 'writer');
});
