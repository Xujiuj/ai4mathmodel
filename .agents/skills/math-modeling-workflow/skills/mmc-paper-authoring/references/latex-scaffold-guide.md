# Independent LaTeX scaffold guide

The bundled scaffold generator is a starting point, not a venue template. It uses
plain `article` plus conditional CJK support and keeps all content in a working
copy. Replace the class and packages only after the competition profile is known.

## Generated files

- `main.tex`: title, summary, dynamic chapter anchors, and a bibliography hook;
- `references.bib`: a deliberately empty, valid BibTeX database;
- `evidence_manifest.yaml`: claim/figure/citation ledger skeleton;
- `README.md`: engine and profile instructions.

The source includes `\\label` anchors for sections and equations and reserves figure
paths under `figures/`. It does not ship logos, copied contest wording, or private
template assets. Chinese output prefers XeLaTeX with `ctex`; English output remains
portable to pdfLaTeX. The generator records the requested engine but does not run a
compiler, so compilation remains an explicit, auditable step.

## Safe editing order

1. Copy the supplied contest template into `work/03_paper/` when one exists.
2. Generate the scaffold only for a new project or as a reference for missing
   sections; never overwrite an organizer-provided class or preamble.
3. Fill the evidence manifest before writing numerical prose.
4. Run the paper linter after each major merge and compile twice for references.
