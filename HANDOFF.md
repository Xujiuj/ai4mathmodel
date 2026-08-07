# 交接说明

数模工坊（math-modeling-workbench）：Electron + React 桌面应用，把数学建模竞赛拆成 analysis / solving / paper / review 四个阶段，由主进程里的 agent supervisor 驱动模型完成。项目可选择 LaTeX 或 Markdown 写作；Markdown 模式仍同时生成 TeX 与 PDF 提交工件。

最后更新：2026-08-05。

---

## 本轮真实回归结果（2026-08-04）

- Electron 到 Hermes 的 `gpt-5.6-sol`、`gpt-5.6-terra`、`claude-sonnet-5` 与生图探针均已真实成功；Python、绘图和 LaTeX 始终在本机执行。
- 完整赛题回归运行 `38872bcc-15a0-4079-ac54-3873e753c22f` 未完成：分析阶段在 Quya 上游连续返回 HTTP 502 后暂停。账户 `3` 与备用账户 `5` 使用同一上游凭据，因此备用路径已被真实命中，却不能作为独立高可用来源。
- 本轮已修复并覆盖测试：Windows 产物原子提交在 `EPERM`/`EBUSY` 时进行有限重试；恢复流程不再让中断尝试占用模型路由重试配额。测试数量持续增长，不要把本节的历史结果当作当前发布证明。
- 继续完整回归前，必须先提供或配置独立且健康的 GPT 上游凭据；仅重复运行相同 Quya 凭据不会提高成功率。

## 当前部署边界（2026-08-05，优先于后文历史说明）

本轮已将生产链路收敛为“桌面端执行，Hermes 仅认证和中转”：用户电脑本地运行 Python、生成数据图、编译 LaTeX，并保存全部项目文件、运行记录与论文工件；Hermes 不运行工作台、Python、绘图、LaTeX 或工件存储。

- Hermes 仅保留 `account-api + PostgreSQL`、`sub2api + PostgreSQL + Redis`、`math-model-gateway.service`、回环绑定的 `image-gateway-api.service`、Nginx、Docker 与 SSH。
- 公网只开放 SSH 与 Nginx 的 TLS `:8080`；Nginx 仅代理 `/agent/`。Sub2API、Account API、Image Gateway 与 Math Model Gateway 都只监听回环地址。
- 已停用旧的控制台/企业/Web 服务以及 WARP、打印、mDNS、外设、固件、无线和云任务代理；保留网络、日志、时间同步和控制台恢复服务作为系统基线。
- 应用用户由独立的 `account-api` 注册、登录、角色与会话管理；网关把设备绑定的短令牌换成服务端持有的 Sub2API 密钥。用户不会得到 Sub2API 或上游凭据。
- `PTS` 积分账本和扣费已启用；在线充值与支付回调仍关闭。固定 pipeline 费用、request 归属和实际成本结算均在 Account API 事务内完成。
- TLS 使用 IP SAN 自签名证书，Electron 仅在网关来源与 SHA-256 证书指纹都精确匹配时放行。证书轮换必须同时更新构建期 `electron/hosted/endpoints.json` 的指纹，并运行下方真实探针；禁止在客户端使用忽略证书错误的做法。
- 2026-07-30 已用真实 Electron 探针通过健康检查、注册、短令牌、目录、`gpt-5.6-sol` 小请求和 `gpt-image-2` 请求，均返回成功状态，且未输出凭据。

下面涉及“远程执行”、以 Sub2API 用户身份直接登录、或已启用充值/收费的历史描述，均以本节为准。

## 0. 五分钟上手

```bash
npm install
npm run dev            # vite + electron 并行
npm test               # node:test，纯 CJS，无需 Electron
npm run qa:electron    # 真实 Electron 窗口的自动化验收，产出 electron-qa-result.json 与 settings-modal-800.png
npm run build          # 编译 agent skills + Vite renderer
```

改完代码至少要跑 `npm test`；动了界面必须再跑 `npm run qa:electron`，它会断言设置弹窗、导航、文件预览和响应式布局。

托管中转的真实探针（会创建一个隔离测试账户，并在带参数时消耗极少量模型与图像配额；生产验证结束后应按受控数据库维护流程清理 `gateway-probe-…@example.invalid` 记录）：

```bash
.\node_modules\.bin\electron.cmd scripts\verify-hosted-gateway.cjs --model --image
```

### clean checkout 的发布边界

`electron/main.cjs`、supervisor/playbooks、`scripts/build-protected-runtime.cjs`、runtime lock/requirements、发布边界测试和 `electron/generated/agent-skills.bundle.json` 已是 clean checkout 必须包含的发布源码/生成输入；`.gitignore` 对这些文件明确放行。若 checkout 中缺少它们，应判定源码不完整，不能从工作机的忽略文件临时补齐后宣称可复现。

仓库仍不包含外部 Python/Tectonic 运行时、Windows PFX、生产 endpoint/TLS 信任数据和服务端 secrets。runner 必须下载摘要固定的 runtime bundle，并从受保护 Environment 生成生产配置；这些值不得提交。

`electron/main.cjs` 已超过 2200 行，是整个应用的编排中心：IPC 注册、运行态管理、工具执行器、预算、恢复、更新全在里面。改动前先通读。

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
- **hosted（官方托管）**：连接信息全部来自服务端目录，提示词在服务端注入；`account-api` 管理应用用户、会话与积分账本，Sub2API 仅由服务端密钥中转。积分扣费已启用，在线充值关闭。

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

应用更新使用自定义 GitHub ZIP bridge。`electron/updater.cjs` 只读取 `package.json.releaseUpdate.apiUrl` 指向的 GitHub latest-release API，并要求新版本资产精确命名为 `MathModelingWorkbench-<version>-Installer.zip`。下载过程限制 GitHub HTTPS 主机、重定向次数和大小，并设置请求/单次读取超时；数据流式写入临时文件并校验 GitHub `sha256:` digest。安装前再次校验摘要，限制 ZIP 条目数、单项/总展开体积、压缩比和磁盘余量，拒绝绝对路径、`..`、链接/reparse 点和额外顶层内容；随后校验 Setup、payload manifest、三个组件包的名称/大小/摘要，并要求 Authenticode Subject 与 `releaseUpdate.publisherNames`、证书 SHA-256 指纹与 `releaseUpdate.publisherThumbprints` 同时完全匹配。只有安装器子进程发出 `spawn` 成功事件后应用才退出，异步启动错误会保留当前应用。

更新器现已覆盖总下载 deadline，并在超时时 abort 请求、cancel 活跃 reader；PowerShell 解压与 Authenticode 检查具有进程级 timeout，专用更新目录中的过期 ZIP、`.part` 和 staging 目录会按边界清理。对应超时、取消、清理和并发串行化已有回归测试。

设置弹窗已接入检查、下载、安装并重启事件。`electron/component-manager.cjs` 独立管理 runtime 组件（python / tectonic）的 Ed25519 签名清单、版本检测、受限下载、哈希校验、归档路径校验和原子替换。生产清单源固定为 `https://github.com/Xujiuj/ai4mathmodel/releases/download/runtime-v1`，验签公钥固定在 `package.json.componentUpdate.manifestPublicKey`；`MMW_RUNTIME_UPDATE_URL`、`MMW_MANIFEST_PUBLIC_KEY` 和 `MMW_MANIFEST_PUBLIC_KEY_PATH` 均不能覆盖生产信任配置。正式启用只需向该 GitHub Release 发布匹配的签名清单与摘要固定组件包。`scripts/release-contract.cjs`、`verify-runtime.cjs`、`verify-package.cjs`、`verify-installer.cjs`、`smoke-package.cjs` 与 `smoke-installer.cjs` 组成发布校验链，`build-modular-installer.cjs` 产出分体安装包。

### 2.8 官方托管模式（TODO_HOSTED，本轮新增）

链路：

```
客户端 → Nginx `/agent/` → 注入网关 :8788 → 自部署 sub2api :18080 → 第三方中转 → 上游模型
                              ├ 展开提示词占位符 / 限流 / 准入排队
                              └ Account API :18090（注册、登录、会话、角色）
```

| 能力 | 位置 |
|---|---|
| `mode` / `tiers` 配置项 | `electron/runtime-config.cjs` |
| 托管连接由服务端目录重建，本地填写不参与托管链路 | `applyHostedCatalog` |
| 凭据 safeStorage 加密 + 稳定设备 ID | `electron/hosted/session.cjs` |
| 注册 / 登录 / 设备短令牌 / 档位目录 / 账户信息 | `electron/hosted/client.cjs` |
| 定长提示词占位符 | `electron/hosted/playbook-ref.cjs` |
| 托管分支、令牌过期自动重签一次、身份错误映射 | `electron/main.cjs`、`direct-provider.cjs` |
| SSE 流式重组（含工具调用增量拼接与 usage） | `direct-provider.cjs` |
| 生图优先取 URL、被拒回退 base64、每阶段张数上限 | `image-provider.cjs` |
| 账户 IPC 与关闭状态的充值入口 | `preload.cjs`、`src/components/AccountPanel.jsx` |
| 注入网关 | `gateway/` |
| App 用户身份契约 | `gateway/account-api.cjs`：`/register`、`/login`、`/me`；Sub2API 只使用服务端配置的活跃密钥 |
| 托管链路测试 | `tests/hosted.test.cjs`、`tests/account-api-gateway.test.cjs` |

2026-07-30 Hermes 已完成最小化部署：Sub2API 仅监听 `127.0.0.1:18080`，Account API 仅监听 `127.0.0.1:18090`，Image Gateway 仅监听 `127.0.0.1:8000`，Math Model Gateway 仅监听 `127.0.0.1:8788`。PostgreSQL 与 Redis 不暴露公网；Nginx 是唯一模型入口。`gpt-5.6-sol` 已通过普通对话、tool calling、流式 usage、gzip、12万/20万长上下文、并发 1/2/4 与八轮 sticky session 真机验证。生图仅 `gpt-image-2` 验证可用，并发 2/4 共 7/7 成功；证据见 `docs/hosted-model-matrix.md`。

Account API 模式已启用 `PTS` 积分账本：每条 pipeline 首次固定扣 2,000 分；已 claim 的上游 request 按 `ceil(actualCostUsd × 7200)` 幂等结算并绑定用户与 pipeline。`/billing` 返回 `complete:false` 代表 Sub2API 成本尚未全部可见，桌面端会持久化 request ID 并在重启及后续托管工作前重试。实际成本允许余额暂时为负，之后的新 pipeline 返回 `402`。`/topup` 仍关闭，余额只能由管理员审计调整。

**提示词保密的实现方式**：托管态客户端发出的 system 内容只有一个定长占位符 `@@PB1|analysis....|rw|@@`，用户消息只有一句「开始执行 X 阶段」。真实 playbook 全部在服务端 `gateway/playbooks.cjs`。网关只在请求体头部做一次定长字节替换，不解析整个 body，CPU 开销与 payload 大小无关。服务端持有的 Sub2API 密钥用 AES-GCM 密封在 15 分钟短期令牌里，客户端持有但无法解开，不能绕过应用直接使用该密钥。

---

## 3. 未完成

### 3.1 上线前必须做（阻塞正式发布）

| 项 | 说明 |
|---|---|
| **Phase 0 上游验证（已完成）** | `gpt-5.6-sol` 核心、长上下文、并发与 sticky session 均通过；`gpt-image-2` 是唯一验证可用的生图模型。当前 App 使用 Account API 身份和服务端 Sub2API 密钥中转，不启用支付入口 |
| **构建源码与外部输入** | clean checkout 已包含 `electron/main.cjs`、supervisor/playbooks、protected-runtime builder、runtime lock/requirements 和完整性校验过的生成 skill bundle。runner 仍必须下载摘要固定的 Python/Tectonic runtime，并从受保护 Environment 生成 `electron/hosted/endpoints.json` 与签名元数据；不得从工作机忽略文件补源码 |
| **托管生产配置与密钥** | 构建前写入真实 `electron/hosted/endpoints.json`（HTTPS gateway/portal，以及自签名部署所需的 `gatewayCertificateFingerprint256`）；服务端提供固定摘要的 `POSTGRES_IMAGE`、数据库与管理员凭据、Account API service token、Sub2API service key/计费查询账户、gateway token/key secrets、上游/生图凭据。所有服务端文件保持 root-only，禁止提交仓库 |
| **Windows 签名** | GitHub `production` environment 提供 `WINDOWS_SIGNING_CERT_B64`、`WINDOWS_SIGNING_CERT_PASSWORD`、完整 Subject `WINDOWS_SIGNING_PUBLISHER_NAME` 和小写 64 hex 指纹 `WINDOWS_SIGNING_PUBLISHER_SHA256`。signed workflow 必须先从 PFX 复核二者，再分别烘焙进 `releaseUpdate.publisherNames` 与 `releaseUpdate.publisherThumbprints`；源码数组保持空，禁止填写伪造值。`v<version>` tag 必须指向 workflow commit，签名发布还要完成杀软信誉/误报验证 |
| **应用更新源** | 已固定为 `https://api.github.com/repos/Xujiuj/ai4mathmodel/releases/latest`，生产环境不能覆盖仓库 URL。正式 Release 必须不可变，并包含同版本 `MathModelingWorkbench-<version>-Installer.zip`、GitHub SHA-256 digest 和白名单证书签名的 Setup |
| **更新器运行门禁** | 下载总 deadline/中止、PowerShell 子进程 timeout、更新缓存清理及其回归测试已实现；signed rollout 仍必须通过真实证书、安装/更新、杀软信誉与回滚验证 |
| **runtime 构建包与组件 Release** | `staging`/`signed` runner 需要 `RUNTIME_BUNDLE_URL` 与 `RUNTIME_BUNDLE_SHA256`。组件增量更新不接受 URL/公钥环境覆盖；必须向同仓库固定 `runtime-v1` Release 发布 Ed25519 签名的 `manifest-<app-major>-stable.json` 和 digest 固定的组件包 |

### 3.2 托管模式的收费闭环（积分扣费已启用，在线支付未启用）

| 项 | 影响 |
|---|---|
| 当前身份隔离 | 注册、登录、角色与会话均由 Account API 持久化；设备短令牌绑定到单一用户和设备 |
| 当前模型中转 | 网关使用服务端 Sub2API 密钥，不向客户端暴露上游或 Sub2API 凭据 |
| 当前收费行为 | pipeline 首次固定扣 2,000 分；claim 后的 request 按 7,200 分/USD 向上取整结算；固定费与 request 均幂等 |
| 余额准入 | 上游调用前检查固定费余额；实际成本可使余额为负，后续新 pipeline 返回 `402` |
| 延迟成本 | `complete:false` 的 request ID 进入本机持久队列，启动与后续托管运行前继续结算 |
| 支付状态 | `/topup` 关闭；仅管理员可通过审计账本调整积分，尚无支付回调与在线充值 |
| 生图保护 | 网关强制 `imageEnabled` 与单请求数量上限；托管生图 request 同样 claim 并进入实际成本结算 |

### 3.3 网关生产化（已完成）

`gateway/operations.cjs` 提供按设备的滑动窗口限流（默认 30 次/60 秒）、有界准入队列（默认 4 个活跃上游流、24 个等待、5 分钟超时）、固定标签 Prometheus 指标和 JSON 请求日志。模型请求的拒绝会返回 `429` 和 `Retry-After`；指标默认关闭，启用时必须配置独立 token。`SIGTERM`/`SIGINT` 会停止新工作、取消排队、排空活跃流 30 秒后才强制关闭。运维说明见 `docs/GATEWAY_OPERATIONS.md`。积分扣费已经上线，支付与充值仍保持关闭。

托管账户入口位于侧栏“账户与充值”：用户登录的是自己的 Account API 账户，凭据仅由 Electron 主进程的 `safeStorage` 加密保存；短期访问令牌不经 IPC 进入渲染层。任务启动前执行余额准入与 pipeline 固定扣费，请求完成后按真实上游成本结算。网关对登录接口额外执行来源与账户双维度限流，充值按钮保持禁用。

### 3.4 更新发布外部依赖

设置弹窗已消费 `checkForUpdates` / `downloadUpdate` / `installUpdate` / `listComponentUpdates` / `installComponentUpdate` / `onUpdaterEvent`。应用更新走固定 GitHub ZIP 合同，组件更新走固定 `runtime-v1` 源和包内 Ed25519 信任根。`node scripts/release-contract.cjs --mode staging` 校验全部静态更新合同，任何静态 blocker 都以非零码退出，但不能证明受保护源、托管配置或生产 secrets 已注入；`--mode signed` 还会打开 PFX，要求 Subject、SHA-256 指纹、受保护环境输入和构建内 allowlist 全部精确一致，并校验 runtime bundle 输入。

### 3.5 健康检查与运行门禁

- Account API 的 `/health` 是进程存活，`/health/ready` 会执行数据库查询；Docker healthcheck 使用 readiness，而不是只看端口。
- Math Model Gateway 的 `/health` 是网关存活/排空状态，`/ready` 会继续检查 Account API readiness。经 Nginx 的生产路径分别为 `/agent/health` 与 `/agent/ready`。
- 桌面 Account 面板显示托管服务状态；`/ready` 失败时托管流水线在付费阶段前被阻止，BYOK、本地 Python、绘图和论文编译不依赖该服务。
- 发布后至少验证 Account API readiness、网关公开 readiness、注册/登录、固定费、实际成本延迟结算、一个模型请求、一个生图请求和一条本地论文编译链。用 `X-Request-Id` 对齐网关与 Account API 日志。

---

## 4. 规划与优先级

按依赖与风险排序：

1. **给 clean runner 注入外部发布输入**。源码、protected builder/lock 和校验过的 skill bundle 已在 checkout；runner 仍需下载摘要固定的 Python/Tectonic runtime，并从受保护 Environment 生成托管 endpoints、TLS 信任与签名元数据。
2. **补齐签名与生产信任根**。在受保护 Environment 配置 PFX、Subject 和 SHA-256 指纹，由 signed workflow 校验并烘焙两类 allowlist；同时配置托管 TLS 指纹、Account/Gateway/Sub2API 凭据，并完成 signed contract 与真实探针。
3. **发布同仓库安装资产与 runtime 组件**。应用更新 URL 已固定；需要发布不可变 GitHub ZIP，并向固定 `runtime-v1` Release 发布签名 manifest 与组件包。
4. **带宽方案落地**（见下）。网关已能保护上游并提供容量信号，但不能替代出口带宽和安装包 CDN 的部署决策。

### 竞赛峰值的真实瓶颈

不是服务器硬件，而是这四项：上游账号并发槽位、token 吞吐、API 成本、生图通道并发。这是分钟级长任务不是聊天，用户已准备等 30 分钟，所以正确策略是**准入排队加进度可见**，而不是堆容量。

---

## 5. 风险与注意事项

### 5.1 带宽（需要决策）

单次完整运行约 90 万 token，按 3 字节/token 折算约 2.7 MB 出流量。出流量 = 网关转发给中转的请求体 + 回给客户端的响应体。

网关到中转这一段能否 gzip 取决于中转商是否接受压缩请求体，多数不接受，而它恰好是出流量大头，所以不要按压缩后估算。

**6 Mbps 固定带宽的实际上限是 350–500 个并发运行**，撑不住 1000 人。两个选择：把机器带宽改成按流量计费（81 GB/月约 ¥65），或把注入层挪到腾讯云 EdgeOne 边缘函数（国内节点，按量约 ¥20/月）。前者改动最小。

另外，安装包分发才是真正的带宽大头（150 MB × 5000 次 = 750 GB/版本）。应用安装 ZIP 必须使用当前信任合同允许的 GitHub Releases/CDN，runtime 组件使用独立对象存储加 CDN；两者都不能走 Hermes origin。

### 5.2 提示词保密的边界

`runtime.bin` 加密只提高静态提取成本。`electron.net.fetch` 走 Chromium 网络栈，遵循系统代理与系统根证书库，用户装 mitmproxy 加导入根证书就能完整导出客户端发出的一切。**只要提示词在客户端组装，就一定可被提取**，这就是为什么托管态必须走服务端注入。byok 模式下 `playbooks.cjs` 仍在客户端，这部分内容视为公开。

### 5.3 容易踩的坑

- **不要在 `normalizeSettings` 里做模式隔离**。本轮踩过：我曾在归一化阶段清空托管态的连接字段，结果配置期的模型查询和保存也被一起清掉，Electron QA 直接失败。隔离必须发生在使用点，也就是 `applyHostedCatalog`，它完全按服务端目录重建各角色连接，本地填写不参与。
- **`.settings-connection-tabs` 这个选择器被 QA 断言依赖**。新增导航时用新类名，不要复用；调整模型角色数量时必须同步更新 Electron QA 的角色标签与数量断言。
- **`rename` 的原子性依赖同卷**。跨卷会退化成 copy + delete，不再原子。staging 目录必须和 `work/` 在同一分区。
- **`BUDGET_EXCEEDED` 必须归为配置类错误**，否则会触发重试，在超预算的情况下继续烧钱。
- **占位符是定长的**。`playbook-ref.cjs` 里 `PLACEHOLDER_LENGTH` 由 `playbookPlaceholder` 自身推导，客户端与 `gateway/server.cjs` 共用同一个模块，改格式时两边会一起变，但部署时要确认网关侧用的是同一份文件。
- **不要把权威收费改成响应头**。Account API 的独立账本和幂等事务是唯一收费事实源；SSE 只透传 request ID，不能依赖响应头或共享 Sub2API 使用量推断用户账单。

### 5.4 文档现状

`TODO_*.md` 是当初的实施方案，其中 BUDGET / DIAGNOSTICS / MULTIPROJECT / RECOVERY / SANDBOX / UPDATE 六份的代码侧**基本都已实现，但文档没回写状态**，读的时候不要被「未完成」误导，以本文件第 2 节和源码为准。`TODO_HOSTED.md` 第 0 节是最新的，其余章节里关于 Cloudflare Worker 的方案已作废（上游中转和用户都在国内，走境外边缘等于穿墙两次）。

---

## 6. 验收基线

不要沿用固定测试数量或历史日期作为发布结论。每个候选版本都要重新运行 `npm test`、`npm run qa:electron`、`npm run dist:dir`、`npm run smoke:package`、`npm audit --omit=dev` 和 `node scripts/release-contract.cjs --mode staging`；有完整外部输入时再运行 `npm run dist:win`、`npm run smoke:installer` 与 signed contract。Account API 目录还要单独执行生产依赖审计。

正式上线证据必须同时包含：签名安装包及 publisher Subject/证书 SHA-256 指纹、GitHub Release digest、受保护 runtime 构建、桌面 UI 回归、Account/Gateway readiness、TLS 指纹钉扎、注册登录、PTS 固定费和实际成本结算、模型/生图探针、本地 Python/科研绘图，以及 LaTeX 和 Markdown 双格式论文工件。任一外部凭据或服务未配置时，只能声明代码或 staging 验证完成，不能声明生产发布完成。详细步骤与回滚见 `docs/RELEASE.md`。
