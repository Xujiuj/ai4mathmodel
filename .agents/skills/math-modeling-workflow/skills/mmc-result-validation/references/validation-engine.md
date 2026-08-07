# Executable validation engine

`scripts/validate_results.py` is a standard-library checker for the evidence
that follows a modeling run. It never repairs values or silently changes a
claim. It returns one JSON report with a `status` (`passed` or `failed`), a
list of `failures`, and numerical `evidence` for every check. Store the input
and output beside the run so that a reviewer can reproduce the decision.

## Input contract

The command accepts either one object with a `kind` field or
`{"checks": [{"kind": ...}]}`. Run it as:

```text
python scripts/validate_results.py --input validation-input.json --output validation-report.json
python scripts/validate_results.py --self-test
```

The five check kinds are independent and can be mixed in one report.

### Ordered forecasts

Use `actual`, `predicted`, and `origins`. An origin has a `train_end` and
either `horizon` or explicit half-open `test_start`/`test_end` indices. The
validator computes RMSE/MAE per holdout and compares the model with a
last-observation naive forecast (or the supplied full-length `baseline`). A
model must not use a test index before `train_end`, and its mean RMSE must not
be worse than the baseline except for the declared `relative_tolerance`.
This catches leakage hidden by a single random split.

### Constrained optimization

Pass `x`, `objective_value`, and optional `lower`, `upper`,
`equality_residuals`, `inequality_residuals`, `best_known`, and `bound`.
Residuals are interpreted as positive violations; equalities use absolute
residuals. The largest residual must be no greater than `tolerance`. For a
minimization problem a lower bound gives
`max(0, objective - bound) / max(|objective|, 1)`; for maximization use the
mirrored expression. A reported reference solution is also compared with a
relative gap. Feasibility and optimality are separate pieces of evidence.

When a binary linear instance has at most 20 variables, set
`exact_binary_check: true` and provide `objective_coefficients` plus
`linear_constraints`. The validator independently recomputes the objective and
all constraints, enumerates the feasible set, and rejects a merely self-reported
optimum. For larger instances, require an independent bound, solver gap, and a
small projected instance that can be checked exactly.

### ODE/dynamical systems

Pass a sequence of equal-width `states` and either `invariant_values` or
linear `invariant_weights` (the dot product is evaluated at every time point).
The maximum relative drift from the initial invariant is compared with
`tolerance`. Optional `step_runs` contains final states at progressively finer
steps; each successive max-norm difference should decrease. This is a sanity
check, not a substitute for an error estimate from a known solution.

### Monte Carlo and simulation

Pass `samples` and an optional initial `warmup` count. The report includes the
mean, standard deviation, lag-one autocorrelation, effective sample size,
i.i.d. MCSE, and autocorrelation-adjusted MCSE. `mcse_target` is a relative
target (default 0.05). A nonzero warm-up is compared with the full-chain mean;
the allowed shift is `warmup_tolerance * max(stdev, |mean|, 1)`. Set
`batch_size` to obtain an independent batch-means MCSE alongside the lag-one
estimate. A wide or unstable interval should narrow the claim or trigger more
replications rather than being hidden by rounding.

### Evaluation/ranking robustness

Pass a row-by-indicator `matrix`, nonnegative `weights`, `directions`
(`benefit`/`cost`), and the actual `method` (`weighted_sum` or `topsis`).
Columns are direction-oriented and min-max normalized before the selected method
is rerun. Never validate TOPSIS conclusions with a weighted-sum surrogate.
`perturbations` can change weights and/or directions. The report gives
the baseline order, every perturbed order, top-item changes, and Kendall's
tau. A top-rank reversal or tau below `minimum_kendall` (default 0.8) fails.
When a ranking is intentionally sensitive, retain the failed report and state
the decision is conditional on the weighting choice.

## Review protocol

1. Keep one input object per central result and include the subproblem/claim ID
   in the surrounding artifact metadata.
2. Run the relevant check after computation and before prose polishing.
3. Treat `failed` as a routing signal: leakage and invalid constraints return to
   computation/model design; unstable ranks or MCSE return to assumptions or
   experiment design.
4. Cite the persisted JSON evidence in the manuscript claim-evidence map.
5. Do not convert `failed` to `passed` by increasing a threshold without
   recording the domain justification.

The built-in self-test covers all five kinds and is a smoke test for the local
runtime, not evidence for a user's dataset.
