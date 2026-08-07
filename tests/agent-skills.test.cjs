const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const bundle = require('../electron/generated/agent-skills.bundle.json');
const { stagePrompt } = require('../electron/supervisor/playbooks.cjs');
const { verifyBundle, skillGuidanceForStage } = require('../electron/supervisor/agent-skills-loader.cjs');
const {
  REQUIRED_SKILLS,
  MAX_RULES_PER_SKILL,
  MAX_RULES_PER_STAGE,
  MAX_STAGE_CHARS,
  buildBundle,
  compileAgentSkills,
  compileRules,
  loadBundledFallback,
  prepareAgentSkillsForBuild,
  validateBundledFallback,
  withIntegrity,
} = require('../scripts/compile-agent-skills.cjs');

test('compileRules removes frontmatter, workflow metadata, paths, and prompt material', () => {
  const repeated = Array.from({ length: 40 }, (_, index) => `Persist verified result ${index} with its units and provenance.`).join('\n');
  const rules = compileRules(`---\nname: private\n---\n# Useful rules\n\nUse verified data and reproducible code.\n| Column | Value |\n|---|---|\n- [x] Completed setup\n--input private.csv\nRead C:\\Users\\secret\\SKILL.md before acting.\nCall gpt-image with prompt_text.\n## Checkpoint\n${repeated}`);
  const output = rules.join('\n');
  assert.match(output, /verified data/);
  assert.doesNotMatch(output, /private|SKILL\.md|C:\\Users|gpt-image|prompt|checkpoint|Column|Completed setup|--input/i);
  assert.equal(rules.length, MAX_RULES_PER_SKILL);
});

test('required repo-local skills fail clearly when missing', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-skills-missing-'));
  await assert.rejects(compileAgentSkills({ skillsRoot: root, outputPath: path.join(root, 'bundle.json') }), (error) => {
    assert.equal(error.code, 'AGENT_SKILL_REQUIRED_MISSING');
    assert.equal(error.skillId, REQUIRED_SKILLS[0].id);
    return true;
  });
  await fsp.rm(root, { recursive: true, force: true });
});

test('compiled bundle is deterministic and includes integrity metadata', () => {
  const sources = [{
    id: 'fixture', required: true,
    sourceSummary: { sha256: 'source-hash', chars: 20, ruleCount: 1, summary: 'verified rule' },
    rules: ['[fixture] verified rule'],
  }];
  const first = withIntegrity(buildBundle(sources));
  const second = withIntegrity(buildBundle(sources));
  assert.deepEqual(first, second);
  assert.equal(first.integrity.algorithm, 'sha256');
  assert.equal(first.integrity.sha256.length, 64);
});

test('runtime rejects a tampered bundle', () => {
  const tampered = { ...bundle, stages: { ...bundle.stages, analysis: { ...bundle.stages.analysis, rules: ['tampered'] } } };
  assert.throws(() => verifyBundle(tampered), (error) => error.code === 'AGENT_SKILL_BUNDLE_TAMPERED');
});

test('clean release builds may reuse only a complete integrity-verified skill bundle', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-skills-fallback-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'bundle.json');
  await fsp.writeFile(file, JSON.stringify(bundle));
  assert.deepEqual(loadBundledFallback(file), bundle);
  const prepared = await prepareAgentSkillsForBuild({ skillsRoot: null, outputPath: file });
  assert.equal(prepared.compiled, false);
  assert.deepEqual(prepared.bundle, bundle);
  assert.throws(() => validateBundledFallback({ ...bundle, sources: bundle.sources.slice(1) }), (error) => error.code === 'AGENT_SKILL_BUNDLE_INVALID');
});

test('clean release builds fail when the committed skill bundle is absent', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-skills-no-fallback-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    prepareAgentSkillsForBuild({ skillsRoot: null, outputPath: path.join(root, 'missing.json') }),
    (error) => error.code === 'AGENT_SKILL_BUNDLE_MISSING',
  );
});

test('stage allowlists isolate compiled skills and contain no private source markers', () => {
  assert.deepEqual(bundle.stages.analysis.skillIds.includes('mmc-modeling-solver'), false);
  assert.deepEqual(bundle.stages.solving.skillIds.includes('mmc-problem-analysis'), false);
  assert.deepEqual(bundle.stages.paper.skillIds.includes('mmc-modeling-solver'), false);
  assert.equal(skillGuidanceForStage('unknown'), '');
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /SKILL\.md|AGENTS\.md|[A-Za-z]:[\\/]|(?:\/Users\/|\/home\/)/i);
  assert.doesNotMatch(serialized, /gpt-image|prompt|secret|api key/i);
  for (const stage of Object.values(bundle.stages)) {
    assert.ok(stage.rules.length <= MAX_RULES_PER_STAGE);
    assert.ok(stage.rules.join('\n').length <= MAX_STAGE_CHARS);
    for (const skillId of stage.skillIds) assert.ok(stage.rules.some((rule) => rule.startsWith(`[${skillId}] `)));
  }
});

test('stagePrompt injects verified compiled rules into the existing playbook', () => {
  const prompt = stagePrompt(path.join(os.tmpdir(), 'mmw-project'), 'analysis');
  assert.match(prompt, /Compiled scientific skill rules \(stage-scoped\)/);
  assert.match(prompt, /mmc-problem-analysis/);
  assert.equal(prompt.includes('C:\\Users\\'), false);
});

test('packaged builds keep compiled skill rules inside the protected runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.build.files.includes('electron/generated/agent-skills.bundle.json'), false);
  assert.equal(packageJson.build.files.includes('electron/protected/runtime.bin'), true);
});

test('generated bundle keeps optional academic plotting non-blocking', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-skills-optional-'));
  const sourceRoot = path.join(root, 'skills');
  for (const definition of REQUIRED_SKILLS) {
    const directory = path.join(sourceRoot, definition.relative);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'SKILL.md'), `# ${definition.id}\nUse verified data and reproducible code.`, 'utf8');
  }
  const outputPath = path.join(root, 'bundle.json');
  const compiled = await compileAgentSkills({ skillsRoot: sourceRoot, optionalAcademicPlottingRoot: path.join(root, 'does-not-exist'), outputPath });
  assert.equal(compiled.sources.some((source) => source.id === 'academic-plotting'), false);
  assert.equal(fs.existsSync(outputPath), true);
  await fsp.rm(root, { recursive: true, force: true });
});
