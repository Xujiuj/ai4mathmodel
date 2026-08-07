# Formula and algorithm cards

Each card is an implementation contract. Replace symbols with problem-specific names and units before coding.

## Weighted evaluation card

Inputs: alternative-by-indicator matrix, indicator directions, weights or weight procedure.

Procedure:

1. Audit constant, missing, and redundant indicators.
2. Orient and normalize each column.
3. Derive weights and verify they sum to one.
4. Compute scores/ranks with equal-weight and selected methods.
5. Perturb weights on the simplex and repeat alternative normalizations.
6. Report rank correlation, top-choice frequency, and indicator contribution.

Failure: the winner changes under small plausible perturbations. Response: report a set of competitive alternatives or collect preference evidence.

## Supervised prediction card

Inputs: rows available at decision time, target, grouping/time structure, loss.

Procedure:

1. Freeze test data and split indices before preprocessing.
2. Fit cleaning/encoding/scaling inside training folds.
3. Run trivial and interpretable baselines.
4. Tune the primary model inside validation only.
5. Evaluate once on test data with uncertainty.
6. Inspect residual/calibration, subgroups, and extrapolation support.
7. Persist predictions, fold assignments, parameters, and metrics.

Failure: leakage, no baseline gain, poor calibration, unstable group errors, or invalid extrapolation. Response: repair split/features or narrow the claim.

## Forecasting card

Let forecast origins be `t_1,...,t_K` and horizons `h=1,...,H`. Train on observations no later than each origin and score `y_(t_k+h)` against `yhat_(t_k+h|t_k)`. Aggregate errors by horizon before averaging across horizons.

Required outputs: fold-origin table, horizon MAE/RMSE, naive-relative error, interval coverage/width, residual ACF, and final forecast with uncertainty.

## Constrained optimization card

Write `min/max f(x;theta)` subject to `g(x;theta)<=0`, `h(x;theta)=0`, and domain `x in X`. Before solving:

1. construct or prove existence of a feasible point;
2. scale coefficients and variables;
3. test a tiny instance;
4. declare solver tolerances and limits.

After solving, recompute every constraint independently from returned `x`, not from solver messages. Report maximum violation, integrality violation, objective recomputation, bound/gap, and comparison with baseline.

## Pareto card

Compute single-objective extrema to establish scales. Generate nondominated candidates with epsilon constraints or a justified search. Remove duplicates and dominated points using consistent tolerances. Present objective-space tradeoffs and select a recommendation only after applying explicit preference or robustness criteria.

## ODE card

Define `dx/dt = F(t,x,theta,u)` and observation `y=H(x)+epsilon`. Check units term by term. Fit only identifiable parameter combinations. Compare at least two solver tolerances and, if stiffness is suspected, explicit versus stiff methods. Validate invariants and held-out dynamics.

## Monte Carlo card

For quantity `q=T(theta,epsilon)`, sample from justified joint uncertainty, preserve dependence, and compute running estimates. Stop when the Monte Carlo standard error or decision probability is below a declared tolerance. Report seed policy, draws, convergence trace, quantiles, and tail probability.

## Graph card

Construct `G=(V,E,w)` from explicit entity and relation rules. Validate duplicate/self edges, direction, weight sign, components, and temporal scope. Select algorithm only after these facts are known. Test invariance to node ordering and sensitivity to plausible edge perturbations.

## Claim boundary card

Translate outputs into the strongest allowed statement:

- association model -> association within sampled domain;
- predictive test -> expected predictive performance under matched deployment conditions;
- identified causal design -> effect under named assumptions;
- optimization -> best solution for the declared objective, constraints, data, and solver guarantee;
- simulation -> behavior of the encoded mechanism under specified scenarios.

Any stronger wording fails review.
