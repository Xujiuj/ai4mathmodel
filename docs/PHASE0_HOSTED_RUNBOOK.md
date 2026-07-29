# Phase 0 托管链路验证手册

Phase 0 的目标是用真实中转与 sub2api 证据决定托管架构。模拟测试只能证明评测器可工作，不能替代本手册的真机结果。

## 1. 准备

1. 复制 `scripts/hosted-eval.config.example.json` 为被 Git 忽略的 `scripts/hosted-eval.config.json`。
2. 为 OpenAI 兼容与 Anthropic 两条候选链填写真实 `baseUrl`、`model` 和 `apiKeyEnv`。
3. 只通过环境变量注入凭据，不把 API Key 写入 JSON、日志或 Markdown。
4. 确认测试账号有明确额度上限，长上下文与并发探测会产生实际费用。

先检查配置，不发出模型请求：

```powershell
npm run eval:hosted:check
```

## 2. 低成本探测

```powershell
npm run eval:hosted
```

默认验证每个候选链路的：

- 工具调用是否完整透传并能完成工具结果回合；
- OpenAI SSE 增量是否能重组，各协议响应是否返回非零 usage；
- `X-Cost`、`X-Balance` 是否由服务端权威回传；
- 总耗时、请求状态与 `Retry-After`/队列位置响应头。

结果写入 `docs/hosted-model-matrix.md`。提交前必须人工检查矩阵，不允许把失败或 `NOT RUN` 改写为通过。

## 3. 高成本探测

确认费用和账号限制后执行：

```powershell
npm run eval:hosted -- --include-expensive
```

该模式按配置执行 120k/200k 长上下文和 1/2/4 并发测试。容量承诺只能使用单账号稳定并发、限流状态和滚动额度的实测值。

## 4. 必须人工取证

以下项目不能仅凭模型响应自动判定：

- 上游是否在我方 system prompt 前追加或改写固定前缀；
- 同一 conversation 连续八轮工具调用是否保持 sticky session；
- sub2api 登录、账户、余额、API Key、订单接口的真实路径与字段；
- 生图通道的实际模型、并发上限和 429 行为；
- 注入点应部署在 sub2api 内、同机网关还是国内边缘函数；
- 国内多地连通性、首 token P50/P95、长请求空闲超时。

取证材料至少包含脱敏请求/响应样本、时间戳、sub2api 后台对应记录和测试账号配置。不得保存密码、完整令牌或上游 API Key。

## 5. 架构冻结门槛

只有以下条件同时满足，才能进入托管余额闭环和生产网关开发：

- OpenAI 与 Anthropic 所需协议均完成工具调用和 usage 验证；
- 120k 真实上下文不被静默截断；
- sub2api 用户态 API 映射已由抓包证据确认；
- 单账号稳定并发、429/529 和冷却策略已有数字；
- 注入点归属已经基于国内链路实测确定。
