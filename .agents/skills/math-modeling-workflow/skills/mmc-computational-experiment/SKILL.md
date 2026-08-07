---
name: mmc-computational-experiment
description: Implement and execute reproducible mathematical-modeling experiments from an approved model contract. Use for data preparation, subproblem solving, code reflection, structured result persistence, and computational provenance.
---

# Computational Experiment

Produce real, reproducible results for each approved subproblem.

## Execution discipline

- Call `list_skill_resources` for the active stage and problem family before writing custom utilities.
- Run `recipe-profile-dataset` during analysis or solving before selecting columns, splits, or preprocessing.
- Run `recipe-modeling-recipes` for its supported deterministic operation before reimplementing it; persist the JSON output and execution receipt.
- Treat a built-in recipe as a checked primitive, not as evidence that the surrounding model choice is valid.
- Read the intake, model, and validation contracts before coding.
- Implement subproblems in dependency order and keep their stable IDs.
- Use one validated data-loading path; never overwrite raw inputs.
- Fit preprocessing only on permitted training data and prevent temporal or target leakage.
- Fix random seeds when stochastic behavior is not itself under study.
- Record software versions, parameters, units, sample ranges, and hardware-sensitive settings.
- Run small sanity checks before full experiments.
- Execute code immediately after each coherent step; do not treat unexecuted code as evidence.
- On failure, diagnose the actual exception, revise minimally, and rerun the failed step.
- Compare outputs with analytical bounds, known cases, or a simple baseline.

## Persistence

- Store each subproblem under `work/02_solving/sub_problem_<n>/`.
- Preserve the minimal source and configuration needed to reproduce accepted outputs.
- Write machine-readable metrics, tables, diagnostics, and artifact paths to `results.yaml`.
- Keep intermediate values only when they support reproducibility, validation, or later figures.
- Build `aggregate_results.yaml` by reading accepted per-problem result files.
- Never copy values manually between code, result files, charts, and prose.

## Required artifacts

- Executed `.py`, `.ipynb`, `.r`, or `.m` source for every subproblem.
- One `results.yaml` per stable subproblem ID.
- `work/02_solving/aggregate_results.yaml` with exact result references.
- `work/02_solving/environment.yaml` with `schema_version`, a runtime name/version record, and dependency name/version records.
- Reusable derived data required for validation or plotting.

## Acceptance criteria

- Every reported number comes from an executed artifact.
- Results are finite, units are consistent, and constraints are checked.
- Re-running from declared inputs reproduces values within stated tolerance.
- Failures and method deviations are explicit rather than hidden.

Read [references/result-contract.md](references/result-contract.md) for result fields and
[references/experiment-recipes.md](references/experiment-recipes.md) for operation contracts.
