const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostedClient } = require('../electron/hosted/client.cjs');
const { hostedEndpoints } = require('../electron/hosted/endpoints.cjs');

function jsonResponse(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return { ok: true, status: 200, arrayBuffer: async () => body };
}

test('hosted catalog sanitizer exposes canonical roles and legacy aliases', async () => {
  const client = createHostedClient({
    endpoints: hostedEndpoints({
      MODELING_HOSTED_GATEWAY: 'https://gateway.example.com/agent',
      MODELING_HOSTED_PORTAL: 'https://portal.example.com',
    }),
    session: {
      deviceId: async () => 'device',
      credential: async () => 'credential',
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/token')) return jsonResponse({ accessToken: 'access', expiresAt: Date.now() + 60_000 });
      return jsonResponse({
        baseUrl: 'https://gateway.example.com/v1',
        tiers: [{
          id: 'standard',
          models: {
            coordinator: 'coordinator-model',
            modeler: 'modeler-model',
            coder: 'coder-model',
            writer: 'writer-model',
            image: 'image-model',
          },
        }],
        defaultTiers: {
          coordinator: 'standard',
          modeler: 'standard',
          coder: 'standard',
          writer: 'standard',
          image: 'standard',
        },
      });
    },
  });

  const catalog = await client.catalog();
  assert.deepEqual(catalog.tiers[0].models, {
    coordinator: 'coordinator-model',
    modeler: 'modeler-model',
    coder: 'coder-model',
    writer: 'writer-model',
    reasoning: 'coordinator-model',
    coding: 'coder-model',
    writing: 'writer-model',
    image: 'image-model',
  });
  assert.deepEqual(catalog.defaultTiers, {
    coordinator: 'standard',
    modeler: 'standard',
    coder: 'standard',
    writer: 'standard',
    reasoning: 'standard',
    coding: 'standard',
    writing: 'standard',
    image: 'standard',
  });
});
