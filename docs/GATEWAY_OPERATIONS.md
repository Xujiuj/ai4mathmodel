# Gateway Operations

The gateway protects upstream model capacity with a per-device sliding-window limit and a bounded admission queue. Defaults are 30 model requests per device per 60 seconds, four active upstream streams, 24 waiting requests, and a five-minute queue timeout. Rejections return `429` and `Retry-After`.

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
