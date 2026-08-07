# Hermes Math Modeling Gateway

This relay keeps all project files, Python execution, charting, and LaTeX compilation on the desktop application. Hermes only hosts account authentication, model relay, image relay, and TLS reverse proxying.

## Runtime boundary

- `account-api + PostgreSQL` stores application users and sessions.
- `sub2api + PostgreSQL + Redis` relays language-model requests.
- `math-model-gateway.service` validates account sessions, issues device-bound short tokens, applies rate limiting and admission queues, and routes images to the existing Image Gateway.
- `image-gateway-api.service` is loopback-only and never receives desktop credentials.

The gateway source has no third-party Node dependencies. `math-model-gateway.service` must bind only to `127.0.0.1:8788`; Nginx is the sole public entry point. Gateway startup rejects every non-loopback `host` value, including wildcard binds such as `0.0.0.0` and `::`.

## TLS and client pinning

The current Hermes deployment uses an IP SAN self-signed certificate on Nginx `:8080`. Electron accepts it only through the default session verifier when both the configured gateway host and the SHA-256 certificate fingerprint match. Normal CA-trusted certificates continue to use Chromium's standard verification path.

On a certificate rotation, update the ignored build-time `electron/hosted/endpoints.json` fingerprint before packaging the desktop app, then run `scripts/verify-hosted-gateway.cjs --model --image`. The probe creates an isolated `gateway-probe-...@example.invalid` account; remove it through the controlled Account API database maintenance procedure after recording the result. Never use a global certificate bypass, `--ignore-certificate-errors`, or an unpinned HTTP endpoint for desktop credentials.

## Server-only configuration

Create `/etc/math-model-gateway/config.json` with mode `account-api`, the shared Account API service token, a service-owned Sub2API relay key, a dedicated Sub2API billing-query account, generated `tokenSecret` and `keySecret`, and the loopback URLs for Sub2API, Account API, and Image Gateway. Use file mode `640`, owned by `root:mathgateway`.

`provision-config.cjs` requires `PUBLIC_BASE_URL`, `ACCOUNT_API_SERVICE_TOKEN`, `SUB2API_BILLING_EMAIL`, and `SUB2API_BILLING_PASSWORD` in its process environment. Set `PUBLIC_BASE_URL` to the complete public gateway prefix, for example `https://gateway.example.com/agent`; an origin-only URL or another path is rejected because it would make desktop requests bypass the Nginx `/agent/` route and return 404. The Account API and gateway must receive the same service token. The billing account needs read access to Sub2API usage records but must not be reused as an end-user desktop account.

Do not put provider keys, user project files, LaTeX artifacts, or Python code on Hermes. PTS ledger charging is active; online payment and self-service top-up remain disabled.

## Deployment

1. Copy `gateway/` and `electron/hosted/playbook-ref.cjs` to `/opt/math-model-gateway`.
2. Create the `mathgateway` system user and root-owned configuration directory.
3. Install and enable `math-model-gateway.service`.
4. Bind `image-gateway-api.service` to `127.0.0.1:8000`.
5. Put the Nginx template behind HTTPS and route only `/agent/` to the loopback gateway. Keep the trailing slash on `proxy_pass http://127.0.0.1:8788/`; Nginx then strips `/agent/` before forwarding the gateway's root routes. Bake the same `https://host/agent` base into the desktop endpoint configuration. For a self-signed certificate, also bake its SHA-256 fingerprint.
6. Verify `/agent/health`, registration/login, device-token issuance, fixed pipeline charging, delayed actual-cost settlement, chat relay, and image relay before disabling legacy services.

The configuration and certificate values are intentionally absent from this repository.
