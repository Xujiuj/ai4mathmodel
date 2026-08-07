#!/usr/bin/env python3
"""Deterministic, dependency-free manuscript and release-package auditor.

The auditor intentionally performs conservative static checks.  It does not
pretend to render a PDF or prove a scientific result; it verifies that the
source package is internally addressable and that declared evidence can be
located before a human performs the final visual and scientific review.

Exit codes: 0 = PASS, 1 = WARN (with no blocking finding), 2 = FAIL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "1.0"
TEXT_EXTENSIONS = {".tex", ".typ", ".md", ".txt", ".bib", ".json", ".yaml", ".yml"}
MANUSCRIPT_EXTENSIONS = {".tex", ".typ"}
GRAPHIC_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".webp"}
EXCLUDED_PARTS = {".git", ".omx", "node_modules", "__pycache__", ".pytest_cache"}
EXCLUDED_RELEASE_SUFFIXES = (
    ".aux",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".lof",
    ".log",
    ".lot",
    ".out",
    ".synctex.gz",
    ".toc",
)
DOI_PATTERN = re.compile(r"^10\.\d{4,9}/[-._;()/:A-Z0-9]+$", re.IGNORECASE)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def relpath(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def finding(severity: str, code: str, path: str, message: str, line: int | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {"severity": severity, "code": code, "path": path, "message": message}
    if line is not None:
        item["line"] = line
    return item


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        if path.name.lower().endswith(EXCLUDED_RELEASE_SUFFIXES):
            continue
        yield path


def candidate_paths(base: Path, target: str, extensions: set[str]) -> list[Path]:
    raw = target.strip().strip("\"'")
    path = Path(raw)
    options = [base / path]
    if not path.suffix:
        options.extend(base / f"{raw}{ext}" for ext in sorted(extensions))
    return options


def resolve_target(root: Path, base: Path, target: str, extensions: set[str]) -> tuple[Path | None, bool]:
    raw = target.strip().strip("\"'")
    path = Path(raw)
    if path.is_absolute() or re.match(r"^[A-Za-z]:[\\/]", raw):
        return None, True
    options = candidate_paths(base, raw, extensions)
    for option in options:
        try:
            resolved = option.resolve()
            resolved.relative_to(root.resolve())
        except (OSError, ValueError):
            return None, True
        if resolved.is_file():
            return resolved, False
    return None, False


def parse_includes(root: Path, path: Path, text: str, findings: list[dict[str, Any]]) -> None:
    patterns = [
        (r"\\(?:input|include)\s*\{([^}]+)\}", "include", TEXT_EXTENSIONS),
        (r"\\bibliography\s*\{([^}]+)\}", "bibliography", {".bib"}),
        (r"\\includegraphics(?:\[[^]]*\])?\s*\{([^}]+)\}", "graphic", GRAPHIC_EXTENSIONS),
        (r"#(?:include|read)\s*\(\s*[\"']([^\"']+)[\"']\s*\)", "include", TEXT_EXTENSIONS),
        (r"#bibliography\s*\(\s*[\"']([^\"']+)[\"']", "bibliography", {".bib"}),
        (r"(?:#)?image\s*\(\s*[\"']([^\"']+)[\"']", "graphic", GRAPHIC_EXTENSIONS),
    ]
    for pattern, kind, extensions in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            target = match.group(1).strip()
            line = line_number(text, match.start())
            targets = [part.strip() for part in target.split(",")] if kind == "bibliography" else [target]
            for one_target in targets:
                resolved, unsafe = resolve_target(root, path.parent, one_target, extensions)
                if unsafe:
                    findings.append(finding("FAIL", "UNSAFE_REFERENCE", relpath(path, root), f"{kind} reference escapes package or is absolute: {one_target}", line))
                elif resolved is None:
                    findings.append(finding("FAIL", "MISSING_REFERENCE", relpath(path, root), f"missing {kind} target: {one_target}", line))


def parse_bibliography(root: Path) -> tuple[set[str], set[str]]:
    keys: set[str] = set()
    for path in iter_files(root):
        if path.suffix.lower() != ".bib":
            continue
        text = read_text(path)
        keys.update(match.group(1).strip() for match in re.finditer(r"@[^,{(]+\s*[({]\s*([^,\s]+)", text))
    for path in iter_files(root):
        if path.suffix.lower() in MANUSCRIPT_EXTENSIONS:
            text = read_text(path)
            keys.update(match.group(1).strip() for match in re.finditer(r"\\bibitem\s*(?:\[[^]]+\])?\s*\{([^}]+)\}", text))
    return keys, set()


def parse_citations(text: str) -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    for match in re.finditer(r"\\cite[a-zA-Z*]*\s*(?:\[[^]]*\]\s*)*\{([^}]+)\}", text):
        found.extend((key.strip(), line_number(text, match.start())) for key in match.group(1).split(",") if key.strip())
    # Typst citations use @key.  Exclude email addresses and escaped TeX commands.
    for match in re.finditer(r"(?<![\\\w])@([A-Za-z][A-Za-z0-9_.:-]*)", text):
        found.append((match.group(1), line_number(text, match.start())))
    return found


def placeholder_findings(root: Path, path: Path, text: str) -> list[dict[str, Any]]:
    patterns = [
        r"\b(?:TODO|FIXME|TBD|WIP|XXX)\b",
        r"\?{3,}",
        r"\b(?:lorem\s+ipsum|your[_ -]?name|insert[_ -]?here|fill[_ -]?in)\b",
        r"\[\s*(?:待补充|未填写|占位|TODO)[^\]]*\]",
        r"<\s*(?:insert|fill|replace|todo|待补充|未填写|占位)[^>]*>",
    ]
    results: list[dict[str, Any]] = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            results.append(finding("FAIL", "PLACEHOLDER", relpath(path, root), f"unresolved placeholder: {match.group(0)}", line_number(text, match.start())))
    return results


def internal_path_findings(root: Path, path: Path, text: str) -> list[dict[str, Any]]:
    pattern = re.compile(r"(?:[A-Za-z]:[\\/][^\s)\]}>,;]+|(?:/Users/|/home/|/mnt/|/opt/|/tmp/)[^\s)\]}>,;]+|(?:^|[\\/])(?:desktop-app|MathModelAgent|\.agents)(?:[\\/][^\s)\]}>,;]+))", re.IGNORECASE)
    results: list[dict[str, Any]] = []
    for match in pattern.finditer(text):
        if match.group(0).startswith(("http://", "https://")):
            continue
        results.append(finding("FAIL", "INTERNAL_PATH", relpath(path, root), f"internal or machine-specific path: {match.group(0).strip()}", line_number(text, match.start())))
    return results


def section_findings(root: Path, path: Path, text: str) -> list[dict[str, Any]]:
    headings: list[str] = []
    for match in re.finditer(r"\\(?:chapter|section|subsection)\s*\{([^}]+)\}|^\s*=+\s+(.+?)\s*$", text, flags=re.IGNORECASE | re.MULTILINE):
        headings.append((match.group(1) or match.group(2)).strip().lower())
    if not headings:
        return [finding("FAIL", "NO_SECTIONS", relpath(path, root), "manuscript has no detectable section headings")]
    groups = {
        "introduction": ("introduction", "background", "引言", "背景", "问题提出", "问题重述", "问题分析"),
        "methods": ("method", "model", "methodology", "方法", "模型", "建模"),
        "results": ("result", "analysis", "experiment", "结果", "分析", "实验", "验证"),
        "conclusion": ("conclusion", "discussion", "结论", "讨论", "建议", "局限"),
    }
    results: list[dict[str, Any]] = []
    for name, tokens in groups.items():
        if not any(any(token in heading for token in tokens) for heading in headings):
            results.append(finding("WARN", "SECTION_GAP", relpath(path, root), f"no heading matched required section group: {name}"))
    return results


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return None
    if value.startswith("{") and value.endswith("}"):
        result: dict[str, Any] = {}
        for item in value[1:-1].split(","):
            if ":" not in item:
                continue
            key, nested_value = item.split(":", 1)
            result[key.strip()] = parse_scalar(nested_value)
        return result
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "none", "~"}:
        return None
    try:
        return float(value) if any(char in value for char in ".eE") else int(value)
    except ValueError:
        return value


def parse_canonical_evidence_yaml(text: str) -> dict[str, Any] | None:
    """Parse the canonical evidence list without requiring a YAML dependency."""
    evidence: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    source: dict[str, Any] | None = None
    in_evidence = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent == 0:
            if stripped == "evidence:":
                in_evidence = True
                continue
            if in_evidence:
                break
        if not in_evidence:
            continue
        if indent == 2 and stripped.startswith("-"):
            current = {}
            evidence.append(current)
            source = None
            stripped = stripped[1:].strip()
            if stripped and ":" in stripped:
                key, nested_value = stripped.split(":", 1)
                current[key.strip()] = parse_scalar(nested_value)
            continue
        if current is None or ":" not in stripped:
            continue
        key, nested_value = stripped.split(":", 1)
        key = key.strip()
        if indent == 4:
            parsed = parse_scalar(nested_value)
            if key == "source" and parsed is None:
                source = {}
                current[key] = source
            else:
                current[key] = parsed
                source = current[key] if key == "source" and isinstance(current[key], dict) else None
        elif indent >= 6 and source is not None:
            source[key] = parse_scalar(nested_value)
    return {"evidence": evidence} if evidence else None


def load_structured(path: Path) -> Any:
    if path.suffix.lower() == ".json":
        try:
            return json.loads(read_text(path))
        except (ValueError, OSError):
            return None
    return parse_canonical_evidence_yaml(read_text(path))


def iter_claim_records(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        collection_keys = ("claims", "evidence")
        for collection_key in collection_keys:
            records = value.get(collection_key)
            if isinstance(records, list):
                for item in records:
                    if isinstance(item, dict):
                        yield item
        if value.get("claim_id") or (value.get("id") and any(key in value for key in ("locator", "evidence_locator", "evidence", "source"))):
            yield value
        for key, item in value.items():
            if key in collection_keys:
                continue
            yield from iter_claim_records(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_claim_records(item)


def validate_locator(root: Path, locator: str) -> tuple[bool, str]:
    value = str(locator).strip()
    if not value:
        return False, "empty locator"
    file_part, _, pointer = value.partition("#")
    line_match = re.match(r"^(.*?):(\d+)(?::(\d+))?$", file_part)
    line: int | None = None
    if line_match:
        file_part = line_match.group(1)
        line = int(line_match.group(2))
    target = (root / file_part).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return False, "locator escapes package"
    if not target.is_file():
        return False, f"file not found: {file_part}"
    if line is not None and line > len(read_text(target).splitlines()):
        return False, f"line {line} exceeds file length"
    if pointer and pointer.startswith("/") and target.suffix.lower() == ".json":
        try:
            node: Any = json.loads(read_text(target))
            for key in pointer.lstrip("/").split("/"):
                node = node[key.replace("~1", "/").replace("~0", "~")]
        except (KeyError, IndexError, TypeError, ValueError):
            return False, f"JSON pointer not found: #{pointer}"
    return True, "resolved"


def normalize_doi(value: Any) -> str:
    doi = str(value or "").strip().lower()
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi)
    return doi.rstrip(".,; ")


def bibliography_doi_keys(root: Path) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for path in iter_files(root):
        if path.suffix.lower() != ".bib":
            continue
        text = read_text(path)
        entries = list(re.finditer(r"@[^,{(]+\s*[({]\s*([^,\s]+)\s*,", text))
        for index, entry in enumerate(entries):
            end = entries[index + 1].start() if index + 1 < len(entries) else len(text)
            block = text[entry.start() : end]
            doi_match = re.search(r"\bdoi\s*=\s*[\{\"]([^}\"]+)", block, flags=re.IGNORECASE)
            if doi_match:
                result.setdefault(normalize_doi(doi_match.group(1)), set()).add(entry.group(1).strip())
    return result


def resolve_evidence_path(root: Path, raw_path: Any) -> tuple[Path | None, str]:
    value = str(raw_path or "").strip().strip("\"'")
    if not value:
        return None, "empty source path"
    path = Path(value)
    if path.is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value):
        return None, "absolute source path"
    try:
        target = (root / path).resolve()
        target.relative_to(root.parent.resolve())
    except (OSError, ValueError):
        return None, "source path escapes the project work directory"
    if not target.is_file():
        return None, f"file not found: {value}"
    return target, "resolved"


def resolve_data_locator(path: Path, locator: Any) -> tuple[bool, str, Any]:
    value = str(locator or "").strip()
    if not value:
        return False, "empty data locator", None
    if path.suffix.lower() != ".json":
        return False, f"structured locator requires JSON source: {path.name}", None
    try:
        node: Any = json.loads(read_text(path))
    except (OSError, ValueError):
        return False, f"invalid JSON source: {path.name}", None
    tokens = value.lstrip("#/").split("/") if value.startswith(("#/", "/")) else value.split(".")
    try:
        for token in tokens:
            token = token.replace("~1", "/").replace("~0", "~")
            node = node[int(token)] if isinstance(node, list) else node[token]
    except (KeyError, IndexError, TypeError, ValueError):
        return False, f"data locator not found: {value}", None
    return True, "resolved", node


def numeric_value_is_used(record: dict[str, Any], manuscript_text: str) -> bool:
    value = record.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    tolerance = record.get("tolerance", 0)
    tolerance = float(tolerance) if isinstance(tolerance, (int, float)) else 0.0
    for token in re.findall(r"(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", manuscript_text):
        try:
            observed = float(token)
        except ValueError:
            continue
        decimals = len(token.partition(".")[2]) if "." in token else 0
        rounding_tolerance = 0.5 * 10**-decimals
        if abs(observed - float(value)) <= max(tolerance, rounding_tolerance, 1e-12):
            return True
    return False


def validate_evidence_record(root: Path, record: dict[str, Any], doi_keys: dict[str, set[str]]) -> list[dict[str, Any]]:
    claim_id = str(record.get("id") or record.get("claim_id") or "unnamed-claim")
    evidence_type = str(record.get("type") or "").strip().lower()
    source = record.get("source")
    if not isinstance(source, dict):
        legacy_locator = record.get("evidence_locator") or record.get("locator") or record.get("evidence") or source
        if isinstance(legacy_locator, str):
            ok, detail = validate_locator(root, legacy_locator)
            return [] if ok else [finding("FAIL", "INVALID_LOCATOR", ".", f"claim {claim_id}: {detail}")]
        return [finding("FAIL", "INVALID_EVIDENCE_SOURCE", ".", f"claim {claim_id} has no structured source")]
    if evidence_type == "citation" or "doi" in source:
        doi = normalize_doi(source.get("doi"))
        if not DOI_PATTERN.fullmatch(doi):
            return [finding("FAIL", "INVALID_DOI", ".", f"claim {claim_id} has an invalid DOI")]
        if doi not in doi_keys:
            return [finding("FAIL", "DOI_NOT_IN_BIBLIOGRAPHY", ".", f"claim {claim_id} DOI is absent from the packaged bibliography: {doi}")]
        return []
    target, detail = resolve_evidence_path(root, source.get("path") or source.get("file"))
    if target is None:
        return [finding("FAIL", "MISSING_EVIDENCE_SOURCE", ".", f"claim {claim_id}: {detail}")]
    locator = source.get("locator") or record.get("locator")
    if locator:
        ok, locator_detail, observed = resolve_data_locator(target, locator)
        if not ok:
            return [finding("FAIL", "INVALID_EVIDENCE_LOCATOR", ".", f"claim {claim_id}: {locator_detail}")]
        expected = record.get("value")
        if isinstance(expected, (int, float)) and not isinstance(expected, bool):
            if not isinstance(observed, (int, float)) or isinstance(observed, bool):
                return [finding("FAIL", "EVIDENCE_VALUE_TYPE", ".", f"claim {claim_id} locator does not resolve to a numeric value")]
            tolerance = float(record.get("tolerance", 0) or 0)
            if abs(float(observed) - float(expected)) > tolerance:
                return [finding("FAIL", "EVIDENCE_VALUE_MISMATCH", ".", f"claim {claim_id} expected {expected} but source contains {observed}")]
    elif evidence_type == "numeric":
        return [finding("FAIL", "MISSING_EVIDENCE_LOCATOR", ".", f"numeric claim {claim_id} has no source locator")]
    return []


def evidence_record_is_used(record: dict[str, Any], manuscript_text: str, cited: set[str], doi_keys: dict[str, set[str]]) -> bool:
    claim_id = str(record.get("id") or record.get("claim_id") or "")
    claim_text = str(record.get("claim") or "").strip()
    if claim_id and claim_id in manuscript_text:
        return True
    if claim_text and claim_text in manuscript_text:
        return True
    source = record.get("source")
    if isinstance(source, dict):
        if source.get("doi"):
            return bool(doi_keys.get(normalize_doi(source["doi"]), set()) & cited)
        raw_path = str(source.get("path") or source.get("file") or "").replace("\\", "/")
        if raw_path and (raw_path in manuscript_text or Path(raw_path).name in manuscript_text):
            return True
    return numeric_value_is_used(record, manuscript_text)


def evidence_findings(root: Path, manuscript_paths: list[Path], cited: set[str]) -> list[dict[str, Any]]:
    manifests = [path for path in iter_files(root) if path.suffix.lower() in {".json", ".yaml", ".yml"} and any(token in path.name.lower() for token in ("evidence", "claim", "result"))]
    records: list[dict[str, Any]] = []
    for path in manifests:
        data = load_structured(path)
        records.extend(iter_claim_records(data))
    if not records:
        return [finding("WARN", "NO_EVIDENCE_MANIFEST", relpath(manuscript_paths[0], root) if manuscript_paths else ".", "no claims/evidence manifest was found; central results cannot be machine-reconciled")]
    results: list[dict[str, Any]] = []
    manuscript_text = "\n".join(read_text(path) for path in manuscript_paths)
    doi_keys = bibliography_doi_keys(root)
    for index, record in enumerate(records, 1):
        claim_id = record.get("id") or record.get("claim_id") or f"claim-{index}"
        results.extend(validate_evidence_record(root, record, doi_keys))
        if not evidence_record_is_used(record, manuscript_text, cited, doi_keys):
            results.append(finding("WARN", "UNUSED_CLAIM", ".", f"claim {claim_id} is absent from manuscript source"))
    return results


def build_manifest(root: Path, exclude: set[Path]) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    for path in iter_files(root):
        if path.resolve() in exclude:
            continue
        data = path.read_bytes()
        files.append({"path": relpath(path, root), "size": len(data), "sha256": sha256_bytes(data)})
    payload = json.dumps(files, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {"algorithm": "sha256", "files": files, "sha256": sha256_bytes(payload)}


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in {".yaml", ".yml"}:
        lines = ["schema_version: '1.0'", f"algorithm: {manifest['algorithm']}", f"sha256: {manifest['sha256']}", "files:"]
        for item in manifest["files"]:
            lines.extend([f"  - path: {json.dumps(item['path'], ensure_ascii=False)}", f"    size: {item['size']}", f"    sha256: {item['sha256']}"])
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Paper quality audit",
        "",
        f"Decision: **{report['decision']}**",
        "",
        f"- Blocking findings: {report['counts']['fail']}",
        f"- Warnings: {report['counts']['warn']}",
        f"- Manuscripts: {report['counts']['manuscripts']}",
        f"- Manifest SHA-256: `{report['manifest']['sha256']}`",
        "",
        "## Findings",
        "",
    ]
    if report["findings"]:
        lines.extend(f"- **{item['severity']}** `{item['code']}` {item['path']}{':' + str(item['line']) if item.get('line') else ''}: {item['message']}" for item in report["findings"])
    else:
        lines.append("No findings.")
    return "\n".join(lines) + "\n"


def audit(root: Path, json_out: Path | None = None, manifest_out: Path | None = None, markdown_out: Path | None = None) -> dict[str, Any]:
    root = root.resolve()
    paths = list(iter_files(root))
    manuscript_paths = [path for path in paths if path.suffix.lower() in MANUSCRIPT_EXTENSIONS]
    findings: list[dict[str, Any]] = []
    for path in manuscript_paths:
        text = read_text(path)
        parse_includes(root, path, text, findings)
        findings.extend(placeholder_findings(root, path, text))
        findings.extend(internal_path_findings(root, path, text))
        findings.extend(section_findings(root, path, text))
    bib_keys, _ = parse_bibliography(root)
    cited: set[str] = set()
    for path in manuscript_paths:
        for key, line in parse_citations(read_text(path)):
            cited.add(key)
            if key not in bib_keys:
                findings.append(finding("FAIL", "MISSING_CITATION", relpath(path, root), f"citation key not found in bibliography: {key}", line))
    for key in sorted(bib_keys - cited):
        findings.append(finding("WARN", "UNUSED_CITATION", ".", f"bibliography entry is not cited: {key}"))
    findings.extend(evidence_findings(root, manuscript_paths, cited))
    fail_count = sum(item["severity"] == "FAIL" for item in findings)
    warn_count = sum(item["severity"] == "WARN" for item in findings)
    decision = "FAIL" if fail_count else "WARN" if warn_count else "PASS"
    excluded = {path.resolve() for path in (json_out, manifest_out, markdown_out) if path}
    manifest = build_manifest(root, excluded)
    report: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "decision": decision,
        "exit_code": 2 if decision == "FAIL" else 1 if decision == "WARN" else 0,
        "root": str(root),
        "counts": {"fail": fail_count, "warn": warn_count, "manuscripts": len(manuscript_paths), "cited_keys": len(cited), "bibliography_keys": len(bib_keys)},
        "findings": findings,
        "manifest": manifest,
    }
    if json_out:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if manifest_out:
        write_manifest(manifest_out, manifest)
    if markdown_out:
        markdown_out.parent.mkdir(parents=True, exist_ok=True)
        markdown_out.write_text(render_markdown(report), encoding="utf-8")
    return report


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="mmc-audit-") as temp:
        root = Path(temp)
        (root / "figures").mkdir()
        (root / "main.tex").write_text("\\section{问题重述}\n\\section{模型建立}\n\\section{结果与验证}\nAccuracy is 0.125. See \\cite{smith2024}.\\includegraphics{figures/result.pdf}\n\\section{结论}\n", encoding="utf-8")
        (root / "refs.bib").write_text("@article{smith2024, title={A test}, doi={10.1000/test-doi}}\n", encoding="utf-8")
        (root / "figures" / "result.pdf").write_bytes(b"placeholder-pdf")
        (root / "results.json").write_text(json.dumps({"metrics": {"accuracy": 0.125}}), encoding="utf-8")
        evidence_path = root / "evidence.yaml"
        canonical = """schema_version: 1
evidence:
  - id: claim:accuracy
    type: numeric
    value: 0.125
    tolerance: 0.001
    source:
      path: results.json
      locator: metrics.accuracy
  - id: claim:figure
    type: figure
    source: {path: figures/result.pdf}
  - id: claim:citation
    type: citation
    source: {doi: 10.1000/test-doi}
"""
        evidence_path.write_text(canonical, encoding="utf-8")
        report = audit(root)
        if report["decision"] != "PASS":
            raise AssertionError(report)
        manifest_path = root / "release_manifest.yaml"
        report_path = root / "paper_quality_audit.md"
        audit(root, manifest_out=manifest_path, markdown_out=report_path)
        if not manifest_path.exists() or "sha256:" not in manifest_path.read_text(encoding="utf-8") or not report_path.exists():
            raise AssertionError("report outputs were not written")
        if any(item["path"].endswith(".aux") for item in report["manifest"]["files"]):
            raise AssertionError("compile artifacts must not enter the release manifest")
        evidence_path.write_text(canonical.replace("metrics.accuracy", "metrics.missing"), encoding="utf-8")
        report = audit(root)
        if not any(item["code"] == "INVALID_EVIDENCE_LOCATOR" for item in report["findings"]):
            raise AssertionError("bad data locator was not rejected")
        evidence_path.write_text(canonical.replace("figures/result.pdf", "figures/missing.pdf"), encoding="utf-8")
        report = audit(root)
        if not any(item["code"] == "MISSING_EVIDENCE_SOURCE" for item in report["findings"]):
            raise AssertionError("missing figure evidence was not rejected")
        evidence_path.write_text(canonical.replace("10.1000/test-doi", "not-a-doi"), encoding="utf-8")
        report = audit(root)
        if not any(item["code"] == "INVALID_DOI" for item in report["findings"]):
            raise AssertionError("invalid DOI was not rejected")
        evidence_path.write_text(canonical, encoding="utf-8")
        (root / "main.tex").write_text(read_text(root / "main.tex") + "TODO", encoding="utf-8")
        report = audit(root)
        if report["decision"] != "FAIL" or report["exit_code"] != 2:
            raise AssertionError(report)
    print("SELF_TEST PASS")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path, help="release package root (positional shorthand)")
    parser.add_argument("--root", "--paper-dir", dest="root", type=Path, help="release package root")
    parser.add_argument("--json-out", type=Path, help="write the full audit report")
    parser.add_argument("--manifest-out", type=Path, help="write the SHA-256 release manifest")
    parser.add_argument("--markdown-out", type=Path, help="write a human-readable paper quality audit")
    parser.add_argument("--strict-warnings", action="store_true", help="return FAIL exit code for warnings")
    parser.add_argument("--self-test", action="store_true", help="run built-in deterministic self-test")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    root = args.root or args.path
    if not root:
        parser.error("--root is required unless --self-test is used")
    report = audit(root, args.json_out, args.manifest_out, args.markdown_out)
    print(f"{report['decision']} fail={report['counts']['fail']} warn={report['counts']['warn']} files={len(report['manifest']['files'])}")
    return 2 if report["decision"] == "FAIL" or (args.strict_warnings and report["decision"] == "WARN") else 1 if report["decision"] == "WARN" else 0


if __name__ == "__main__":
    raise SystemExit(main())
