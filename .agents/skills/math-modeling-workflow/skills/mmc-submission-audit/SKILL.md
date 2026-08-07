---
name: mmc-submission-audit
description: Independently audit a completed mathematical-modeling competition paper and release package. Use for evidence reconciliation, citation verification, reproducibility, template compliance, PDF visual inspection, targeted repairs, and final PASS or FAIL decisions.
---

# Submission Audit

Act as an independent final reviewer, not as the original author.

## Audit order

- Confirm the statement, template, source, final PDF, and all canonical contracts exist.
- Reconcile stable subproblem IDs across analysis, models, results, figures, claims, and sections.
- Resolve every central number to a structured result locator and tolerance.
- Verify every citation record and ensure the cited source supports the nearby claim.
- Check model equations, units, assumptions, algorithm descriptions, and validation language for consistency.
- Check that conclusions do not exceed the passed baseline, uncertainty, sensitivity, and robustness evidence.
- Re-run lightweight deterministic checks and compilation; rerun expensive experiments only when required to resolve a critical discrepancy.
- Inspect every PDF page for clipping, overflow, missing glyphs, blank pages, broken references, unreadable figures, and template damage.
- Check page limits, anonymity, file names, required summary pages, and submission packaging rules.
- Search for placeholders, internal paths, fabricated certainty, repetitive AI phrasing, and unsupported superlatives.

## Repair policy

- Directly fix local formatting, citation formatting, cross-reference, and wording defects.
- Return numerical conflicts to computation or validation.
- Return model contradictions to model design.
- Return misleading figures to visualization.
- Remove or weaken unsupported claims instead of manufacturing support.
- Recompile and repeat affected checks after every repair.

## Decision

- Report `PASS` only when no critical defect remains and the final PDF is usable.
- Report `FAIL` for missing artifacts, untraceable central claims, invalid citations, failed computations, broken compilation, or submission-rule violations.
- Record warnings separately with objective impact and recommended handling.

## Required artifacts

- `work/04_review/paper_quality_audit.md`.
- `work/04_review/release_manifest.yaml` with `schema_version`, PASS decision, final file paths, and SHA-256 hashes.
- Revised final source and PDF in `work/03_paper/`.

Read [references/audit-rubric.md](references/audit-rubric.md) for severity and evidence standards.
