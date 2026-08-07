---
name: mmc-result-validation
description: Independently test the credibility of mathematical-modeling results. Use after computation and during review for baseline comparison, diagnostics, uncertainty, sensitivity, robustness, constraint checks, and claim calibration.
---

# Result Validation

Challenge accepted computations before they become paper claims.

## Validation design

- Select checks that match the problem type rather than mechanically applying every metric.
- Compare with a naive or established baseline under the same data and evaluation protocol.
- Verify train/test separation, temporal ordering, optimization feasibility, and constraint satisfaction.
- Use residual or error analysis to expose systematic failures.
- Quantify uncertainty through intervals, resampling, repeated seeds, or scenario ranges when appropriate.
- Test sensitivity to influential parameters and assumptions.
- Test robustness to perturbations, missingness, alternative specifications, or stress scenarios.
- Check numerical stability, boundary behavior, and unit consistency.
- Distinguish statistical significance, practical importance, and competition relevance.
- Calibrate each conclusion to the strongest evidence actually passed.

## Independence rules

- Read computation artifacts directly; do not trust narrative summaries alone.
- Do not repair the model silently. Return structural defects to model design and execution defects to computation.
- Record failed checks with the same prominence as passed checks.
- Never mark validation passed because a chart looks plausible.

## Required artifacts

- `work/02_solving/validation_report.yaml`: versioned checks with ID, subproblem ID, status, and persisted evidence paths.
- `work/02_solving/validation_summary.md`: interpretable credibility assessment.
- Validation scripts or notebooks when checks require computation.
- Accepted uncertainty, sensitivity, and robustness tables for paper use.

## Acceptance criteria

- Each central result has at least one direct diagnostic and one relevant comparative or robustness check.
- Each check is reproducible and linked to persisted evidence.
- Failed critical checks block paper claims until resolved or explicitly removed.
- Limitations state where the model should not be trusted.

Read [references/validation-matrix.md](references/validation-matrix.md) to select checks by model family.
