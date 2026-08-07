# Windows Release

The Windows release uses one modular installer contract for first installation and in-app application updates. A release asset is named `MathModelingWorkbench-<version>-Installer.zip`; it contains `MathModelingWorkbench-<version>-Setup.exe`, `payload-manifest.json`, and the digest-pinned packages required by Setup.

## Release Modes

- Pushes to `main` and pull requests run `npm ci`, tests, the renderer/protected-skill build, the production dependency audit, and the staging release contract. These checks intentionally keep the browser-only build free of an Electron binary download.
- Manual `staging` builds an unsigned installer after downloading a SHA-256-pinned runtime bundle. The result is a GitHub Actions artifact for internal validation only and must not be distributed.
- Manual `signed` requires an existing `v<package version>` tag pointing at the workflow commit. It imports the release certificate, signs the Electron executable, launcher, and Setup, runs installer verification, and publishes one immutable GitHub Release asset.

A clean checkout contains the Electron/supervisor and playbook sources, protected-runtime builder and lock files, release-boundary tests, and the integrity-verified generated skill bundle. It does not contain the external Python/Tectonic payload, signing certificate, or deployment-specific endpoint/TLS/credential secrets. The workflow must acquire the digest-pinned runtime bundle and generate production configuration from protected GitHub Environment inputs before `npm run dist:win`; none of those external values may be committed. A passing staging contract alone is therefore not proof that the external inputs are present or that a distributable installer was built.

## Application Update Contract

Packaged Windows builds read the fixed latest-release API in `package.json.releaseUpdate.apiUrl` (`https://api.github.com/repos/Xujiuj/ai4mathmodel/releases/latest`). Runtime environment variables cannot replace the repository URL or signer trust lists. The protected signed workflow is the only place allowed to populate those lists before the package is built.

The updater accepts only a newer, non-draft, non-prerelease semantic version and an exact same-repository asset named `MathModelingWorkbench-<version>-Installer.zip`. It requires the GitHub asset size and `sha256:` digest, restricts requests and redirects to known GitHub HTTPS hosts, bounds metadata/download size, applies request and per-read timeouts, streams to an atomic temporary file under the application's user-data update directory, and verifies the digest again before installation.

Before extraction, the updater bounds archive entry count, per-entry and total expanded size, compression ratio, and required free disk space. It rejects absolute paths, parent traversal, NULs, links/reparse points, paths outside the temporary directory, and unexpected top-level content. After extraction it validates the exact Setup, payload manifest, and core/Python/Tectonic package names, sizes, and hashes. Setup also requires an Authenticode signature whose full certificate Subject matches `package.json.releaseUpdate.publisherNames` and whose SHA-256 certificate thumbprint matches `releaseUpdate.publisherThumbprints`. Both checks must pass. The app quits only after the installer child emits its successful `spawn` event; an asynchronous launch error leaves the current app running. Development and non-Windows builds decline application updates.

The updater now enforces an overall download deadline, aborts the active request and cancels a slow reader, applies process-level timeouts to PowerShell extraction and Authenticode checks, and removes stale ZIP, partial-download, and staging entries only inside its dedicated update directory. Regression tests cover timeout/cancellation, cleanup bounds, operation serialization, and asynchronous installer launch errors. Production rollout still requires a real signed install/update and rollback exercise plus certificate reputation/antivirus validation.

Runtime-component updates are separate. `electron/component-manager.cjs` requests `manifest-<app-major>-stable.json` only from `https://github.com/Xujiuj/ai4mathmodel/releases/download/runtime-v1` and verifies it with the Ed25519 SPKI public key in `package.json.componentUpdate.manifestPublicKey`. `MMW_RUNTIME_UPDATE_URL`, `MMW_MANIFEST_PUBLIC_KEY`, and `MMW_MANIFEST_PUBLIC_KEY_PATH` cannot replace those production defaults. A valid manifest must use HTTPS component URLs and declare byte sizes and SHA-256 hashes; installation also enforces safe archive paths and staged replacement with metadata rollback. The manifest private key remains an offline release secret and is never packaged.

## Production Inputs

Configure the GitHub `production` and `staging` environments as applicable:

- `RUNTIME_BUNDLE_URL`: HTTPS URL of a ZIP containing `python/`, `tectonic/`, `guard/`, and `THIRD_PARTY_NOTICES.txt`.
- `RUNTIME_BUNDLE_SHA256`: exact 64-character digest of that ZIP.
- `WINDOWS_SIGNING_CERT_B64`: base64 PFX payload, required for `signed`.
- `WINDOWS_SIGNING_CERT_PASSWORD`: PFX password, required for `signed`.
- `WINDOWS_SIGNING_PUBLISHER_NAME`: the complete PFX certificate Subject, required for `signed`.
- `WINDOWS_SIGNING_PUBLISHER_SHA256`: the lowercase 64-hex SHA-256 certificate thumbprint, required for `signed`.
- The committed integrity-verified modeling/figure skill bundle. Raw skill sources are needed only for an intentional bundle refresh and are never required by a clean release build.
- A real `electron/hosted/endpoints.json` containing the HTTPS gateway/portal and, for the current self-signed deployment, the normalized SHA-256 certificate fingerprint in `gatewayCertificateFingerprint256`.

The source `releaseUpdate.publisherNames` and `releaseUpdate.publisherThumbprints` arrays intentionally remain empty. For a signed build, the protected workflow opens the PFX, requires its Subject and SHA-256 thumbprint to exactly match the two production Environment inputs, then bakes one value into each allowlist before building. `scripts/release-contract.cjs --mode signed` independently repeats the PFX and baked-metadata checks before signing. Do not commit a guessed Subject or thumbprint. The certificate, runtime bundle, manifest private key, and private source must never be placed in a release asset.

The hosted production environment also requires:

- A digest-pinned `POSTGRES_IMAGE`, random PostgreSQL and bootstrap-admin credentials, and an `ACCOUNT_API_SERVICE_TOKEN` of at least 32 characters in the root-only Account API environment.
- The same Account API service token in the root-owned gateway config, plus a service-owned Sub2API relay key, a dedicated Sub2API billing-query account, generated gateway token/key secrets, and real upstream model/image credentials.
- Nginx TLS as the only public entry point, Account API/Sub2API/Image Gateway/Math Model Gateway bound to loopback or a private Docker network, the immutable GitHub Release ZIP for application updates, and the fixed same-repository `runtime-v1` Release for signed runtime manifests and component archives.

PTS charging is active. The defaults are 2,000 PTS once per pipeline plus `ceil(actualCostUsd * 7200)` for each claimed upstream request. Settlement is idempotent and delayed costs are retried. Online payment and self-service top-up remain disabled; only audited administrator ledger adjustments can add balance.

## Health And Release Verification

The service chain distinguishes liveness from readiness:

```bash
curl --fail http://127.0.0.1:18090/health
curl --fail http://127.0.0.1:18090/health/ready
curl --fail http://127.0.0.1:8788/health
curl --fail http://127.0.0.1:8788/ready
curl --fail --cacert <gateway-ca.pem> https://<gateway-host>:8080/agent/ready
```

Account `/health/ready` performs a live database query. Gateway `/ready` calls Account readiness, so the public `/agent/ready` route represents the hosted authentication dependency as well as the gateway process. Never replace TLS verification with `-k` or a global certificate bypass. The desktop account panel displays this state and blocks a hosted pipeline while readiness is false.

Run from `desktop-app/` for every candidate. `npm ci` does not install Electron 43's binary because that package has no `postinstall`; run the explicit, idempotent ensure step before any Electron command:

```bash
npm ci
npm run ensure:electron
node scripts/release-contract.cjs --mode staging
npm test
npm run qa:electron
npm run dist:dir
npm run smoke:package
npm audit --omit=dev
```

With all production inputs present and the signer allowlists baked into the candidate package, also run `node scripts/release-contract.cjs --mode signed`, `npm run dist:win`, and `npm run smoke:installer`. Audit `deploy/hermes/account-api/` separately with `npm audit --omit=dev`. The signed contract is expected to fail when any signing certificate, password, Subject, SHA-256 thumbprint, baked allowlist, or runtime-bundle input is absent or mismatched.

After deployment, verify the signed install/update path, project reopen, one hosted or BYOK pipeline, local Python and scientific plotting, LaTeX compilation, Markdown/TeX/PDF export, Account and Gateway readiness, registration/login, fixed PTS charging, delayed actual-cost settlement, and model/image probes. Record request IDs so gateway and Account API logs can be correlated.

## Rollback

Published tags and assets are immutable. Never replace an asset under an existing tag. If rollout fails, stop promotion and publish a higher patch version containing the revert; keep the previous release available for manual recovery.

The updater keeps the current app running when Setup emits a launch error and quits after the child confirms process creation. Setup extracts the new core into `app.new`, moves the installed core to `app.backup`, and activates the new core only after extraction succeeds. A failed switch restores `app.backup`; after a successful switch the backup is removed. Re-run the previous modular installer for workstation rollback. Component installation uses a separate staging directory and restores the previous component metadata/content when installation fails.

For a hosted-service rollback, drain the gateway, restore the previous service unit/source and root-owned configuration, then require Account `/health/ready`, Gateway `/ready`, login, billing, model, and image smoke checks before reopening traffic. Account migrations are transactional and forward/idempotent; do not improvise a destructive schema rollback. Restore only from a verified encrypted PostgreSQL backup when data recovery is required.
