# Claim-Evidence Map

Evidence types:

- `numeric`: YAML or JSON path plus value and tolerance.
- `figure`: accepted figure ID and source-data contract.
- `citation`: verified literature evidence ID.
- `derivation`: analysis or model-contract section containing the derivation.
- `limitation`: validation finding or explicit data constraint.

Each central claim records its paper section, supporting evidence IDs, permitted wording strength, and known boundary. Claims without sufficient evidence are removed, weakened, or sent upstream.

Prose review order: scientific correctness, section purpose, paragraph logic, claim-evidence-boundary alignment, then sentence clarity. Polishing must expose weak reasoning rather than hide it.

