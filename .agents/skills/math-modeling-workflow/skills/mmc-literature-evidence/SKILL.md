---
name: mmc-literature-evidence
description: Search, verify, and organize scholarly sources for mathematical-modeling methods and domain claims. Use during analysis, paper writing, and review to create a citation-ready evidence map with verified identifiers and claim-level provenance.
---

# Literature Evidence

Build a compact evidence base that supports method choice and factual claims.

## Search strategy

- Derive queries from each subproblem's domain, method family, constraints, and evaluation needs.
- Search primary scholarly indexes and DOI registries through configured research tools.
- Prefer original method papers, authoritative reviews, official standards, and strong domain studies.
- Use recent work for current practice and seminal work for method provenance.
- Read metadata and available abstracts before deciding relevance.
- Do not cite a search-result snippet as evidence.

## Verification

- Verify title, authors, year, venue, DOI, and URL against at least one authoritative registry.
- Reject fabricated, unverifiable, retracted, irrelevant, or duplicate sources.
- Attribute a claim to the source that actually makes it; prefer primary over secondary citation.
- Mark abstract-only evidence and avoid claiming details that require unread full text.
- Record contradictory findings instead of selecting only convenient sources.
- Never infer a DOI from a title pattern.

## Required artifacts

- `work/01_analysis/literature/evidence_map.yaml`: versioned evidence records with ID, claim, title, year, status, and authoritative verification sources.
- `work/01_analysis/literature/search_log.md`: query, scope, date, inclusion, and exclusion rationale.
- `work/01_analysis/literature/references.bib`: normalized, deduplicated citation records.
- `work/01_analysis/literature/method_notes.md`: applicability, assumptions, strengths, and failure modes.

## Handoff rules

- Model design may use only methods whose applicability is documented.
- Paper writing may cite only records marked `verified`.
- Every background or methodological claim must resolve to a unique evidence ID.
- Missing support remains an explicit gap; polished prose must not conceal it.

Read [references/evidence-schema.md](references/evidence-schema.md) for the structured record format.
