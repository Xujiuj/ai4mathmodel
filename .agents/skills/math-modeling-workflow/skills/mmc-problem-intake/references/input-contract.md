# Problem intake and scientific framing handbook

## Statement normalization

Extract the statement without answering it. Preserve original quantities, units, time ranges, constraints, deliverable verbs, and competition-specific formatting requirements. Create a file inventory with type, role, parse status, row or page count, and any encoding or OCR limitation.

Build a requirement ledger. Each row must contain: requirement ID, source location, exact requested output, decision user, accepted evidence, relevant data, and owning subproblem. Detect hidden deliverables in phrases such as compare, evaluate, justify, recommend, predict, explain, or discuss robustness.

## Ambiguity sensitivity precheck

List every interpretation that could change the mathematical answer. For each ambiguity, compare plausible readings and classify its effect:

- `cosmetic`: wording changes but model and answer do not;
- `parameter`: changes a value or unit but not the model family;
- `structural`: changes variables, constraints, target, causal direction, or subproblem dependencies.

Resolve cosmetic and parameter ambiguity conservatively and record the choice. For structural ambiguity, branch the analysis or state the assumption and require a sensitivity scenario. Never hide a structural choice inside code.

## Data audit

Profile each table before model selection:

| Check | Evidence to record | Typical defect |
|---|---|---|
| shape and grain | rows, columns, one-row meaning | mixed entity levels |
| keys | candidate key, duplicates, join cardinality | many-to-many explosion |
| types | observed and semantic type | numeric codes treated as quantities |
| missingness | count, rate, pattern by group/time | informative missingness |
| range and units | min/max/quantiles and unit source | percent vs proportion |
| time | timezone, frequency, gaps, ordering | future leakage |
| target | construction time and availability | label leakage |
| geography/network | coordinate system or edge semantics | invalid distance/direction |

Raw inputs remain unchanged. Any cleaning rule must be train-only when a split exists, and must be recorded with affected rows and rationale.

## From prompt to research contract

For every subproblem define:

1. question in one testable sentence;
2. claim type and decision consequence;
3. observational unit and population/domain of validity;
4. inputs available at decision time;
5. requested outputs, units, and acceptable precision;
6. constraints and invariants;
7. estimand or objective function;
8. at least one rival hypothesis or alternate model family;
9. discriminating test and falsifier;
10. dependencies on other subproblems.

Examples of estimands include a future conditional mean, a treatment contrast under named assumptions, a Pareto-efficient allocation, a steady-state quantity, a path cost, or a risk probability. If no estimand can be stated, the subproblem is not ready for model design.

## Decomposition rules

Split by requested answer and dependency, not by document section. A valid dependency graph is acyclic. Prefer a small number of coherent subproblems; do not fragment a single optimization model into artificial prose tasks. A downstream question may depend only on a declared upstream output.

Use this readiness test before exit:

- every statement requirement is mapped exactly once;
- every data file has a declared role or is explicitly unused;
- every subproblem has a stable ID, unique result path, and validation requirement;
- units and time direction are explicit;
- leakage and identifiability risks are named;
- no proposed result value appears before computation.
