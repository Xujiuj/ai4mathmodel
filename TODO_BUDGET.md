# 费用护栏系统实施计划

> 状态（2026-07-29）：代码侧已实现并由 `tests/budget.test.cjs` 覆盖。本文保留为历史实施记录；以后续源码、测试与 `HANDOFF.md` 为准。

## 已完成
✅ electron/pricing.cjs - 价目表模块(BUILTIN_PRICING, resolvePricing, computeCost)
✅ electron/supervisor/contracts.cjs - 添加 DEFAULT_BUDGET, normalizeBudget
✅ createRunState 添加 spend 字段:{inputTokens, outputTokens, cacheReadTokens, cost, pricingUnknown, byStage}
✅ direct-provider.cjs 的 anthropicAnswer/openAiAnswer/ollamaAnswer 返回 usage

## 待完成

### 1. direct-provider.cjs - runDirectAgent 累积 usage
**位置**: electron/supervisor/direct-provider.cjs:351

**修改点 A**: 函数开头初始化累积器
```js
async function runDirectAgent({ ... }) {
  // ... existing validation ...
  const protocol = protocolFor(connection);
  const allowedTools = new Set(tools.map((tool) => tool.name));
  const messages = [{ role: 'user', content: cleanText(prompt, 80_000) }];
  let toolCallCount = 0;

  // 新增:累积 usage
  const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
```

**修改点 B**: callProvider 调用后累加 usage(约在384行附近)
```js
const answer = await callProvider({ ... });

// 新增:累加本次 usage
if (answer.usage) {
  totalUsage.inputTokens += answer.usage.inputTokens || 0;
  totalUsage.outputTokens += answer.usage.outputTokens || 0;
  totalUsage.cacheReadTokens += answer.usage.cacheReadTokens || 0;
}

if (!answer.toolCalls.length) {
  return {
    code: 0,
    stdout: answer.text,
    stderr: '',
    toolCallCount,
    turns: turn + 1,
    provider: protocol,
    usage: totalUsage  // 新增
  };
}
```

**修改点 C**: 超过 MAX_TURNS 的返回(约在420行附近,需grep确认)
```js
// 搜索 "return.*MAX_TURNS\|throw.*MAX_TURNS" 找到这个分支
// 也要加上 usage: totalUsage
```

### 2. supervisor.cjs - 调用后累加费用到 state.spend
**位置**: electron/supervisor/supervisor.cjs 中调用 runDirectAgent 的地方

**步骤**:
1. `grep -n "runDirectAgent" electron/supervisor/supervisor.cjs` 找调用点
2. 在调用返回后添加:
```js
const result = await runDirectAgent({ ... });

// 新增:累加费用
if (result.usage && state.spend) {
  const { computeCost } = require('../pricing.cjs');
  const { cost, pricingUnknown } = computeCost(
    result.usage,
    result.provider,
    connection.model,
    policy.budget.pricingOverrides || {}
  );

  state.spend.inputTokens += result.usage.inputTokens || 0;
  state.spend.outputTokens += result.usage.outputTokens || 0;
  state.spend.cacheReadTokens += result.usage.cacheReadTokens || 0;
  state.spend.cost += cost;
  if (pricingUnknown) state.spend.pricingUnknown = true;

  const stage = state.currentStage;
  if (stage && !state.spend.byStage[stage]) {
    state.spend.byStage[stage] = { inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  if (stage) {
    state.spend.byStage[stage].inputTokens += result.usage.inputTokens || 0;
    state.spend.byStage[stage].outputTokens += result.usage.outputTokens || 0;
    state.spend.byStage[stage].cost += cost;
  }
}
```

### 3. supervisor.cjs - 调用前预算检查
**位置**: 同上,在 runDirectAgent 调用**之前**

```js
// 新增:预算检查函数(放在 supervisor.cjs 文件顶部)
function assertBudget(state) {
  const { budget, spend } = state;
  if (!budget?.enabled) return;

  const totalTokens = spend.inputTokens + spend.outputTokens;
  if (spend.cost >= budget.maxCostPerRun || totalTokens >= budget.maxTokensPerRun) {
    const error = new Error('已达到本次运行的预算上限。');
    error.code = 'BUDGET_EXCEEDED';
    error.category = 'configuration';  // 不触发 retry
    throw error;
  }
}

// 在每次 runDirectAgent 调用前:
assertBudget(state);
const result = await runDirectAgent({ ... });
```

### 4. retry-policy.cjs - BUDGET_EXCEEDED 归为终止类
**位置**: electron/supervisor/retry-policy.cjs:classifyFailure

**修改点**: 在 `function classifyFailure(error)` 中添加:
```js
if (code === 'BUDGET_EXCEEDED') return { category: FAILURE_CLASSES.CONFIGURATION, reason: error.message };
```

确保 CONFIGURATION 类别在 `shouldPauseImmediately` 中返回 true。

### 5. public-events.cjs - 新增 usage 事件类型
**位置**: electron/public-events.cjs

**修改点**: 在 toPublicPipelineEvent 中添加 usage-progress 分支:
```js
case 'usage.updated':
  return publicEvent('usage-progress', 'running', stage,
    `已消耗 ${payload.tokens.toLocaleString()} tokens · 约 ¥${payload.cost.toFixed(2)}`,
    event.createdAt
  );
```

**触发点**: supervisor.cjs 在累加 spend 后:
```js
await transition('usage.updated', {
  tokens: state.spend.inputTokens + state.spend.outputTokens,
  cost: state.spend.cost,
  pricingUnknown: state.spend.pricingUnknown,
});
```

### 6. main.cjs - 运行前预估弹窗
**位置**: electron/main.cjs 的 runFullPipeline 或 runAgentPipeline 开头

**实现**:
```js
async function estimateCost(stages, settings) {
  // 读取用户历史 usage-history.json,不存在则用内置基线
  const historyFile = path.join(app.getPath('userData'), 'usage-history.json');
  const history = await fsp.readFile(historyFile, 'utf8').then(JSON.parse).catch(() => ({}));

  // 每阶段 P50 token 数(用户历史 || 内置基线)
  const baseline = {
    analysis: history.analysis?.p50 || 120_000,
    solving: history.solving?.p50 || 350_000,
    paper: history.paper?.p50 || 280_000,
    review: history.review?.p50 || 150_000,
  };

  let minCost = 0, maxCost = 0;
  const { computeCost } = require('./pricing.cjs');
  const connections = normalizeSettings(settings).connections;

  for (const stage of stages) {
    const conn = connections[stage === 'paper' ? 'writing' : 'reasoning'];
    const tokens = baseline[stage] || 200_000;
    const usage = { inputTokens: tokens * 0.7, outputTokens: tokens * 0.3, cacheReadTokens: 0 };
    const { cost } = computeCost(usage, conn.protocol, conn.model);
    minCost += cost * 0.6;  // P50 × 0.6 = 保守下限
    maxCost += cost * 1.8;  // P50 × 1.8 = 乐观上限
  }

  return { minCost, maxCost };
}

// runFullPipeline 开头:
const { minCost, maxCost } = await estimateCost(stages, options);
const budget = normalizeSettings(options).policy?.budget || DEFAULT_BUDGET;

if (budget.enabled && !options.skipBudgetPrompt) {
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '费用预估',
    message: `本次运行预计消耗 ¥${minCost.toFixed(1)} ~ ¥${maxCost.toFixed(1)}`,
    detail: `当前预算上限:¥${budget.maxCostPerRun}\n\n点击"继续"开始运行,点击"取消"返回。`,
    buttons: ['继续', '取消'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: '不再提示(可在设置中修改)',
  });
  if (response.response === 1) throw new Error('用户取消');
  // TODO:保存 checkboxChecked 到用户配置
}
```

### 7. UI 组件 - 实时费用显示
**位置**: desktop-app/src/components/Shell.jsx 或 StatusBar 组件

**新增状态**:
```jsx
const [spend, setSpend] = useState({ cost: 0, tokens: 0, pricingUnknown: false });

useEffect(() => {
  const unsubscribe = desktopApi.onRunEvent((event) => {
    if (event.type === 'usage-progress') {
      setSpend({
        cost: event.payload?.cost || 0,
        tokens: event.payload?.tokens || 0,
        pricingUnknown: event.payload?.pricingUnknown || false,
      });
    }
  });
  return unsubscribe;
}, []);
```

**渲染**:
```jsx
<div className="spend-indicator">
  {spend.tokens > 0 && (
    <span className={spend.pricingUnknown ? 'pricing-unknown' : ''}>
      {spend.tokens.toLocaleString()} tokens
      {!spend.pricingUnknown && ` · ¥${spend.cost.toFixed(2)}`}
    </span>
  )}
</div>
```

### 8. runtime-config.cjs - settings schema 扩展
**位置**: electron/runtime-config.cjs

**修改**: DEFAULT_SETTINGS 添加:
```js
const DEFAULT_SETTINGS = Object.freeze({
  // ... existing fields ...
  agentPolicy: DEFAULT_AGENT_POLICY,  // 从 contracts.cjs 导入
  pricingOverrides: {},  // { "anthropic:claude-opus": [109.5, 547.5, 10.95], ... }
});
```

normalizeSettings 中添加对应的规范化逻辑。

### 9. 测试
**文件**: tests/budget.test.cjs

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCost, resolvePricing } = require('../electron/pricing.cjs');
const { normalizeBudget, DEFAULT_BUDGET } = require('../electron/supervisor/contracts.cjs');

test('computeCost calculates correct CNY cost for Anthropic Claude', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000 };
  const { cost, pricingUnknown } = computeCost(usage, 'anthropic', 'claude-opus-4');
  assert.ok(!pricingUnknown);
  assert.ok(cost > 380 && cost < 390);  // 109.5 + 273.75 + 2.19
});

test('resolvePricing returns null for unknown models', () => {
  assert.equal(resolvePricing('openai', 'gpt-99-ultra'), null);
});

test('normalizeBudget clamps maxTokensPerRun to safe range', () => {
  const budget = normalizeBudget({ maxTokensPerRun: 999_999_999 });
  assert.equal(budget.maxTokensPerRun, 50_000_000);
});

test('budget enforcement stops before exceeding maxCostPerRun', async () => {
  // TODO:集成测试,需 mock callProvider
});
```

## 优先级顺序
1. ✅ 价目表与 contracts(已完成)
2. runDirectAgent usage 累积(修改点 1)
3. supervisor 累加与检查(修改点 2+3)
4. retry-policy 分类(修改点 4)
5. 运行前预估(修改点 6)
6. UI 实时显示(修改点 7)
7. 设置扩展(修改点 8)
8. 测试(修改点 9)

## 预计工作量
- 核心逻辑(1-4): 3-4 人日
- 预估与 UI(5-7): 2-3 人日
- 测试与调优(8-9): 1-2 人日
**总计**: 6-9 人日
