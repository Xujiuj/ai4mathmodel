# Model family catalog

Use this catalog after the subproblem contract fixes the requested output, observational unit, decision time, constraints, and claim type. Select the smallest family that can represent the mechanism and survive a meaningful test.

## 1. Evaluation and ranking

### Direction and normalization

Convert every indicator to “larger is better” before weighting. For a benefit indicator use

`z_ij = (x_ij - min_j)/(max_j - min_j)`.

For a cost indicator use

`z_ij = (max_j - x_ij)/(max_j - min_j)`.

For a target value `a_j`, use a symmetric closeness score such as

`z_ij = 1 - |x_ij-a_j| / max_i |x_ij-a_j|`.

If a column is constant, mark it non-discriminating instead of dividing by zero.

### Entropy weighting

Use when weights should reflect observed dispersion, not importance. With nonnegative normalized values,

`p_ij = z_ij / sum_i z_ij`, `e_j = -k sum_i p_ij ln(p_ij)`, and `w_j = (1-e_j)/sum_j(1-e_j)`.

Replace `0 ln 0` by zero. A high entropy weight means the feature separates alternatives; it does not prove domain importance. Compare with equal weights and one preference-based scheme.

### AHP

Use only when justified expert preferences and a hierarchy exist. Construct reciprocal pairwise matrices, recover the principal-eigenvector weights, and report `CR = CI/RI`, with `CI=(lambda_max-n)/(n-1)`. Reject or revise a matrix when `CR >= 0.1`. Avoid large flat matrices; split a hierarchy before comparisons become cognitively implausible.

### TOPSIS

Use for compensatory ranking by distance to ideal and anti-ideal solutions. After direction unification, vector normalization, and weighting, compute `D_i+`, `D_i-`, and closeness `C_i=D_i-/(D_i+ + D_i-)`. Report rank plus closeness, not a fabricated percentage. Test rank stability under normalization, weights, and removal of correlated indicators.

### PCA or factor reduction

Use when many indicators measure overlapping latent dimensions. Standardize on the analyzed population, inspect explained variance and loadings, retain components by a declared criterion, and orient signs for interpretation. PCA changes the meaning of dimensions; do not present component scores as original indicators.

### Efficiency models

Use DEA only when alternatives are comparable decision-making units with meaningful inputs and outputs. State orientation and returns-to-scale assumption. Check sensitivity to extreme units and leave-one-out removal. An efficiency score is relative to the observed frontier, not absolute performance.

Minimum evidence: equal-weight ranking, correlation/redundancy analysis, rank correlation across plausible specifications, and a table showing which indicators drive each leading alternative.

## 2. Regression and classification

### Interpretable generalized linear models

Use linear, logistic, Poisson, or related GLMs when coefficient interpretation and uncertainty matter and link/distribution assumptions are defensible. Specify the estimand and link. Inspect residuals, influence, nonlinearity, overdispersion, and collinearity. Use ridge for correlated predictors and lasso only when sparse selection is scientifically meaningful.

### Tree ensembles and boosting

Use random forests or gradient boosting for tabular nonlinear interactions with enough independent observations. Tune only inside training folds. Compare against a regularized GLM. Report calibration for probabilities, permutation or SHAP-style explanations with correlation caveats, and errors by decision-relevant groups. Do not extrapolate tree predictions beyond training support without a limitation.

### Classification metrics

Select metrics from the decision cost. For imbalance, include precision-recall and a threshold-specific confusion matrix. Define positive class. Report sensitivity, specificity, precision, and calibration when probabilities drive decisions. Choose the threshold on validation data, then evaluate once on the test set.

### Clustering

Use K-means for approximately spherical scaled clusters, hierarchical methods for nested structure, and density methods for irregular clusters/noise. Select hyperparameters using stability, silhouette-like separation, and domain interpretability. Clusters are descriptive constructs, not discovered causal types.

Minimum evidence: leakage-safe split, trivial and interpretable baselines, resampling uncertainty, calibration or residual diagnostics, and slice performance.

## 3. Time series and forecasting

### Baselines

Always run last-value, drift, and seasonal-naive baselines when applicable. A complex forecaster must beat the correct naive model at the horizons that matter.

### Exponential smoothing and ARIMA

Use exponential smoothing for level/trend/seasonal structure with limited covariates. Use ARIMA after checking stationarity and differencing needs. Select orders using domain constraints plus ACF/PACF and information criteria, then inspect residual autocorrelation. Seasonal periods must come from sampling and mechanism, not automated convenience.

### Dynamic regression and state-space models

Use when external drivers, latent states, missing observations, or time-varying uncertainty matter. All covariates used for forecast evaluation must be known or separately forecast at the decision time. State the transition and observation equations.

### Machine-learning forecasting

Use lag/rolling features with linear models or boosting when multiple covariates and nonlinearities exist. Create all features causally, using only past values. Sequence neural networks require enough independent temporal information and must still beat seasonal-naive and simpler feature models.

### Evaluation

Use rolling or expanding origins. Report error by horizon and scale-aware metrics such as MAE/RMSE plus a relative measure against naive. For intervals, report empirical coverage and width. Check drift and physical bounds.

## 4. Optimization and operations research

### LP, MILP, and convex optimization

Use LP for linear continuous decisions, MILP for integrality/logical choices, and convex programming when convexity can be established. Define all variable domains, objective direction, units, and constraints. Construct a feasible baseline before solving. Report status, objective, constraint residuals, bound/gap, and runtime.

### Dynamic programming

Use when a state summarizes all information needed for future decisions and the transition exhibits optimal substructure. Define state, action, transition, reward/cost, boundary condition, and recursion. Quantify state-space growth and use approximation only with a validation case.

### Network and routing optimization

For shortest paths choose algorithms by weight assumptions. For flow enforce capacity and conservation. For assignment verify row/column coverage. For TSP/VRP prevent subtours and enforce depot, capacity, time-window, and service constraints. Validate on a small case with an exact or enumerated solution.

### Multi-objective optimization

Normalize objectives using meaningful ideal/nadir or single-objective extrema. Use epsilon-constraint or Pareto search when tradeoffs matter; use a weighted sum only when preferences and scaling are defensible. Report dominated points, tradeoff curvature, and recommendation sensitivity to preferences.

### Metaheuristics

Use GA, SA, PSO, or other heuristics only when exact/convex methods are unavailable at the needed scale. Design feasibility-preserving representation or an explicit repair. Run multiple independent seeds, show convergence, compare with a feasible heuristic and small exact instances, and never call the best run globally optimal.

## 5. Dynamics, simulation, and uncertainty

### ODE and compartment models

Define state meaning, units, initial conditions, parameters, inputs, and invariants. Use parameter identifiability checks before fitting. Choose stiff solvers when time scales differ. Compare tolerances/step sizes and verify conservation or boundedness. Validate on held-out time windows when parameters are estimated.

### Markov chains

Use when the declared state makes the future conditionally independent of earlier history. Transition rows must be nonnegative and sum to one. Distinguish transient, absorbing, and stationary questions. Check time homogeneity and state-definition sensitivity.

### Queueing and discrete-event simulation

Check analytic stability conditions before simulation. Declare arrival/service assumptions, resources, priority, warm-up, horizon, and replication scheme. Use independent seeds and report confidence intervals for wait, utilization, throughput, and tail risk.

### Monte Carlo uncertainty propagation

Specify distributions and dependence from evidence. Draw independent or structured samples, propagate through the model, and monitor Monte Carlo standard error. Report quantiles and decision probabilities rather than only a mean. Increase draws until conclusions, not merely digits, stabilize.

## 6. Graph, spatial, and text models

For graphs, define node/edge semantics, direction, weights, multi-edges, missing edges, and time window. Check connected components before centrality or paths. Validate rankings under edge perturbation.

For spatial models, declare coordinate reference system, distance definition, neighborhood, and spatial dependence. Use blocked validation when local autocorrelation would leak information.

For text, preserve document unit, language processing, vocabulary fitting, and temporal split. Topic models need stability and semantic review; sentiment scores need domain validation. Text-derived variables do not become objective facts merely because they are numeric.

## 7. Selection record

For every chosen family record: trigger conditions satisfied, rejected families and reasons, equations/algorithm, baseline, data interface, computational scale, validation design, failure signal, fallback, and exact paper outputs. If a critical condition is unknown, keep the family provisional.
