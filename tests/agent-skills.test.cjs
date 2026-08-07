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
  MAX_MODULE_CHARS,
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
  assert.doesNotMatch(output, /private|SKILL\.md|C:\\Users|gpt-image|prompt|checkpoint|Column|Completed setup|--input|references\//i);
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

test('runtime rejects tampered handbook content even when stage rules are unchanged', () => {
  const tampered = {
    ...bundle,
    modules: bundle.modules.map((module, index) => index === 0 ? { ...module, content: `${module.content}\ntampered` } : module),
  };
  assert.throws(() => verifyBundle(tampered), (error) => error.code === 'AGENT_SKILL_BUNDLE_TAMPERED');
});

test('build and runtime reject self-consistent obsolete or incomplete bundles', () => {
  const obsolete = withIntegrity({ ...bundle, bundleVersion: '1' });
  const incompleteStage = withIntegrity({
    ...bundle,
    stages: { ...bundle.stages, review: { skillIds: [], rules: [] } },
  });
  for (const candidate of [obsolete, incompleteStage]) {
    assert.throws(() => verifyBundle(candidate), (error) => error.code === 'AGENT_SKILL_BUNDLE_INVALID');
    assert.throws(() => validateBundledFallback(candidate), (error) => error.code === 'AGENT_SKILL_BUNDLE_INVALID');
  }
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
  assert.deepEqual(bundle.stages.analysis.skillIds.includes('mmc-computational-experiment'), false);
  assert.deepEqual(bundle.stages.solving.skillIds.includes('mmc-problem-intake'), false);
  assert.deepEqual(bundle.stages.paper.skillIds.includes('mmc-computational-experiment'), false);
  assert.deepEqual(bundle.stages.review.skillIds.includes('mmc-submission-audit'), true);
  assert.equal(skillGuidanceForStage('unknown'), '');
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /SKILL\.md|AGENTS\.md|[A-Za-z]:\\\\(?:Users|home|mnt|opt)\\|(?:\/Users\/|\/home\/)/i);
  assert.doesNotMatch(serialized, /gpt-image|prompt_text|secret|api key/i);
  assert.doesNotMatch(serialized, /references?[\\/][^\s)]+/i);
  for (const stage of Object.values(bundle.stages)) {
    assert.ok(stage.rules.length <= MAX_RULES_PER_STAGE);
    assert.ok(stage.rules.join('\n').length <= MAX_STAGE_CHARS);
    for (const skillId of stage.skillIds) assert.ok(stage.rules.some((rule) => rule.startsWith(`[${skillId}] `)));
    for (const skillId of stage.skillIds) assert.ok(stage.moduleIds.some((id) => id.startsWith(`${skillId}:`)));
  }
  assert.equal(bundle.modules.length, REQUIRED_SKILLS.length * 2);
  assert.ok(bundle.modules.every((module) => module.content.length <= MAX_MODULE_CHARS));
});

test('stagePrompt injects verified compiled rules into the existing playbook', () => {
  const prompt = stagePrompt(path.join(os.tmpdir(), 'mmw-project'), 'analysis');
  assert.match(prompt, /Compiled scientific workflow \(self-contained, stage-scoped\)/);
  assert.match(prompt, /mmc-problem-intake/);
  assert.match(prompt, /Ambiguity sensitivity precheck/);
  assert.equal(prompt.includes('C:\\Users\\'), false);
});

test('compiled workflow contains concrete research, modeling, plotting, and writing mechanisms', () => {
  const analysis = skillGuidanceForStage('analysis');
  const solving = skillGuidanceForStage('solving');
  const paper = skillGuidanceForStage('paper');
  const review = skillGuidanceForStage('review');

  assert.match(analysis, /rival explanation/i);
  assert.match(analysis, /rolling(?:-| or expanding )origin/i);
  assert.match(analysis, /Identifier verification/i);
  assert.match(analysis, /Pareto frontier/i);
  assert.match(solving, /constraint residuals/i);
  assert.match(solving, /Monte Carlo error/i);
  assert.match(solving, /rank reversal/i);
  assert.match(paper, /claim-evidence-boundary/i);
  assert.match(paper, /vector PDF\/SVG/i);
  assert.match(review, /causal evidence only with identification/i);
  assert.match(review, /page by page/i);
});

test('packaged builds keep compiled skill rules inside the protected runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.build.files.includes('electron/generated/agent-skills.bundle.json'), false);
  assert.equal(packageJson.build.files.includes('electron/protected/runtime.bin'), true);
});

test('generated bundle is self-contained and requires every workflow skill', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-skills-self-contained-'));
  const sourceRoot = path.join(root, 'skills');
  for (const definition of REQUIRED_SKILLS) {
    const directory = path.join(sourceRoot, definition.relative);
    await fsp.mkdir(path.join(directory, 'references'), { recursive: true });
    await fsp.writeFile(
      path.join(directory, 'SKILL.md'),
      `# ${definition.id}\nUse verified data, an explicit baseline, declared assumptions, and reproducible code for every accepted result.`,
      'utf8',
    );
    const handbookNames = {
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
    };
    await fsp.writeFile(
      path.join(directory, 'references', handbookNames[definition.id]),
      `# ${definition.id} handbook\nThis self-contained handbook provides deterministic research and modeling decisions without external resources.`,
      'utf8',
    );
  }
  const outputPath = path.join(root, 'bundle.json');
  const compiled = await compileAgentSkills({ skillsRoot: sourceRoot, outputPath });
  assert.deepEqual(compiled.sources.map((source) => source.id), REQUIRED_SKILLS.map((skill) => skill.id));
  assert.equal(compiled.sources.every((source) => source.required), true);
  assert.equal(compiled.modules.length, REQUIRED_SKILLS.length * 2);
  assert.equal(fs.existsSync(outputPath), true);
  await fsp.rm(root, { recursive: true, force: true });
});
