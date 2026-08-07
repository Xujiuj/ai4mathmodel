const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyHostedCatalog,
  connectionKeyForStage,
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveModel,
} = require('../electron/runtime-config.cjs');

test('normalizes only public preferences and three independent model connections', () => {
  const settings = normalizeSettings({
    appearance: 'dark',
    autoSave: false,
    compactMode: true,
    executable: 'untrusted-command',
    extraConfig: 'dangerous=true',
    agentRuntime: { sourceProtection: false, maxAttemptsPerModel: 99 },
    connections: {
      reasoning: {
        provider: '自定义推理服务',
        baseUrl: 'https://reasoning.example/v1',
        protocol: 'openai',
        model: 'reasoner',
        fallbackModels: ['private-fallback'],
      },
      writing: { provider: '写作服务', baseUrl: 'https://writing.example/v1', protocol: 'anthropic', model: 'writer' },
      image: { provider: '本地生图', baseUrl: 'http://127.0.0.1:11434', protocol: 'ollama', model: 'illustrator' },
    },
  });

  assert.equal(settings.appearance, 'dark');
  assert.equal(settings.autoSave, false);
  assert.equal(settings.compactMode, true);
  assert.equal(settings.connections.reasoning.provider, '自定义推理服务');
  assert.equal(settings.connections.coding.model, 'reasoner');
  assert.equal(settings.connections.writing.model, 'writer');
  assert.equal(settings.connections.writing.protocol, 'anthropic');
  assert.equal(settings.connections.image.protocol, 'ollama');
  assert.equal('fallbackModels' in settings.connections.reasoning, false);
  assert.equal('agentRuntime' in settings, false);
  assert.equal('executable' in settings, false);
  assert.equal('extraConfig' in settings, false);
});

test('falls back to safe public defaults', () => {
  const settings = normalizeSettings({ appearance: 'sepia', connections: { reasoning: { protocol: 'unknown' } } });
  assert.equal(settings.appearance, DEFAULT_SETTINGS.appearance);
  assert.equal(settings.connections.reasoning.protocol, 'openai');
  assert.equal(DEFAULT_SETTINGS.agentPolicy.researchEnabled, false);
  assert.equal(settings.agentPolicy.researchEnabled, false);
  assert.equal(normalizeSettings({ appearance: 'system' }).appearance, 'system');
  assert.equal(normalizeSettings({ connections: { reasoning: { protocol: 'openai-responses' } } }).connections.reasoning.protocol, 'openai-responses');
});

test('persists scholarly research opt-in as a strict boolean', () => {
  assert.equal(normalizeSettings({ agentPolicy: { researchEnabled: true } }).agentPolicy.researchEnabled, true);
  assert.equal(normalizeSettings({ agentPolicy: { researchEnabled: 'true' } }).agentPolicy.researchEnabled, false);
  assert.equal(normalizeSettings({ agentPolicy: { researchEnabled: 1 } }).agentPolicy.researchEnabled, false);
});

test('resolves SOL reasoning, Terra solving, and writing models by stage', () => {
  const settings = normalizeSettings({
    connections: {
      reasoning: { model: 'reasoning-model' },
      coding: { model: 'coding-model' },
      writing: { model: 'writing-model' },
    },
  });
  assert.equal(resolveModel(settings, 'analysis'), 'reasoning-model');
  assert.equal(resolveModel(settings, 'solving'), 'coding-model');
  assert.equal(resolveModel(settings, 'paper'), 'writing-model');
});

test('migrates legacy BYOK settings without a coding connection to the reasoning model', () => {
  const settings = normalizeSettings({
    mode: 'byok',
    connections: {
      reasoning: {
        provider: 'legacy-provider',
        baseUrl: 'https://legacy.example/v1',
        protocol: 'anthropic',
        model: 'legacy-reasoner',
      },
      writing: { model: 'legacy-writer' },
      image: { model: 'legacy-image' },
    },
  });

  assert.deepEqual(settings.connections.coding, settings.connections.reasoning);
  assert.equal(resolveModel(settings, 'solving'), 'legacy-reasoner');

  const explicitlyEmpty = normalizeSettings({
    mode: 'byok',
    connections: {
      reasoning: { model: 'reasoner' },
      coding: { model: '' },
    },
  });
  assert.equal(explicitlyEmpty.connections.coding.model, '');
});

test('keeps connection labels independent from direct endpoint configuration', () => {
  const settings = normalizeSettings({
    provider: '旧服务标签',
    baseUrl: 'https://legacy.example/v1',
    model: 'legacy-model',
    protocol: 'anthropic',
    connections: {
      reasoning: { provider: '任意服务名称', baseUrl: 'https://gateway.example/v1', protocol: 'ollama', model: 'custom-model' },
    },
  });

  assert.equal(settings.connections.reasoning.provider, '任意服务名称');
  assert.equal(settings.connections.reasoning.baseUrl, 'https://gateway.example/v1');
  assert.equal(settings.connections.reasoning.protocol, 'ollama');
  assert.equal(settings.connections.reasoning.model, 'custom-model');
  assert.equal(settings.connections.writing.provider, '');
  assert.equal(settings.connections.writing.baseUrl, '');
  assert.equal(settings.connections.writing.model, '');
});

test('migrates legacy reasoning into coordinator, modeler, and coder roles', () => {
  const settings = normalizeSettings({
    mode: 'byok',
    connections: {
      reasoning: { provider: 'legacy', baseUrl: 'https://legacy.example/v1', model: 'legacy-model' },
      writing: { model: 'legacy-writer' },
    },
  });
  assert.equal(settings.connections.coordinator.model, 'legacy-model');
  assert.equal(settings.connections.modeler.model, 'legacy-model');
  assert.equal(settings.connections.coder.model, 'legacy-model');
  assert.equal(settings.connections.reasoning.model, 'legacy-model');
  assert.equal(settings.connections.writer.model, 'legacy-writer');
  assert.equal(connectionKeyForStage('supervisor'), 'coordinator');
  assert.equal(connectionKeyForStage('analysis'), 'modeler');
  assert.equal(connectionKeyForStage('review'), 'modeler');
  assert.equal(connectionKeyForStage('solving'), 'coder');
  assert.equal(connectionKeyForStage('paper'), 'writer');
});

test('hosted catalog accepts legacy fields while exposing canonical roles', () => {
  const settings = applyHostedCatalog({ mode: 'hosted', tiers: { reasoning: 'standard', coding: 'standard', writing: 'standard', image: 'standard' } }, {
    baseUrl: 'https://gateway.example/v1',
    defaultTiers: { reasoning: 'standard', coding: 'standard', writing: 'standard', image: 'standard' },
    tiers: [{ id: 'standard', models: { reasoning: 'reasoning-model', coding: 'coding-model', writing: 'writing-model', image: 'image-model' } }],
  });
  assert.equal(settings.connections.coordinator.model, 'reasoning-model');
  assert.equal(settings.connections.modeler.model, 'reasoning-model');
  assert.equal(settings.connections.coder.model, 'coding-model');
  assert.equal(settings.connections.writer.model, 'writing-model');
  assert.equal(settings.connections.image.model, 'image-model');
  assert.equal(settings.connections.reasoning.model, 'reasoning-model');
  assert.equal(settings.connections.coding.model, 'coding-model');
});
