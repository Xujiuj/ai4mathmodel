# Hosted Model Phase 0 Matrix

Generated: 2026-07-29T02:46:19.567Z

| Candidate | Protocol | Tool calling | Usage returned | X-Cost | X-Balance | Duration |
|---|---|---:|---:|---:|---:|---:|
| hermes-gpt-5.6-sol (gpt-5.6-sol) | openai | PASS | PASS | FAIL | FAIL | 3767 ms |

## Expensive Probes

Not run. Re-run with `--include-expensive` after confirming quota and cost limits.

## Additional Probe Evidence

- Non-streaming chat completion: PASS (HTTP 200 with non-empty content).
- Gzip-compressed request body: PASS (HTTP 200 with non-empty content).
- Live user contract: PASS for login, profile, dashboard usage, and paginated API keys.
- `X-Cost` / `X-Balance`: not emitted by sub2api; the injection gateway must provide the authoritative headers.

## Manual Evidence Still Required

- [ ] 上游是否在 system prompt 前追加或改写内容
- [ ] 八轮工具调用是否保持 sticky session
- [x] sub2api 登录、账户、用量与 API Key 接口的真实路径和字段
- [ ] 充值流程
- [ ] 生图通道并发与限流行为
- [ ] 注入点归属与国内边缘可达性
