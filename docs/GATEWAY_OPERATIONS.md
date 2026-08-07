# Gateway Operations

The gateway protects upstream model capacity with a per-device sliding-window limit and a bounded admission queue. Defaults are 30 model requests per device per 60 seconds, four active upstream streams, 24 waiting requests, and a five-minute queue timeout. Rejections return `429` and `Retry-After`.

Billing queries use a separate limiter and admission queue (30 requests per device per 60 seconds, two concurrent jobs, eight queued jobs by default). Each billing batch is capped at 72 unique request IDs and Sub2API usage lookups are processed with bounded concurrency. Tune `operations.billingRateLimit`, `operations.billingAdmission`, and `sub2api.billingConcurrency` only with corresponding upstream capacity.

Account-level windows are applied in addition to device windows: `operations.accountRateLimit` covers model traffic, `operations.billingAccountRateLimit` covers billing, and `operations.tokenRateLimit` limits access-token issuance. Account API mode keys these windows by the authenticated UID; legacy mode uses a credential-derived key. Rotating `X-Device-Id` therefore cannot reset the account budget or consume additional shared admission capacity.

JSON request bodies have a 15-second total deadline and a five-second inactivity deadline by default. Set `requestBodyTimeoutMs` and `requestBodyInactivityTimeoutMs` in the gateway config when deployment latency requires different bounds; both are clamped to a short operational range. A timed-out upload returns `408` and releases its admission lease.

Hosted login is backed by the separate Account API, which owns application users, password hashes, roles, and sessions. The gateway never exposes its service-owned Sub2API key or an upstream provider credential to the renderer. Login attempts are separately limited by both source address and an HMAC-derived account identity: eight attempts per 15 minutes by default. Set `operations.loginRateLimit.trustProxy` only when a trusted reverse proxy overwrites `X-Forwarded-For`.

Account API mode uses a `PTS` ledger. Starting a pipeline debits 2,000 points once, before the first upstream request. Each claimed upstream request is then settled once at `ceil(actualCostUsd * 7200)` points. A settlement response with `complete: false` means that Sub2API has not exposed every requested cost yet; it is not a zero-cost result. The desktop persists those request IDs and retries them after restart and before later hosted work. Actual upstream cost may take a balance below zero, and the next new pipeline is rejected with `402` until an administrator credits the account.

Online payment and self-service top-up remain disabled. Balance changes are administrator ledger adjustments only. Keep the Account API service token and the dedicated Sub2API billing-query account out of client configuration and logs; they belong only in the root-owned gateway configuration.

Successful hosted auth JSON responses (`/auth/login`, `/auth/register`, and `/auth/token`) are marked `Cache-Control: no-store` with `Pragma: no-cache`. Readiness requires a bounded JSON response containing `{ "ok": true }` from Sub2API and the image gateway; an HTTP 200 with `ok: false` is not ready.

## Metrics

Metrics are disabled by default. Set `operations.metrics.enabled` to `true` and configure a separate non-empty `operations.metrics.token`; never reuse a hosted access token. Scrape `operations.metrics.path` (default `/metrics`) with:

```text
Authorization: Bearer <metrics token>
```

The endpoint returns `404` while disabled and `401` without the correct token. Do not publish it through an unauthenticated reverse-proxy route.

The primary signals are:

- `gateway_admission_active` and `gateway_admission_queued`: upstream saturation and wait pressure.
- `gateway_admission_rejections_total{reason=...}`: `rate_limit`, `queue_full`, `queue_timeout`, or cancelled/closing work.
- `gateway_upstream_requests_total` and `gateway_upstream_request_duration_milliseconds`: upstream failures and latency.
- `gateway_http_requests_total` and `gateway_http_request_duration_milliseconds`: gateway request rate, errors, and latency by bounded route/status labels.

No raw device ID, access token, request body, email, or request ID is a metric label. Gateway logs are JSON and include only the generated gateway request ID and an HMAC-derived device identifier.

## Shutdown

`SIGTERM` and `SIGINT` stop new requests, return `503` for normal routes, cancel queued admissions, and allow active streams to finish for `shutdownGraceMs` (30 seconds by default). After that deadline the gateway aborts remaining streams and sockets. `/health` returns `503` while draining.

## First Response

1. Is `gateway_admission_active` at its configured maximum, and is `gateway_admission_queued` growing? Increase capacity only after confirming the upstream account and bandwidth can support it.
2. Is `gateway_admission_rejections_total` dominated by `rate_limit`, `queue_full`, `queue_timeout`, or upstream-related failures? Rate-limit events indicate per-device pressure; queue events indicate shared capacity saturation.
3. Are upstream duration histogram buckets shifting upward or are upstream `5xx` responses increasing? Check the Sub2API health route and upstream provider status before changing gateway limits.

For a planned restart, remove the instance from the load balancer first, send `SIGTERM`, wait for the configured grace period plus a small margin, then confirm the process exits. Do not use an unauthenticated metrics endpoint as a readiness probe.
