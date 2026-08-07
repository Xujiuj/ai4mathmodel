# Evidence Schema

Each evidence record contains:

- `id`: stable citation evidence ID.
- `claim`: the narrow claim supported.
- `source_type`: primary study, review, standard, dataset, or official documentation.
- `title`, `authors`, `year`, `venue`.
- `doi` or another authoritative identifier.
- `verification_sources`: registries used to confirm metadata.
- `access_level`: full text, abstract, or metadata only.
- `supports`: supported subproblem and model decision IDs.
- `limitations`: scope, population, assumptions, or conflicts.
- `status`: verified, provisional, rejected, or retracted.

Only `verified` records may enter the final bibliography.

