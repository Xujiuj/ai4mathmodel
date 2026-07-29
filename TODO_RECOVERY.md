# 产物原子提交实施计划 (#15)

> 状态（2026-07-29）：代码侧已实现，包括同卷 staging、原子提交、旧版本保留与中断恢复。本文保留为历史实施记录；以后续源码、测试与 `HANDOFF.md` 为准。

## 前置依赖
⚠️ **必须先完成 #14(多项目并行)**,因为 staging 目录结构依赖 runId 隔离。

## 当前问题
- 阶段产物直写 `work/02_solving/`,中断后半成品留在原地
- gate 校验读到半成品可能误判通过(results.yaml 已写但图未生成)或误判失败(触发全阶段重跑)
- 无 commit marker,状态与产物可能不一致(崩在 save 与产物写入之间)
- 无 powerMonitor,合盖导致长跑白费

## 实施方案

### 1. 目录约定
```
work/02_solving/                     ← 已提交的产物(gate 已通过)
work/.staging/<runId>/02_solving/    ← 本次尝试的写入目标
work/.trash/<timestamp>/02_solving/  ← 提交时被覆盖的旧产物(保留最近 3 代)
work/.desktop-supervisor/commits/    ← commit marker 存放处
```

### 2. staging 路径解析器
**位置**: electron/staging.cjs (新文件)

```js
const path = require('node:path');

const STAGE_DIR_MAP = Object.freeze({
  analysis: '01_analysis',
  solving: '02_solving',
  paper: '03_paper',
  review: '04_review',
});

function stagingPath(root, runId, stage) {
  if (!STAGE_DIR_MAP[stage]) throw new Error(`Unknown stage: ${stage}`);
  return path.join(root, 'work', '.staging', runId, STAGE_DIR_MAP[stage]);
}

function committedPath(root, stage) {
  if (!STAGE_DIR_MAP[stage]) throw new Error(`Unknown stage: ${stage}`);
  return path.join(root, 'work', STAGE_DIR_MAP[stage]);
}

function trashPath(root, timestamp, stage) {
  return path.join(root, 'work', '.trash', String(timestamp), STAGE_DIR_MAP[stage]);
}

function commitMarkerPath(root, stage) {
  return path.join(root, 'work', '.desktop-supervisor', 'commits', `${stage}.json`);
}

// Injected view: makes artifact-gates see staging instead of committed
function stagingProjectView(root, runId) {
  return {
    root,
    resolvePath: (relative) => {
      // work/02_solving/... → work/.staging/<runId>/02_solving/...
      for (const [stage, dir] of Object.entries(STAGE_DIR_MAP)) {
        if (relative.startsWith(`work/${dir}`)) {
          return path.join(root, 'work', '.staging', runId, relative.slice(5));
        }
      }
      return path.join(root, relative);
    },
  };
}

module.exports = {
  stagingPath,
  committedPath,
  trashPath,
  commitMarkerPath,
  stagingProjectView,
  STAGE_DIR_MAP,
};
```

### 3. artifact-gates 改造
**位置**: electron/supervisor/artifact-gates.cjs

**当前签名**:
```js
async function validateStageArtifacts(root, stage) { ... }
```

**改为**:
```js
async function validateStageArtifacts(projectView, stage) {
  // projectView = { root, resolvePath: (relative) => absolute }
  const resolve = projectView.resolvePath || ((rel) => path.join(projectView.root, rel));

  // 所有 path.join(root, 'work/02_solving/...') 改为 resolve('work/02_solving/...')
  // 示例:
  const resultsFile = resolve(`work/${STAGE_DIR_MAP[stage]}/results.yaml`);
  // ...
}
```

**调用点修改**: main.cjs / supervisor.cjs 中所有 validateStageArtifacts 调用
```js
// 校验 staging:
const gate = await validateStageArtifacts(stagingProjectView(root, runId), stage);

// 校验已提交产物:
const gate = await validateStageArtifacts({ root }, stage);
```

### 4. 原子提交函数
**位置**: electron/staging.cjs

```js
const fsp = require('node:fs/promises');
const fs = require('node:fs');

async function commitStage(root, runId, stage, gateResult) {
  const staging = stagingPath(root, runId, stage);
  const committed = committedPath(root, stage);
  const marker = commitMarkerPath(root, stage);

  if (!gateResult.ok) {
    // 未通过:staging 保留,供重试增量利用
    return { committed: false, gate: gateResult };
  }

  await fsp.mkdir(path.dirname(committed), { recursive: true });
  await fsp.mkdir(path.dirname(marker), { recursive: true });

  // 旧产物移入 trash(如存在)
  if (fs.existsSync(committed)) {
    const trash = trashPath(root, Date.now(), stage);
    await fsp.mkdir(path.dirname(trash), { recursive: true });
    await fsp.rename(committed, trash);
  }

  // 原子提交:staging → committed (同卷 rename)
  await fsp.rename(staging, committed);

  // 写 marker(提交凭证)
  await fsp.writeFile(marker, JSON.stringify({
    runId,
    stage,
    committedAt: new Date().toISOString(),
    gate: gateResult,
  }, null, 2), 'utf8');

  return { committed: true, gate: gateResult };
}

async function readCommitMarker(root, stage) {
  try {
    return JSON.parse(await fsp.readFile(commitMarkerPath(root, stage), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { ...exports, commitStage, readCommitMarker };
```

### 5. supervisor 集成 - 在阶段完成后提交
**位置**: electron/supervisor/supervisor.cjs

**现有流程**:
```js
// 阶段循环结束,validate,标记 completed
await transition('stage.completed', { stage });
```

**改为**:
```js
const { validateStageArtifacts } = require('../artifact-gates.cjs');
const { stagingProjectView, commitStage } = require('../staging.cjs');

// 阶段循环结束,先在 staging 上 validate
const gate = await validateStageArtifacts(stagingProjectView(projectRoot, state.runId), stage);

if (gate.ok) {
  // 原子提交
  await commitStage(projectRoot, state.runId, stage, gate);
  await transition('stage.completed', { stage });
} else {
  // 未通过:保留 staging,标记失败,触发重试
  await transition('stage.failed', { stage, gate });
}
```

### 6. 启动时崩溃恢复
**位置**: main.cjs - resumeInterruptedPipelines

```js
const { readCommitMarker, stagingPath } = require('./staging.cjs');

async function recoverProjectState(root, state) {
  // 清理孤儿 staging:不属于当前 runId 的一律移入 trash
  const stagingRoot = path.join(root, 'work', '.staging');
  const orphans = await fsp.readdir(stagingRoot).catch(() => []);

  for (const dir of orphans) {
    if (dir !== state.runId) {
      const orphan = path.join(stagingRoot, dir);
      const trash = path.join(root, 'work', '.trash', `orphan-${Date.now()}`, dir);
      await fsp.mkdir(path.dirname(trash), { recursive: true });
      await fsp.rename(orphan, trash).catch(() => {});
    }
  }

  // 逐阶段核对 commit marker 与 state.tasks 的一致性
  for (const [stage, task] of Object.entries(state.tasks)) {
    const marker = await readCommitMarker(root, stage);

    if (task.status === 'completed' && !marker) {
      // 状态说完成但产物没提交 → 重跑
      task.status = 'pending';
      task.attempts = [];
    }

    if (task.status !== 'completed' && marker?.runId === state.runId) {
      // 产物已提交但状态没落盘(崩在 rename 与 save 之间)→ 信任产物
      task.status = 'completed';
      task.completedAt = marker.committedAt;
    }
  }

  return state;
}

// resumeInterruptedPipelines 中:
const state = await store.load();
if (state && !isTerminalStatus(state.status)) {
  const recovered = await recoverProjectState(root, state);
  await store.save(recovered);
  // ... 继续恢复 ...
}
```

### 7. 电源事件处理
**位置**: main.cjs

```js
const { powerMonitor, powerSaveBlocker } = require('electron');

let powerBlockerId = null;

function enablePowerBlock() {
  if (!powerBlockerId) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
}

function disablePowerBlock() {
  if (powerBlockerId) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

// runAgentPipeline 开始时
enablePowerBlock();

// 结束时
disablePowerBlock();

// 监听休眠/恢复
powerMonitor.on('suspend', () => {
  // 暂停调度器(不 kill 正在跑的 python,让它继续)
  for (const [root, runner] of activeRunners) {
    if (runner.pipeline) runner.pipeline.suspended = true;
  }
});

powerMonitor.on('resume', () => {
  // 恢复前校验所有 provider 连接
  for (const [root, runner] of activeRunners) {
    if (runner.pipeline?.suspended) {
      // 检查连接可达性,不可达则 pause
      runner.pipeline.suspended = false;
    }
  }
});
```

### 8. artifact-cleanup 更新
**位置**: electron/artifact-cleanup.cjs

```js
// TRANSIENT_DIRECTORIES 添加:
const TRANSIENT_DIRECTORIES = new Set([
  '__pycache__', '.pytest_cache', '.ipynb_checkpoints', '.mypy_cache', '.ruff_cache',
  '.staging',  // 新增:staging 目录由 commitStage 管理,cleanup 忽略
]);

// 新增:清理旧 trash(保留最近 3 代)
async function cleanOldTrash(root) {
  const trashRoot = path.join(root, 'work', '.trash');
  const entries = await fsp.readdir(trashRoot, { withFileTypes: true }).catch(() => []);

  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));

  for (const dir of dirs.slice(3)) {  // 保留最近 3 个
    await fsp.rm(path.join(trashRoot, dir.name), { recursive: true, force: true });
  }
}
```

### 9. 用户可见性
**UI 改进**: 恢复时明确告知
```js
// public-events.cjs
case 'run.resumed':
  const completed = payload.completedStages?.join('、') || '无';
  const next = payload.nextStage || '未知';
  return publicEvent('run-resumed', 'running', null,
    `已完成:${completed};将从"${next}"继续`,
    event.createdAt
  );
```

## 12 崩溃点自动化测试
**位置**: tests/crash-recovery.test.cjs

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const CRASH_POINTS = [
  'before-gate',          // gate 校验前
  'gate-pass-before-trash',  // gate 通过,旧产物移入 trash 前
  'after-trash-before-rename', // trash 后,rename staging 前
  'after-rename-before-marker', // rename 后,写 marker 前
  'after-marker-before-save',  // marker 写完,state save 前
  'after-save',           // state save 后(正常完成)
];

for (const point of CRASH_POINTS) {
  test(`recovers correctly when crashed at ${point}`, async () => {
    // 1. 启动 Electron,设置环境变量 CRASH_AT=point
    // 2. 运行一个阶段,在 point 处 process.exit(1)
    // 3. 重启,调用 recoverProjectState
    // 4. 断言:已完成阶段不重跑,未完成阶段的 staging/committed/marker 一致性

    // TODO:需要 mock Electron 环境或用 spectron
  });
}
```

## 验收标准
1. 用 `process.kill` 在 12 个崩溃点强杀主进程,重启后:
   - 无半成品进入 `work/`
   - 已完成阶段不重跑
   - `work/` 下不出现 `.staging` 残留
2. 合盖 5 分钟后打开,任务继续(未被 suspend 杀掉)
3. trash 自动保留最近 3 代,更早的被清理

## 工作量
- staging 路径解析器:1 人日
- artifact-gates 改造:2-3 人日(影响面大)
- commitStage + 恢复逻辑:2-3 人日
- 电源事件:1 人日
- 12 崩溃点测试:3-4 人日(最耗时,但必须做)
**总计**:9-12 人日

## 注意事项
- artifact-gates 的 resolvePath 注入会触及所有 gate 规则,需要完整回归
- rename 的原子性依赖同卷操作,跨卷会退化为 copy+delete(非原子)
- powerSaveBlocker 在 Windows 上依赖 ES_CONTINUOUS | ES_SYSTEM_REQUIRED
