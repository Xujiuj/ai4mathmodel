# Experiment recipes and reporting contracts

## Recipe selection

Use the signed `recipe-profile-dataset` resource before modeling tabular inputs. Use
`recipe-modeling-recipes` for reusable computations and checks. Execute recipes through
`run_builtin_recipe`; do not copy their source into project code. Preserve the returned
JSON and execution receipt beside the subproblem that consumes it. A recipe supplies a
deterministic primitive, while the project source must still document problem-specific
units, transformations, equations, and interpretation.

## JSON operation index

Pass `--input <contract.json> --output <result.json>` to the modeling recipe.

| Operation | Required input | Primary output | Reject when |
|---|---|---|---|
| `split_indices` | strategy plus length, groups, time values, or coordinates | disjoint train/test indices and overlap audit | either partition is empty or groups/blocks overlap |
| `ols_fit` | feature matrix and target | coefficients, predictions, rank, condition number, residual metrics | shapes differ or values are non-finite |
| `regression_metrics` | actual and predicted arrays | MAE, RMSE, R2, bias | arrays are empty or incompatible |
| `ahp_weights` | positive reciprocal matrix | weights, lambda max, CI, CR, acceptance | reciprocity or consistency fails |
| `entropy_topsis` | alternative-indicator matrix and directions | weights, normalized matrix, closeness, ranks | direction or dimensions are invalid |
| `gm11_forecast` | at least four positive observations | fitted values, forecast, residual metrics, level-ratio audit | positivity or sample requirements fail |
| `deterministic_kmeans` | finite matrix and cluster count | centers, labels, inertia, convergence | unique rows are fewer than clusters |
| `shortest_path` | weighted edges, source, target | reachability, distance, node path | an edge weight is negative or non-finite |
| `binary_linear_program` | up to 20 binary variables, linear objective, linear constraints | exact optimum or infeasibility, decision vector, zero gap | dimensions/senses are invalid or the exact-baseline limit is exceeded |
| `rolling_origins` | series length, minimum train, horizon | causal train/test slices | the horizon cannot fit |
| `constraint_report` | values and declared bounds/equalities | feasibility and maximum residual | dimensions are inconsistent |
| `monte_carlo_summary` | finite samples | MC standard error and quantiles | fewer than two samples exist |
| `markov_diagnostics` | transition matrix | row-sum and nonnegativity audit | matrix is not square |

For `split_indices`, use `group` for repeated entities, `time` for forecasting,
`spatial` for autocorrelated coordinates, and `iid` only when observations are genuinely
exchangeable. Fit every learned preprocessing step on the returned training indices.

## Prediction experiment

Persist one row per observation with stable row ID, split/fold, actual, prediction, residual, group, and forecast horizon where applicable. Persist a separate metrics record with baseline and primary values. For probabilities, include threshold and calibration bins.

Minimum comparisons:

- regression: mean/median or domain constant plus interpretable linear baseline;
- classification: prevalence/majority plus logistic baseline;
- time series: last and seasonal naive;
- spatial/grouped data: the same model evaluated under random and blocked/grouped splits to expose leakage.

Bootstrap the independent unit, not arbitrary rows. In repeated measures, resample entities. In time series, use block/bootstrap methods only when their assumptions are acceptable.

## Evaluation/ranking experiment

Persist the directed and normalized indicator matrix, weight vector, contribution matrix, score/rank table, and sensitivity runs. Include equal weights. Draw alternative weight vectors on the simplex or perturb the declared weights, then report winner frequency and rank-correlation distribution.

## Optimization experiment

Persist variables, objective components, all constraint residuals, solver status, bound/gap, runtime, and scenario parameters. Recompute feasibility independently. For heuristics persist every seed/run, convergence history, feasible rate, best/mean/standard deviation, and a comparison with a simple feasible solution and exact small cases.

## Dynamics experiment

Persist parameter values and units, initial/boundary conditions, observation times, solver/method/tolerances, state trajectories, invariant residuals, parameter-fit residuals, and tolerance/step convergence. Separate calibration and validation windows.

## Simulation experiment

Persist configuration, warm-up, run length, seeds, per-replication outputs, confidence intervals, and Monte Carlo error. Inspect running estimates. When rare events drive the decision, report the number of observed tail events and do not trust a nominal percentile with inadequate samples.

## Sensitivity experiment

Use parameter ranges justified by data, literature, or policy. Store base, low, high, and joint scenarios. For scalar output `y` and parameter `p`, normalized local sensitivity may be reported as `(Delta y / y0)/(Delta p / p0)` when denominators are meaningful. Use global or joint scenarios when interactions matter.

## Result-to-paper handoff

Every manuscript-ready quantity needs value, unit, uncertainty, comparator, scope, structured locator, and rounding rule. Every figure needs its source-data extract and generation source. Never recover values from pixels or terminal text.
