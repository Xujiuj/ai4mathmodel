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

function getSkillResource(resourceId, value = bundle) {
  const checked = verifyBundle(value);
  const resource = checked.modules.find((module) => module.id === String(resourceId || '').trim());
  if (!resource) {
    const error = new Error('Built-in skill resource was not found.');
    error.code = 'AGENT_SKILL_RESOURCE_NOT_FOUND';
    throw error;
  }
  return resource;
}

function publicResource(resource) {
  const { content: _content, executionSource: _executionSource, ...descriptor } = resource;
  return descriptor;
}

function listSkillResources({
  stage = '',
  skillId = '',
  kind = '',
  problemFamilies = [],
  includeContent = false,
} = {}, value = bundle) {
  const checked = verifyBundle(value);
  const stageKey = String(stage || '').trim().toLowerCase();
  const allowedIds = stageKey ? new Set(checked.stages?.[stageKey]?.moduleIds || []) : null;
  const families = new Set((Array.isArray(problemFamilies) ? problemFamilies : [problemFamilies])
    .map((family) => String(family || '').trim().toLowerCase()).filter(Boolean));
  return checked.modules
    .filter((resource) => !allowedIds || allowedIds.has(resource.id))
    .filter((resource) => !stageKey || resource.allowedStages.includes(stageKey))
    .filter((resource) => !skillId || resource.skillId === skillId)
    .filter((resource) => !kind || resource.kind === kind)
    .filter((resource) => !families.size || resource.problemFamilies.includes('all')
      || resource.problemFamilies.some((family) => families.has(family)))
    .map((resource) => includeContent && resource.kind !== 'recipe'
      ? { ...publicResource(resource), content: resource.content }
      : publicResource(resource));
}

function skillGuidanceForStage(stage, options = {}, value = bundle) {
  if (options?.schemaVersion) {
    value = options;
    options = {};
  }
  const checked = verifyBundle(value);
  const entry = checked.stages?.[String(stage || '').trim().toLowerCase()];
  if (!entry || !Array.isArray(entry.rules) || !entry.rules.length) return '';
  const problemFamilies = Array.isArray(options.problemFamilies) ? options.problemFamilies : [];
  const maxChars = Math.max(8_000, Math.min(Number(options.maxChars) || 26_000, 30_000));
  const modules = entry.moduleIds
    .map((id) => checked.modules.find((module) => module.id === id))
    .filter((module) => module && module.kind !== 'procedure')
    .filter((module) => !problemFamilies.length || module.problemFamilies.includes('all')
      || module.problemFamilies.some((family) => problemFamilies.includes(family)));
  if (modules.some((module) => !module)) return '';
  const inventory = modules.map((module) => {
    const families = module.problemFamilies.join(',');
    return `- ${module.id} | ${module.kind}/${module.language} | families=${families}`;
  }).join('\n');
  const prefix = `\n\nCompiled scientific workflow (self-contained, stage-scoped):\n${entry.rules.join('\n')}\n\nBuilt-in resource protocol:\n- Call list_skill_resources with this stage and the active problem families before writing custom utilities.\n- Call read_skill_reference for the smallest relevant reference resource; recipes never expose their source.\n- Call run_builtin_recipe for a matching recipe, persist its structured output, and cite the returned execution receipt.\n- Write custom code only for problem-specific logic or when no listed recipe implements the required operation.\n\nAvailable built-in resources:\n${inventory}`;
  const sectionBudget = Math.max(0, maxChars - prefix.length);
  const seen = new Set();
  const sections = [];
  let used = 0;
  for (const module of modules.filter((candidate) => candidate.kind !== 'recipe')) {
    if (seen.has(module.contentSha256)) continue;
    const section = `\n### ${module.title}\n${module.content}`;
    if (used + section.length > sectionBudget) continue;
    sections.push(section);
    seen.add(module.contentSha256);
    used += section.length;
  }
  return `${prefix}${sections.join('\n')}`;
}

verifyBundle(bundle);

module.exports = {
  canonicalPayload,
  getSkillResource,
  listSkillResources,
  skillGuidanceForStage,
  verifyBundle,
};
