"""Deterministic literature helpers for mathematical-modeling projects.

This module deliberately performs no network calls. Search services are selected by
the caller and their returned metadata is treated as untrusted input. The commands
create reproducible search plans, normalize DOI/BibTeX records, and check whether
manuscript claims are bound to verified evidence records.

Examples:
    python literature_tools.py plan --tasks tasks.json --output search-plan.json
    python literature_tools.py normalize --input candidates.json --output references.json
    python literature_tools.py normalize --bibtex-file references.bib --output references.json
    python literature_tools.py ledger --ledger claims.json --references references.json
    python literature_tools.py --self-test
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(18|19|20)\d{2}\b")
RESERVED_BIB = re.compile(r"[\\{}$%&#_~^]")


def _read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in re.split(r"[;,|]", value) if part.strip()]
    return [str(part).strip() for part in value if str(part).strip()]


def normalize_doi(value: Any) -> str | None:
    """Return a canonical DOI or ``None`` for missing/invalid values."""
    if value is None:
        return None
    doi = str(value).strip()
    doi = re.sub(r"^doi\s*:\s*", "", doi, flags=re.IGNORECASE)
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi, flags=re.IGNORECASE)
    doi = doi.strip().rstrip(".,;:)]}>")
    # DOI syntax contains no whitespace; reject wrapped or concatenated input
    # instead of silently creating a different identifier.
    if re.search(r"\s", doi):
        return None
    doi = doi.casefold()
    return doi if DOI_RE.fullmatch(doi) else None


def normalize_title(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).casefold()
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def _safe_year(value: Any) -> int | None:
    match = YEAR_RE.search(str(value or ""))
    return int(match.group(0)) if match else None


def _first_author(authors: Iterable[str]) -> str:
    first = next(iter(authors), "")
    # BibTeX supports "Family, Given" and ordinary "Given Family" forms.
    if "," in first:
        return first.split(",", 1)[0].strip()
    words = first.split()
    return words[-1] if words else ""


def _authors(value: Any) -> list[str]:
    """Parse BibTeX's ``and`` separator without splitting family/given commas."""
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in re.split(r"\s+and\s+", value, flags=re.IGNORECASE) if part.strip()]
    return [str(part).strip() for part in value if str(part).strip()]


def _bib_escape(value: str) -> str:
    return RESERVED_BIB.sub(lambda match: "\\" + match.group(0), value)


def parse_bibtex(text: str) -> list[dict[str, Any]]:
    """Parse common BibTeX entries without evaluating macros or embedded code."""
    records: list[dict[str, Any]] = []
    cursor = 0
    while True:
        match = re.search(r"@([A-Za-z]+)\s*([({])", text[cursor:])
        if not match:
            break
        start = cursor + match.start()
        opening = match.group(2)
        closing = "}" if opening == "{" else ")"
        body_start = cursor + match.end()
        depth = 1
        quote = False
        end = body_start
        while end < len(text) and depth:
            char = text[end]
            if char == '"' and (end == 0 or text[end - 1] != "\\"):
                quote = not quote
            elif not quote and char == opening:
                depth += 1
            elif not quote and char == closing:
                depth -= 1
            end += 1
        if depth:
            raise ValueError(f"unterminated BibTeX entry near offset {start}")
        body = text[body_start : end - 1].strip()
        comma = body.find(",")
        if comma < 0:
            cursor = end
            continue
        key = body[:comma].strip()
        fields: dict[str, str] = {"citation_key": key, "type": match.group(1).casefold()}
        for field, raw in _split_bib_fields(body[comma + 1 :]):
            fields[field.casefold()] = _strip_bib_value(raw)
        records.append(fields)
        cursor = end
    return records


def _split_bib_fields(body: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    start = 0
    depth = 0
    quote = False
    chunks: list[str] = []
    for index, char in enumerate(body):
        if char == '"' and (index == 0 or body[index - 1] != "\\"):
            quote = not quote
        elif not quote and char == "{":
            depth += 1
        elif not quote and char == "}" and depth:
            depth -= 1
        elif not quote and depth == 0 and char == ",":
            chunks.append(body[start:index])
            start = index + 1
    chunks.append(body[start:])
    for chunk in chunks:
        if "=" not in chunk:
            continue
        name, value = chunk.split("=", 1)
        if name.strip():
            result.append((name.strip(), value.strip()))
    return result


def _strip_bib_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == "{" and value[-1] == "}")):
        value = value[1:-1]
    return re.sub(r"\s+", " ", value.replace("\\&", "&")).strip()


def _canonical_record(raw: dict[str, Any], index: int) -> dict[str, Any]:
    authors = _authors(raw.get("authors", raw.get("author")))
    title = str(raw.get("title", "")).strip()
    record: dict[str, Any] = {
        "id": str(raw.get("id") or raw.get("citation_key") or f"candidate-{index + 1}"),
        "status": str(raw.get("status", "candidate")).casefold(),
        "role": str(raw.get("role", "background")).strip(),
        "title": title,
        "authors": authors,
        "year": _safe_year(raw.get("year")),
        "venue": str(raw.get("venue", raw.get("journal", raw.get("booktitle", "")))).strip(),
        "doi": normalize_doi(raw.get("doi")),
        "url": str(raw.get("url", "")).strip() or None,
        "citation_key": str(raw.get("citation_key", "")).strip() or None,
    }
    for key in ("claim_supported", "scope", "limitations", "verification"):
        if key in raw:
            record[key] = raw[key]
    return record


def _merge_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[list[str]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        identity = ("doi", record["doi"]) if record.get("doi") else (
            "title", f"{normalize_title(record.get('title'))}|{record.get('year') or ''}|{normalize_title(_first_author(record.get('authors', [])))}"
        )
        groups[identity].append(record)
    merged: list[dict[str, Any]] = []
    duplicate_groups: list[list[str]] = []
    for members in groups.values():
        status_rank = {"verified": 0, "screened": 1, "candidate": 2, "rejected": 3}
        ordered = sorted(members, key=lambda item: (status_rank.get(str(item.get("status", "candidate")).casefold(), 4), -sum(value not in (None, "", []) for value in item.values()), item["id"]))
        winner = dict(ordered[0])
        for candidate in ordered[1:]:
            for key, value in candidate.items():
                if winner.get(key) in (None, "", []) and value not in (None, "", []):
                    winner[key] = value
        merged.append(winner)
        if len(members) > 1:
            duplicate_groups.append([member["id"] for member in members])
    # Stable keys avoid changing a manuscript when input order changes.
    used: dict[str, int] = {}
    for record in sorted(merged, key=lambda item: (normalize_title(item.get("title")), item.get("year") or 0, item["id"])):
        base = re.sub(r"[^a-z0-9]+", "", _first_author(record.get("authors", [])).casefold()) or "source"
        base += str(record.get("year") or "nd")
        title_token = next(iter(normalize_title(record.get("title")).split()), "source")
        base += re.sub(r"[^a-z0-9]+", "", title_token)[:12]
        used[base] = used.get(base, 0) + 1
        record["citation_key"] = base if used[base] == 1 else f"{base}{used[base]}"
    return sorted(merged, key=lambda item: item["citation_key"]), duplicate_groups


def normalize_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    canonical = [_canonical_record(record, index) for index, record in enumerate(records)]
    normalized, duplicate_groups = _merge_records(canonical)
    issues: list[dict[str, Any]] = []
    for record in normalized:
        missing = [field for field in ("title", "authors", "year") if not record.get(field)]
        if missing:
            issues.append({"id": record["id"], "kind": "missing_field", "fields": missing})
        if record.get("doi") is None and not record.get("url"):
            issues.append({"id": record["id"], "kind": "missing_identifier", "message": "no valid DOI or URL"})
    return {"version": 1, "records": normalized, "duplicate_groups": duplicate_groups, "issues": issues}


def build_search_plan(tasks: list[dict[str, Any]], *, databases: list[str], languages: list[str], start_year: int | None, end_year: int | None) -> dict[str, Any]:
    facets = ("phenomenon", "domain", "task", "method", "population", "validation")
    plan_tasks = []
    for index, task in enumerate(tasks):
        values = {key: _as_list(task.get(key)) for key in facets}
        domain_terms = values["domain"] or values["phenomenon"] or ["mathematical modeling"]
        task_terms = values["task"] or ["modeling"]
        method_terms = values["method"] or ["method comparison"]
        validation_terms = values["validation"] or ["validation"]
        broad = f"({' OR '.join(domain_terms)}) AND ({' OR '.join(task_terms)}) AND ({' OR '.join(method_terms)})"
        precise = broad + f" AND ({' OR '.join(validation_terms)})"
        plan_tasks.append({
            "id": str(task.get("id") or f"task-{index + 1}"),
            "facets": values,
            "queries": [{"purpose": "discovery", "query": broad}, {"purpose": "verification", "query": precise}],
            "screening": {"include": ["directly addresses the task or method", "reports enough metadata to verify", "matches the population or setting"], "exclude": ["snippet-only records", "unverifiable identifiers", "duplicate or retracted records"]},
        })
    return {
        "version": 1,
        "boundary": {"databases": databases, "languages": languages, "year_range": [start_year, end_year], "document_types": ["journal article", "conference paper", "review", "standard"], "stopping_rule": "stop after each task has verified method provenance and domain evidence, or record a boundary failure"},
        "tasks": plan_tasks,
        "logging_fields": ["timestamp", "service", "exact_query", "filters", "result_count", "screened_count", "decision", "reason"],
        "notes": ["A negative result means not found inside this boundary; it does not prove absence.", "Do not infer a DOI from a title pattern; verify metadata against a registry or publisher."],
    }


def validate_ledger(claims: list[dict[str, Any]], references: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {str(reference.get("id")): reference for reference in references}
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    if len(by_id) != len(references):
        errors.append({"kind": "duplicate_reference_id"})
    for claim in claims:
        claim_id = str(claim.get("claim_id") or claim.get("id") or "<missing>")
        evidence_ids = _as_list(claim.get("evidence_ids", claim.get("sources", [])))
        if not str(claim.get("text", "")).strip():
            errors.append({"claim_id": claim_id, "kind": "empty_claim"})
        if not evidence_ids:
            errors.append({"claim_id": claim_id, "kind": "unsupported_claim"})
        if len(set(evidence_ids)) != len(evidence_ids):
            errors.append({"claim_id": claim_id, "kind": "duplicate_evidence_binding"})
        for evidence_id in evidence_ids:
            reference = by_id.get(evidence_id)
            if reference is None:
                errors.append({"claim_id": claim_id, "evidence_id": evidence_id, "kind": "unknown_evidence"})
                continue
            if str(reference.get("status", "")).casefold() != "verified":
                errors.append({"claim_id": claim_id, "evidence_id": evidence_id, "kind": "unverified_evidence"})
            if not str(reference.get("claim_supported", "")).strip():
                errors.append({"claim_id": claim_id, "evidence_id": evidence_id, "kind": "missing_supported_proposition"})
            if not str(reference.get("scope", "")).strip():
                warnings.append({"claim_id": claim_id, "evidence_id": evidence_id, "kind": "missing_source_scope"})
        strength = str(claim.get("strength", "")).casefold()
        if any(token in str(claim.get("text", "")).casefold() for token in ("always", "never", "proves", "causes", "all")) and strength not in {"descriptive", "bounded"}:
            warnings.append({"claim_id": claim_id, "kind": "overclaim_language", "message": "replace universal/causal wording with a bounded proposition or document causal design"})
    return {"version": 1, "valid": not errors, "claim_count": len(claims), "reference_count": len(references), "errors": errors, "warnings": warnings}


def _self_test() -> dict[str, Any]:
    assert normalize_doi("10.1234/has whitespace") is None
    bib = '@article{Smith2022, author = {Smith, Ada and Doe, Lin}, title = {A Robust Method}, year = {2022}, doi = {https://doi.org/10.1234/ABC.1}, journal = {Journal}}'
    parsed = parse_bibtex(bib)
    normalized = normalize_records(parsed + [{"id": "copy", "title": "A Robust Method", "authors": ["Ada Smith", "Lin Doe"], "year": 2022, "doi": "10.1234/abc.1", "status": "verified", "claim_supported": "bounded method result", "scope": "benchmark"}])
    assert len(normalized["records"]) == 1 and normalized["duplicate_groups"]
    plan = build_search_plan([{"id": "forecast", "domain": ["rainfall"], "task": ["forecasting"], "method": ["ARIMA"]}], databases=["Crossref"], languages=["en"], start_year=2015, end_year=2026)
    assert "verification" in plan["tasks"][0]["queries"][1]["purpose"]
    reference = dict(normalized["records"][0]); reference.update({"id": "lit-001", "status": "verified", "claim_supported": "bounded method result", "scope": "benchmark"})
    ledger = validate_ledger([{"claim_id": "c1", "text": "The method improves error on this benchmark.", "evidence_ids": ["lit-001"], "strength": "bounded"}], [reference])
    assert ledger["valid"]
    invalid_ledger = validate_ledger([{"claim_id": "bad", "text": "The method always causes improvement.", "evidence_ids": ["missing"]}], [])
    assert not invalid_ledger["valid"] and invalid_ledger["errors"]
    return {"parsed": parsed, "normalized": normalized, "plan": plan, "ledger": ledger, "invalid_ledger": invalid_ledger}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--self-test-output", type=Path)
    sub = parser.add_subparsers(dest="command")
    plan = sub.add_parser("plan", help="build a reproducible search boundary and query plan")
    plan.add_argument("--tasks", required=True, help="JSON list or object containing tasks")
    plan.add_argument("--output", required=True)
    plan.add_argument("--databases", default="Crossref,OpenAlex,Google Scholar")
    plan.add_argument("--languages", default="en")
    plan.add_argument("--start-year", type=int)
    plan.add_argument("--end-year", type=int)
    normalize = sub.add_parser("normalize", help="normalize and deduplicate JSON or BibTeX records")
    normalize.add_argument("--input")
    normalize.add_argument("--bibtex-file")
    normalize.add_argument("--output", required=True)
    ledger = sub.add_parser("ledger", help="validate claim-to-source bindings")
    ledger.add_argument("--ledger", required=True)
    ledger.add_argument("--references", required=True)
    ledger.add_argument("--output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.self_test:
        report = _self_test()
        if args.self_test_output:
            _write_json(args.self_test_output, report)
        else:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if args.command == "plan":
        payload = _read_json(args.tasks)
        tasks = payload.get("tasks", payload) if isinstance(payload, dict) else payload
        _write_json(args.output, build_search_plan(tasks, databases=_as_list(args.databases), languages=_as_list(args.languages), start_year=args.start_year, end_year=args.end_year))
        return 0
    if args.command == "normalize":
        if bool(args.input) == bool(args.bibtex_file):
            raise SystemExit("choose exactly one of --input or --bibtex-file")
        records = parse_bibtex(Path(args.bibtex_file).read_text(encoding="utf-8")) if args.bibtex_file else _read_json(args.input)
        if isinstance(records, dict):
            records = records.get("records", records.get("references", []))
        _write_json(args.output, normalize_records(records))
        return 0
    if args.command == "ledger":
        claims_payload = _read_json(args.ledger)
        refs_payload = _read_json(args.references)
        claims = claims_payload.get("claims", claims_payload) if isinstance(claims_payload, dict) else claims_payload
        references = refs_payload.get("records", refs_payload.get("references", refs_payload)) if isinstance(refs_payload, dict) else refs_payload
        result = validate_ledger(claims, references)
        if args.output:
            _write_json(args.output, result)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["valid"] else 2
    _parser().print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
