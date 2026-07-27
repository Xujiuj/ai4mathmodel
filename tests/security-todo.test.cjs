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

test('staging commit moves artifacts and writes marker', async () => {
  await withTempRoot(async (root) => {
    const runId = 'run-1';
    await prepareStageStaging(root, runId, 'analysis');
    const staging = stagingPath(root, runId, 'analysis');
    await fsp.writeFile(path.join(staging, 'analysis.md'), ANALYSIS_MD, 'utf8');
    await fsp.writeFile(path.join(staging, 'problem_text.md'), PROBLEM_TEXT, 'utf8');
    const view = stagingProjectView(root, runId);
    const gate = await validateStageArtifacts(view, 'analysis');
    assert.equal(gate.ok, true, gate.reason || '');
    const result = await commitStage(root, runId, 'analysis', gate);
    assert.equal(result.committed, true);
    assert.ok(fs.existsSync(path.join(committedPath(root, 'analysis'), 'analysis.md')));
    assert.ok(!fs.existsSync(staging));
    const marker = await readCommitMarker(root, 'analysis');
    assert.equal(marker.runId, runId);
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
