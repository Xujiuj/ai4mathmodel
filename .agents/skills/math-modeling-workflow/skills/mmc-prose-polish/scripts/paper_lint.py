#!/usr/bin/env python3
"""Lint a mathematical-modeling manuscript for traceability and overclaiming.

The checker is deliberately conservative: it reports locations for authors and
does not rewrite a manuscript. Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


NUMBER_RE = re.compile(
    r"(?<![A-Za-z0-9_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?"
)
UNIT_RE = re.compile(r"(?:\\%|%|[°µμΩA-Za-z]+(?:\s*/\s*[°µμΩA-Za-z0-9]+)?)")
CITATION_RE = re.compile(r"\\(?:cite|citep|citet|parencite)[A-Za-z*]*\s*\{([^}]*)\}")
BIB_KEY_RE = re.compile(r"@[^\s{]+\s*\{\s*([^,\s]+)", re.I)
LABEL_RE = re.compile(r"\\label\s*\{([^}]+)\}")
REF_RE = re.compile(r"\\(?:eqref|ref|pageref)\s*\{([^}]+)\}")

OVERCLAIM_TERMS = {
    "proves": "critical",
    "prove": "critical",
    "guarantees": "critical",
    "guarantee": "critical",
    "always": "major",
    "never": "major",
    "universally": "major",
    "unprecedented": "major",
    "perfectly": "major",
    "optimal": "major",
    "causal": "major",
    "generalizable": "major",
    "generalises": "major",
    "证明": "critical",
    "保证": "critical",
    "始终": "major",
    "最优": "major",
    "因果": "major",
    "普适": "major",
}
QUALIFIER_RE = re.compile(
    r"\b(?:under|within|on the declared|in the observed|simulated|conditional|for this dataset)\b"
    r"|在(?:本数据|该样本|所给|模拟|声明的|限定)条件下",
    re.I,
)
RESULT_CUE_RE = re.compile(r"result|accuracy|error|rate|increase|decrease|metric|结果|准确|误差|提升|下降|指标", re.I)


def _finding(code: str, severity: str, file: str, line: int, message: str) -> dict[str, Any]:
    return {"code": code, "severity": severity, "file": file, "line": line, "message": message}


def _number_value(token: str) -> str:
    return token.replace(",", "").rstrip("%")


def _files(root: Path) -> list[Path]:
    return sorted(
        path for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".tex", ".md", ".bib"}
    )


def scan(root: Path) -> dict[str, Any]:
    inventory: dict[str, Any] = {
        "numbers": [], "units": [], "citations": [], "labels": [], "references": [], "bibliography": []
    }
    findings: list[dict[str, Any]] = []
    labels: dict[str, tuple[str, int]] = {}
    refs: list[tuple[str, str, int]] = []
    bib_keys: list[tuple[str, str, int]] = []

    for path in _files(root):
        relative = path.relative_to(root).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append(_finding("ENCODING", "major", relative, 1, "file is not UTF-8; inventory is incomplete"))
            continue
        lines = text.splitlines()
        for line_number, line in enumerate(lines, 1):
            for match in NUMBER_RE.finditer(line):
                suffix = line[match.end(): match.end() + 24]
                # Ignore the small TeX spacing commands before a unit, while
                # retaining escaped percent signs as the percent unit.
                unit_match = UNIT_RE.match(re.sub(r"^(?:\\[,;:]|\\s)+", "", suffix.lstrip()))
                unit = unit_match.group(0) if unit_match else ("%" if match.group(0).endswith("%") else "")
                unit = unit.replace(r"\%", "%")
                record = {
                    "file": relative, "line": line_number, "token": match.group(0),
                    "value": _number_value(match.group(0)), "unit": unit,
                }
                inventory["numbers"].append(record)
                if unit:
                    inventory["units"].append({"file": relative, "line": line_number, "unit": unit})
            for match in CITATION_RE.finditer(line):
                for key in (part.strip() for part in match.group(1).split(",")):
                    if key:
                        inventory["citations"].append({"file": relative, "line": line_number, "key": key})
            for match in LABEL_RE.finditer(line):
                label = match.group(1).strip()
                inventory["labels"].append({"file": relative, "line": line_number, "key": label})
                if label in labels:
                    old_file, old_line = labels[label]
                    findings.append(_finding("DUPLICATE_LABEL", "critical", relative, line_number,
                                             f"label {label!r} already declared at {old_file}:{old_line}"))
                labels[label] = (relative, line_number)
            for match in REF_RE.finditer(line):
                for key in (part.strip() for part in match.group(1).split(",")):
                    if key:
                        refs.append((key, relative, line_number))
                        inventory["references"].append({"file": relative, "line": line_number, "key": key})
            if path.suffix.lower() in {".tex", ".md"}:
                for term, default_severity in OVERCLAIM_TERMS.items():
                    if re.search(rf"(?<!\w){re.escape(term)}(?!\w)", line, re.I):
                        severity = "minor" if QUALIFIER_RE.search(line) else default_severity
                        findings.append(_finding("OVERCLAIM", severity, relative, line_number,
                                                 f"{term!r} needs an explicit evidence boundary"))
        if path.suffix.lower() == ".bib":
            for line_number, line in enumerate(lines, 1):
                for match in BIB_KEY_RE.finditer(line):
                    key = match.group(1).strip()
                    bib_keys.append((key, relative, line_number))
                    inventory["bibliography"].append({"file": relative, "line": line_number, "key": key})

    bib_set = {key for key, _, _ in bib_keys}
    for citation in inventory["citations"]:
        if citation["key"] not in bib_set:
            findings.append(_finding("MISSING_CITATION", "critical", citation["file"], citation["line"],
                                     f"citation key {citation['key']!r} has no BibTeX record"))
    label_set = set(labels)
    for key, file, line in refs:
        if key not in label_set:
            findings.append(_finding("MISSING_LABEL", "critical", file, line, f"reference target {key!r} is undefined"))
    cited_keys = {entry["key"] for entry in inventory["citations"]}
    for key, file, line in bib_keys:
        if key not in cited_keys:
            findings.append(_finding("UNUSED_BIB", "info", file, line, f"bibliography key {key!r} is not cited"))
    return {"inventory": inventory, "findings": findings}


def compare_numbers(current: dict[str, Any], baseline: dict[str, Any]) -> list[dict[str, Any]]:
    current_by_file: dict[str, list[dict[str, Any]]] = {}
    baseline_by_file: dict[str, list[dict[str, Any]]] = {}
    for item in current["inventory"]["numbers"]:
        current_by_file.setdefault(item["file"], []).append(item)
    for item in baseline["inventory"]["numbers"]:
        baseline_by_file.setdefault(item["file"], []).append(item)
    findings: list[dict[str, Any]] = []
    for file in sorted(set(current_by_file) | set(baseline_by_file)):
        now = current_by_file.get(file, [])
        old = baseline_by_file.get(file, [])
        if len(now) != len(old):
            line = now[0]["line"] if now else 1
            findings.append(_finding("NUMERIC_COUNT_DRIFT", "major", file, line,
                                     f"baseline has {len(old)} numeric tokens; current file has {len(now)}"))
        for index, (new, previous) in enumerate(zip(now, old)):
            if (new["value"], new["unit"]) != (previous["value"], previous["unit"]):
                severity = "major" if RESULT_CUE_RE.search(" ".join([file, str(new["line"])])) else "minor"
                findings.append(_finding("NUMERIC_DRIFT", severity, file, new["line"],
                                         f"{previous['token']} {previous['unit']!r} -> {new['token']} {new['unit']!r} at token {index + 1}"))
    return findings


def lint(root: Path, baseline_root: Path | None = None) -> dict[str, Any]:
    result = scan(root)
    findings = result["findings"]
    if baseline_root is not None:
        baseline = scan(baseline_root)
        findings.extend(compare_numbers(result, baseline))
        current_citations = {entry["key"] for entry in result["inventory"]["citations"]}
        baseline_citations = {entry["key"] for entry in baseline["inventory"]["citations"]}
        if current_citations != baseline_citations:
            findings.append(_finding("CITATION_DRIFT", "major", ".", 1,
                                     f"citation key set changed: {sorted(baseline_citations)} -> {sorted(current_citations)}"))
        current_labels = {entry["key"] for entry in result["inventory"]["labels"]}
        baseline_labels = {entry["key"] for entry in baseline["inventory"]["labels"]}
        if current_labels != baseline_labels:
            findings.append(_finding("LABEL_DRIFT", "major", ".", 1,
                                     f"label set changed: {sorted(baseline_labels)} -> {sorted(current_labels)}"))
        current_refs = {entry["key"] for entry in result["inventory"]["references"]}
        baseline_refs = {entry["key"] for entry in baseline["inventory"]["references"]}
        if current_refs != baseline_refs:
            findings.append(_finding("REFERENCE_DRIFT", "major", ".", 1,
                                     f"reference target set changed: {sorted(baseline_refs)} -> {sorted(current_refs)}"))
    counts = Counter(item["severity"] for item in findings)
    decision = "FAIL" if counts["critical"] else "REVIEW" if counts["major"] else "PASS"
    result.update({
        "schema_version": 1,
        "decision": decision,
        "counts": {level: counts[level] for level in ("critical", "major", "minor", "info")},
        "findings": sorted(findings, key=lambda item: (item["file"], item["line"], item["code"])),
    })
    return result


def self_test() -> None:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="mmc-lint-") as temp:
        root = Path(temp) / "current"
        baseline = Path(temp) / "baseline"
        root.mkdir()
        baseline.mkdir()
        (root / "main.tex").write_text(
            "\\section{Results}\\label{sec:r}\nAccuracy is 92.0\\%. \\cite{ok}\n\\eqref{eq:x}\n"
            "\\begin{equation} x=1 \\label{eq:x} \\end{equation}\n", encoding="utf-8"
        )
        (root / "references.bib").write_text("@article{ok, title={A}}\n", encoding="utf-8")
        result = lint(root)
        assert result["decision"] == "PASS", result
        (baseline / "main.tex").write_text(
            "\\section{Results}\\label{sec:r}\nAccuracy is 92.0\\%. \\cite{ok}\n"
            "\\begin{equation} x=1 \\label{eq:x} \\end{equation}\n", encoding="utf-8"
        )
        (baseline / "references.bib").write_text("@article{ok, title={A}}\n", encoding="utf-8")
        (root / "main.tex").write_text("Accuracy is 91.0\\%. \\cite{missing}\n\\ref{nope}\n", encoding="utf-8")
        result = lint(root, baseline)
        assert result["decision"] == "FAIL", result
        assert any(item["code"] == "LABEL_DRIFT" for item in result["findings"])
    print("paper_lint self-test: ok")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="manuscript directory")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    if args.root is None:
        parser.error("--root is required unless --self-test is used")
    report = lint(args.root, args.baseline)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    return 0 if report["decision"] == "PASS" else 2 if report["decision"] == "REVIEW" else 1


if __name__ == "__main__":
    raise SystemExit(main())
