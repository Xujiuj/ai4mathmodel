# Scientific argument and prose handbook

## Diagnose before editing

Review in this order: paper type and template, section responsibility, paragraph logic, claim-evidence-boundary alignment, then sentence style. Sentence polishing cannot repair a missing comparison, unsupported claim, or misplaced result.

For every paragraph ask:

1. What single job does this paragraph perform?
2. What is its main claim?
3. What evidence or reasoning supports it?
4. What boundary prevents overgeneralization?
5. Does it connect logically to the previous and next paragraphs?

Split paragraphs with competing jobs. Merge fragments that repeat one point. Preserve equations, values, identifiers, citation keys, and technical meaning.

## Claim calibration

Match verbs to evidence:

- descriptive evidence: `shows`, `summarizes`, `is associated with`;
- predictive evidence: `predicts on the declared holdout`, `improves the selected metric`;
- causal evidence only with identification: `estimates the effect under ...`;
- optimization: `is optimal for the stated objective and constraints`;
- simulation: `occurs in the simulated scenarios`, not necessarily in the real world.

Flag unsupported words such as proves, guarantees, universally, unprecedented, perfectly, significantly, robust, optimal, or causal. Retain them only when the exact definition and evidence are present.

## Results and discussion separation

Results should state the analysis, quantity, comparator, uncertainty, and direct answer. Discussion should interpret mechanism or implications, compare with literature, expose limitations, and state transfer conditions. Move methods details out of result interpretation and do not repeat all results in the conclusion.

## Sentence-level revision

Prefer concrete subjects and active verbs where responsibility matters. Keep terms stable; do not replace technical terms merely for variety. Remove workflow narration, filler transitions, promotional adjectives, vague references, stacked nouns, repeated conclusions, and claims about the writing process. Define acronyms at first use and keep symbols consistent with equations.

Preserve uncertainty and limitations during compression. Never polish away a failed diagnostic, conflicting result, or caveat. If the source logic is weak, report the defect instead of making it sound confident.

## Human-quality checks

Detect mechanical patterns: identical paragraph openings, repetitive three-item lists, excessive headings, generic bridge sentences, false quotations, unexplained bold emphasis, and conclusion-only restatement. Replace them with content-driven logic, not arbitrary stylistic variation.

## Review output

Record each issue with severity, section, quoted or uniquely located text, defect type, reasoning, and a bounded revision. Severity is `critical` for altered truth or unsupported central claims, `major` for broken argument or missing evidence, and `minor` for local clarity/style. After applying revisions, recheck all numeric values, citations, cross-references, and equations for accidental change.
