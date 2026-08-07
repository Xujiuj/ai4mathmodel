const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  BUNDLE_VERSION,
  REQUIRED_SOURCE_IDS,
  STAGE_SKILL_IDS,
  assertBundleStructure,
} = require('../electron/supervisor/agent-skills-contract.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SKILLS_ROOT = process.env.AGENT_SKILLS_ROOT
  ? path.resolve(process.env.AGENT_SKILLS_ROOT)
  : path.resolve(PROJECT_ROOT, '.agents', 'skills');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'electron', 'generated', 'agent-skills.bundle.json');
const MAX_RULES_PER_SKILL = 20;
const MAX_RULES_PER_STAGE = MAX_RULES_PER_SKILL * 7;
const MAX_RULE_CHARS = 360;
const MAX_STAGE_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 320;
const MAX_MODULE_CHARS = 24_000;

const HANDBOOK_FILES = Object.freeze({
  'mmc-workflow-orchestrator': 'pipeline-contract.md',
  'mmc-problem-intake': 'input-contract.md',
  'mmc-literature-evidence': 'evidence-schema.md',
  'mmc-model-design': 'model-contract.md',
  'mmc-computational-experiment': 'result-contract.md',
  'mmc-result-validation': 'validation-matrix.md',
  'mmc-scientific-visualization': 'figure-contract.md',
  'mmc-paper-authoring': 'claim-evidence-map.md',
  'mmc-prose-polish': 'prose-rubric.md',
  'mmc-submission-audit': 'audit-rubric.md',
});

const REQUIRED_SKILLS = Object.freeze(REQUIRED_SOURCE_IDS.map((id) => ({
  id,
  relative: path.join('math-modeling-workflow', 'skills', id),
})));

const STAGE_ALLOWLIST = STAGE_SKILL_IDS;

const META_LINE_PATTERNS = [
  /\bskill\.md\b/i,
  /\bagents\.md\b/i,
  /\b(?:workflow|core pipeline|mandatory rules|resource manifest|role dispatch|checkpoint|blocking|gate before|when to load|when not to load)\b/i,
  /\b(?:step\s+\d|use when|user invokes|slash command|reply\s+\*\*|run .*scripts?\/|bash .*\/scripts?\/|python .*\/scripts?\/)/i,
  /\$\{[^}]+\}|(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/|\/mnt\/|\/opt\/)/i,
  /(?:prompt|gpt-image|tool call|subprocess|os\.environ|secret|api key|token)/i,
  /\]\(references?[\\/][^)]+\)|\breferences?[\\/][^\s)]+/i,
];

const STRUCTURAL_LINE_PATTERNS = [
  /^#{1,6}\s+/u,
  /^>\s*\[![A-Z]+\]\s*$/u,
  /^\|.*\|\s*$/u,
  /^(?:[-*]\s*)?\[[ xX]\]\s+/u,
  /^--[\w-]+(?:\s|$)/u,
  /^```/u,
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function stripFrontmatter(value) {
  const text = normalizeNewlines(value);
  if (!/^\s*---\s*\n/.test(text)) return text;
  const end = text.indexOf('\n---', text.indexOf('\n') + 1);
  return end >= 0 ? text.slice(end + 4) : text;
}

function redactAbsolutePaths(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s)`\]}>]+/g, '[path]')
    .replace(/(?:\\\\|\/)(?:Users|home|mnt|opt|var)\/[^\s)`\]}>]+/gi, '[path]');
}

function isMetaLine(line) {
  return META_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function cleanRule(line) {
  const value = redactAbsolutePaths(line)
    .replace(/\bSKILL\.md\b|\bAGENTS\.md\b/gi, '[source]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value || value.length < 12) return '';
  return value.slice(0, MAX_RULE_CHARS);
}

function compileRules(markdown) {
  const rules = [];
  for (const rawLine of stripFrontmatter(markdown).split('\n')) {
    const line = rawLine.trim();
    if (!line || STRUCTURAL_LINE_PATTERNS.some((pattern) => pattern.test(line)) || isMetaLine(line)) continue;
    const rule = cleanRule(line);
    if (rule && !rules.includes(rule)) rules.push(rule);
    if (rules.length >= MAX_RULES_PER_SKILL) break;
  }
  return rules;
}

function compileModule(markdown) {
  const withoutResourceDirections = stripFrontmatter(markdown)
    .split('\n')
    .filter((line) => !/references?[\\/]/i.test(line))
    .join('\n');
  const content = redactAbsolutePaths(withoutResourceDirections)
    .replace(/\[([^\]]+)\]\(references?[\\/][^)]+\)/gi, '$1')
    .replace(/\bSKILL\.md\b|\bAGENTS\.md\b/gi, '[source]')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!content || content.length < 80) {
    const error = new Error('Compiled skill module is empty or too small');
    error.code = 'AGENT_SKILL_MODULE_EMPTY';
    throw error;
  }
  if (content.length > MAX_MODULE_CHARS) {
    const error = new Error(`Compiled skill module exceeds ${MAX_MODULE_CHARS} characters`);
    error.code = 'AGENT_SKILL_MODULE_TOO_LARGE';
    throw error;
  }
  return content;
}

function compileSource({ id, file, handbookFile, required }) {
  const source = fs.readFileSync(file, 'utf8');
  const handbook = fs.readFileSync(handbookFile, 'utf8');
  const rules = compileRules(source);
  const normalized = normalizeNewlines(source);
  const summary = rules.slice(0, 3).join(' ').slice(0, MAX_SUMMARY_CHARS);
  const documents = [
    { suffix: 'procedure', title: `${id} operating procedure`, value: source },
    { suffix: 'handbook', title: `${id} decision handbook`, value: handbook },
  ];
  return {
    id,
    required: Boolean(required),
    sourceSummary: {
      sha256: sha256(normalized),
      chars: normalized.length,
      ruleCount: rules.length,
      summary,
    },
    rules,
    modules: documents.map((document) => {
      const content = compileModule(document.value);
      return {
        id: `${id}:${document.suffix}`,
        skillId: id,
        title: document.title,
        sha256: sha256(content),
        content,
      };
    }),
  };
}

function canonicalPayload(bundle) {
  return JSON.stringify({
    schemaVersion: bundle.schemaVersion,
    bundleVersion: bundle.bundleVersion,
    sources: bundle.sources,
    modules: bundle.modules,
    stages: bundle.stages,
  });
}

function resolveSources({ skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const sources = [];
  for (const definition of REQUIRED_SKILLS) {
    const directory = path.join(skillsRoot, definition.relative);
    const file = path.join(directory, 'SKILL.md');
    const handbookFile = path.join(directory, 'references', HANDBOOK_FILES[definition.id]);
    if (!fs.existsSync(file) || !fs.existsSync(handbookFile)) {
      const error = new Error(`Required agent skill is missing: ${definition.id}`);
      error.code = 'AGENT_SKILL_REQUIRED_MISSING';
      error.skillId = definition.id;
      throw error;
    }
    sources.push(compileSource({ id: definition.id, file, handbookFile, required: true }));
  }
  return sources;
}

function buildBundle(sources) {
  const available = new Set(sources.map((source) => source.id));
  const modules = sources.flatMap((source) => source.modules || []);
  const stages = {};
  for (const [stage, ids] of Object.entries(STAGE_ALLOWLIST)) {
    const stageSources = ids
      .map((id) => sources.find((source) => source.id === id))
      .filter(Boolean);
    const rules = [];
    let chars = 0;
    for (let index = 0; index < MAX_RULES_PER_SKILL && rules.length < MAX_RULES_PER_STAGE; index += 1) {
      for (const source of stageSources) {
        const rule = source.rules[index];
        if (!rule) continue;
        const tagged = `[${source.id}] ${rule}`;
        if (chars + tagged.length + 1 > MAX_STAGE_CHARS) continue;
        rules.push(tagged);
        chars += tagged.length + 1;
      }
    }
    stages[stage] = {
      skillIds: ids.filter((id) => available.has(id)),
      moduleIds: modules.filter((module) => ids.includes(module.skillId)).map((module) => module.id),
      rules,
    };
  }
  return {
    schemaVersion: 2,
    bundleVersion: BUNDLE_VERSION,
    sources: sources.map(({ id, required, sourceSummary }) => ({ id, required, sourceSummary })),
    modules,
    stages,
  };
}

function withIntegrity(bundle) {
  const payload = JSON.parse(canonicalPayload(bundle));
  return { ...payload, integrity: { algorithm: 'sha256', sha256: sha256(canonicalPayload(payload)) } };
}

function validateBundledFallback(bundle) {
  const expected = String(bundle?.integrity?.sha256 || '');
  const actual = sha256(canonicalPayload(bundle || {}));
  if (bundle?.integrity?.algorithm !== 'sha256' || !expected || expected !== actual) {
    const error = new Error('Bundled agent skills failed integrity or completeness validation');
    error.code = 'AGENT_SKILL_BUNDLE_INVALID';
    throw error;
  }
  return assertBundleStructure(bundle, {
    code: 'AGENT_SKILL_BUNDLE_INVALID',
    message: 'Bundled agent skills failed integrity or completeness validation',
  });
}

function loadBundledFallback(outputPath = DEFAULT_OUTPUT) {
  return validateBundledFallback(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
}

async function compileAgentSkills({ skillsRoot = DEFAULT_SKILLS_ROOT, outputPath = DEFAULT_OUTPUT } = {}) {
  const bundle = withIntegrity(buildBundle(resolveSources({ skillsRoot })));
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return bundle;
}

async function prepareAgentSkillsForBuild({
  skillsRoot = DEFAULT_SKILLS_ROOT,
  outputPath = DEFAULT_OUTPUT,
} = {}) {
  if (skillsRoot) {
    return {
      bundle: await compileAgentSkills({ skillsRoot, outputPath }),
      compiled: true,
    };
  }
  if (!fs.existsSync(outputPath)) {
    const error = new Error('Committed agent skill bundle is missing; set AGENT_SKILLS_ROOT to regenerate it');
    error.code = 'AGENT_SKILL_BUNDLE_MISSING';
    throw error;
  }
  return { bundle: loadBundledFallback(outputPath), compiled: false };
}

if (require.main === module) {
  prepareAgentSkillsForBuild().then(({ bundle, compiled }) => {
    process.stdout.write(compiled
      ? `Compiled ${bundle.sources.length} agent skills into ${path.relative(PROJECT_ROOT, DEFAULT_OUTPUT)}\n`
      : `Using verified bundled agent skills (${bundle.sources.length} sources)\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'AGENT_SKILL_COMPILE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUNDLE_VERSION,
  DEFAULT_OUTPUT,
  DEFAULT_SKILLS_ROOT,
  MAX_RULES_PER_SKILL,
  MAX_RULES_PER_STAGE,
  MAX_STAGE_CHARS,
  MAX_MODULE_CHARS,
  REQUIRED_SKILLS,
  STAGE_ALLOWLIST,
  buildBundle,
  canonicalPayload,
  compileAgentSkills,
  prepareAgentSkillsForBuild,
  compileRules,
  compileModule,
  compileSource,
  loadBundledFallback,
  resolveSources,
  sha256,
  stripFrontmatter,
  validateBundledFallback,
  withIntegrity,
};
