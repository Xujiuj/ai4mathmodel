# Hosted Model Phase 0 Matrix

Generated: 2026-07-29T03:09:25.957Z

| Candidate | Protocol | Tool calling | Usage returned | X-Cost | X-Balance | Duration |
|---|---|---:|---:|---:|---:|---:|
| hermes-gpt-5.6-sol (gpt-5.6-sol) | openai | PASS | PASS | FAIL | FAIL | 6037 ms |

## Expensive Probes

- hermes-gpt-5.6-sol long context 120000: PASS (9374 ms)
- hermes-gpt-5.6-sol long context 200000: PASS (14358 ms)
- hermes-gpt-5.6-sol concurrency 1: 1/1 passed (3614 ms)
- hermes-gpt-5.6-sol concurrency 2: 2/2 passed (4350 ms)
- hermes-gpt-5.6-sol concurrency 4: 4/4 passed (6703 ms)

## Additional Probe Evidence

- Non-streaming chat completion: PASS (HTTP 200 with non-empty content).
- Gzip-compressed request body: PASS (HTTP 200 with non-empty content).
- Live user contract: PASS for login, profile, dashboard usage, and paginated API keys.
- Eight-turn sticky tool session: PASS (8/8 requests succeeded; database records used one upstream account).
- `X-Cost` / `X-Balance`: not emitted by sub2api. Authoritative billing must query usage records by `x-request-id` after the stream completes.

## Image Generation

| Model | Single request | Concurrency 2 | Concurrency 4 | Result |
|---|---:|---:|---:|---|
| gpt-image-1 | FAIL (HTTP 503; upstream 404) | NOT RUN | NOT RUN | unavailable |
| gpt-image-1.5 | FAIL (HTTP 503) | NOT RUN | NOT RUN | unavailable |
| gpt-image-2 | PASS | 2/2 PASS | 4/4 PASS | verified |

`gpt-image-2` produced 7/7 images across the single and concurrent probes. Database records matched 7/7 requests, each completed in approximately 14.5-17.6 seconds, and no `429` or `Retry-After` response was observed.

## Payment

- The portal route is `/purchase`; `/dashboard/topup` is invalid.
- Hermes reports `payment_enabled: false` and has zero payment types, methods, and packages.
- Payment remains blocked until real provider credentials and packages are configured. The client must expose this as disabled, not as a working recharge command.

## Manual Evidence Still Required

- [ ] 上游是否在 system prompt 前追加或改写内容
- [x] 八轮工具调用是否保持 sticky session
- [x] sub2api 登录、账户、用量与 API Key 接口的真实路径和字段
- [x] 充值入口、支付开关与支付配置现状
- [x] 生图通道并发与限流行为
- [ ] 注入点归属与国内边缘可达性
