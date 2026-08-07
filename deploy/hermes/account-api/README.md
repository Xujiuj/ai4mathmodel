# Hermes account API

This deployment is deliberately separate from `/opt/sub2api`: it owns App registration, roles, sessions, audit events, the active `PTS` ledger, and request-to-user billing ownership. It does not enable online payments or alter Sub2API data.

## Deploy

Copy this directory to `/opt/account-api`, create a root-only `.env` from `.env.example` using random secrets, set `POSTGRES_IMAGE` to a published image reference ending in `@sha256:<64 hex characters>`, then:

```bash
chmod 600 .env
docker compose up -d --build
curl --fail http://127.0.0.1:18090/health
curl --fail http://127.0.0.1:18090/health/ready
```

The bootstrap administrator is created only from `BOOTSTRAP_ADMIN_*` when the email does not already exist. Rotate/remove `BOOTSTRAP_ADMIN_PASSWORD` after provisioning. PostgreSQL has no host port and the containers use a private Docker bridge. Compose explicitly binds the API to all interfaces inside its container so Docker health checks and port forwarding work, while the published host port remains restricted to `127.0.0.1:18090`. A direct Node launch defaults to the loopback-only `ACCOUNT_API_BIND_HOST=127.0.0.1`.

The API applies `schema.sql` inside a transaction before it starts listening. The migration is protected by a PostgreSQL advisory transaction lock and uses idempotent `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` statements, so both empty databases and existing persistent volumes are upgraded on restart. `/health` is liveness; `/health/ready` verifies a live database query and is the container readiness check.

For database URLs outside the private compose network, startup requires an explicit TLS `sslmode` (`require`, `verify-ca`, or preferably `verify-full`); private loopback, RFC1918, `.local`, and `account-postgres` hosts are the only development/compose exceptions. Rate limiting keys use the direct TCP peer by default and ignore `X-Forwarded-For`. Set `ACCOUNT_API_TRUSTED_PROXY_IPS` to a comma-separated allowlist only when a known reverse proxy connects directly; then a single syntactically valid forwarded IP may be used.

After changing either bootstrap or database credentials in `.env`, run `./rotate-secrets.sh` to update the persisted password hashes before restarting the API.

## API

- `POST /register`, `POST /login`, `POST /logout`, `GET /me`
- `GET /admin/users`, `PATCH /admin/users/:id` for an authenticated administrator
- `GET|POST /admin/users/:id/ledger` for audited administrator balance review and adjustment
- `POST /internal/billing/start`, `/internal/billing/claim`, `/internal/billing/settle` for the gateway only

The internal routes require `Authorization: Bearer <ACCOUNT_API_SERVICE_TOKEN>` and never accept an end-user session. Configure the same random token, with at least 32 characters, in the gateway's root-owned `identityProvider.serviceToken` field.

Public registration does not grant PTS by default. `ACCOUNT_API_SIGNUP_GRANT_CREDITS` may enable a one-time grant for an abuse-controlled campaign; each grant uses a unique per-user ledger reference and is recorded as `signup_grant_issued`, while duplicate email inserts and concurrent attempts cannot create a second user or grant. Registration and login enforce both per-identity and per-source attempt windows, and successful authentication clears only the identity bucket so rotating email addresses cannot reset the source limit.

Each pipeline is charged `ACCOUNT_API_FIXED_RUN_CREDITS` once before upstream work. Claimed request IDs are bound to one user and pipeline, and actual Sub2API cost is settled idempotently at `ceil(actualCostUsd * ACCOUNT_API_CREDITS_PER_USD)` points. The default values are 2,000 points per pipeline and 7,200 points per USD. Actual usage may make a balance negative; a later pipeline is blocked until an administrator credits the ledger.

Every state mutation records an audit event. Audit rows are indexed by `created_at`. Retain audit events for at least 365 days; before pruning older rows, create and verify an encrypted PostgreSQL backup (including the audit table) and retain that backup under the organization's backup policy. Schedule daily database backups and test a restore at least quarterly. Passwords use `scrypt` with a unique random salt; session tokens are random, stored only as SHA-256 hashes, and expire after seven days. This API intentionally has no self-service top-up or payment endpoint.

Each response carries an `X-Request-Id`. A supplied ID is accepted only when it is a short printable token; otherwise the API generates a UUID. Structured error logs include that ID, status, and error code only, never authorization headers, secrets, or request bodies. Expired sessions are deleted at startup and by a bounded hourly cleanup task; cleanup failures are logged without interrupting request handling.
