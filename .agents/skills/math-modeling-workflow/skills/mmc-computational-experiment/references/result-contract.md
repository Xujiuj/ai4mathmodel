# Result Contract

Each `results.yaml` contains:

- `schema_version` and `subproblem_id`;
- `method_version` and `random_seed` where relevant;
- finite `metrics` with units or unit metadata;
- `parameters` and configuration references;
- `artifacts` pointing to executed source, tables, and derived data;
- `constraints` with measured violations;
- `diagnostics` with evidence paths;
- `status`: accepted, provisional, or failed;
- `deviations` from the approved model contract;
- `claims` containing only result-supported statements.

The aggregate file references these records and must not duplicate values with different rounding or names.

