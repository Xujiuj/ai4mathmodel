const crypto = require('node:crypto');

const SCHEMA_VERSION = 3;
const BUNDLE_VERSION = '4';

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
const REQUIRED_RECIPE_IDS = Object.freeze([
  'mmc-literature-evidence:recipe-literature-tools',
  'mmc-computational-experiment:recipe-modeling-recipes',
  'mmc-computational-experiment:recipe-profile-dataset',
  'mmc-result-validation:recipe-validate-results',
  'mmc-scientific-visualization:recipe-publication-plots',
  'mmc-paper-authoring:recipe-generate-paper-scaffold',
  'mmc-prose-polish:recipe-paper-lint',
  'mmc-submission-audit:recipe-release-audit',
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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function validSchema(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.type;
}

function validModule(module) {
  const kinds = new Set(['procedure', 'reference', 'recipe', 'template']);
  const languages = new Set(['markdown', 'python', 'latex', 'typst', 'text']);
  const base = typeof module?.id === 'string'
    && REQUIRED_SOURCE_IDS.includes(module.skillId)
    && typeof module.title === 'string'
    && kinds.has(module.kind)
    && languages.has(module.language)
    && typeof module.entrypoint === 'boolean'
    && Array.isArray(module.allowedStages)
    && module.allowedStages.length > 0
    && module.allowedStages.every((stage) => Object.hasOwn(STAGE_SKILL_IDS, stage))
    && Array.isArray(module.problemFamilies)
    && module.problemFamilies.length > 0
    && module.problemFamilies.every((family) => typeof family === 'string' && family.length > 0)
    && typeof module.content === 'string'
    && module.content.length >= 80
    && /^[a-f0-9]{64}$/.test(module.sha256 || '')
    && /^[a-f0-9]{64}$/.test(module.contentSha256 || '')
    && module.contentSha256 === sha256(module.content);
  if (!base) return false;
  if (module.kind !== 'recipe') {
    return module.entrypoint === false
      && module.executionSource === undefined
      && module.executionSha256 === undefined
      && module.sha256 === module.contentSha256;
  }
  return module.language === 'python'
    && module.entrypoint === true
    && validSchema(module.argumentSchema)
    && validSchema(module.outputSchema)
    && typeof module.executionSource === 'string'
    && module.executionSource.length >= 80
    && module.executionSha256 === module.sha256
    && module.executionSha256 === sha256(module.executionSource);
}

function assertBundleStructure(value, {
  code = 'AGENT_SKILL_BUNDLE_INVALID',
  message = 'Agent skill bundle structure is invalid.',
} = {}) {
  const sourceIds = Array.isArray(value?.sources) ? value.sources.map((source) => source?.id) : [];
  const modules = Array.isArray(value?.modules) ? value.modules : [];
  const moduleIds = modules.map((module) => module?.id);
  const stageNames = Object.keys(value?.stages || {});
  let valid = value?.schemaVersion === SCHEMA_VERSION
    && value?.bundleVersion === BUNDLE_VERSION
    && sameArray(sourceIds, REQUIRED_SOURCE_IDS)
    && modules.length >= REQUIRED_SOURCE_IDS.length * 2
    && new Set(moduleIds).size === moduleIds.length
    && modules.every(validModule)
    && REQUIRED_RECIPE_IDS.every((id) => moduleIds.includes(id))
    && sameArray(stageNames, Object.keys(STAGE_SKILL_IDS));

  for (const [stage, expectedIds] of Object.entries(STAGE_SKILL_IDS)) {
    const entry = value?.stages?.[stage];
    valid = valid
      && sameArray(entry?.skillIds, expectedIds)
      && Array.isArray(entry?.moduleIds)
      && entry.moduleIds.length >= expectedIds.length * 2
      && entry.moduleIds.every((id) => moduleIds.includes(id))
      && expectedIds.every((id) => entry.moduleIds.some((moduleId) => moduleId.startsWith(`${id}:`)))
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
  REQUIRED_RECIPE_IDS,
  REQUIRED_SOURCE_IDS,
  SCHEMA_VERSION,
  STAGE_SKILL_IDS,
  assertBundleStructure,
};
