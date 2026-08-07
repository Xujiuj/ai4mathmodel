---
name: mmc-scientific-visualization
description: Plan, create, and audit publication-grade figures for mathematical-modeling papers. Use for data charts, model schematics, multi-panel evidence figures, accessibility, export quality, source traceability, and figure-to-claim consistency.
---

# Scientific Visualization

Treat every figure as a scientific argument with reproducible evidence.

## Figure contract

- State the single conclusion the figure must support before choosing a chart or layout.
- Map each panel to a unique evidence role; remove decorative or redundant panels.
- Separate quantitative charts from conceptual schematics.
- Use real persisted data for every numerical axis, label, annotation, and statistic.
- Keep a manifest linking each figure to source data, generation code, subproblem, and paper claim.
- Choose final dimensions, language, font, color accessibility, and export formats before rendering.
- Use direct labels when they reduce eye travel and preserve readable text at final paper size.
- Prefer restrained, colorblind-safe palettes with redundant line styles or markers.
- Do not highlight the proposed method in a way that obscures fair comparison.

## Production routing

- Call `list_skill_resources` and use `recipe-publication-plots` for a supported figure archetype before writing one-off plotting code.
- Pass a JSON figure spec with the claim, source data, encodings, units, uncertainty semantics, final size, and output stem.
- Keep the generated plotted-data CSV, manifest, QA JSON, PDF, SVG, and PNG together; a lone image is incomplete.
- Build precise data-driven charts from reproducible plotting code and deterministic exports.
- Use evidence hierarchy, purposeful multi-panel composition, and scientific schematics only when they clarify the argument.
- Generate numerical figures with the same code family that reads their source data.
- Use AI image generation only for non-data schematics when it is configured and scientifically appropriate.
- Keep labels short and verify every generated label against the model contract.
- Export vector PDF or SVG for charts and high-resolution raster only when the content requires it.
- Preserve editable source and publication output for every accepted figure.

## Visual verification

- Render final-size previews and inspect legibility, overlaps, clipping, contrast, and misleading scales.
- Check axis units, uncertainty definitions, sample sizes, baselines, and statistical annotations.
- Check captions and panels against the exact underlying values.
- Reject truncated axes, inconsistent encodings, chart junk, inaccessible color-only distinctions, and unsupported annotations.
- Regenerate from source after every data or style correction; never retouch numerical content manually.

## Required artifacts

- `work/02_solving/figures/figure_manifest.yaml` with versioned figure IDs, claims, source data, generation source, and exports.
- Generation source, source-data extract, vector output, and review preview for each figure.
- `work/04_review/figure_audit.md` with final-size visual findings.

Read [references/figure-contract.md](references/figure-contract.md) for manifest fields and review criteria.
