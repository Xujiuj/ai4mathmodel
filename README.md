# AI4MathModel

AI4MathModel is a Windows desktop workbench for mathematical-modeling competitions. Users upload the problem materials and paper template, configure their own model endpoint, then run the end-to-end workflow from one workspace.

## Model Connection

The application does not require a local model CLI or a fixed vendor/model. Each reasoning, writing, and optional image connection is configured with:

- Protocol: OpenAI-compatible, Anthropic Messages, or Ollama
- Base URL
- API key when required by the upstream service
- Model ID selected from the endpoint or entered manually

The service name is only a local label. Credentials are stored with the operating-system credential protection API and are not committed to this repository.

## Installation

Download `MathModelingWorkbench-0.1.0-Installer.zip` from the GitHub Release page, extract it without changing its directory structure, and run `MathModelingWorkbench-0.1.0-Setup.exe`.

The installer lets users choose whether to install the optional scientific-computing and LaTeX runtimes. When they are not installed, the application can use compatible local Python and LaTeX executables.

## Public Source Boundary

This public repository contains the renderer, direct-provider adapters, installer definitions, public tests, and build metadata. It intentionally excludes private task-orchestration implementation, internal prompts, local runtime payloads, generated installers, credentials, and user files. The verified Windows distribution is published through GitHub Releases.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
