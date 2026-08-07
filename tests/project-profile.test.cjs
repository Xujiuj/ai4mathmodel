const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPETITIONS,
  DEFAULT_PROJECT_PROFILE,
  PAPER_FORMATS,
  PROJECT_SCHEMA_VERSION,
  normalizeProjectProfile,
  normalizeProjectRecord,
} = require('../electron/project-profile.cjs');
const { projectProfileGuidance, stagePrompt } = require('../electron/supervisor/playbooks.cjs');

test('publishes the supported project profile contract', () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 2);
  assert.deepEqual(COMPETITIONS, ['china', 'american']);
  assert.deepEqual(PAPER_FORMATS, ['latex', 'markdown']);
  assert.deepEqual(DEFAULT_PROJECT_PROFILE, { competition: 'china', paperFormat: 'latex' });
});

test('migrates legacy project records to deterministic defaults', () => {
  assert.deepEqual(normalizeProjectRecord({ id: 'legacy', name: 'Legacy' }), {
    id: 'legacy',
    name: 'Legacy',
    projectSchemaVersion: 2,
    profile: { competition: 'china', paperFormat: 'latex' },
  });
  assert.deepEqual(normalizeProjectRecord(null), {
    projectSchemaVersion: 2,
    profile: { competition: 'china', paperFormat: 'latex' },
  });
});

test('accepts American competition projects with Markdown authoring', () => {
  const record = normalizeProjectRecord({
    id: 'mcm',
    profile: { competition: 'american', paperFormat: 'markdown' },
  });
  assert.deepEqual(record.profile, { competition: 'american', paperFormat: 'markdown' });
});

test('falls back invalid project profile values independently', () => {
  assert.deepEqual(normalizeProjectProfile({ competition: 'other', paperFormat: 'markdown' }), {
    competition: 'china',
    paperFormat: 'markdown',
  });
  assert.deepEqual(normalizeProjectProfile({ competition: 'american', paperFormat: 'docx' }), {
    competition: 'american',
    paperFormat: 'latex',
  });
  assert.deepEqual(normalizeProjectProfile([]), DEFAULT_PROJECT_PROFILE);
});

test('preserves extension fields without mutating input', () => {
  const input = {
    id: 'future',
    schemaVersion: 17,
    custom: { keep: true },
    profile: { competition: 'american', paperFormat: 'markdown', locale: 'en-US' },
  };
  const before = structuredClone(input);
  const normalized = normalizeProjectRecord(input);

  assert.deepEqual(input, before);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.profile, input.profile);
  assert.deepEqual(normalized.custom, { keep: true });
  assert.equal(normalized.schemaVersion, 17);
  assert.equal(normalized.profile.locale, 'en-US');
  assert.equal(normalized.projectSchemaVersion, 2);
});

test('adds competition and dual-artifact requirements to Agent prompts', () => {
  const guidance = projectProfileGuidance({ competition: 'american', paperFormat: 'markdown' });
  assert.match(guidance, /MCM\/ICM/);
  assert.match(guidance, /paper\.md/);
  assert.match(guidance, /TeX.*PDF/);

  const prompt = stagePrompt('C:\\projects\\contest', 'paper', { competition: 'american', paperFormat: 'markdown' });
  assert.match(prompt, /美国大学生数学建模竞赛/);
  assert.match(prompt, /Markdown 双产物/);
});
