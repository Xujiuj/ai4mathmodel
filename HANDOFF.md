# 交接说明

数模工坊（math-modeling-workbench）：Electron + React 桌面应用，把数学建模竞赛拆成 analysis / solving / paper / review 四个阶段，由主进程里的 agent supervisor 驱动模型完成，产出可提交的 LaTeX 论文。

最后更新：2026-07-29。

---

## 0. 五分钟上手

```bash
npm install
npm run dev            # vite + electron 并行
npm test               # 81 例，node:test，纯 CJS，无需 Electron
npm run qa:electron    # 真实 Electron 窗口的自动化验收，产出 electron-qa-result.json 与 settings-modal-800.png
npm run build          # 仅前端
```

改完代码至少要跑 `npm test`；动了界面必须再跑 `npm run qa:electron`，它会断言设置弹窗、导航、文件预览和响应式布局。

### 仓库里看不到但磁盘上存在的文件

以下文件被 `.gitignore` 排除（属于私有实现与受保护构建输入），但**确实存在于工作目录**，不要以为它们缺失：

`electron/main.cjs`、`electron/supervisor/supervisor.cjs`、`electron/supervisor/playbooks.cjs`、`electron/supervisor/retry-policy.cjs`、`scripts/build-protected-runtime.cjs`、`tests/release-boundary.test.cjs`。

`electron/main.cjs` 约 1800 行，是整个应用的编排中心：IPC 注册、运行态管理、工具执行器、预算、恢复、更新全在里面。改动前先通读。

---

## 1. 架构速览

```
渲染层 src/            React，无 Node 权限
   ↕ preload.cjs       窄接口 IPC 白名单
主进程 electron/
   main.cjs            编排：IPC / 运行态 / 工具执行 / 预算 / 恢复
   supervisor/         流水线状态机、阶段 playbook、模型直连、产物闸门
   hosted/             官方托管模式：会话、令牌、档位目录、余额
   pricing / job-limits / project-lock / staging / diagnostics / updater / component-manager
gateway/               部署在服务端的提示词注入层（Node，无第三方依赖）
runtime/guard/         Python 沙箱：AST 扫描 + 断网入口
```

模型调用有两种模式，由 `settings.mode` 区分：

- **byok（自带模型）**：用户自己填 Base URL、模型、API Key，凭据经 `safeStorage` 加密存 `credentials.json`。
- **hosted（官方托管）**：连接信息全部来自服务端目录，提示词在服务端注入，计费与充值由自部署的 sub2api 承担。

---

## 2. 已完成

### 2.1 核心流水线

四阶段状态机、阶段产物闸门、重试策略、工具调用循环（列目录 / 读文件 / 读表格 / 读文档 / 写文件 / 跑 Python / 编译论文）、Anthropic 与 OpenAI 兼容双协议、Ollama 本地模型、图像生成、运行记录与检查点。

### 2.2 多项目并行（原 TODO_MULTIPROJECT）

`main.cjs` 的运行态已从全局单例改成 `activeRunners: Map`，键为规范化后的项目根路径，`MAX_CONCURRENT_RUNS = 2`。跨进程互斥见 `electron/project-lock.cjs`。事件按 root 路由，渲染层按当前项目过滤。

### 2.3 产物原子提交与崩溃恢复（原 TODO_RECOVERY）

`electron/staging.cjs` 提供 `prepareStageStaging` / `stagingProjectView` / `commitStage` / `recoverProjectState`。阶段产物先写 `.staging/<runId>/`，过闸门后原子提交到 `work/`，旧版本进 `.trash/`。`artifact-cleanup.cjs` 负责保留代数。启动时 `resumeInterruptedPipelines` 恢复中断运行，运行期用 `powerSaveBlocker` 阻止休眠。

### 2.4 Python 沙箱（原 TODO_SANDBOX）

黑名单正则 + `open`/`chdir` patch + `environ.clear()` + `-I` 隔离模式，已有的 watchdog 与 taskkill 保留。新增 `electron/job-limits.cjs`（Job Object 限制内存 4 GB、CPU 30 分钟、进程数 8，随主进程退出清理进程树），`runtime/guard/scan.py`（执行前 AST 静态扫描）与 `runtime/guard/sandbox_entry.py`（强制断网，由 `pythonSandbox.allowNetwork` 控制）。

### 2.5 费用护栏（原 TODO_BUDGET）

`electron/pricing.cjs` 内置价目表并支持覆盖；`supervisor.cjs` 里 `ensureSpend` / `assertBudget` / `accumulateSpend` 在每次调用前后校验与累加；超限抛 `BUDGET_EXCEEDED` 并归为配置类错误不重试；`usage.updated` 事件经 `public-events.cjs` 脱敏成 `usage-progress` 推给界面，状态栏实时显示 token 与费用；运行前有费用预估弹窗。

### 2.6 诊断包（原 TODO_DIAGNOSTICS）

`electron/diagnostics.cjs` 生成脱敏诊断 ZIP，带 supportCode，入口在设置弹窗，仅用户主动导出，不做自动上报。

### 2.7 更新链路的代码侧（原 TODO_UPDATE）

`electron/updater.cjs` 封装 `electron-updater`；`electron/component-manager.cjs` 管理 runtime 组件（python / tectonic）的清单校验与增量更新；`scripts/sign-runtime-manifest.cjs`、`verify-runtime.cjs`、`verify-package.cjs`、`verify-installer.cjs`、`smoke-package.cjs` 组成发布校验链；`build-modular-installer.cjs` 产出分体安装包。

### 2.8 官方托管模式（TODO_HOSTED，本轮新增）

链路：

```
客户端 → 注入网关 :8788 → 自部署 sub2api :8080 → 第三方中转 → 上游模型
         └ 展开提示词占位符        └ 用户体系 / Token 计费 / 限流 / 充值
```

| 能力 | 位置 |
|---|---|
| `mode` / `tiers` 配置项 | `electron/runtime-config.cjs` |
| 托管连接由服务端目录重建，本地填写不参与托管链路 | `applyHostedCatalog` |
| 凭据 safeStorage 加密 + 稳定设备 ID | `electron/hosted/session.cjs` |
| 登录 / 短期令牌续签 / 档位目录 / 余额 / 充值 | `electron/hosted/client.cjs` |
| 定长提示词占位符 | `electron/hosted/playbook-ref.cjs` |
| 托管分支、令牌过期自动重签一次、`402` 错误码 | `electron/main.cjs`、`direct-provider.cjs` |
| SSE 流式重组（含工具调用增量拼接与 usage） | `direct-provider.cjs` |
| 生图优先取 URL、被拒回退 base64、每阶段张数上限 | `image-provider.cjs` |
| 账户 IPC 与充值入口 | `preload.cjs`、`src/components/AccountPanel.jsx` |
| 注入网关 | `gateway/` |
| 托管链路测试 10 例 | `tests/hosted.test.cjs` |

**提示词保密的实现方式**：托管态客户端发出的 system 内容只有一个定长占位符 `@@PB1|analysis....|rw|@@`，用户消息只有一句「开始执行 X 阶段」。真实 playbook 全部在服务端 `gateway/playbooks.cjs`。网关只在请求体头部做一次定长字节替换，不解析整个 body，CPU 开销与 payload 大小无关。上游 API Key 用 AES-GCM 密封在 15 分钟短期令牌里，客户端持有但解不开，无法绕过应用直接使用号池。

---

## 3. 未完成

### 3.1 上线前必须做（阻塞发布）

| 项 | 说明 |
|---|---|
| **Phase 0 上游验证** | 中转商是否支持 tool calling、`stream_options.include_usage`、长上下文、`usage` 回传、gzip 请求体。这些假设目前全部未经真机验证 |
| **sub2api 用户态 API 对齐** | `gateway/sub2api.cjs` 现在是宽松取值加注释，登录 / 用户资料 / API Key 列表的真实路径与字段确认后要收敛成精确映射 |
| **三个配置文件** | `gateway/config.json`、`gateway/playbooks.cjs`、`electron/hosted/endpoints.json`，都有对应的 `.example` 模板且已 gitignore。打包后读不到环境变量，托管地址必须构建期落盘 |
| **代码签名证书** | `package.json` 的 `win` 段只有 `signingHashAlgorithms`，没有证书配置。证书采购是关键路径，1–3 周；杀软误报报备另需 1–4 周 |
| **更新服务器** | `publish.url` 还是占位符 `https://dl.example.com/mmw/${channel}/` |

### 3.2 托管模式的功能缺口

| 项 | 影响 |
|---|---|
| 状态栏余额展示 | 现在只有 token 与本地估算费用，托管态没有余额条 |
| 运行前余额校验 | `runFullPipeline` 只检查了登录与档位可用，没有拿余额做准入判断，用户会在跑到一半时撞上 `402` |
| 服务端权威成本回传 | 网关还没有回传 `X-Cost` / `X-Balance` 响应头，客户端也没解析，托管态费用显示依赖本地估算（已在托管态关闭费用预估弹窗，但状态栏仍走本地价目表） |
| `runSingleStage` 未做托管前置检查 | 单阶段运行时未登录会抛出原始错误而不是友好提示 |
| 生图档位为空的保护 | 若目录里 `imageEnabled` 为真但 `models.image` 为空，会带空模型名发请求 |

### 3.3 网关的生产化缺口

网关目前是功能正确但没有生产加固的最小实现：没有限流、没有准入排队、没有请求日志与指标、没有优雅关闭、设备绑定只在令牌与请求头都带值时才比对。竞赛峰值场景下这些都要补。

### 3.4 界面缺口

更新相关的 IPC 与 preload 接口（`checkForUpdates` / `downloadUpdate` / `installUpdate` / `listComponentUpdates` / `onUpdaterEvent`）都已就绪，但**渲染层没有任何界面消费它们**，用户看不到也点不了更新。这违反了 `AGENTS.md` 里「每个可见命令要么能用要么显式禁用」的约定，属于需要补齐的一块。

---

## 4. 规划与优先级

按依赖与风险排序：

1. **Phase 0 上游验证**。所有托管代码都建立在对中转商能力的假设上，这一步不做，后面的工作量估算都不可信。特别是 tool calling 与流式 usage，如果中转商不支持，`direct-provider.cjs` 的托管分支要改。
2. **补齐 3.1 的配置与证书**。证书是外部依赖、周期最长，越早启动越好，可以先自签开发、证书到位再替换。
3. **托管余额闭环**（3.2）。网关回传权威成本 → 客户端解析 → 状态栏显示 → 运行前准入。这条链打通后本地价目表在托管态就可以彻底停用。
4. **网关生产化**（3.3）。限流与准入排队优先，因为竞赛峰值下这是唯一能保护上游账号的手段。返回 `429` 带 `Retry-After`，客户端据此做排队 UX。
5. **更新界面**（3.4）。
6. **带宽方案落地**（见下）。

### 竞赛峰值的真实瓶颈

不是服务器硬件，而是这四项：上游账号并发槽位、token 吞吐、API 成本、生图通道并发。这是分钟级长任务不是聊天，用户已准备等 30 分钟，所以正确策略是**准入排队加进度可见**，而不是堆容量。

---

## 5. 风险与注意事项

### 5.1 带宽（需要决策）

单次完整运行约 90 万 token，按 3 字节/token 折算约 2.7 MB 出流量。出流量 = 网关转发给中转的请求体 + 回给客户端的响应体。

网关到中转这一段能否 gzip 取决于中转商是否接受压缩请求体，多数不接受，而它恰好是出流量大头，所以不要按压缩后估算。

**6 Mbps 固定带宽的实际上限是 350–500 个并发运行**，撑不住 1000 人。两个选择：把机器带宽改成按流量计费（81 GB/月约 ¥65），或把注入层挪到腾讯云 EdgeOne 边缘函数（国内节点，按量约 ¥20/月）。前者改动最小。

另外，安装包分发才是真正的带宽大头（150 MB × 5000 次 = 750 GB/版本），必须走对象存储加 CDN，绝对不能走自有 origin。

### 5.2 提示词保密的边界

`runtime.bin` 加密只提高静态提取成本。`electron.net.fetch` 走 Chromium 网络栈，遵循系统代理与系统根证书库，用户装 mitmproxy 加导入根证书就能完整导出客户端发出的一切。**只要提示词在客户端组装，就一定可被提取**，这就是为什么托管态必须走服务端注入。byok 模式下 `playbooks.cjs` 仍在客户端，这部分内容视为公开。

### 5.3 容易踩的坑

- **不要在 `normalizeSettings` 里做模式隔离**。本轮踩过：我曾在归一化阶段清空托管态的连接字段，结果配置期的模型查询和保存也被一起清掉，Electron QA 直接失败。隔离必须发生在使用点，也就是 `applyHostedCatalog`，它完全按服务端目录重建三类连接，本地填写不参与。
- **`.settings-connection-tabs` 这个选择器被 QA 断言依赖**。新增导航时用新类名，不要复用，否则 `tabs.length === 3` 会挂。
- **`rename` 的原子性依赖同卷**。跨卷会退化成 copy + delete，不再原子。staging 目录必须和 `work/` 在同一分区。
- **`BUDGET_EXCEEDED` 必须归为配置类错误**，否则会触发重试，在超预算的情况下继续烧钱。
- **占位符是定长的**。`playbook-ref.cjs` 里 `PLACEHOLDER_LENGTH` 由 `playbookPlaceholder` 自身推导，客户端与 `gateway/server.cjs` 共用同一个模块，改格式时两边会一起变，但部署时要确认网关侧用的是同一份文件。
- **中转商可能拒绝 `stream_options`**。代码对缺失 usage 是容忍的（记为 0），但那样计费会失真，Phase 0 要验。

### 5.4 文档现状

`TODO_*.md` 是当初的实施方案，其中 BUDGET / DIAGNOSTICS / MULTIPROJECT / RECOVERY / SANDBOX / UPDATE 六份的代码侧**基本都已实现，但文档没回写状态**，读的时候不要被「未完成」误导，以本文件第 2 节和源码为准。`TODO_HOSTED.md` 第 0 节是最新的，其余章节里关于 Cloudflare Worker 的方案已作废（上游中转和用户都在国内，走境外边缘等于穿墙两次）。

---

## 6. 验收基线

当前状态：`npm test` 81 例全过，`npm run qa:electron` 退出码 0，其中设置弹窗断言包含 `twoModeTabs`、`hostedPanelVisible`、`threeConnectionTabs`、`fitsViewport`。接手后第一件事是复现这两条基线，再开始改动。
