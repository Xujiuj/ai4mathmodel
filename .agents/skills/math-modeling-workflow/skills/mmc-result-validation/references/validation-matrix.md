# Validation Matrix

| Model family | Minimum relevant checks |
| --- | --- |
| Prediction | leakage audit, baseline, out-of-sample error, residuals, calibration or interval coverage |
| Time series | chronological split, naive forecast, residual autocorrelation, rolling evaluation, horizon sensitivity |
| Optimization | feasibility, optimality gap or bound, baseline policy, parameter sensitivity, stress scenario |
| Classification | stratified or temporal evaluation, confusion analysis, calibration, threshold sensitivity |
| Evaluation/ranking | indicator direction, normalization, weight sensitivity, rank stability |
| Simulation | conservation or invariants, convergence, repeated seeds, scenario coverage |
| Causal/statistical | identification assumptions, diagnostics, alternative specification, uncertainty |

Choose only applicable checks, but explain every omission that weakens a central claim.

