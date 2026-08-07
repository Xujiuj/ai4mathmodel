---
name: mmc-problem-intake
description: Inspect and normalize mathematical-modeling competition statements, templates, datasets, and constraints. Use before model selection to create an exact, versioned subproblem contract and identify material risks without solving the problem.
---

# Problem Intake and Decomposition

Convert raw competition materials into a precise contract for research and modeling.

## Procedure

- Inventory every problem, template, data, and rules file before interpreting the task.
- Extract text from supported documents without modifying source files.
- Preserve the original meaning; distinguish explicit requirements from inferred context.
- Identify the competition, language, output format, page limits, deadlines, and template entry.
- Count only top-level requested questions as subproblems.
- Assign stable IDs such as `sp-1`; never renumber them downstream.
- For each subproblem, record inputs, outputs, objectives, constraints, evaluation criteria, dependencies, and uncertainty.
- Inspect data schemas, units, time ranges, missingness, duplicates, encoding, and join keys.
- Record ambiguous terms with plausible interpretations and a discriminating check.
- Separate facts, assumptions, and decisions so later prose cannot blur them.

## Required artifacts

- `work/01_analysis/problem_text.md`: normalized statement with source-file inventory.
- `work/01_analysis/data_profile.yaml`: schemas, units, quality issues, and usable ranges.
- `work/01_analysis/subproblems.yaml`: versioned dependency contract with stable IDs.
- `work/01_analysis/intake_risks.md`: unresolved ambiguity, missing data, and conservative handling.

## Quality criteria

- Every declared input path exists or is explicitly produced by a predecessor.
- Dependencies are acyclic and match the statement's logical order.
- Outputs answer the exact requested questions rather than convenient substitutes.
- No model is selected before ambiguity and data feasibility are evaluated.
- No factual content is added without a traceable source in the supplied materials.

Read [references/input-contract.md](references/input-contract.md) for the canonical handoff fields.

