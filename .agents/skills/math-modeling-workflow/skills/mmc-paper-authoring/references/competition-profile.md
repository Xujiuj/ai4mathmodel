# Competition profile contract

The profile is the small, explicit interface between intake and paper assembly. It
prevents a generic article skeleton from silently violating a contest's rules.
Store it as `work/pipeline/competition-profile.yaml` (or JSON when YAML support is
not available). Unknown fields are preserved but never interpreted as permissions.

```yaml
schema_version: 1
contest:
  name: ""
  year: 0
  division: ""
  language: zh # zh | en | bilingual
  team_number: ""
submission:
  deadline_utc: ""
  page_limit: null
  abstract_page_limit: null
  anonymous: true
  allowed_engines: [xelatex, lualatex, pdflatex]
  required_files: [source, pdf, bibliography]
  forbidden_files: [aux, log, synctex.gz]
  filename_pattern: ""
paper:
  title: ""
  entrypoint: main.tex
  section_order: [summary, restatement, analysis, assumptions, notation,
                  model, results, validation, sensitivity, limitations, conclusion]
  required_sections: [summary, assumptions, model, results, conclusion, references]
  citation_style: numeric
  figure_formats: [pdf, png]
  table_rules: {caption_position: below, units_in_header: true}
evidence:
  required_claim_fields: [claim_id, subproblem_id, source, locator, boundary]
  numeric_precision: 3
  uncertainty_required: true
  baseline_required: true
```

## Resolution rules

1. Read the supplied statement, template comments, class files, and organizer
   instructions. Record only observations with a locator; never infer a page limit
   from a common contest convention.
2. Normalize language to `zh`, `en`, or `bilingual`. If the statement and template
   disagree, set `language: ambiguous` in the intake report and block authoring.
3. Resolve the entrypoint by following `\\input` and `\\include` from the copied
   working template. The profile stores the working-copy relative path, not a
   machine path.
4. Treat `required_sections` and `required_files` as hard checks. `section_order` is
   a preferred order and may be extended only with a documented reason.
5. A null limit means “not established”, not “unlimited”. The release audit must
   report the missing rule instead of making a guess.

## Evidence linkage

Each profile field that affects prose or layout gets an evidence locator such as
`statement:p2`, `template:class:line-41`, or `rules.pdf:p7`. Keep the locators in
`work/pipeline/profile-evidence.yaml`; this makes a later rule change auditable.

## Minimal acceptance checks

- `schema_version` is supported and `language` is resolved.
- `entrypoint` exists under the copied paper directory.
- every required section has a chapter mapping;
- the page/filename/anonymity rules are either verified or explicitly unknown;
- no profile value contains an absolute path, secret, or private template name.
