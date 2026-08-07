# Scientific visualization handbook

## Figure contract before drawing

Every figure begins with five decisions:

1. one-sentence claim the figure must support;
2. source data artifact and exact fields or locators;
3. comparison structure and uncertainty to display;
4. chart archetype and why it preserves the evidence;
5. final physical size and export formats.

If no substantive claim exists, omit the figure. Quantitative evidence must be plotted from persisted data by reproducible code. Boxes-and-arrows diagrams are reserved for mechanisms, algorithms, or system relationships and must never imitate quantitative evidence.

## Chart selection by analytical task

| Evidence task | Preferred archetype | Avoid |
|---|---|---|
| trend over ordered x/time | line with points and interval band | decorative smoothing without raw/support points |
| observed vs predicted | parity/scatter plus marginal residual or error panel | dual axes that imply false association |
| distribution by group | violin/box plus jitter or raincloud | bars of means without spread/sample size |
| method comparison | dot/interval or grouped bar with uncertainty | truncated axes that exaggerate gain |
| matrix or many pair relations | annotated heatmap or correlation grid | unreadable labels and uncorrected significance claims |
| classification tradeoff | ROC or precision-recall with confidence band and baseline | single AUC number without curve/context |
| multi-metric model fidelity | Taylor diagram or normalized performance grid | radar chart with arbitrary scales |
| parameter sensitivity | response curve, tornado, or ranked elasticity | unlabelled one-factor spaghetti |
| optimization tradeoff | Pareto frontier with dominated points distinguished | one preferred point without alternatives |
| spatial evidence | projected map with scale/legend and uncertainty | unprojected distance comparison |
| network structure | topology view only when position has meaning; otherwise matrix/summary | hairball network |
| workflow/mechanism | content-driven schematic | fixed decorative card layout |

## Styling at final size

Set the target width before styling: approximately single-column, one-and-a-half-column, or full-page as allowed by the template. At that size, axis labels, tick labels, legends, annotations, and panel letters must remain readable. Use zero letter spacing and consistent type. Avoid dense titles inside plots; place interpretation in the caption.

Use a colorblind-safe palette and redundant encodings such as line style, marker, or direct label. Do not encode ordered magnitude with unordered hues. Keep backgrounds quiet, grids subordinate, and legends compact. Ensure grayscale still distinguishes central comparisons.

## Statistical and semantic integrity

Show uncertainty when it affects interpretation and define whether it is SD, SE, confidence interval, prediction interval, bootstrap interval, or quantile range. State sample size and the unit of replication. Statistical annotations must name the test, sidedness, multiplicity treatment, and meaning of error bars where relevant.

Axes include quantity and unit. Categories retain stable ordering. Log scales are declared. Missing data are not silently converted to zero. Maps declare coordinate assumptions. Network width/size mappings are explained. Never interpolate or smooth beyond what the data and model justify.

## Reproducible export contract

Each figure manifest entry contains `figure_id`, `subproblem_id`, `claim`, `source_data`, `data_locators`, `generation_source`, `archetype`, `final_width`, `exports`, `uncertainty_definition`, and `qa_status`.

Prefer vector PDF/SVG for line art and charts with editable text. Use high-resolution raster only when the content requires it; use at least 300 DPI for continuous-tone imagery and 600 DPI for line-heavy raster output. Embed or preserve fonts where the format permits. Export the exact data subset used by the figure when feasible.

## Visual QA

Inspect the rendered figure at final manuscript size. Check clipping, overlap, font substitution, legend collision, panel alignment, contrast, colorblind readability, unit accuracy, data consistency, and whether the intended claim is visible without zooming. Compare plotted values against the structured source. A figure fails if it is attractive but cannot be traced or read.
