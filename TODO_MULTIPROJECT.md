# 多项目并行支持实施计划 (#14)

> 状态（2026-07-29）：代码侧已实现，当前上限为两个项目并行。本文保留为历史实施记录；以后续源码、测试与 `HANDOFF.md` 为准。

## 当前架构问题
- main.cjs 的 activeRun/activePipeline/activeSupervisor/activeDirectAbortController 为全局单例
- preload.cjs 的 stopStage()/activeRun() 无 root 参数
- resumeInterruptedPipelines 因 `if(activeRun||activePipeline) return` 只恢复第一个项目
- spawnTracked 互斥检查基于全局 activeRun

## 实施方案

### 1. 全局单例改为 Map
**位置**: electron/main.cjs

```js
// 原来:
let activeRun = null;
let activePipeline = null;
let activeSupervisor = null;
let activeDirectAbortController = null;

// 改为:
const activeRunners = new Map();  // canonicalRoot -> { run, pipeline, supervisor, abortController, startedAt }

function canonicalRoot(root) {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getRunner(root) {
  return activeRunners.get(canonicalRoot(root));
}

function setRunner(root, ctx) {
  activeRunners.set(canonicalRoot(root), ctx);
}

function deleteRunner(root) {
  activeRunners.delete(canonicalRoot(root));
}
```

### 2. 修改所有 activeRun 访问点
**影响范围**: main.cjs 中约 20+ 处

**模式 A - 读取检查**:
```js
// 原来:
if (activeRun) throw new Error('已有任务运行中');

// 改为:
const runner = getRunner(root);
if (runner?.run) throw new Error('该项目已有任务运行中');
```

**模式 B - 设置**:
```js
// 原来:
activeRun = pythonProcess;
activePipeline = { ... };

// 改为:
setRunner(root, {
  run: pythonProcess,
  pipeline: { ... },
  supervisor: null,
  abortController: null,
  startedAt: Date.now(),
});
```

**模式 C - 清理**:
```js
// 原来:
activeRun = null;
activePipeline = null;

// 改为:
deleteRunner(root);
```

**关键函数**:
- `spawnTracked(root, ...)` - 加 root 参数,检查/设置 getRunner(root)
- `stopActiveRun()` → `stopRun(root)` - 按 root 查找并终止
- `runAgentPipeline(root, ...)` - 检查 getRunner(root),设置 runner.pipeline
- `resumeInterruptedPipelines()` - 遍历所有项目,并行恢复(见下)

### 3. preload API 扩展
**位置**: electron/preload.cjs

```js
// 原来:
stopStage: () => invoke('pipeline:stop'),
activeRun: () => invoke('pipeline:active'),

// 改为:
stopStage: (root) => invoke('pipeline:stop', { root }),
activeRun: (root) => invoke('pipeline:active', { root }),
activeRuns: () => invoke('pipeline:active-all'),  // 新增:全局运行列表
```

**main.cjs handler**:
```js
handle('pipeline:stop', async (_event, { root } = {}) => {
  assertTrustedSender(_event);
  if (!root) throw new Error('root 参数必填');
  return stopRun(root);
});

handle('pipeline:active', async (_event, { root } = {}) => {
  assertTrustedSender(_event);
  if (!root) throw new Error('root 参数必填');
  const runner = getRunner(root);
  return runner?.pipeline || null;
});

handle('pipeline:active-all', async (_event) => {
  assertTrustedSender(_event);
  return Array.from(activeRunners.entries()).map(([root, runner]) => ({
    root,
    stage: runner.pipeline?.currentStage || null,
    startedAt: runner.startedAt,
  }));
});
```

### 4. 跨进程互斥锁
**位置**: electron/project-lock.cjs (新文件)

```js
const fsp = require('node:fs/promises');
const path = require('node:path');

function lockFile(root) {
  return path.join(root, 'work', '.desktop-supervisor', 'run.lock');
}

async function acquireLock(root) {
  const file = lockFile(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const lock = { pid: process.pid, startedAt: Date.now(), hostname: require('os').hostname() };

  try {
    // 'wx' = 原子创建,存在则失败
    await fsp.writeFile(file, JSON.stringify(lock, null, 2), { flag: 'wx', mode: 0o600 });
    return { acquired: true, lock };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    // 锁存在,检查持有者是否存活
    const existing = JSON.parse(await fsp.readFile(file, 'utf8'));
    const pidAlive = await isPidAlive(existing.pid);

    if (!pidAlive) {
      // 陈旧锁,接管
      await fsp.writeFile(file, JSON.stringify(lock, null, 2), { mode: 0o600 });
      return { acquired: true, lock, stale: existing };
    }

    return { acquired: false, existing };
  }
}

async function releaseLock(root) {
  await fsp.rm(lockFile(root), { force: true });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);  // signal=0 只检查不杀
    return true;
  } catch {
    return false;
  }
}

module.exports = { acquireLock, releaseLock };
```

**集成**: runAgentPipeline 开头
```js
const { acquireLock, releaseLock } = require('./project-lock.cjs');

async function runAgentPipeline(root, options, { stages, resume, forceResume } = {}) {
  const lockResult = await acquireLock(root);
  if (!lockResult.acquired) {
    throw new Error(`该项目已在另一个应用实例中运行(PID ${lockResult.existing.pid})`);
  }

  try {
    // ... existing pipeline logic ...
  } finally {
    await releaseLock(root);
    deleteRunner(root);
  }
}
```

### 5. 并发控制与排队
**位置**: main.cjs

```js
const MAX_CONCURRENT_RUNS = 2;  // 可配置

async function waitForSlot() {
  while (activeRunners.size >= MAX_CONCURRENT_RUNS) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// runAgentPipeline 在 acquireLock 前:
await waitForSlot();
sendRunEvent({ type: 'run.queued', root, queuePosition: activeRunners.size });
```

### 6. 事件路由
**位置**: main.cjs - sendRunEvent

```js
// 原来:
function sendRunEvent(event) {
  mainWindow?.webContents.send('pipeline:event', event);
}

// 改为:
function sendRunEvent(event) {
  if (!event.root) {
    // 全局事件(应用级),广播
    mainWindow?.webContents.send('pipeline:event', event);
  } else {
    // 项目级事件,带 root
    mainWindow?.webContents.send('pipeline:event', { ...event, root: event.root });
  }
}
```

**渲染层过滤**: src/App.jsx
```js
useEffect(() => {
  const unsubscribe = desktopApi.onRunEvent((event) => {
    if (event.root && event.root !== currentProject?.root) return;  // 忽略其他项目
    // ... handle event ...
  });
  return unsubscribe;
}, [currentProject]);
```

### 7. resumeInterruptedPipelines 改造
**位置**: main.cjs

```js
// 原来:
async function resumeInterruptedPipelines() {
  if (activeRun || activePipeline) return;  // 只恢复一个
  const projects = await readProjects();
  for (const project of projects) {
    const store = createRunStore(project.root);
    const state = await store.load();
    if (state && !isTerminalStatus(state.status)) {
      return runAgentPipeline(project.root, {}, { stages: [...PIPELINE_STAGES], resume: true });
    }
  }
}

// 改为:
async function resumeInterruptedPipelines() {
  const projects = await readProjects();
  const pending = [];

  for (const project of projects) {
    const store = createRunStore(project.root);
    const state = await store.load();
    if (state && !isTerminalStatus(state.status)) {
      pending.push({ root: project.root, state });
    }
  }

  // 并行恢复,受 MAX_CONCURRENT_RUNS 限制
  await Promise.allSettled(pending.map((item) =>
    runAgentPipeline(item.root, {}, { stages: [...PIPELINE_STAGES], resume: true, forceResume: true })
      .catch((error) => {
        sendRunEvent({
          type: 'run.paused',
          root: item.root,
          message: `恢复失败:${error.message}`,
        });
      })
  ));
}
```

### 8. UI 适配
**位置**: src/components/Shell.jsx

**项目列表显示运行态**:
```jsx
<div className="project-item">
  <span>{project.name}</span>
  {activeRuns.find(r => r.root === project.root) && (
    <span className="running-indicator">● {activeRuns.find(r => r.root === project.root).stage}</span>
  )}
</div>
```

**关闭确认**:
```jsx
// main.cjs - app.on('before-quit')
app.on('before-quit', async (event) => {
  if (activeRunners.size === 0) return;

  event.preventDefault();
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '确认退出',
    message: `${activeRunners.size} 个任务正在运行`,
    detail: '退出将终止所有任务。确定要退出吗?',
    buttons: ['取消', '强制退出'],
    defaultId: 0,
    cancelId: 0,
  });

  if (response.response === 1) {
    for (const [root] of activeRunners) {
      await stopRun(root).catch(() => {});
    }
    app.quit();
  }
});
```

## 验收标准
1. 两个项目并行运行完整流程,work/ 产物互不污染
2. 停止项目 A 不影响项目 B
3. 同一项目在两个应用实例中打开,第二个被拒绝并提示 PID
4. 达到 MAX_CONCURRENT_RUNS 后第三个项目排队,前面完成后自动开始
5. 关闭应用时有运行任务,弹确认框

## 工作量
- Map 重构 + API 扩展:3-4 人日
- 跨进程锁:1-2 人日
- 并发控制 + 事件路由:1-2 人日
- UI 适配:1 人日
- 测试:2 人日
**总计**:8-11 人日

## 注意事项
- 这是 #15(恢复原子性)的前置依赖,必须先完成
- Map 重构会触及 main.cjs 大量代码,需要完整回归测试
- 跨进程锁依赖 process.kill(pid, 0) 的 POSIX 语义,Windows 上同样有效
