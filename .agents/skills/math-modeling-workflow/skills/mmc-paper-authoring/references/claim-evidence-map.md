# Competition paper authoring handbook

## Write from an evidence ledger

Before drafting prose, create one row per central claim with: claim ID, subproblem ID, claim type, manuscript section, source artifact, locator or DOI, uncertainty/boundary, planned figure/table, and status. Draft only from supported rows. Every important number must resolve to structured results; every professional citation must resolve to a verified literature record.

## Paper architecture

Use an hourglass structure adapted to the competition template:

1. summary/abstract: context and requested decision, modeling strategy, strongest quantitative results, validation, implication;
2. problem restatement and analysis: what must be answered and why the decomposition is sound;
3. assumptions and notation: only assumptions used later, with scope and consequences;
4. model construction: motivation, variables, equations/algorithm, estimation or solving;
5. results by subproblem: direct answer, evidence, validation, interpretation;
6. sensitivity and robustness: conditions under which the recommendation changes;
7. strengths, limitations, and conclusion: reusable contribution plus bounded claims;
8. references in the required style.

Follow the supplied competition template over generic conventions. Keep all required cover, summary, page, anonymity, and team-number rules intact.

## Paragraph and section logic

Each technical paragraph should perform one job: claim, evidence, reasoning, or boundary. A strong result paragraph usually follows `question -> method/output -> quantitative evidence -> comparator/uncertainty -> interpretation`. Equations are introduced by modeling purpose, followed by variable meaning and how they produce the requested answer.

Keep Results and Discussion responsibilities distinct even when the template combines them. Results report what the verified analysis found. Discussion explains meaning, limitations, and transferability. Do not introduce unsupported new results in the conclusion.

## Abstract contract

The abstract contains no workflow narration. It must answer:

- What problem and decision were addressed?
- What model families were used and why are they complementary?
- What are the most important quantitative answers, with units or comparison?
- How were they validated or stress-tested?
- What recommendation or insight follows, and under what boundary?

Do not claim novelty, optimality, causality, or generality beyond the evidence.

## Tables and figures

Every figure/table is cited before or near its appearance and has a self-contained professional caption. Captions state what is shown, key encodings, uncertainty/sample information, and any necessary condition. Do not put production notes, file names, or style labels in captions.

## Citation discipline

Use literature for method provenance, domain facts, standard definitions, and comparison context. Cite the source that directly supports the sentence. Do not use one citation at the end of a paragraph to cover multiple unrelated claims. The bibliography contains only cited verified records; every in-text key must exist.

## Claim-to-source manifest

The paper evidence manifest distinguishes:

- `numeric`: structured path plus locator and value/tolerance;
- `figure`: existing image plus manifest ID and source data;
- `citation`: verified DOI plus bounded supported claim;
- `derivation`: equation or analytical derivation location;
- `limitation`: assumption or failed/limited validation that narrows the claim.

The final manuscript passes authoring only when each central claim has one or more evidence records, all requested subproblems receive a direct answer, and the compiled PDF agrees with the source and structured results.
