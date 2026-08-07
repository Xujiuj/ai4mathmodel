#!/usr/bin/env python3
"""Generate a small, original LaTeX starting point for a modeling paper.

This is intentionally a scaffold generator rather than a contest template. It
creates a reproducible working directory and never downloads or copies assets.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ZH_SECTIONS = [
    ("问题重述", "restatement"),
    ("问题分析", "analysis"),
    ("基本假设与符号", "assumptions"),
    ("模型建立与求解", "model"),
    ("结果与验证", "results"),
    ("敏感性分析", "sensitivity"),
    ("局限性与结论", "conclusion"),
]
EN_SECTIONS = [
    ("Restatement of the problem", "restatement"),
    ("Problem analysis", "analysis"),
    ("Assumptions and notation", "assumptions"),
    ("Model construction and solution", "model"),
    ("Results and validation", "results"),
    ("Sensitivity analysis", "sensitivity"),
    ("Limitations and conclusion", "conclusion"),
]


def _tex_escape(value: str) -> str:
    """Escape metadata while leaving generated section markup controlled."""
    replacements = {
        "&": r"\&",
        "%": r"\%",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
    }
    return "".join(replacements.get(char, char) for char in value)


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "paper"


def _normalize_subproblems(values: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for value in values or ["1"]:
        item = value.strip()
        if not item or not re.fullmatch(r"[A-Za-z0-9_-]+", item):
            raise ValueError(f"invalid subproblem id: {value!r}")
        if item not in normalized:
            normalized.append(item)
    return normalized or ["1"]


def render_tex(language: str, title: str, team_number: str, engine: str,
               subproblems: list[str] | None = None, competition: str = "generic",
               problem_choice: str = "") -> str:
    chinese = language == "zh"
    if chinese and engine == "pdflatex":
        raise ValueError("Chinese fallback scaffolds require xelatex or lualatex")
    if competition == "cumcm" and not chinese:
        raise ValueError("cumcm fallback scaffold requires Chinese")
    if competition == "mcm" and chinese:
        raise ValueError("mcm fallback scaffold requires English")
    sections = ZH_SECTIONS if chinese else EN_SECTIONS
    title_text = _tex_escape(title)
    team_text = _tex_escape(team_number) or ("待填写" if chinese else "TBD")
    if chinese:
        preamble = r"""\documentclass[11pt,a4paper]{article}
\usepackage{iftex}
\ifPDFTeX
  \PackageError{mmc-scaffold}{Chinese requires XeLaTeX or LuaLaTeX}{}
\else
  \usepackage{ctex}
\fi
\usepackage{amsmath,amssymb,booktabs,graphicx,hyperref}
\hypersetup{hidelinks}
"""
        summary_heading = "摘要"
        summary_text = "在此填写问题、模型链、主要定量结果、验证方法与适用边界。摘要最后撰写。"
    else:
        preamble = r"""\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb,booktabs,graphicx,hyperref}
\hypersetup{hidelinks}
"""
        summary_heading = "Summary"
        summary_text = "State the decision, model chain, headline quantitative results, validation, and scope. Draft this last."
    if competition == "mcm":
        identity = (
            "\\begin{center}\n"
            f"{{\\large\\bfseries Team Control Number: {team_text}}}\\hfill "
            f"{{\\large\\bfseries Problem Chosen: {_tex_escape(problem_choice) or 'TBD'}}}\\\\[1.2em]\n"
            f"{{\\LARGE\\bfseries {title_text}}}\n"
            "\\end{center}\n"
        )
    elif competition == "cumcm":
        identity = (
            "\\begin{center}\n"
            f"{{\\LARGE\\bfseries {title_text}}}\\\\[0.8em]\n"
            f"{{\\large 参赛队号：{team_text}}}\n"
            "\\end{center}\n"
        )
    else:
        identity = f"\\title{{{title_text}}}\n\\author{{Team {team_text}}}\n\\date{{}}\n\\maketitle\n"
    body = [
        preamble,
        f"\\begin{{document}}\n{identity}",
        f"% mmc:anchor=summary evidence=claim.summary\n\\begin{{abstract}}\n{summary_text}\n\\end{{abstract}}\n",
    ]
    ids = _normalize_subproblems(subproblems)
    for heading, anchor in sections:
        expanded = [(heading, anchor)]
        if anchor in {"model", "results"}:
            expanded = [(f"{heading} ({item})", f"{anchor}-S{item}") for item in ids]
        for expanded_heading, expanded_anchor in expanded:
            body.append(
                f"% mmc:anchor={expanded_anchor} evidence=\n"
                f"\\section{{{expanded_heading}}}\\label{{sec:{expanded_anchor}}}\n"
                "Replace this bounded placeholder with evidence-backed prose. "
                "Keep one controlling claim per paragraph.\n"
            )
    body.append(
        r"""% mmc:anchor=references evidence=citation.*
\bibliographystyle{plain}
\bibliography{references}
\end{document}
"""
    )
    return "\n".join(body)


def render_manifest(language: str, title: str, team_number: str, engine: str,
                    subproblems: list[str] | None = None, competition: str = "generic",
                    problem_choice: str = "") -> str:
    # YAML is emitted as plain text to keep the generator dependency-free.
    def quote(value: str) -> str:
        return json.dumps(value, ensure_ascii=False)

    ids = _normalize_subproblems(subproblems)
    section_ids: list[str] = []
    for _, anchor in (ZH_SECTIONS if language == "zh" else EN_SECTIONS):
        section_ids.extend(f"{anchor}-S{item}" for item in ids) if anchor in {"model", "results"} else section_ids.append(anchor)
    lines = [
        "schema_version: 1",
        f"language: {language}",
        f"engine: {engine}",
        f"competition_profile: {competition}",
        f"problem_choice: {quote(problem_choice)}",
        f"title: {quote(title)}",
        f"team_number: {quote(team_number)}",
        "evidence: []",
        "sections:",
    ]
    lines.extend(f"  - {anchor}" for anchor in ["summary", *section_ids, "references"])
    lines.extend([
        "integrity:",
        "  numbers_locked: false",
        "  labels_locked: false",
        "  citations_locked: false",
    ])
    return "\n".join(lines) + "\n"


def generate(output: Path, language: str, title: str, team_number: str, engine: str,
             subproblems: list[str] | None = None, competition: str = "generic",
             problem_choice: str = "") -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    (output / "figures").mkdir(exist_ok=True)
    ids = _normalize_subproblems(subproblems)
    (output / "main.tex").write_text(
        render_tex(language, title, team_number, engine, ids, competition, problem_choice), encoding="utf-8"
    )
    (output / "references.bib").write_text(
        "% Verified records only. Add one BibTeX entry per cited source.\n", encoding="utf-8"
    )
    (output / "evidence_manifest.yaml").write_text(
        render_manifest(language, title, team_number, engine, ids, competition, problem_choice), encoding="utf-8"
    )
    (output / "scaffold_manifest.json").write_text(
        json.dumps({
            "schema_version": 1,
            "generator": "independent-mmc-scaffold",
            "competition_profile": competition,
            "language": language,
            "engine": engine,
            "subproblems": ids,
            "problem_choice": problem_choice,
            "organizer_template_supersedes": True,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return [output / name for name in ("main.tex", "references.bib", "evidence_manifest.yaml", "scaffold_manifest.json")]


def self_test() -> None:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="mmc-scaffold-") as temp:
        files = generate(Path(temp) / "zh", "zh", "城市配送模型", "A-01", "xelatex", ["1", "2"], "cumcm", "A")
        text = files[0].read_text(encoding="utf-8")
        assert "\\section{问题分析}" in text
        assert "\\label{sec:model-S2}" in text
        assert "% mmc:anchor=summary" in text
        assert "numbers_locked: false" in files[2].read_text(encoding="utf-8")
        assert "competition_profile: cumcm" in files[2].read_text(encoding="utf-8")
        files = generate(Path(temp) / "en", "en", "Routing study", "B-02", "pdflatex", ["1"], "mcm", "C")
        assert "\\section{Problem analysis}" in files[0].read_text(encoding="utf-8")
        assert "Problem Chosen: C" in files[0].read_text(encoding="utf-8")
    print("generate_paper_scaffold self-test: ok")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="output paper directory")
    parser.add_argument("--language", choices=("zh", "en"), default="en")
    parser.add_argument("--title", default="Mathematical modeling study")
    parser.add_argument("--team-number", default="")
    parser.add_argument("--engine", choices=("xelatex", "lualatex", "pdflatex"), default="xelatex")
    parser.add_argument("--subproblems", default="1", help="comma-separated stable subproblem IDs, e.g. 1,2,3")
    parser.add_argument("--competition-profile", choices=("generic", "cumcm", "mcm"), default="generic")
    parser.add_argument("--problem-choice", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    if args.output is None:
        parser.error("--output is required unless --self-test is used")
    generated = generate(
        args.output, args.language, args.title, args.team_number, args.engine,
        args.subproblems.split(","), args.competition_profile, args.problem_choice,
    )
    print(f"generated {len(generated)} files in {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
