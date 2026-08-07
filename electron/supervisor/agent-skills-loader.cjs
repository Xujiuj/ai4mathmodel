const crypto = require('node:crypto');
const bundle = require('../generated/agent-skills.bundle.json');

function canonicalPayload(value) {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    bundleVersion: value.bundleVersion,
    sources: value.sources,
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
  return value;
}

function skillGuidanceForStage(stage, value = bundle) {
  const checked = verifyBundle(value);
  const entry = checked.stages?.[String(stage || '').trim().toLowerCase()];
  if (!entry || !Array.isArray(entry.rules) || !entry.rules.length) return '';
  return `\n\nCompiled scientific skill rules (stage-scoped):\n${entry.rules.join('\n')}`;
}

verifyBundle(bundle);

module.exports = { canonicalPayload, skillGuidanceForStage, verifyBundle };
