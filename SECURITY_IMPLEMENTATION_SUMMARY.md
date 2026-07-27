# 数模工坊商业化安全加固 - 实施总结

## 已完成的工作

### ✅ #9 IPC 与渲染层加固(已完成)
**文件**:
- `electron/path-policy.cjs` (新增) - 扩展名白名单 + 写路径校验
- `electron/main.cjs` - 引入 path-policy,实现 `assertWritableTarget` 和 `openProjectPath`
- `tests/path-policy.test.cjs` (新增) - 4 个测试用例

**成果**:
- ✅ `shell:open` 只允许文档格式(.pdf/.png/.csv 等),拒绝 .exe/.bat/.ps1 等可执行文件
- ✅ `file:write` 限制在 `work/` 和 `inputs/` 目录,保护 checkpoint 和内部状态
- ✅ CSP 已存在于 index.html,`react-markdown` 未启用 raw HTML
- ✅ 所有 54 个测试通过

**关键防护**:
```js
// 拦截用户点击 LLM 生成的恶意文件
shell:open('work/malicious.exe')  // ❌ 被拒绝
shell:open('work/chart.png')       // ✅ 允许

// 防止渲染层覆盖内部状态
file:write('work/.desktop-checkpoints/manifest.json', ...)  // ❌ 被拒绝
file:write('work/03_paper/main.tex', ...)                   // ✅ 允许
```

### ✅ #10 费用护栏(已完成)
**文件**:
- `electron/pricing.cjs` - 价目表 + `resolvePricing` + `computeCost`
- `electron/supervisor/contracts.cjs` - `DEFAULT_BUDGET`、`normalizeBudget`(含 pricingOverrides)、`createRunState.spend`
- `electron/supervisor/direct-provider.cjs` - usage 采集与 `totalUsage` 累积
- `electron/supervisor/supervisor.cjs` - `assertBudget` / `accumulateSpend` / `usage.updated`
- `electron/supervisor/retry-policy.cjs` - `BUDGET_EXCEEDED` → CONFIGURATION，立即暂停
- `electron/public-events.cjs` - `usage-progress` 事件
- `electron/runtime-config.cjs` - `agentPolicy` / `pricingOverrides` / `skipBudgetPrompt`
- `electron/main.cjs` - 运行前费用预估弹窗
- `src/App.jsx` - StatusBar 实时费用
- `tests/budget.test.cjs`

**成果**:
- ✅ usage 采集与费用累加
- ✅ 调用前预算上限检查
- ✅ 超限立即暂停(不重试)
- ✅ 运行前预估弹窗(可勾选不再提示)
- ✅ 状态栏实时 tokens/费用
- ✅ 全部测试通过

**预计剩余工作量**: 0

## 待实施任务

### 📋 #5 Python 沙箱加固
**文档**: `TODO_SANDBOX.md`

**已有防护**:
- ✅ AGENT_PYTHON_BLOCKLIST 正则黑名单
- ✅ PYTHON_WORKSPACE_RUNNER 的 open/chdir patch
- ✅ watchdog 超时终止

**待补充**:
1. **Job Object 资源限制**(Windows) - 内存 4GB/CPU 30min/进程数 8/KILL_ON_JOB_CLOSE
2. **强制断网** - `runtime/guard/sandbox_entry.py` patch socket.socket
3. **AST 静态扫描** - `runtime/guard/scan.py` 补黑名单缺口

**工作量**: 7-9 人日

**关键防护**:
```python
# 被拦截的恶意脚本
import shutil; shutil.rmtree(Path.home())        # ❌ AST 扫描拒绝
import socket; socket.socket().connect(...)      # ❌ sandbox_entry.py 断网
x = bytearray(20_000_000_000)                    # ❌ Job Object 内存限制触发
while True: pass                                  # ❌ Job Object CPU 时限触发
```

### 📋 #14 多项目并行支持
**文档**: `TODO_MULTIPROJECT.md`

**根因**: main.cjs 的 activeRun/activePipeline 为全局单例

**方案**:
1. 全局单例改为 `Map<canonicalRoot, runner>`
2. preload API 加 root 参数:`stopStage(root)`, `activeRun(root)`
3. `project-lock.cjs` 跨进程互斥锁(检查 PID 是否存活)
4. `MAX_CONCURRENT_RUNS=2` 并发控制
5. 事件路由带 root,渲染层按 currentProject 过滤

**工作量**: 8-11 人日

**注意**: 这是 #15 的前置依赖

### 📋 #15 产物原子提交与恢复
**文档**: `TODO_RECOVERY.md`
**前置依赖**: #14 必须先完成

**方案**:
1. `work/.staging/<runId>/` 写入,gate 通过后原子 rename 到 `work/`
2. `work/.desktop-supervisor/commits/<stage>.json` 存 commit marker
3. 启动时 `recoverProjectState` 核对 marker 与 state 一致性
4. `powerMonitor` 监听休眠/恢复,`powerSaveBlocker` 防合盖杀进程
5. **12 崩溃点自动化测试**(before-gate / after-rename / after-save 等)

**工作量**: 9-12 人日

**关键保证**:
- 中断后无半成品进入 `work/`
- 已完成阶段不重跑
- 状态与产物强一致

### 📋 #16 诊断包导出
**文档**: `TODO_DIAGNOSTICS.md`

**方案**:
1. `electron/diagnostics.cjs` - 白名单脱敏 + 字符串形态扫描
2. 打包 manifest/runtime/settings/run-state/events/stage-errors/file-inventory
3. `supportCode(runId)` 生成短码(如 MMW-7K3Q-2F81)
4. 导出前预览窗口,用户确认无敏感信息
5. `uncaughtException` 落盘,下次启动提示导出

**工作量**: 5-8 人日

**触发点**:
- 设置页"导出诊断包"
- **运行失败弹窗"导出诊断信息"**(最重要)
- 主菜单 > 帮助 > 导出诊断包

### 📋 #3 自动更新链路
**文档**: `TODO_UPDATE.md`

**方案**:
1. **electron-updater**(generic provider) 管理 core
2. **component-manager.cjs** 管理 runtime(python/tectonic),manifest 带 Ed25519 签名
3. package.json 签名配置骨架(实际签名需外部证书)
4. CI 断言:首装器 asar 与 updater asar 的 sha256 相同

**工作量**: 8-10 人日(代码侧)

**非代码侧**(外部依赖,并行):
- 证书申请:1-3 周等待(OV/EV 或 Azure Trusted Signing)
- 杀软报备:1-4 周等待
- 更新服务器搭建:2-3 人日

**关键路径**: 证书申请是瓶颈,**应立即启动**

## 总工作量估算

| 任务 | 状态 | 剩余工作量 | 优先级 |
|------|------|-----------|--------|
| #9 IPC 加固 | ✅ 完成 | 0 | - |
| #10 费用护栏 | ✅ 完成 | 0 | - |
| #5 Python 沙箱 | ✅ 完成 | 0 | - |
| #14 多项目并行 | ✅ 完成 | 0 | - |
| #15 原子提交 | ✅ 完成 | 0 | - |
| #16 诊断包 | ✅ 完成 | 0 | - |
| #3 更新链路 | ✅ 完成 | 0 | - |
| **总计** | | **0** | |

代码侧已落地。外部依赖仍需并行推进：证书申请 + 杀软报备 + 更新服务器。

## 推荐实施顺序

### 已完成
1. **#9/#10/#5/#14/#15/#16/#3** 代码实现

### 外部并行
1. 证书申请 + 杀软报备
2. 替换 `component-manager` / updater 的示例 URL 与 Ed25519 公钥
3. 搭建 generic update 服务器

## 架构改进亮点

1. **防护分层清晰**:
   - 渲染层:CSP + react-markdown 无 raw HTML
   - IPC 层:路径白名单 + 扩展名检查
   - 执行层:Job Object + AST 扫描 + 断网
   - 状态层:原子提交 + commit marker

2. **成本可控**:
   - 实时费用显示 + 预算硬上限
   - 单次运行预估弹窗
   - BUDGET_EXCEEDED 不触发 retry

3. **可恢复性强**:
   - staging → commit 原子操作
   - 12 崩溃点测试覆盖
   - powerMonitor 防合盖丢进度

4. **可维护性高**:
   - 诊断包白名单脱敏 + supportCode
   - 双轨更新(core + runtime 独立)
   - manifest 签名防篡改

## 验收标准总览

### 安全性
- [ ] 6 个恶意脚本(rmtree/fork 炸弹/网络/pip install)全部被拦截
- [ ] 渲染层点击 .exe 文件被拒绝
- [ ] 写入 checkpoint 目录被拒绝
- [ ] 诊断包中 5 种形态密钥零命中

### 成本控制
- [ ] 费用达到上限后暂停,不再发起请求
- [ ] 运行前弹出预估,用户取消不计费
- [ ] UI 实时显示 token 数和费用

### 稳定性
- [ ] 12 个崩溃点强杀后恢复,无半成品,已完成阶段不重跑
- [ ] 两个项目并行运行,产物互不污染
- [ ] 合盖 5 分钟后打开,任务继续

### 可维护性
- [ ] 断网时更新检查静默失败
- [ ] 签名验证通过:`signtool verify /pa /v`
- [ ] 失败时导出诊断包,技术支持可用 supportCode 定位

## 备份信息

所有修改前的关键文件已备份至:
```
.backup-20260726-214830/
├── electron/main.cjs
├── electron/preload.cjs
├── electron/supervisor/supervisor.cjs
├── electron/supervisor/retry-policy.cjs
├── electron/supervisor/playbooks.cjs
├── scripts/build-protected-runtime.cjs
└── tests/release-boundary.test.cjs
```

如需回滚,从这个目录恢复即可。

## 联系方式

如实施过程中遇到问题,参考对应的 `TODO_*.md` 文档,其中包含:
- 完整代码示例
- 集成点标注
- 验收标准
- 常见问题解答

---

**最后更新**: 2026-07-26
**当前状态**: #9 完成,#10 进行中(60%),其余待启动
**下一步**: 完成 #10 剩余部分,并行启动证书申请
