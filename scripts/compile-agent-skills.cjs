const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

const PRIMARY_HANDBOOK_FILES = Object.freeze({
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
const COMPILED_RESOURCE_DIRECTORIES = Object.freeze([
  { directory: 'references', extensions: new Set(['.md']), kind: 'reference' },
  { directory: 'scripts', extensions: new Set(['.py']), kind: 'recipe' },
  { directory: 'templates', extensions: new Set(['.tex', '.typ']), kind: 'template' },
]);
const RESOURCE_MANIFEST_FILE = 'resources.json';
const DEFAULT_ARGUMENT_SCHEMA = Object.freeze({
  type: 'array',
  items: { type: 'string', maxLength: 2048 },
  maxItems: 32,
});
const DEFAULT_OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });
const EXECUTABLE_SOURCE_BLOCKLIST = [
  /\b(?:SKILL|AGENTS)\.md\b/i,
  /(?:^|["'`\s])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/mnt\/|\/opt\/)/m,
  /(?:^|["'`\s])\.agents[\\/]/m,
];

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

function moduleSlug(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\.[^.\/]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function languageForExtension(extension) {
  return ({ '.md': 'markdown', '.py': 'python', '.tex': 'latex', '.typ': 'typst' })[extension] || 'text';
}

function allowedStagesForSkill(skillId) {
  return Object.entries(STAGE_ALLOWLIST)
    .filter(([, ids]) => ids.includes(skillId))
    .map(([stage]) => stage);
}

function loadResourceManifest(directory) {
  const file = path.join(directory, RESOURCE_MANIFEST_FILE);
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${RESOURCE_MANIFEST_FILE} must contain an object`);
  }
  return parsed.resources && typeof parsed.resources === 'object' ? parsed.resources : parsed;
}

function listResourceFiles(root, extensions, prefix = '') {
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listResourceFiles(target, extensions, relative));
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push({ relative, target });
  }
  return files;
}

function validatePythonSyntax(file) {
  const program = 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")';
  const result = spawnSync('python', ['-c', program, file], { encoding: 'utf8', windowsHide: true });
  if (result.error?.code === 'ENOENT') return;
  if (result.status !== 0) {
    const error = new Error(`Built-in recipe has invalid Python syntax: ${path.basename(file)}`);
    error.code = 'AGENT_SKILL_RECIPE_INVALID';
    error.detail = String(result.stderr || result.stdout || '').trim().slice(0, 2000);
    throw error;
  }
}

function recipePromptContent(title, metadata) {
  const families = metadata.problemFamilies.join(', ');
  return `Built-in Python recipe: ${title}. Invoke it by resource ID through the trusted recipe tool; do not reproduce its source in the prompt. Applicable problem families: ${families}. The runtime verifies its hash, arguments, sandbox policy, and declared output contract before use.`;
}

function resolveResourceDocuments(directory, skillId) {
  const documents = [];
  const manifest = loadResourceManifest(directory);
  for (const definition of COMPILED_RESOURCE_DIRECTORIES) {
    const resourceRoot = path.join(directory, definition.directory);
    if (!fs.existsSync(resourceRoot)) continue;
    const entries = listResourceFiles(resourceRoot, definition.extensions);
    for (const entry of entries) {
      const extension = path.extname(entry.relative).toLowerCase();
      const manifestKey = `${definition.directory}/${entry.relative}`.replaceAll('\\', '/');
      const declared = manifest[manifestKey] || manifest[entry.relative] || {};
      const problemFamilies = Array.isArray(declared.problemFamilies) && declared.problemFamilies.length
        ? [...new Set(declared.problemFamilies.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
        : ['all'];
      const allowedStages = Array.isArray(declared.allowedStages) && declared.allowedStages.length
        ? declared.allowedStages.filter((stage) => Object.hasOwn(STAGE_ALLOWLIST, stage))
        : allowedStagesForSkill(skillId);
      const raw = normalizeNewlines(fs.readFileSync(entry.target, 'utf8'));
      if (definition.kind === 'recipe') {
        if (EXECUTABLE_SOURCE_BLOCKLIST.some((pattern) => pattern.test(raw))) {
          const error = new Error(`Built-in recipe contains a private or absolute source reference: ${entry.relative}`);
          error.code = 'AGENT_SKILL_RECIPE_UNSAFE';
          throw error;
        }
        validatePythonSyntax(entry.target);
      }
      documents.push({
        suffix: `${definition.kind}-${moduleSlug(entry.relative)}`,
        title: String(declared.title || `${moduleSlug(entry.relative).replace(/-/g, ' ')} ${definition.kind}`),
        value: raw,
        kind: definition.kind,
        language: languageForExtension(extension),
        entrypoint: definition.kind === 'recipe',
        allowedStages,
        problemFamilies,
        argumentSchema: declared.argumentSchema || DEFAULT_ARGUMENT_SCHEMA,
        outputSchema: declared.outputSchema || DEFAULT_OUTPUT_SCHEMA,
        required: declared.required === true,
        summary: String(declared.summary || ''),
      });
    }
  }
  return documents;
}

function compileSource({ id, file, required }) {
  const source = fs.readFileSync(file, 'utf8');
  const rules = compileRules(source);
  const normalized = normalizeNewlines(source);
  const summary = rules.slice(0, 3).join(' ').slice(0, MAX_SUMMARY_CHARS);
  const documents = [
    {
      suffix: 'procedure', title: `${id} operating procedure`, value: source,
      kind: 'procedure', language: 'markdown', entrypoint: false,
      allowedStages: allowedStagesForSkill(id), problemFamilies: ['all'],
      argumentSchema: null, outputSchema: null, required: true, summary: '',
    },
    ...resolveResourceDocuments(path.dirname(file), id),
  ];
  return {
    id,
    required: Boolean(required),
    sourceSummary: {
      sha256: sha256(normalized),
      chars: normalized.length,
      ruleCount: rules.length,
      moduleCount: documents.length,
      summary,
    },
    rules,
    modules: documents.map((document) => {
      const executionSource = document.kind === 'recipe' ? normalizeNewlines(document.value) : undefined;
      const content = document.kind === 'recipe'
        ? recipePromptContent(document.title, document)
        : compileModule(document.value);
      const contentSha256 = sha256(content);
      const resourceSha256 = executionSource ? sha256(executionSource) : contentSha256;
      return {
        id: `${id}:${document.suffix}`,
        skillId: id,
        title: document.title,
        kind: document.kind,
        language: document.language,
        entrypoint: document.entrypoint,
        allowedStages: document.allowedStages,
        problemFamilies: document.problemFamilies,
        argumentSchema: document.argumentSchema,
        outputSchema: document.outputSchema,
        required: document.required,
        sha256: resourceSha256,
        contentSha256,
        content,
        ...(executionSource ? { executionSha256: resourceSha256, executionSource } : {}),
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
    const handbookFile = path.join(directory, 'references', PRIMARY_HANDBOOK_FILES[definition.id]);
    if (!fs.existsSync(file) || !fs.existsSync(handbookFile)) {
      const error = new Error(`Required agent skill is missing: ${definition.id}`);
      error.code = 'AGENT_SKILL_REQUIRED_MISSING';
      error.skillId = definition.id;
      throw error;
    }
    sources.push(compileSource({ id: definition.id, file, required: true }));
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
      moduleIds: modules.filter((module) => module.allowedStages.includes(stage)).map((module) => module.id),
      rules,
    };
  }
  return {
    schemaVersion: 3,
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
