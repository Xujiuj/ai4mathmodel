const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.join(projectRoot, 'runtime');
const protectedDirectory = path.join(projectRoot, 'electron', 'protected');
const protectedTargets = ['loader.jsc', 'runtime.bin', 'spreadsheet-worker.cjs']
  .map((name) => path.join(protectedDirectory, name));

test('release manifest excludes skills and plaintext application internals', () => {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const build = packageInfo.build || {};
  const serialized = JSON.stringify(build).toLowerCase();

  assert.ok(Array.isArray(build.extraResources));
  assert.deepEqual(build.extraResources.map((entry) => entry.from), [
    'runtime/THIRD_PARTY_NOTICES.txt',
    'runtime/guard',
  ]);
  assert.doesNotMatch(serialized, /skill\.md|\.agents|math-modeling-competition/);
  assert.ok(Array.isArray(build.files));
  assert.ok(build.files.includes('electron/bootstrap.cjs'));
  assert.ok(build.files.includes('electron/protected/loader.jsc'));
  assert.ok(build.files.includes('electron/protected/runtime.bin'));
  assert.ok(!build.files.includes('electron/protected/main.jsc'));
  assert.ok(build.files.includes('electron/protected/spreadsheet-worker.cjs'));
  assert.ok(!build.files.includes('electron/workers/spreadsheet-worker.cjs'));
  assert.ok(!build.files.some((entry) => /^electron\/\*\*/.test(entry)));
});

test('bundled runtime contains no skill or application source trees', { skip: !fs.existsSync(runtimeRoot) }, () => {
  const forbiddenNames = new Set(['skill.md', '.agents', 'agents.md', '__pycache__']);
  const pending = [runtimeRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(forbiddenNames.has(entry.name.toLowerCase()), false, `forbidden runtime entry: ${path.join(directory, entry.name)}`);
      assert.equal(entry.name.toLowerCase().endsWith('.pyc'), false, `compiled Python cache must not be packaged: ${path.join(directory, entry.name)}`);
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }

  assert.equal(fs.existsSync(path.join(runtimeRoot, 'codex')), false, 'deprecated local model runtime must not be shipped');
  const tectonicEntries = fs.readdirSync(path.join(runtimeRoot, 'tectonic')).sort();
  assert.ok(tectonicEntries.every((name) => ['tectonic.exe', 'LICENSE.txt', 'fonts', 'cache'].includes(name)));
});

test('protected build encrypts private runtime strings instead of shipping readable bytecode', { skip: !protectedTargets.every((target) => fs.existsSync(target)) }, () => {
  for (const target of protectedTargets) assert.equal(fs.existsSync(target), true, `missing protected output: ${target}`);

  const needles = [
    'SKILL.md',
    '.agents',
    'STAGE_PLAYBOOKS',
    'Supervisor Dispatch v1',
    'local-supervisor-policy',
    'createAgentSupervisor',
    '你正在当前工作目录内执行无人值守',
    '所有安全重试与模型降级路径已耗尽',
  ];
  for (const target of protectedTargets) {
    const content = fs.readFileSync(target);
    const decoded = [content.toString('utf8'), content.toString('utf16le')];
    for (const needle of needles) {
      assert.equal(decoded.some((text) => text.includes(needle)), false, `${path.basename(target)} exposes ${needle}`);
    }
  }
});

test('renderer bridge does not expose private run state or internal terminology', () => {
  const preload = fs.readFileSync(path.join(projectRoot, 'electron', 'preload.cjs'), 'utf8');
  const renderer = [
    path.join(projectRoot, 'src', 'App.jsx'),
    path.join(projectRoot, 'src', 'api.js'),
    path.join(projectRoot, 'src', 'modelConfig.js'),
    path.join(projectRoot, 'src', 'components', 'Modals.jsx'),
    path.join(projectRoot, 'src', 'components', 'Shell.jsx'),
    path.join(projectRoot, 'src', 'components', 'StageWorkspace.jsx'),
    path.join(projectRoot, 'src', 'components', 'RunDrawer.jsx'),
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  assert.doesNotMatch(preload, /pipelineState|pipelineEvents|pipeline:state|pipeline:events/);
  assert.doesNotMatch(renderer, /agentRuntime|Agent 系统|推理总控|supervisor-event|agent-dispatch|route\.degraded/);
  assert.doesNotMatch(renderer, /运行当前阶段|继续当前阶段|运行赛题解析|运行模型求解|运行质量审查/);
});

test('public pipeline events contain only the renderer allowlist', () => {
  const { toPublicPipelineEvent } = require('../electron/public-events.cjs');
  const source = {
    type: 'attempt.failed',
    runId: 'run-private-id',
    createdAt: '2026-07-22T01:02:03.000Z',
    payload: {
      stage: 'solving',
      role: 'solver',
      model: 'private-model',
      reason: 'private diagnostic',
      category: 'rate-limit',
      attempt: 3,
      prompt: 'private prompt',
    },
  };
  const event = toPublicPipelineEvent(source);

  assert.deepEqual(Object.keys(event).sort(), ['at', 'message', 'stage', 'status', 'type'].sort());
  assert.equal(event.type, 'stage-progress');
  assert.equal(event.stage, 'solving');
  assert.equal(event.status, 'recovering');
  assert.doesNotMatch(JSON.stringify(event), /solver|private-model|private diagnostic|rate-limit|private prompt|run-private-id/);
});
