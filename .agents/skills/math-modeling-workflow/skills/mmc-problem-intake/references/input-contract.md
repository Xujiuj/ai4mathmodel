# Input Contract

`subproblems.yaml` must contain `schema_version` and a `subproblems` list. Each item contains:

- `id`: stable lowercase identifier.
- `question`: exact requested outcome.
- `inputs`: existing project-relative paths.
- `outputs`: declared project-relative result paths.
- `depends_on`: earlier subproblem IDs only.
- `objective`: measurable objective or decision target.
- `constraints`: explicit and inferred constraints, labeled separately.
- `evaluation`: success metrics and required checks.
- `uncertainties`: unresolved definitions or data limitations.

`data_profile.yaml` records every input table's encoding, shape, fields, types, units, missingness, duplicates, time coverage, and join keys.

