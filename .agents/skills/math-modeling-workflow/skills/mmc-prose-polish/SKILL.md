---
name: mmc-prose-polish
description: Independently audit and improve the argument structure and academic prose of a mathematical-modeling paper without changing scientific evidence. Use after a complete draft and before final submission review.
---

# Academic Prose Polish

Advise the paper author without becoming a second owner of the manuscript source.

## Boundary

- Read the draft, evidence manifest, validation summary, and verified bibliography.
- Write findings only to `work/03_paper/prose_polish_report.yaml`.
- Do not directly edit final TeX, Markdown, figures, numbers, equations, citations, or conclusions.
- Do not invent novelty, causality, certainty, data, or references.
- Mark scientific inconsistencies for upstream repair instead of polishing around them.

## Review order

- Identify the paper type, competition audience, and rhetorical purpose of each section.
- Check the paper-level argument before paragraph or sentence style.
- Check whether introduction, model, results, evaluation, and conclusion perform distinct jobs.
- Check each paragraph for one controlling claim, supporting evidence, and a justified boundary.
- Separate observation from interpretation and implication.
- Calibrate wording to the evidence strength recorded by validation.
- Improve logical transitions, terminology stability, concision, and reader orientation.
- Remove repetitive openings, promotional language, vague praise, workflow narration, and generic AI phrasing.
- Preserve equations, variable meanings, units, numerical precision, citation intent, and technical terms.
- For Chinese-to-English revision, reconstruct logical relations before translating clauses.

## Report contract

- Record location, issue type, severity, evidence risk, recommended revision, and whether author action is required.
- Provide replacement prose only when it preserves the original verified meaning.
- Distinguish required scientific corrections from optional stylistic improvements.
- Finish with an overclaim list and an unresolved terminology list.
- Persist `schema_version`, decision, structured findings, overclaims, and unresolved terminology even when the lists are empty.

Read [references/prose-rubric.md](references/prose-rubric.md) for section responsibilities and severity.
