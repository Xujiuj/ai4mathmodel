"""Deterministic CSV profiler for a modeling project.

Copy this recipe into the active solving stage and run it against a declared CSV.
It uses the Python standard library so it also works before scientific packages load.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime
from pathlib import Path


MISSING = {"", "na", "n/a", "nan", "null", "none", "-"}


def parse_number(value: str):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def quantile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def parse_datetime(value: str):
    candidate = value.strip()
    if not candidate or re.fullmatch(r"[+-]?\d+(?:\.\d+)?", candidate):
        return None
    normalized = candidate[:-1] + "+00:00" if candidate.endswith("Z") else candidate
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass
    for pattern in ("%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y", "%Y-%m", "%Y/%m"):
        try:
            return datetime.strptime(candidate, pattern)
        except ValueError:
            continue
    return None


def infer_unit(name: str):
    match = re.search(r"(?:\(([^()]+)\)|\[([^\[\]]+)\])\s*$", name)
    if match:
        return (match.group(1) or match.group(2)).strip()
    suffix = re.search(r"_(kg|g|mg|km|m|cm|mm|s|min|h|day|days|usd|cny|pct|percent)$", name, re.I)
    return suffix.group(1) if suffix else None


def median_step_seconds(values):
    ordered = sorted(set(values))
    if len(ordered) < 2:
        return None
    steps = [(right - left).total_seconds() for left, right in zip(ordered, ordered[1:])]
    return quantile(steps, 0.5)


def profile_csv(path: Path, encoding: str = "utf-8-sig"):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with path.open("r", encoding=encoding, newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        columns = {field: [] for field in fields}
        row_count = 0
        duplicate_counter = Counter()
        for row in reader:
            row_count += 1
            duplicate_counter[tuple(row.get(field, "") for field in fields)] += 1
            for field in fields:
                columns[field].append((row.get(field) or "").strip())

    summaries = []
    for field, raw_values in columns.items():
        missing = sum(value.lower() in MISSING for value in raw_values)
        observed = [value for value in raw_values if value.lower() not in MISSING]
        numbers = [parse_number(value) for value in observed]
        numeric = [value for value in numbers if value is not None]
        is_numeric = bool(observed) and len(numeric) / len(observed) >= 0.95
        dates = [parse_datetime(value) for value in observed]
        parsed_dates = [value for value in dates if value is not None]
        is_datetime = not is_numeric and bool(observed) and len(parsed_dates) / len(observed) >= 0.95
        summary = {
            "name": field,
            "observed_type": "numeric" if is_numeric else "datetime" if is_datetime else "text_or_category",
            "unit_candidate": infer_unit(field),
            "non_missing_count": len(observed),
            "missing_count": missing,
            "missing_rate": missing / row_count if row_count else 0.0,
            "unique_count": len(set(observed)),
            "identifier_candidate": bool(observed)
            and len(set(observed)) == len(observed)
            and (bool(re.search(r"(?:^|_)(?:id|key|code)(?:$|_)", field, re.I)) or (not is_numeric and not is_datetime)),
        }
        if is_numeric:
            q25 = quantile(numeric, 0.25)
            q75 = quantile(numeric, 0.75)
            iqr = q75 - q25
            mean = sum(numeric) / len(numeric)
            variance = sum((value - mean) ** 2 for value in numeric) / max(len(numeric) - 1, 1)
            summary["numeric"] = {
                "min": min(numeric),
                "q25": q25,
                "median": quantile(numeric, 0.5),
                "q75": q75,
                "max": max(numeric),
                "mean": mean,
                "standard_deviation": math.sqrt(variance),
                "iqr_outlier_count": sum(value < q25 - 1.5 * iqr or value > q75 + 1.5 * iqr for value in numeric),
                "zero_count": sum(value == 0 for value in numeric),
                "negative_count": sum(value < 0 for value in numeric),
            }
        elif is_datetime:
            summary["datetime"] = {
                "start": min(parsed_dates).isoformat(),
                "end": max(parsed_dates).isoformat(),
                "median_step_seconds": median_step_seconds(parsed_dates),
                "monotonic_non_decreasing": all(
                    left <= right for left, right in zip(parsed_dates, parsed_dates[1:])
                ),
            }
        else:
            summary["top_values"] = Counter(observed).most_common(10)
        summaries.append(summary)

    return {
        "schema_version": 1,
        "path": path.as_posix(),
        "sha256": digest,
        "rows": row_count,
        "columns": len(fields),
        "duplicate_rows": sum(count - 1 for count in duplicate_counter.values() if count > 1),
        "candidate_keys": [item["name"] for item in summaries if item["identifier_candidate"]],
        "time_fields": [item["name"] for item in summaries if item["observed_type"] == "datetime"],
        "fields": summaries,
    }


def self_test():
    import tempfile

    with tempfile.TemporaryDirectory(prefix="mmc-profile-") as directory:
        source = Path(directory) / "fixture.csv"
        source.write_text(
            "id,date,value_kg,group\n"
            "a,2025-01-01,1.0,x\n"
            "b,2025-01-02,2.0,x\n"
            "c,2025-01-03,100.0,y\n",
            encoding="utf-8",
        )
        report = profile_csv(source)
        assert report["rows"] == 3
        assert report["candidate_keys"] == ["id"]
        assert report["time_fields"] == ["date"]
        value = next(item for item in report["fields"] if item["name"] == "value_kg")
        assert value["unit_candidate"] == "kg"
    print("profile_dataset self-test: ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, nargs="?")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--encoding", default="utf-8-sig")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.input is None:
        parser.error("input is required unless --self-test is used")
    report = profile_csv(args.input, args.encoding)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
