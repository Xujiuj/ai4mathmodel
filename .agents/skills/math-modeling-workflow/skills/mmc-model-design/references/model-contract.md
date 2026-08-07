# Model selection and mathematical contract handbook

## Route by problem structure

Choose from the decision target, data-generating structure, and validation opportunity. Do not select a model because it is fashionable.

| Structure | Candidate families | Minimum baseline | Critical diagnostic |
|---|---|---|---|
| scalar/tabular prediction | regularized GLM, trees, boosting, calibrated classifier | mean/rate, linear or logistic model | leakage-safe holdout, calibration, residual slices |
| ordered time series | seasonal naive, ETS/ARIMA, state space, feature regression | last value and seasonal naive | rolling-origin error, residual autocorrelation |
| ranking/evaluation | normalized indicators, entropy/CRITIC weights, PCA, outranking | equal weights and one-indicator ranking | weight and normalization rank stability |
| constrained allocation | LP/MILP, convex program, dynamic programming, heuristic | feasible greedy or relaxed bound | feasibility, optimality gap, shadow/sensitivity analysis |
| routing/network | shortest path, flow, matching, centrality/community methods | simple path/tree or degree baseline | connectivity, conservation, perturbation stability |
| continuous dynamics | ODE/PDE, compartment, state-space, system identification | equilibrium or reduced model | identifiability, conservation, solver convergence |
| stochastic operations | queueing, Monte Carlo, discrete-event or agent simulation | analytic approximation or deterministic scenario | replication error, warm-up and variance diagnostics |
| causal/policy question | randomized contrast if available, matching/weighting, panel or quasi-experiment | descriptive association | overlap, pre-trends, negative controls, sensitivity |
| multi-objective decision | weighted/epsilon constraint, Pareto search, goal programming | single-objective extremes | Pareto dominance and preference sensitivity |

Use hybrid models only when each component has a distinct role and the interface can be validated. Complexity without a discriminating gain is a liability.

## Candidate comparison

Score at least two credible families on applicability, assumptions, identifiability, interpretability, computational cost, data demand, uncertainty support, and strength of available validation. Reject a method when a critical assumption is contradicted or cannot be tested. A simple baseline is mandatory.

## Claim and hypothesis design

For each central modeling claim write:

- observation: what the input directly shows;
- main hypothesis or mechanism;
- rival explanation;
- prediction unique enough to distinguish them;
- test statistic or diagnostic;
- falsification condition;
- consequence if falsified.

Do not turn correlation into mechanism. Predictive accuracy supports predictive claims, not causal effects. Optimization output is conditional on the objective, constraints, and parameter assumptions.

## Mathematical specification

Define sets, indices, parameters, decision/state variables, domains, and units before equations. Then specify the relevant objects:

- objective or loss and whether it is minimized or maximized;
- equality/inequality constraints and boundary conditions;
- transition, likelihood, estimator, or update equations;
- initial conditions and parameter estimation method;
- preprocessing fitted on training data only;
- initialization, stopping rule, tolerances, and random seed;
- expected computational complexity;
- uncertainty target and estimation method.

Map every requested answer to an equation or algorithm output. Map every equation to an executable step and a validation check.

## Failure-aware design

Declare failure modes before execution. Examples:

- prediction: leakage, nonstationarity, imbalance, poor calibration, extrapolation;
- optimization: infeasibility, unboundedness, symmetry, numerical scaling, weak relaxation;
- dynamics: non-identifiability, stiffness, unstable discretization, violated conservation;
- simulation: insufficient warm-up, correlated replications, rare-event under-sampling;
- evaluation: rank reversal, arbitrary normalization, double-counted indicators;
- causal: lack of overlap, post-treatment adjustment, failed pre-trends.

For each failure specify a detection signal, a response, and a fallback. Fallbacks must be simpler and testable, not merely a different opaque model.

## Required model contract fields

Each subproblem record must include `subproblem_id`, `claim_type`, `estimand_or_objective`, `candidate_families`, `selected_family`, `baseline`, `variables`, `equations_or_algorithm`, `assumptions`, `identifiability`, `data_interface`, `solver_or_training`, `validation_tests`, `failure_modes`, `fallback`, and `paper_outputs`.

Exit only when another implementer can reproduce the intended computation without guessing a variable, split, metric, tolerance, or success condition.
