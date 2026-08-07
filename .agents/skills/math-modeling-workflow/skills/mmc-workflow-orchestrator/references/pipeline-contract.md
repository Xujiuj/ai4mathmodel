# End-to-end control handbook

## Canonical state machine

The four visible stages remain `analysis -> solving -> paper -> review`. Internally, each stage has explicit substates and a durable exit test.

| Visible stage | Internal sequence | Required exit evidence | Failure owner |
|---|---|---|---|
| analysis | intake, evidence search, hypothesis set, model contract | normalized statement, acyclic subproblems, data profile, model and validation contracts | analysis |
| solving | data preparation, baseline, primary model, diagnostics, stress tests, figure data | executed code, one result contract per subproblem, aggregate results, validation report | solving |
| paper | evidence binding, outline, drafting, figures, bibliography, compile | source manuscript, evidence manifest, verified bibliography, readable PDF | paper |
| review | claim audit, numerical audit, figure audit, layout audit, release | corrected source and PDF, release manifest with a defensible decision | review |

Status values are `not_started`, `working`, `blocked`, `failed`, and `passed`. A stage is `passed` only when the backend artifact gate accepts its persisted outputs. Text that merely says a check passed is not evidence.

## Dependency and recovery rules

1. Assign a stable `sp-*` identifier to every requested answer. Carry it through model, code, result, figure, claim, and audit records.
2. Read only declared upstream artifacts. Never infer a result from a log or from prose when a structured result is required.
3. On failure, identify the earliest invalid contract. Return there, repair it, and invalidate all downstream claims derived from it.
4. Reuse a persisted artifact only when its inputs, method configuration, and source hash still match. Otherwise rerun its owner stage.
5. Do not silently change a method during solving. Record the observed incompatibility, the replacement, and the validation consequence.
6. A downstream stage may improve presentation but may not manufacture missing computation, evidence, or assumptions.

## Mandatory research loop

For each subproblem, execute this loop rather than selecting a familiar algorithm immediately:

1. Freeze the observation and requested decision without interpretation.
2. Declare the claim type: descriptive, associational, predictive, causal, mechanistic, optimization, or simulation.
3. Generate at least one credible rival explanation or alternative model family.
4. Derive a prediction or diagnostic that separates the main and rival accounts.
5. Specify the baseline, metric, split or scenario design, uncertainty method, and failure threshold.
6. Run the baseline before the primary method.
7. Challenge the result with diagnostics, sensitivity, and one structure-breaking test.
8. Promote only supported claims into the paper evidence manifest.

## Blocking conditions

Stop the affected branch and report a bounded limitation when any of these holds:

- a required input is absent or unreadable;
- units, time direction, entity keys, or target definition cannot be resolved;
- the desired causal effect is not identifiable from the available design;
- a solver returns infeasible or unstable results and no verified fallback succeeds;
- a central reference cannot be verified from a DOI or trusted bibliographic record;
- a central numeric claim cannot be located in a structured result;
- the final PDF cannot be opened or violates the competition template.

Other independent subproblems may continue. Do not label the whole project successful while a required branch is blocked.

## Completion decision

Use `PASS` only when all required subproblems have passed, all central claims are traceable, all referenced figures exist and are legible at final size, the bibliography contains no unresolved record, the PDF compiles and opens, and there are no critical audit findings. Use `CONDITIONAL` only for an explicit non-critical limitation allowed by the competition. Otherwise use `FAIL` and route each defect to its owner.
