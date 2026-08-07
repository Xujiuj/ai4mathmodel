const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  stagingPath,
  committedPath,
  stagingProjectView,
  renameWithRetry,
  copyWithRetry,
  commitStage,
  recoverProjectState,
  prepareStageStaging,
  readCommitMarker,
} = require('../electron/staging.cjs');
const { acquireLock, releaseLock } = require('../electron/project-lock.cjs');
const { redactObject, supportCode, createDiagnosticPackage } = require('../electron/diagnostics.cjs');
const { listComponentUpdates, seedInstalledComponentsSync, readInstalledComponents } = require('../electron/component-manager.cjs');
const { createAutoUpdaterBridge } = require('../electron/updater.cjs');
const { validateStageArtifacts } = require('../electron/supervisor/artifact-gates.cjs');

async function withTempRoot(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-todo-'));
  try {
    return await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const ANALYSIS_MD = `# 问题重述
本赛题要求对给定数据进行建模与求解，并给出可复核的方案。
# 数据理解
数据字段、缺失值和量纲已核对，明确训练与验证切分。
# 模型假设
假设系统稳态、噪声有界、样本独立同分布。
# 符号说明
定义决策变量、参数与目标函数符号，统一单位。
# 方法比较
比较线性规划、启发式与仿真方法并给出选型依据。
# 验证方案
使用交叉验证、敏感性分析和误差分解检验模型稳健性。
${'详细论证与公式推导以及实验设计说明。'.repeat(400)}
`;

const PROBLEM_TEXT = `${'规范化赛题文本与约束条件说明。'.repeat(40)}\n`;

const ANALYSIS_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]);

const SUBPROBLEMS_YAML = [
  'schema_version: 1',
  'subproblems:',
  '  - id: sp-1',
  '    question: Complete the staged modeling task.',
  '    inputs: [inputs/problem/statement.txt]',
  '    outputs: [work/02_solving/sub_problem_1/results.yaml]',
  '    depends_on: []',
  '    primary_method: Validated mathematical modeling.',
  '    validation_requirements: [Compare against a baseline.]',
].join('\n');

async function writeEnhancedAnalysisContracts(directory) {
  const literature = path.join(directory, 'literature');
  await fsp.mkdir(literature, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(directory, 'data_profile.yaml'), 'schema_version: 1\ndatasets:\n  - path: inputs/problem/statement.txt\n    status: profiled\n', 'utf8'),
    fsp.writeFile(path.join(directory, 'model_contract.yaml'), 'schema_version: 1\nmodels:\n  - subproblem_id: sp-1\n    family_id: regression\n    algorithm_id: ridge-regression\n    method: regularized regression\n    claim_type: predictive\n    estimand_or_objective: future conditional mean\n    candidate_families: [regression, classification]\n    baseline: historical mean\n    variables: {target: demand, features: predictors}\n    equations_or_algorithm: [fit ridge coefficients, predict held-out rows]\n    assumptions: [stable sampling]\n    data_interface: {input: inputs/problem/data.csv, split: grouped holdout}\n    solver_or_training: {seed: 2025, stopping: closed form}\n    validation_tests: [held-out error]\n    failure_modes: [distribution shift]\n    fallback: regularized linear baseline\n    paper_outputs: [coefficient table, residual figure]\n', 'utf8'),
    fsp.writeFile(path.join(directory, 'validation_plan.yaml'), 'schema_version: 1\nchecks:\n  - subproblem_id: sp-1\n    method: baseline comparison\n', 'utf8'),
    fsp.writeFile(path.join(directory, 'figure_plan.yaml'), 'schema_version: 1\nfigures:\n  - id: fig-1\n    claim: model comparison\n', 'utf8'),
    fsp.writeFile(path.join(literature, 'evidence_map.yaml'), 'schema_version: 1\nevidence:\n  - id: lit-1\n    claim_supported: The method is applicable.\n    status: verified\n    role: method_origin\n    metadata:\n      title: Verified modeling method\n      year: 2025\n      doi: 10.1000/verified\n    verification:\n      service: Crossref\n      checked_fields: [title, year, doi]\n', 'utf8'),
    fsp.writeFile(path.join(literature, 'references.bib'), '@article{verified, title={Verified modeling method}, author={Author}, journal={Journal}, year={2025}}\n', 'utf8'),
    fsp.writeFile(path.join(directory, 'intake_risks.md'), '# Intake risks\n\nAmbiguity, missing-data exposure, conservative interpretation, and resolution checks are recorded here. '.repeat(3), 'utf8'),
    fsp.writeFile(path.join(directory, 'model_design.md'), '# Model design\n\nCandidate methods, equations, assumptions, baseline, interfaces, and failure conditions are compared. '.repeat(12), 'utf8'),
    fsp.writeFile(path.join(literature, 'search_log.md'), '# Search log\n\nQuery, registry, date, scope, inclusion rationale, and exclusion rationale are recorded. '.repeat(5), 'utf8'),
    fsp.writeFile(path.join(literature, 'method_notes.md'), '# Method notes\n\nApplicability, assumptions, evidence, strengths, limitations, and known failure modes are recorded. '.repeat(8), 'utf8'),
  ]);
}

test('staging commit preserves the run snapshot and writes a committed marker', async () => {
  await withTempRoot(async (root) => {
    const runId = 'run-1';
    await prepareStageStaging(root, runId, 'analysis');
    await fsp.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
    await fsp.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'modeling problem', 'utf8');
    const staging = stagingPath(root, runId, 'analysis');
    await fsp.writeFile(path.join(staging, 'analysis.md'), ANALYSIS_MD, 'utf8');
    await fsp.writeFile(path.join(staging, 'problem_text.md'), PROBLEM_TEXT, 'utf8');
    await fsp.writeFile(path.join(staging, 'analysis.pdf'), ANALYSIS_PDF);
    await fsp.writeFile(path.join(staging, 'subproblems.yaml'), SUBPROBLEMS_YAML, 'utf8');
    await writeEnhancedAnalysisContracts(staging);
    const view = stagingProjectView(root, runId);
    const gate = await validateStageArtifacts(view, 'analysis');
    assert.equal(gate.ok, true, gate.reason || '');
    const result = await commitStage(root, runId, 'analysis', gate);
    assert.equal(result.committed, true);
    assert.ok(fs.existsSync(path.join(committedPath(root, 'analysis'), 'analysis.md')));
    assert.ok(fs.existsSync(staging));
    const marker = await readCommitMarker(root, 'analysis');
    assert.equal(marker.runId, runId);
  });
});

test('staging project view falls back to committed upstream artifacts until a stage snapshot exists', async () => {
  await withTempRoot(async (root) => {
    const runId = 'run-view';
    const committed = committedPath(root, 'analysis');
    await fsp.mkdir(committed, { recursive: true });
    await fsp.writeFile(path.join(committed, 'analysis.md'), 'committed analysis', 'utf8');
    const view = stagingProjectView(root, runId);
    assert.equal(view.resolvePath('work/01_analysis/analysis.md'), path.join(committed, 'analysis.md'));

    await prepareStageStaging(root, runId, 'analysis');
    assert.equal(
      view.resolvePath('work/01_analysis/analysis.md'),
      path.join(stagingPath(root, runId, 'analysis'), 'analysis.md'),
    );
    assert.equal(
      view.resolvePath('work/01_analysis/analysis.pdf'),
      path.join(stagingPath(root, runId, 'analysis'), 'analysis.pdf'),
    );
  });
});

test('staging rename retries transient filesystem locks before preserving atomic commit', async () => {
  let calls = 0;
  const sleeps = [];
  await renameWithRetry('source', 'destination', {
    rename: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('temporary file lock');
        error.code = 'EPERM';
        throw error;
      }
    },
    sleep: async (delay) => sleeps.push(delay),
    delays: [1, 2],
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1, 2]);
});

test('staging copy retries transient filesystem locks before publishing an existing stage', async () => {
  let calls = 0;
  const sleeps = [];
  await copyWithRetry('source', 'destination', {
    copy: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('temporary file lock');
        error.code = 'EPERM';
        throw error;
      }
    },
    sleep: async (delay) => sleeps.push(delay),
    delays: [1, 2],
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1, 2]);
});

test('staging commit updates an existing stage without renaming its live directory', async () => {
  await withTempRoot(async (root) => {
    const initialRun = 'run-existing';
    const replacementRun = 'run-replacement';
    const committed = committedPath(root, 'analysis');
    await fsp.mkdir(committed, { recursive: true });
    await fsp.writeFile(path.join(committed, 'analysis.md'), 'old analysis', 'utf8');
    await fsp.writeFile(path.join(committed, 'problem_text.md'), 'old problem', 'utf8');

    await prepareStageStaging(root, replacementRun, 'analysis');
    await fsp.mkdir(path.join(root, 'inputs', 'problem'), { recursive: true });
    await fsp.writeFile(path.join(root, 'inputs', 'problem', 'statement.txt'), 'modeling problem', 'utf8');
    const staging = stagingPath(root, replacementRun, 'analysis');
    await fsp.writeFile(path.join(staging, 'analysis.md'), ANALYSIS_MD, 'utf8');
    await fsp.writeFile(path.join(staging, 'problem_text.md'), PROBLEM_TEXT, 'utf8');
    await fsp.writeFile(path.join(staging, 'analysis.pdf'), ANALYSIS_PDF);
    await fsp.writeFile(path.join(staging, 'subproblems.yaml'), SUBPROBLEMS_YAML, 'utf8');
    await writeEnhancedAnalysisContracts(staging);
    const gate = await validateStageArtifacts(stagingProjectView(root, replacementRun), 'analysis');
    assert.equal(gate.ok, true, gate.reason || '');

    const result = await commitStage(root, replacementRun, 'analysis', gate);
    assert.equal(result.committed, true);
    assert.equal(await fsp.readFile(path.join(committed, 'analysis.md'), 'utf8'), ANALYSIS_MD);
    assert.equal(fs.existsSync(staging), true);
    const marker = await readCommitMarker(root, 'analysis');
    assert.equal(marker.runId, replacementRun);
    const trashEntries = await fsp.readdir(path.join(root, 'work', '.trash'));
    const archived = path.join(root, 'work', '.trash', trashEntries[0], '01_analysis', 'analysis.md');
    assert.equal(await fsp.readFile(archived, 'utf8'), 'old analysis');
    assert.notEqual(initialRun, replacementRun);
  });
});

test('recoverProjectState trusts commit marker over incomplete state', async () => {
  await withTempRoot(async (root) => {
    const runId = 'run-2';
    await prepareStageStaging(root, runId, 'analysis');
    await fsp.writeFile(path.join(stagingPath(root, runId, 'analysis'), 'analysis.md'), ANALYSIS_MD, 'utf8');
    await fsp.writeFile(path.join(stagingPath(root, runId, 'analysis'), 'problem_text.md'), PROBLEM_TEXT, 'utf8');
    await commitStage(root, runId, 'analysis', { ok: true, artifactRefs: ['work/01_analysis/analysis.md'] });
    const state = {
      runId,
      tasks: {
        analysis: { status: 'running', attempts: [{ status: 'running' }], artifactRefs: [] },
      },
    };
    const recovered = await recoverProjectState(root, state);
    assert.equal(recovered.tasks.analysis.status, 'completed');
  });
});

test('project lock rejects second acquire while pid alive', async () => {
  await withTempRoot(async (root) => {
    const first = await acquireLock(root);
    assert.equal(first.acquired, true);
    const second = await acquireLock(root);
    assert.equal(second.acquired, false);
    await releaseLock(root);
    const third = await acquireLock(root);
    assert.equal(third.acquired, true);
    await releaseLock(root);
  });
});

test('diagnostics redacts secrets and builds support code', async () => {
  assert.equal(supportCode('abcdef0123456789').startsWith('MMW-'), true);
  const redacted = redactObject({ apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', baseUrl: 'https://user:pass@example.com/v1?token=1', nested: { token: 'abc' } });
  assert.match(redacted.apiKey, /redacted/);
  assert.equal(redacted.baseUrl.includes('token'), false);
  assert.match(redacted.nested.token, /redacted/);

  await withTempRoot(async (root) => {
    await fsp.mkdir(path.join(root, 'work', '03_paper'), { recursive: true });
    await fsp.writeFile(path.join(root, 'work', '03_paper', 'main.tex'), '\\begin{document}ok\\end{document}', 'utf8');
    const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmw-ud-'));
    await fsp.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ connections: { reasoning: { apiKey: 'secret-key', baseUrl: 'https://api.example/v1' } } }), 'utf8');
    const pack = await createDiagnosticPackage({
      root,
      userDataPath: userData,
      runtimeStatusImpl: async () => ({ python: true }),
      createRunStoreImpl: () => ({
        load: async () => ({ runId: 'run-diag', tasks: { analysis: { lastError: { category: 'model', reason: 'fail sk-abcdefghijklmnopqrstuvwxyz' } } } }),
        readEvents: async () => [{ type: 'run.started', payload: { apiKey: 'x' } }],
      }),
    });
    assert.ok(pack.parts['manifest.json']);
    assert.match(pack.parts['settings.redacted.json'], /redacted/);
    await fsp.rm(userData, { recursive: true, force: true });
  });
});

test('component manager seeds installed components and updater bridge degrades safely', async () => {
  await withTempRoot(async (root) => {
    seedInstalledComponentsSync(root, '0.1.0');
    const installed = await readInstalledComponents(root);
    assert.equal(installed.core.version, '0.1.0');
    const updates = await listComponentUpdates({
      runtimeRootPath: root,
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    assert.equal(updates.ok, false);
  });
  const bridge = createAutoUpdaterBridge({ isDev: true });
  assert.equal(bridge.enabled, false);
  assert.equal((await bridge.check()).ok, false);
});

test('Ed25519 manifest sign and verify roundtrip', () => {
  const {
    signManifest,
    verifyManifestSignature,
  } = require('../electron/component-manager.cjs');
  const content = {
    version: '1',
    channel: 'stable',
    components: {
      python: { version: '3.12.1', sha256: 'abc', url: 'https://example/p.7z' },
    },
  };
  const signed = signManifest(content);
  assert.ok(signed.signature);
  assert.equal(verifyManifestSignature(signed), true);
  assert.equal(verifyManifestSignature({ ...signed, version: 'tampered' }), false);
});

test('AST scan rejects forbidden socket usage', () => {
  const scan = path.join(__dirname, '..', 'runtime', 'guard', 'scan.py');
  const tmp = path.join(os.tmpdir(), `mmw-scan-${Date.now()}.py`);
  fs.writeFileSync(tmp, 'import socket\nsocket.socket()\n', 'utf8');
  const result = spawnSync('python', [scan, tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /Forbidden/);
});

test('sandbox executes staged scripts from their stage directory with scoped shared imports', async () => {
  await withTempRoot(async (root) => {
    const stageRoot = path.join(root, 'work', '.staging', 'run-python', '02_solving');
    const scriptDirectory = path.join(stageRoot, 'sub_problem_1');
    await fsp.mkdir(path.join(stageRoot, 'shared'), { recursive: true });
    await fsp.mkdir(scriptDirectory, { recursive: true });
    await fsp.writeFile(path.join(stageRoot, 'shared', '__init__.py'), '', 'utf8');
    await fsp.writeFile(path.join(stageRoot, 'shared', 'constants.py'), 'VALUE = 17\n', 'utf8');
    const script = path.join(scriptDirectory, 'solve.py');
    await fsp.writeFile(script, [
      'from pathlib import Path',
      'from shared.constants import VALUE',
      "Path('result.txt').write_text(str(VALUE), encoding='utf-8')",
    ].join('\n'), 'utf8');

    const guard = path.join(__dirname, '..', 'runtime', 'guard', 'sandbox_entry.py');
    const result = spawnSync('python', [guard, script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_ROOT: root,
        WORKSPACE_STAGE_ROOT: stageRoot,
        WORKSPACE_CWD: scriptDirectory,
        ALLOW_NETWORK: '0',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await fsp.readFile(path.join(scriptDirectory, 'result.txt'), 'utf8'), '17');
    assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
  });
});
