---
name: mmc-model-design
description: Compare candidate methods and design implementable mathematical models for competition subproblems. Use after intake and literature research to define assumptions, equations, algorithms, dependencies, failure modes, and validation plans.
---

# Model Design

Turn the problem contract and evidence base into an executable modeling contract.

## Method selection

- Call `list_skill_resources` with the inferred problem families and read the matching model catalog and algorithm cards before final selection.
- Record a stable `family_id` and `algorithm_id`; a free-form method name alone is not an implementable contract.
- If no catalog entry satisfies the data and claim conditions, define a custom method with the same trigger, equation, algorithm, diagnostic, failure, and fallback fields.
- Start from the decision target and data-generating structure, not from a preferred algorithm.
- Compare at least two credible method families when alternatives exist.
- Evaluate applicability, assumptions, identifiability, interpretability, computational cost, and validation strength.
- Include a simple baseline before selecting a sophisticated method.
- Use literature evidence to justify method provenance and domain suitability.
- Reject unnecessary complexity that cannot be validated with available data.
- Document why the chosen approach should fail and how failure will be detected.

## Mathematical contract

- Define sets, indices, parameters, variables, units, and domains before equations.
- State objective functions, constraints, state transitions, likelihoods, or estimators precisely.
- Distinguish structural assumptions from numerical approximations.
- Specify preprocessing, initialization, stopping conditions, and random-seed policy.
- Map every equation to a requested output and every requested output to executable steps.
- Preserve cross-subproblem dependencies and declare which persisted result is consumed next.
- Define expected complexity and fallback methods for infeasible or unstable cases.

## Required artifacts

- `work/01_analysis/model_contract.yaml`: selected methods, interfaces, assumptions, and tests.
- `work/01_analysis/model_design.md`: reasoning, equations, comparison, and failure analysis.
- `work/01_analysis/validation_plan.yaml`: baseline, diagnostic, sensitivity, and robustness requirements.
- `work/01_analysis/figure_plan.yaml`: claim-oriented schematic and result-figure needs.

## Acceptance criteria

- Another agent can implement the model without guessing variables or success criteria.
- Every major assumption has a justification, sensitivity check, or explicit limitation.
- Every selected metric answers a competition requirement.
- The contract contains no unverified result values or fabricated evidence.

Read [references/model-contract.md](references/model-contract.md) for required fields,
[references/model-family-catalog.md](references/model-family-catalog.md) for selection rules,
and [references/algorithm-cards.md](references/algorithm-cards.md) for executable handoff details.
