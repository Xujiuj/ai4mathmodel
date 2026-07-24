const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  assert.equal(normalizeSettings({ appearance: 'system' }).appearance, 'system');
});

test('resolves reasoning and writing models by stage', () => {
  const settings = normalizeSettings({
    connections: {
      reasoning: { model: 'reasoning-model' },
      writing: { model: 'writing-model' },
    },
  });
  assert.equal(resolveModel(settings, 'analysis'), 'reasoning-model');
  assert.equal(resolveModel(settings, 'solving'), 'reasoning-model');
  assert.equal(resolveModel(settings, 'paper'), 'writing-model');
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
