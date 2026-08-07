# Submission and release audit handbook

## Independent audit order

Audit the final artifacts, not status messages. Work from highest consequence to presentation:

1. requirement coverage;
2. claim and numerical provenance;
3. model and validation adequacy;
4. literature and citation validity;
5. figure/table integrity;
6. manuscript structure and language;
7. template, compile, PDF, and release package.

## Cross-artifact consistency

Join stable subproblem IDs across analysis contract, model contract, per-problem results, aggregate results, figure manifest, evidence manifest, manuscript, and release manifest. Each required ID appears exactly once where uniqueness is required. Any orphan, duplicate, changed ID, or stale downstream artifact is a release blocker.

For every central numeric statement, resolve its evidence locator and compare the manuscript value within declared rounding tolerance. For every figure, verify the file exists, is cited, appears in the PDF, and maps to source data and generation code. For every professional factual claim, resolve a verified bibliography record and confirm the cited source supports the bounded proposition.

## Technical audit

Check baseline comparison, split/scenario validity, leakage controls, solver status, constraints/invariants, uncertainty, sensitivity, and family-specific diagnostics. A sophisticated model does not compensate for a missing baseline or invalid evaluation design. Downgrade claims when validation is limited; return critical failures to computation or analysis.

## Manuscript audit

Confirm every requested question has a direct answer. Check summary density, assumption use, notation consistency, equation numbering, units, significant digits, cross-references, caption completeness, and separation of result from interpretation. Remove internal workflow language and unsupported superlatives without deleting substantive evidence.

## Figure audit at final size

Inspect the rendered PDF page by page. Check clipping, overlap, unreadable text, rasterization, font substitution, empty panels, misleading axes, undefined uncertainty, color-only encoding, inconsistent units, and caption mismatch. Compare a sample of plotted values to source data and all headline values to structured results.

## Build and template audit

Compile through the actual template toolchain enough times to resolve references and bibliography. Fix the cause of warnings that affect content or layout. Verify page limit, anonymity/team ID, required summary sheet, margins, fonts, references, blank pages, links, and embedded assets. Open the final PDF independently and inspect first, representative middle, figure-heavy, bibliography, and last pages.

## Severity and disposition

- `critical`: fabricated/untraceable evidence, missing required answer, invalid model result, false citation, unreadable or non-opening PDF;
- `major`: missing baseline/uncertainty, unstable recommendation, misleading figure, broken reference, template violation;
- `minor`: local wording, spacing, or non-substantive formatting issue.

Critical and major findings must be fixed and re-audited. Minor findings may remain only when explicitly recorded and submission rules still pass.

## Release manifest

Record source manuscript, final PDF, bibliography, evidence manifest, figure manifest, file hashes, audit timestamp, unresolved limitations, and decision. `PASS` requires zero unresolved critical or major findings. Never compute a quality score that conceals a blocking defect.
