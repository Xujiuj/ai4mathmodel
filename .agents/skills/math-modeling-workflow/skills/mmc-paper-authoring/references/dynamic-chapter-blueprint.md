# Dynamic chapter blueprint

The chapter map is generated from accepted subproblem IDs, not from a fixed essay.
It is a directed plan with stable anchors so figures, equations, and evidence
records remain addressable when a problem has two or six subproblems.

## Section graph

| Anchor | Purpose | Required inputs | Produced records |
|---|---|---|---|
| `summary` | decision, method chain, headline results, validation, boundary | accepted result ledger | `claim.summary.*` |
| `restatement` | translate the statement into answerable outputs | statement digest, subproblem map | `question.S*.text` |
| `analysis` | explain decomposition and information flow | intake assumptions, literature notes | `decision.model.*` |
| `assumptions` | list only operative assumptions and consequences | assumption register | `assumption.*` |
| `notation` | one stable symbol table with units | model contract | `symbol.*` |
| `model.S{n}` | construct and solve subproblem n | selected model card, data contract | `equation.*`, `algorithm.*` |
| `results.S{n}` | answer subproblem n with measured evidence | result ledger, figure/table manifests | `claim.S{n}.*` |
| `validation` | diagnostics, baselines, uncertainty and failure modes | validation matrix | `check.*` |
| `sensitivity` | show decision changes over declared perturbations | sensitivity table | `claim.sensitivity.*` |
| `limitations` | state scope and unverified assumptions | failed/limited checks | `limitation.*` |
| `conclusion` | bounded answers and transfer conditions | all accepted claims | `claim.conclusion.*` |
| `references` | cited, verified bibliography only | citation ledger | `citation.*` |

The graph is intentionally hourglass-shaped: broad question framing narrows to
one model per subproblem, expands into evidence and diagnostics, then narrows to
bounded recommendations. A section may be omitted only when the profile marks it
optional and the audit records the reason.

## Subproblem expansion

For each subproblem create the same four anchors:

1. `model.S{n}.choice` — objective, data geometry, constraints, and rejected
   alternatives;
2. `model.S{n}.solve` — equation/algorithm, stopping rule, and implementation ID;
3. `results.S{n}.answer` — the direct answer in the requested unit;
4. `results.S{n}.check` — baseline, residual/diagnostic, uncertainty, and boundary.

Never merge two subproblems merely because they use the same algorithm. Keep their
claim IDs distinct and cite the shared implementation as a dependency.

## Dynamic insertion contract

The generator emits a section only after its inputs are present. Each insertion
contains a machine comment with `anchor`, `subproblem_id`, and `evidence_ids`:

```tex
% mmc:anchor=model.S2 evidence=eq.S2.1,algo.S2
\\section{Model for subproblem 2}\\label{sec:model-S2}
```

These comments are not user-facing prose; they let the linter detect orphaned
claims and preserve references after a section is reordered. Remove them only in a
final packaging pass after the manifest has been frozen.

## Gate before writing

- every requested question maps to one or more `results.S{n}` anchors;
- every result anchor has a source artifact and locator;
- every equation, figure, and table used by a result has a stable ID;
- a missing validation record is written as a limitation, never silently omitted;
- the abstract and conclusion are drafted from the accepted claim ledger last.
