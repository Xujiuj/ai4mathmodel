# Prose and conservation lint contract

`paper_lint.py` is a deterministic pre-review check. It does not decide whether a
model is scientifically correct; it catches accidental edits and wording that
would overstate evidence. It accepts TeX, Markdown, and BibTeX and emits JSON so a
release audit can fail on selected severities.

## Conservation checks

- **numbers**: decimal, percent, signed, scientific-notation, and comma-grouped
  tokens are extracted with their surrounding unit/qualifier;
- **units**: SI-like tokens (`kg`, `m/s`, `°C`, `%`, etc.) are compared alongside
  each number; a changed value or unit is a warning unless the baseline explicitly
  records a replacement;
- **citation keys**: every `\\cite{a,b}` key must occur once in BibTeX; unused
  bibliography keys are informational;
- **equation labels**: `\\label{...}` values must be unique and every `\\eqref` or
  `\\ref` target must resolve (section/figure labels are included in the same set);
- **overclaims**: words such as “proves”, “guarantees”, “always”, “optimal”,
  “causal”, and “generalizable” are flagged unless a nearby qualification is
  present. The linter reports locations; it never rewrites scientific text.

## Baseline mode

Pass `--baseline` with the previously accepted draft. The comparison is token based
and whitespace independent. A changed numeric token is `major` when it appears in a
sentence containing a result cue (`result`, `accuracy`, `error`, `rate`, `increase`,
or Chinese equivalents), otherwise `minor`. Citation and label changes remain
`major` because they can break traceability.

## Report contract

```json
{
  "schema_version": 1,
  "decision": "PASS|REVIEW|FAIL",
  "counts": {"critical": 0, "major": 0, "minor": 0, "info": 0},
  "findings": [{"code": "NUMERIC_DRIFT", "severity": "major", "file": "main.tex", "line": 42, "message": "..."}],
  "inventory": {"numbers": [], "units": [], "citations": [], "labels": [], "references": []}
}
```

`FAIL` is reserved for unresolved citations/labels and a critical overclaim. A
changed result number or unit yields `REVIEW` so an author must reconcile the
evidence manifest before release.
