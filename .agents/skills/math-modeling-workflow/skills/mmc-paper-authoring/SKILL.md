---
name: mmc-paper-authoring
description: Assemble an evidence-grounded mathematical-modeling competition paper in the supplied template. Use after model and result approval for claim mapping, academic prose, citations, figures, tables, equations, and reproducible compilation.
---

# Paper Authoring

Write the paper from approved evidence rather than from model memory.

## Evidence-first assembly

- Call `list_skill_resources` and use `recipe-generate-paper-scaffold` only when the organizer did not provide a usable template.
- Prefer the organizer template over the built-in scaffold; never overwrite a nonempty paper directory.
- Run the literature normalizer, paper linter, and release auditor through their signed recipe IDs before declaring the paper ready.
- Stage the supplied competition template and edit only the working copy.
- Create a claim-evidence map before drafting prose.
- Use only verified literature records, accepted result files, validated tables, and audited figures.
- Give every central numerical claim a unique evidence record and locator.
- Keep analysis, equations, implementation, results, and validation consistent with stable subproblem IDs.
- Do not rerun experiments, change selected models, or invent missing evidence during writing.

## Argument and prose

- Organize the paper around the competition questions and one coherent solution chain.
- State relevance, modeling choice, result, validation, and limitation in a reader-oriented order.
- Make each paragraph carry one controlling idea supported by evidence or reasoning.
- Keep Results focused on what was obtained and evaluation focused on interpretation and limits.
- Calibrate causal, optimality, robustness, and generalization language to passed checks.
- Replace vague claims such as “effective” or “reasonable” with measured evidence.
- Preserve technical terminology and mathematical notation across sections.
- Remove workflow narration, internal paths, model names, placeholders, and promotional language.
- Draft the abstract last from verified methods, exact headline results, validation, and contribution.

## Citations and presentation

- Cite the source actually verified and attribute prior contributions accurately.
- Place each figure or table near the paragraph that interprets it.
- Explain modeling motivation before an equation and meaning after it.
- Include units, uncertainty, baseline context, and limitations where readers need them.
- Follow the template's language, page, anonymity, title, summary, and reference requirements.
- Compile repeatedly until references, figures, fonts, and layout are stable.

## Required artifacts

- Final source and PDF under `work/03_paper/`.
- `work/03_paper/evidence_manifest.yaml` covering claims, figures, and citations.
- Complete bibliography and all referenced assets.

## Concrete authoring resources

- Resolve the contest rules into the profile described in
  `references/competition-profile.md`; unresolved limits are reported as unknown.
- Expand the requested subproblems with `references/dynamic-chapter-blueprint.md`
  so each answer, equation, figure, and validation record has a stable anchor.
- For a new working copy, run the signed scaffold recipe with `--output
  work/03_paper --language zh|en --competition-profile generic|cumcm|mcm`.
  The profiles are original fallbacks; an organizer-provided class always takes
  precedence. Use XeLaTeX or LuaLaTeX for Chinese.
- Fill the generated evidence manifest before inserting numerical prose, then
  compile with the engine recorded by the profile and inspect the resulting PDF.

Read [references/claim-evidence-map.md](references/claim-evidence-map.md) for evidence types and prose checks.
