# Computational experiment handbook

## Execution order

For each subproblem, execute `profile -> clean -> baseline -> primary model -> diagnostics -> sensitivity/stress -> persist`. Run subproblems in dependency order. A result contract is valid only after its producing code completed successfully.

## Reproducible data preparation

Use one controlled loader for raw data. Preserve original files. Record encoding, parsed types, units, time index, entity key, join cardinality, missing-value policy, outlier policy, and rows affected. Fit imputation, scaling, feature selection, dimensionality reduction, and target encoding on training data only.

Choose the split from the data structure:

- IID prediction: stratified or grouped holdout as appropriate;
- repeated entities: group split so an entity does not cross train and test;
- time series: rolling or expanding origin with no future information;
- spatial data: blocked spatial validation when local dependence matters;
- policy/causal analysis: design-specific comparison before outcome modeling.

## Exploratory analysis

Freeze descriptive observations before interpretation. Quantify distributions, missingness, dependence, temporal or spatial structure, group imbalance, and possible leakage. Separate data-quality facts from domain hypotheses. EDA must influence the model contract; ornamental charts are not enough.

## Experiment ledger

Every run records subproblem ID, timestamp, code artifact, input hashes, seed, library/runtime versions, preprocessing parameters, model/solver configuration, split or scenarios, elapsed time, warnings, exit status, and output paths. Do not overwrite a successful run with an undocumented rerun.

## Family-specific execution minimums

| Family | Required execution evidence |
|---|---|
| regression/classification | baseline, leakage-safe split, selected metric, calibration or residual analysis, group/slice errors |
| time series | naive baselines, rolling-origin folds, horizon-specific error, residual autocorrelation, interval coverage |
| optimization | feasible baseline, solver status, objective, constraint residuals, bound/gap if available, parameter scenarios |
| ODE/state model | parameter method, initial conditions, solver tolerance, conservation/bound checks, step/tolerance convergence |
| simulation | warm-up rule, independent seeds, replication count, confidence interval or Monte Carlo error |
| network | graph construction rules, connectivity/components, conservation where relevant, perturbation test |
| evaluation/ranking | normalization and direction, weight method, equal-weight baseline, rank stability |

## Results contract

Store reportable quantities in structured YAML/JSON rather than extracting them from logs or images. Each subproblem record contains:

```yaml
schema_version: 1
subproblem_id: sp-1
metrics:
  primary_metric: 0.0
artifacts:
  - work/02_solving/sub_problem_1/solver.py
  - work/02_solving/sub_problem_1/results.yaml
validation:
  status: passed
  method: "specific test actually run"
  summary: "quantitative baseline, error, and robustness result"
evidence:
  - claim: "bounded result claim"
    artifact: work/02_solving/sub_problem_1/results.yaml
    locator: metrics.primary_metric
```

Metrics must be finite, units must be declared where applicable, and locators must resolve to the stored value. Figures and tables derive from the same persisted result data; never edit plotted values manually.

## Numerical hygiene

Check NaN/Inf, scale disparity, unit conversion, deterministic sorting, random seeds, boundary cases, and convergence. Report uncertainty and meaningful precision. A very small metric is not automatically good; compare it to baseline, natural scale, and decision consequence.

Exit only when every requested subproblem has executed code, a valid result record, a baseline comparison, an appropriate diagnostic, and an aggregate entry in original subproblem order.
