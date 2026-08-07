# AI4MathModel

AI4MathModel is a Windows desktop workbench for mathematical-modeling competitions. Users can paste a problem statement, select or drag in a `.txt`/`.md` problem file, or add the other supported problem and data materials before running analysis, modeling, coding, paper writing, and review from one local workspace. Uploading a paper template is optional: when none is supplied, the project receives a competition-profile default for a China or US competition. Projects can target LaTeX or Markdown; Markdown projects still produce synchronized TeX and PDF submission artifacts.

## Model Connection

The application supports two connection modes:

- Hosted mode signs in to the application account service and uses server-managed routing with PTS credit settlement. Self-service top-up and online payment are currently disabled.
- BYOK mode does not require a local model CLI or fixed vendor/model. The coordinator, modeler, coder, writer, and optional image roles can be routed independently. Text connections support OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic Messages, and Ollama. The optional image role uses an OpenAI-compatible image connection. Each connection is configured with:

- Protocol
- Base URL
- API key when required by the upstream service
- Model ID selected from the endpoint or entered manually

The service name is only a local label. Credentials are stored with the operating-system credential protection API and are not committed to this repository.

## Desktop Workflow And Artifacts

Project creation accepts direct problem text and `.txt` or `.md` files without requiring a separate upload step. Additional problem, dataset, and template files can be added from the workbench. The generated default template remains replaceable by an imported competition template.

The workbench keeps analysis, solving, paper, and review outputs in stage-scoped project directories. RunDrawer shows current and historical runs, live stage logs, cancellation, and eligible resume/re-run actions; the project outline, inspector, and paper workspace provide file and paper previews. When the corresponding paper artifact exists, the paper toolbar can export PDF, TeX, Markdown, and DOCX. DOCX is generated from the compiled paper and is exposed only after successful conversion, so its absence is reported rather than silently substituting another format.

## Architecture Scope

The backend adopts relevant AI-provider, orchestration, account, gateway, and PTS-settlement patterns from [MathModelAgent](https://github.com/jihe520/MathModelAgent), while deliberately retaining this project's Electron workbench and stage-oriented interaction model. The reference project's chat/notebook page, public `/modeling` task HTTP API, and WebSocket task surface are intentional non-goals for this desktop product.

The corresponding desktop capabilities are exposed through trusted Electron IPC, stage workspaces, RunDrawer, live logs, cancellation and recovery, file preview, and the paper workspace. This boundary keeps local Python execution, scientific plotting, LaTeX compilation, artifacts, and run history on the workstation instead of introducing a second browser UI or a public task-control service.

## Development Build

Run from this directory:

```bash
npm ci
npm run ensure:electron
npm run dev
npm test
npm run qa:electron
npm run build
```

The clean checkout contains the Electron orchestration sources, protected-runtime builder and lock files, and the integrity-verified generated skill bundle needed to build the application. A Windows distribution still requires the externally supplied, digest-pinned Python/Tectonic runtime plus signing and production configuration secrets described in `HANDOFF.md`.

Electron 43 does not expose a package `postinstall` hook. After a clean install, `npm run ensure:electron` validates the locked package and runs Electron's official checksum-verified `install.js` only when `node_modules/electron/dist` is incomplete. Browser-only `npm run build` does not download Electron; the Electron development, QA, capture, and packaging scripts invoke the ensure step themselves.

The build validates the committed `electron/generated/agent-skills.bundle.json` and compiles its stage-scoped modeling and scientific-figure rules into the protected runtime. It never depends on a directory outside a clean checkout. To refresh the committed bundle intentionally, set `AGENT_SKILLS_ROOT` to the reviewed skill source tree before running `npm run compile:agent-skills`; optional academic plotting can be supplied through `ACADEMIC_PLOTTING_SKILL_ROOT` during that refresh.

## Installation

Download `MathModelingWorkbench-<version>-Installer.zip` from [GitHub Releases](https://github.com/Xujiuj/ai4mathmodel/releases), extract the complete archive without changing its directory structure, and run `MathModelingWorkbench-<version>-Setup.exe`. The adjacent `packages/` directory is required by Setup.

The installer lets users choose whether to install the optional scientific-computing and LaTeX runtimes. When they are not installed, the application can use compatible local Python and LaTeX executables.

Packaged Windows builds expose application and runtime-component updates in Settings. Application updates use only the repository URL plus the signer Subject and SHA-256 certificate thumbprint compiled into `package.json`. Runtime-component manifests come only from the fixed [`runtime-v1` GitHub Release](https://github.com/Xujiuj/ai4mathmodel/releases/tag/runtime-v1) and are verified with the Ed25519 public key compiled into the package; runtime environment variables cannot replace either trust root. Development builds do not install updates. See [docs/RELEASE.md](docs/RELEASE.md) for the signing, health-check, and rollback contract.

## Hosted Service Readiness

Python execution, scientific plotting, paper compilation, project files, and run history stay on the workstation. The hosted service provides account authentication, model relay, and PTS settlement only. The desktop checks the gateway `/ready` route, displays service availability in the account panel, and blocks a hosted pipeline while the Account API/database dependency is unavailable. BYOK work remains independent of that hosted readiness check.

Production packaging requires real hosted endpoints and TLS trust data, server credentials, a signed runtime/component source, and a Windows signing certificate. Placeholder/example configuration is not release-ready; the complete external-input checklist is in [docs/RELEASE.md](docs/RELEASE.md).

## Production Release Prerequisites

A distributable Windows release is not authorized by a passing source test suite alone. The protected release environment must supply and validate all of the following:

- `RUNTIME_BUNDLE_URL` and `RUNTIME_BUNDLE_SHA256` for the reviewed Python/Tectonic runtime bundle.
- `WINDOWS_SIGNING_CERT_B64`, `WINDOWS_SIGNING_CERT_PASSWORD`, `WINDOWS_SIGNING_PUBLISHER_NAME`, and `WINDOWS_SIGNING_PUBLISHER_SHA256` for Authenticode signing and updater trust pinning.
- Production `MODELING_HOSTED_GATEWAY`, `MODELING_HOSTED_PORTAL`, and `MODELING_HOSTED_GATEWAY_CERTIFICATE_FINGERPRINT256` values, baked into `electron/hosted/endpoints.json` by the release workflow.
- Production Account API, PostgreSQL, gateway, Sub2API, image-provider, and upstream model credentials, with TLS termination, network binding, backups, and health checks configured as described in the deployment runbooks.
- A signed runtime-component manifest and immutable component archives whose sizes and SHA-256 hashes match the published manifest.

The signer allowlists are intentionally empty in source and are populated only by the protected signed workflow after the certificate Subject and SHA-256 thumbprint match the release secrets. Repository examples, local endpoint files, or staging results do not by themselves prove that these production inputs are approved or operational.

## Staged Release And Rollback

1. Build an unsigned staging candidate from a clean checkout with the digest-pinned runtime and candidate hosted configuration. Run the staging release contract, full tests, Electron QA, packaged-directory verification, and package smoke test. The unsigned artifact is for internal validation only.
2. Create a signed candidate only from an immutable `v<package version>` tag pointing to the workflow commit. Inject and verify the production signer metadata, run the signed release contract, build and verify the modular installer, run installer smoke tests, and exercise the signed install/update plus one real hosted or BYOK workflow before publication.
3. Promote only after Account and Gateway readiness, authentication, billing, model/image probes, local Python/plotting, paper compilation, and all four export paths have been checked. Keep the first rollout observable and stop promotion on new integrity, security, billing, or workflow failures.

Published tags and assets are immutable. Do not replace a failed asset in place: stop promotion and publish a higher patch version containing the revert. Re-run the previous modular installer for workstation recovery. For hosted-service rollback, drain the gateway, restore the previous service and root-owned configuration, then require readiness, login, billing, model, and image smoke checks before reopening traffic. Database migrations are forward/idempotent; use a verified encrypted backup for data recovery instead of improvising a destructive schema rollback. See [docs/RELEASE.md](docs/RELEASE.md) for the exact commands, trust checks, health routes, and recovery contract.

## Release Source Boundary

This repository contains the renderer, Electron orchestration and playbooks, provider adapters, protected-runtime builder and lock data, installer definitions, tests, and the verified generated skill bundle. It intentionally excludes the external Python/Tectonic payload, signing certificate, production credentials and endpoint trust data, generated installers, and user files. Signed Windows distributions are published through GitHub Releases only after the external-runtime, signing, health, and smoke checks in `docs/RELEASE.md` pass.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
