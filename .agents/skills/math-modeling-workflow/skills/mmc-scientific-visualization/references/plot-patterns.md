# Plot pattern recipes

Choose a recipe only after defining the figure claim and source data. The bundled `publication_plots.py` supplies reusable primitives. Adapt labels, units, dimensions, and grouping; never replace real data with its demo mode.

## Line with uncertainty

Use for an ordered quantity with replicated, bootstrap, posterior, or model interval uncertainty. Draw the central estimate as a line and the interval as a light band. If observations exist, show restrained points. The manifest must define the interval and independent unit.

## Prediction diagnostic plate

Use a compact multi-panel figure when predictive credibility, not only score, is the claim:

- observed versus predicted with identity line;
- residual versus fitted with zero line;
- residual distribution or quantile plot;
- error by decision-relevant group or horizon.

Use common colors and units. Do not pool horizons when horizon degradation is important.

## ROC or precision-recall with resampling interval

Interpolate each fold curve onto a common grid, plot a mean curve, and show fold/bootstrap variation as a band. Report mean and dispersion of AUC/AP and show the correct no-skill baseline. For severe imbalance prefer precision-recall as the main panel.

## Distribution comparison

Use box/violin plus jitter or a raincloud layout to retain individual observations, distribution shape, and summary. State sample sizes and whether points are independent. Do not use a bar of means when distribution or outliers affect the claim.

## Correlation and dependence

Use a lower-triangle scatter/smoother, diagonal distribution, and upper-triangle coefficient/uncertainty grid for a small selected set. For many variables use a clustered heatmap. Correlation is descriptive; do not label it influence or effect.

## Taylor diagram

Use when comparing pattern correlation, standard deviation, and centered RMSE across several models. Angle is `arccos(correlation)` and radius is model standard deviation, usually normalized by observation standard deviation. Explain the geometry in the caption; do not use for audiences that cannot decode it without benefit.

## Sensitivity tornado

For each parameter plot low/high change in the target relative to the base case, ordered by impact. Preserve sign. State perturbation ranges. A tornado chart based on arbitrary identical percentages is local sensitivity, not full uncertainty analysis.

## Pareto frontier

Plot all feasible candidates quietly, dominated points separately, and nondominated points in objective order. Mark the recommended point only after preference/robustness selection. Axis directions must make optimization preference obvious.

## Convergence and feasibility

For iterative optimization, plot best and typical objective by iteration across seeds, with a second panel for feasible rate or maximum violation. A smooth best-so-far curve alone can hide frequent infeasibility and run instability.

## Export package

For every accepted figure produce:

- vector PDF and SVG when the content is line art;
- PNG preview at the final aspect ratio;
- a CSV/JSON extract containing exactly plotted data;
- a manifest entry with claim, source, generator, dimensions, uncertainty, and QA;
- a final-size visual inspection record.

The paper caption is not embedded in the image. File names, internal workflow terms, and style claims do not appear inside the figure.
