# Literature evidence toolkit

This skill ships a small, offline-first checker so a project does not depend on a
private research plugin at runtime. The script only normalizes data supplied by the
caller; it never treats a title, abstract, URL, or DOI-like string as verified.

## 1. Define a search boundary

Create a JSON task file. Each facet is a list of synonyms; missing facets are filled
with conservative defaults.

```json
{
  "tasks": [{
    "id": "q2-forecast",
    "domain": ["urban rainfall", "precipitation"],
    "task": ["forecasting", "prediction"],
    "method": ["ARIMA", "gradient boosting"],
    "population": ["city-scale"],
    "validation": ["rolling origin", "external validation"]
  }]
}
```

Build the reproducible boundary and two query levels:

```text
python scripts/literature_tools.py plan --tasks tasks.json \
  --databases Crossref,OpenAlex --languages en,zh \
  --start-year 2015 --end-year 2026 --output work/search-plan.json
```

The generated file records inclusion/exclusion rules, a stopping rule, and the
logging fields needed in `search_log.md`. The script does not perform network
searches: use an approved service, save its raw metadata, and record the exact query,
filters, result count, and screening decision. “No result” is bounded by this plan.

## 2. Normalize candidates and BibTeX

JSON candidates may use either `author` or `authors`, `journal` or `venue`, and may
contain DOI URLs. BibTeX is parsed without macro expansion or command execution.

```text
python scripts/literature_tools.py normalize \
  --bibtex-file work/references.bib --output work/references.normalized.json
python scripts/literature_tools.py normalize \
  --input work/candidates.json --output work/references.normalized.json
```

The output lowercases valid DOI values, strips registry URL prefixes, normalizes
titles for matching, merges duplicate DOI or (title + year + first author) records,
and assigns stable citation keys. Missing title/author/year or both DOI and URL are
reported as issues. A normalized record is not automatically `verified`; verification
requires comparing metadata with a registry or publisher and setting `status` to
`verified` in the evidence map.

## 3. Bind claims to evidence

Use a ledger such as:

```json
{
  "claims": [{
    "claim_id": "method-01",
    "text": "The selected model reduced MAE on the held-out benchmark.",
    "strength": "bounded",
    "evidence_ids": ["lit-001"]
  }]
}
```

Validate it against normalized records:

```text
python scripts/literature_tools.py ledger \
  --ledger work/claim-ledger.json \
  --references work/references.normalized.json \
  --output work/claim-ledger.report.json
```

The report fails on unknown, duplicate, unverified, or proposition-less evidence and
on claims with no source. It warns about missing source scope and universal/causal
wording (`always`, `never`, `proves`, `causes`, `all`) so the writer can narrow the
claim or document a causal design. Only a `valid: true` report should be handed to
paper authoring.

## Data contract

The minimum evidence record is:

```yaml
id: lit-001
status: verified
role: method_origin
claim_supported: "bounded proposition actually supported by the source"
scope: "population, setting, or mathematical conditions"
limitations: ["abstract-only", "single benchmark"]
metadata:
  title: "Verified title"
  authors: ["Family, Given"]
  year: 2024
  venue: "Verified venue"
  doi: "10.1234/example"
verification:
  service: "registry or publisher"
  checked_fields: [title, authors, year, venue, doi]
```

Keep discovery candidates, verification notes, the original BibTeX, normalized
records, and claim ledger as separate artifacts. Never overwrite a candidate with a
verified status without an auditable check.
