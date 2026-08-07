const crypto = require('node:crypto');
const bundle = require('../generated/agent-skills.bundle.json');
const { assertBundleStructure } = require('./agent-skills-contract.cjs');

function canonicalPayload(value) {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    bundleVersion: value.bundleVersion,
    sources: value.sources,
    modules: value.modules,
    stages: value.stages,
  });
}

function verifyBundle(value = bundle) {
  const expected = value?.integrity?.sha256;
  const actual = crypto.createHash('sha256').update(canonicalPayload(value)).digest('hex');
  if (!expected || value?.integrity?.algorithm !== 'sha256' || expected !== actual) {
    const error = new Error('Agent skill bundle integrity check failed.');
    error.code = 'AGENT_SKILL_BUNDLE_TAMPERED';
    throw error;
  }
  return assertBundleStructure(value);
}

function skillGuidanceForStage(stage, value = bundle) {
  const checked = verifyBundle(value);
  const entry = checked.stages?.[String(stage || '').trim().toLowerCase()];
  if (!entry || !Array.isArray(entry.rules) || !entry.rules.length) return '';
  const modules = entry.moduleIds.map((id) => checked.modules.find((module) => module.id === id));
  if (modules.some((module) => !module)) return '';
  const handbook = modules.map((module) => `\n### ${module.title}\n${module.content}`).join('\n');
  return `\n\nCompiled scientific workflow (self-contained, stage-scoped):\n${entry.rules.join('\n')}\n${handbook}`;
}

verifyBundle(bundle);

module.exports = { canonicalPayload, skillGuidanceForStage, verifyBundle };
