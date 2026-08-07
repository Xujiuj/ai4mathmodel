const SCHEMA_VERSION = 1;
const BUNDLE_VERSION = '2';

const REQUIRED_SOURCE_IDS = Object.freeze([
  'mmc-workflow-orchestrator',
  'mmc-problem-intake',
  'mmc-literature-evidence',
  'mmc-model-design',
  'mmc-computational-experiment',
  'mmc-result-validation',
  'mmc-scientific-visualization',
  'mmc-paper-authoring',
  'mmc-prose-polish',
  'mmc-submission-audit',
]);

const STAGE_SKILL_IDS = Object.freeze({
  analysis: Object.freeze([
    'mmc-workflow-orchestrator',
    'mmc-problem-intake',
    'mmc-literature-evidence',
    'mmc-model-design',
    'mmc-scientific-visualization',
  ]),
  solving: Object.freeze([
    'mmc-workflow-orchestrator',
    'mmc-computational-experiment',
    'mmc-result-validation',
    'mmc-scientific-visualization',
  ]),
  paper: Object.freeze([
    'mmc-workflow-orchestrator',
    'mmc-literature-evidence',
    'mmc-scientific-visualization',
    'mmc-paper-authoring',
    'mmc-prose-polish',
  ]),
  review: Object.freeze([
    'mmc-workflow-orchestrator',
    'mmc-literature-evidence',
    'mmc-result-validation',
    'mmc-scientific-visualization',
    'mmc-paper-authoring',
    'mmc-prose-polish',
    'mmc-submission-audit',
  ]),
});

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function assertBundleStructure(value, {
  code = 'AGENT_SKILL_BUNDLE_INVALID',
  message = 'Agent skill bundle structure is invalid.',
} = {}) {
  const sourceIds = Array.isArray(value?.sources) ? value.sources.map((source) => source?.id) : [];
  const stageNames = Object.keys(value?.stages || {});
  let valid = value?.schemaVersion === SCHEMA_VERSION
    && value?.bundleVersion === BUNDLE_VERSION
    && sameArray(sourceIds, REQUIRED_SOURCE_IDS)
    && sameArray(stageNames, Object.keys(STAGE_SKILL_IDS));

  for (const [stage, expectedIds] of Object.entries(STAGE_SKILL_IDS)) {
    const entry = value?.stages?.[stage];
    valid = valid
      && sameArray(entry?.skillIds, expectedIds)
      && Array.isArray(entry?.rules)
      && entry.rules.length > 0
      && entry.rules.every((rule) => typeof rule === 'string' && rule.trim().length > 0)
      && expectedIds.every((id) => entry.rules.some((rule) => rule.startsWith(`[${id}] `)));
  }

  if (!valid) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  return value;
}

module.exports = {
  BUNDLE_VERSION,
  REQUIRED_SOURCE_IDS,
  SCHEMA_VERSION,
  STAGE_SKILL_IDS,
  assertBundleStructure,
};
