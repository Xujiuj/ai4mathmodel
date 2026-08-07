# Independent release-audit implementation

`scripts/release_audit.py` is the packaged static gate for the final release
directory. It uses only Python's standard library, so the desktop runtime does
not depend on a private workstation skill or a third-party parser.

## Invocation

```text
python scripts/release_audit.py --root work/03_paper \
  --json-out work/04_review/paper_quality_audit.json \
  --manifest-out work/04_review/release_manifest.json
```

The root may also be supplied positionally (`release_audit.py work/03_paper`)
or with the reference-compatible `--paper-dir` alias.

The process prints one line with the decision and counts. Exit codes are
stable: `0` means `PASS`, `1` means `WARN` with no blocking finding, and `2`
means `FAIL`. `--strict-warnings` promotes `WARN` to exit code `2` for CI.

## Checks performed

- LaTeX `\\input`, `\\include`, and `\\includegraphics` plus Typst `#include`,
  `#read`, and `image` targets are resolved relative to the source file.
  Missing targets, absolute paths, and path traversal are blocking findings.
- LaTeX citation commands and Typst `@key` citations are joined to `.bib`
  entries or `\\bibitem` declarations. Missing keys block; unused keys warn.
- Placeholders (`TODO`, `TBD`, `FIXME`, `???`, fill-in markers, and Chinese
  unfinished markers) and machine-specific paths are blocking findings.
- Manuscript headings are classified into introduction, method/model, results,
  and conclusion/discussion groups. Missing groups warn; no detectable
  headings blocks.
- JSON/YAML files named for claims, evidence, or results are inspected. The
  canonical `evidence` list accepts typed `numeric`, `figure`, and `citation`
  records. Numeric records resolve `source.path` plus a dotted or JSON-pointer
  `source.locator` and independently compare the stored value within the
  declared tolerance. Figure records require an existing packaged asset.
  Citation records require a syntactically valid DOI present in a cited BibTeX
  entry. Legacy single-string locators remain supported for older projects.
- Evidence paths may address the paper directory or a sibling stage beneath
  the same project work directory. Absolute paths and paths escaping that work
  directory are rejected.
- A missing manifest is an explicit warning rather than a silently successful
  audit. Evidence is considered used when its claim ID/text, rounded numeric
  value, figure path, or DOI-backed citation is present in the manuscript.
- A deterministic SHA-256 manifest records every release file (sorted POSIX
  paths, byte length, and digest). Report/manifest outputs and LaTeX auxiliary
  files such as `.aux`, `.log`, `.blg`, and `.out` are omitted.

The script is deliberately a preflight gate, not a PDF renderer or a scientific
reviewer. A `PASS` means that package references and declared provenance are
internally resolvable; the final workflow still performs visual PDF inspection,
model validation, and human review of claim scope.

## Report shape

The JSON report contains `schema_version`, `decision`, `exit_code`, `counts`, a
machine-readable `findings` list (`severity`, `code`, `path`, optional `line`,
and message), and a `manifest` containing the file hashes. This shape is stable
enough for a CI gate while keeping source-specific prose out of the contract.
