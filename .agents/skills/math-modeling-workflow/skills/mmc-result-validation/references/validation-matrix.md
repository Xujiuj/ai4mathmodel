# Result validation and falsification handbook

## Validation logic

Validation asks whether the evidence supports the exact claim under its declared scope. It is not a list of extra metrics. For each claim, identify the failure it must survive, the test that exposes that failure, a threshold or comparison, and the action on failure.

Always include four layers when applicable:

1. internal correctness: equations, units, constraints, and code agree;
2. empirical adequacy: fit or performance against held-out data or known cases;
3. robustness: conclusions persist under plausible perturbations;
4. decision validity: changes matter in the requested practical decision.

## Family-specific matrix

| Family | Baseline | Diagnostics | Uncertainty/robustness | Reject or revise when |
|---|---|---|---|---|
| regression | mean and simple linear | residual shape, heteroskedasticity, influence, slice error | bootstrap or analytical interval, feature perturbation | residual structure invalidates inference or no baseline gain |
| classification | prevalence and logistic | confusion by threshold/group, calibration, PR under imbalance | bootstrap AUC/PR, threshold sensitivity | poor calibration or gain vanishes on held-out groups |
| time series | last and seasonal naive | residual ACF, rolling errors, drift | horizon intervals, window/season sensitivity | future leakage, coverage failure, no naive gain |
| optimization | feasible greedy and relaxation bound | constraint residual, solver status, gap | RHS/cost scenarios, alternative optima | infeasible/unbounded or recommendation unstable |
| ODE/dynamics | equilibrium/reduced case | conservation, residual trajectory, parameter correlation | profile/bootstrap parameters, step/tolerance sensitivity | non-identifiability or solver-dependent conclusion |
| simulation | analytic/deterministic approximation | warm-up, autocorrelation, replication stability | independent seeds, CI/Monte Carlo error | CI too wide or result changes with warm-up/seed |
| graph/network | simple path/degree rule | components, flow conservation, edge semantics | edge/node perturbation, weight sensitivity | disconnected construction or brittle ranking/path |
| evaluation/ranking | equal weights | indicator redundancy, direction and normalization | weight/normalization perturbation, rank correlation | rank reversal under small plausible choices |
| causal/policy | descriptive association | overlap, balance, pre-trends, placebo | specification and unmeasured-confounding sensitivity | identification assumption contradicted |

## Rival-model challenge

At least one alternative must be capable of explaining the same observation. Compare on the discriminating prediction declared during analysis, not only the primary score. If both models remain plausible, narrow the conclusion and report model uncertainty rather than declaring a winner.

## Sensitivity design

Vary parameters over justified ranges, one-at-a-time only for local interpretation and jointly for interacting uncertainty. Report elasticity or normalized change when units differ. For scenario analysis, include central, favorable, adverse, and at least one structure-breaking scenario. Do not choose ranges solely to make the conclusion stable.

## Sanity and invariance checks

Use known limits, dimensional consistency, monotonicity where theoretically required, conservation, permutation invariance, symmetry, bounds, and small synthetic cases with analytically known answers. A model that passes predictive metrics but violates a hard invariant does not pass.

## Validation report

Record for each subproblem: claim, check ID, rationale, implementation artifact, observed value, expected threshold/comparator, status, and corrective action. Status may be `passed`, `failed`, or `limited`. Failed critical checks route to model design or computation. Limited checks require a narrowed manuscript claim.

Never hide a failed test, average away a weak subgroup, or substitute narrative confidence for quantitative evidence.
