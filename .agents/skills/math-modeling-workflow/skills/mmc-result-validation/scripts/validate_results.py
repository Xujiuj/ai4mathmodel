"""Deterministic result checks for mathematical-modeling artifacts.

The module intentionally uses only the Python standard library.  It is a small
validator, not a solver: it reports evidence and a status so a workflow can
decide whether a claim is publishable.  Input/output are JSON for easy use from
the desktop runtime and for reproducible archived checks.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any, Iterable, Sequence


EPS = 1e-12


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def _numbers(values: Iterable[Any], name: str, minimum: int = 1) -> list[float]:
    result = [float(value) for value in values]
    if len(result) < minimum or not all(math.isfinite(value) for value in result):
        raise ValueError(f"{name} must contain at least {minimum} finite numbers")
    return result


def _mean(values: Sequence[float]) -> float:
    return statistics.fmean(values)


def _rmse(actual: Sequence[float], predicted: Sequence[float]) -> float:
    return math.sqrt(_mean([(a - p) ** 2 for a, p in zip(actual, predicted)]))


def _mae(actual: Sequence[float], predicted: Sequence[float]) -> float:
    return _mean([abs(a - p) for a, p in zip(actual, predicted)])


def _status(ok: bool, evidence: dict[str, Any], failures: list[str]) -> dict[str, Any]:
    return {
        "status": "passed" if ok else "failed",
        "ok": bool(ok),
        "failures": failures,
        "evidence": evidence,
    }


def rolling_origin_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Check ordered holdouts against a last-observation baseline.

    ``predicted`` is indexed like ``actual``.  ``origins`` contains either
    ``{train_end, horizon}`` or explicit ``{train_end, test_start, test_end}``
    entries, with the end indices exclusive.  A supplied ``baseline`` may be
    indexed like actual; otherwise the previous observed value is repeated.
    """
    actual = _numbers(payload.get("actual", []), "actual", 4)
    predicted = _numbers(payload.get("predicted", []), "predicted", len(actual))
    if len(predicted) != len(actual):
        raise ValueError("actual and predicted must have the same length")
    raw_origins = payload.get("origins") or []
    if not raw_origins:
        minimum_train = int(payload.get("minimum_train", max(2, len(actual) // 2)))
        horizon = int(payload.get("horizon", 1))
        step = int(payload.get("step", 1))
        raw_origins = [
            {"train_end": i, "test_start": i, "test_end": i + horizon}
            for i in range(minimum_train, len(actual) - horizon + 1, step)
        ]
    baseline_input = payload.get("baseline")
    baseline = _numbers(baseline_input, "baseline", len(actual)) if baseline_input is not None else None
    if baseline is not None and len(baseline) != len(actual):
        raise ValueError("baseline must have the same length as actual")
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    for index, raw in enumerate(raw_origins):
        train_end = int(raw["train_end"])
        test_start = int(raw.get("test_start", train_end))
        test_end = int(raw.get("test_end", test_start + int(raw["horizon"])))
        if train_end < 1 or test_start < train_end or test_end <= test_start or test_end > len(actual):
            failures.append(f"origin {index}: invalid or overlapping train/test bounds")
            continue
        observed = actual[test_start:test_end]
        fitted = predicted[test_start:test_end]
        if baseline is None:
            reference = [actual[train_end - 1]] * len(observed)
        else:
            reference = baseline[test_start:test_end]
        rows.append({
            "origin": index,
            "train_end": train_end,
            "test_start": test_start,
            "test_end": test_end,
            "n": len(observed),
            "model_rmse": _rmse(observed, fitted),
            "baseline_rmse": _rmse(observed, reference),
            "model_mae": _mae(observed, fitted),
            "baseline_mae": _mae(observed, reference),
        })
    if not rows:
        failures.append("no valid rolling-origin holdouts")
    model_rmse = _mean([row["model_rmse"] for row in rows]) if rows else math.inf
    baseline_rmse = _mean([row["baseline_rmse"] for row in rows]) if rows else math.inf
    tolerance = float(payload.get("relative_tolerance", 0.0))
    relative_gain = (baseline_rmse - model_rmse) / max(abs(baseline_rmse), EPS)
    if rows and relative_gain < -tolerance:
        failures.append("model is worse than the ordered naive baseline")
    if any(row["test_start"] < row["train_end"] for row in rows):
        failures.append("temporal leakage detected")
    return _status(
        not failures,
        {"origins": rows, "mean_model_rmse": model_rmse, "mean_baseline_rmse": baseline_rmse,
         "relative_gain": relative_gain, "holdouts": len(rows)},
        failures,
    )


def optimization_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Check bound/equality/inequality residuals and a reported optimality gap."""
    x = _numbers(payload.get("x", []), "x", 1)
    tolerance = float(payload.get("tolerance", 1e-7))
    residuals: dict[str, list[float]] = {"lower": [], "upper": [], "equality": [], "inequality": []}
    lower = payload.get("lower")
    upper = payload.get("upper")
    if lower is not None:
        values = _numbers(lower, "lower", len(x))
        if len(values) != len(x):
            raise ValueError("lower and x must have the same length")
        residuals["lower"] = [max(0.0, lo - value) for lo, value in zip(values, x)]
    if upper is not None:
        values = _numbers(upper, "upper", len(x))
        if len(values) != len(x):
            raise ValueError("upper and x must have the same length")
        residuals["upper"] = [max(0.0, value - hi) for value, hi in zip(x, values)]
    residuals["equality"] = [abs(float(value)) for value in payload.get("equality_residuals", [])]
    residuals["inequality"] = [max(0.0, float(value)) for value in payload.get("inequality_residuals", [])]
    if any(not math.isfinite(value) for values in residuals.values() for value in values):
        raise ValueError("constraint residuals must be finite")
    maximum = max((value for values in residuals.values() for value in values), default=0.0)
    objective = float(payload.get("objective_value"))
    if not math.isfinite(objective):
        raise ValueError("objective_value must be finite")
    sense = str(payload.get("sense", "min")).lower()
    if sense not in {"min", "max"}:
        raise ValueError("sense must be min or max")
    gaps: dict[str, float] = {}
    if payload.get("best_known") is not None:
        best = float(payload["best_known"])
        gaps["best_known_relative"] = abs(objective - best) / max(abs(best), 1.0)
    if payload.get("bound") is not None:
        bound = float(payload["bound"])
        signed = objective - bound if sense == "min" else bound - objective
        gaps["bound_relative"] = max(0.0, signed) / max(abs(objective), 1.0)
    gap_limit = float(payload.get("gap_tolerance", tolerance))
    gap_failures = [f"{name} exceeds gap tolerance" for name, value in gaps.items() if value > gap_limit]
    independent: dict[str, Any] = {}
    independent_failures: list[str] = []
    coefficients = payload.get("objective_coefficients")
    linear_constraints = payload.get("linear_constraints")
    if coefficients is not None:
        coefficients = _numbers(coefficients, "objective_coefficients", len(x))
        if len(coefficients) != len(x):
            raise ValueError("objective_coefficients and x must have the same length")
        recomputed_objective = sum(coefficient * value for coefficient, value in zip(coefficients, x))
        independent["recomputed_objective"] = recomputed_objective
        if abs(recomputed_objective - objective) > tolerance:
            independent_failures.append("reported objective does not match the decision vector")
    if linear_constraints is not None:
        recomputed_residuals = []
        for constraint in linear_constraints:
            lhs = _numbers(constraint.get("coefficients", []), "linear constraint coefficients", len(x))
            if len(lhs) != len(x):
                raise ValueError("linear constraint coefficients and x must have the same length")
            value = sum(coefficient * decision for coefficient, decision in zip(lhs, x))
            rhs = float(constraint["rhs"])
            constraint_sense = str(constraint["sense"])
            if constraint_sense == "<=":
                violation = max(0.0, value - rhs)
            elif constraint_sense == ">=":
                violation = max(0.0, rhs - value)
            elif constraint_sense == "==":
                violation = abs(value - rhs)
            else:
                raise ValueError("linear constraint sense must be <=, >=, or ==")
            recomputed_residuals.append({"lhs": value, "sense": constraint_sense, "rhs": rhs, "violation": violation})
        independent["recomputed_constraints"] = recomputed_residuals
        if any(row["violation"] > tolerance for row in recomputed_residuals):
            independent_failures.append("independently recomputed constraint residual exceeds tolerance")
    if payload.get("exact_binary_check"):
        if coefficients is None or linear_constraints is None:
            raise ValueError("exact_binary_check requires objective_coefficients and linear_constraints")
        if len(x) > 20:
            raise ValueError("exact binary validation supports at most twenty variables")
        optimum = None
        feasible_assignments = 0
        for mask in range(1 << len(x)):
            decision = [(mask >> index) & 1 for index in range(len(x))]
            feasible = True
            for constraint in linear_constraints:
                value = sum(float(coefficient) * selected for coefficient, selected in zip(constraint["coefficients"], decision))
                rhs = float(constraint["rhs"])
                constraint_sense = str(constraint["sense"])
                feasible = ((constraint_sense == "<=" and value <= rhs + tolerance)
                            or (constraint_sense == ">=" and value >= rhs - tolerance)
                            or (constraint_sense == "==" and abs(value - rhs) <= tolerance))
                if not feasible:
                    break
            if not feasible:
                continue
            feasible_assignments += 1
            value = sum(coefficient * selected for coefficient, selected in zip(coefficients, decision))
            optimum = value if optimum is None else (max(optimum, value) if sense == "max" else min(optimum, value))
        independent["exact_binary_optimum"] = optimum
        independent["exact_binary_feasible_assignments"] = feasible_assignments
        if optimum is None:
            independent_failures.append("exact binary check found no feasible assignment")
        elif abs(objective - optimum) > gap_limit:
            independent_failures.append("reported objective is not exact-binary optimal")
    failures = ([] if maximum <= tolerance else ["constraint residual exceeds tolerance"]) + gap_failures + independent_failures
    return _status(
        not failures,
        {"objective_value": objective, "sense": sense, "max_constraint_residual": maximum,
         "constraint_residuals": residuals, "gaps": gaps, "tolerance": tolerance,
         "gap_tolerance": gap_limit, "independent_recomputation": independent},
        failures,
    )


def _dot(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right):
        raise ValueError("state and invariant weights must have the same length")
    return sum(a * b for a, b in zip(left, right))


def ode_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Check a linear invariant and convergence across step sizes."""
    states = [[float(value) for value in row] for row in payload.get("states", [])]
    if len(states) < 2 or not states[0] or any(len(row) != len(states[0]) for row in states):
        raise ValueError("states must contain at least two equal-length finite rows")
    if any(not _finite(value) for row in states for value in row):
        raise ValueError("states must be finite")
    invariant_values = payload.get("invariant_values")
    if invariant_values is None:
        weights = _numbers(payload.get("invariant_weights", []), "invariant_weights", len(states[0]))
        if len(weights) != len(states[0]):
            raise ValueError("invariant_weights and state width must match")
        invariant_values = [_dot(row, weights) for row in states]
    else:
        invariant_values = _numbers(invariant_values, "invariant_values", len(states))
        if len(invariant_values) != len(states):
            raise ValueError("invariant_values and states must have the same length")
    initial = invariant_values[0]
    scale = max(abs(initial), 1.0)
    conservation_error = max(abs(value - initial) / scale for value in invariant_values)
    runs = payload.get("step_runs") or []
    convergence_rows: list[dict[str, float]] = []
    for left, right in zip(runs, runs[1:]):
        left_state = _numbers(left["final_state"], "step final_state", 1)
        right_state = _numbers(right["final_state"], "step final_state", len(left_state))
        if len(left_state) != len(right_state):
            raise ValueError("step runs must have equal final-state widths")
        difference = max(abs(a - b) for a, b in zip(left_state, right_state))
        convergence_rows.append({"coarse_step": float(left["step"]), "fine_step": float(right["step"]),
                                 "max_difference": difference})
    nonincreasing = all(
        convergence_rows[i + 1]["max_difference"] <= convergence_rows[i]["max_difference"] * (1 + 1e-9)
        for i in range(len(convergence_rows) - 1)
    )
    tolerance = float(payload.get("tolerance", 1e-6))
    failures = []
    if conservation_error > tolerance:
        failures.append("conservation error exceeds tolerance")
    if convergence_rows and not nonincreasing:
        failures.append("step refinement does not reduce successive differences")
    return _status(
        not failures,
        {"initial_invariant": initial, "final_invariant": invariant_values[-1],
         "max_relative_conservation_error": conservation_error, "step_convergence": convergence_rows,
         "nonincreasing_difference": nonincreasing, "tolerance": tolerance},
        failures,
    )


def _lag1(values: Sequence[float]) -> float:
    if len(values) < 3:
        return 0.0
    mean = _mean(values)
    centered = [value - mean for value in values]
    denominator = sum(value * value for value in centered)
    return sum(a * b for a, b in zip(centered, centered[1:])) / denominator if denominator > EPS else 0.0


def monte_carlo_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Estimate MCSE, account for lag-one autocorrelation, and inspect warm-up."""
    raw = _numbers(payload.get("samples", []), "samples", 4)
    warmup = int(payload.get("warmup", 0))
    if warmup < 0 or warmup >= len(raw) - 2:
        raise ValueError("warmup must leave at least two post-warmup samples")
    values = raw[warmup:]
    stdev = statistics.stdev(values) if len(values) > 1 else 0.0
    rho = max(-0.99, min(0.99, _lag1(values)))
    iid_mcse = stdev / math.sqrt(len(values))
    effective_n = len(values) * (1 - rho) / max(1 + rho, EPS)
    adjusted_mcse = stdev / math.sqrt(max(effective_n, 1.0))
    full_mean = _mean(raw)
    post_mean = _mean(values)
    shift = abs(post_mean - full_mean)
    scale = max(stdev, abs(post_mean), 1.0)
    warmup_limit = float(payload.get("warmup_tolerance", 0.05)) * scale
    target = float(payload.get("mcse_target", 0.05))
    relative_mcse = adjusted_mcse / max(abs(post_mean), 1.0)
    failures = []
    if relative_mcse > target:
        failures.append("adjusted MCSE exceeds target")
    if warmup and shift > warmup_limit:
        failures.append("post-warm-up mean differs materially from full-chain mean")
    batch_size = int(payload.get("batch_size", 0))
    batch_mcse = None
    if batch_size > 1 and len(values) >= 2 * batch_size:
        batches = [_mean(values[i:i + batch_size]) for i in range(0, len(values) - batch_size + 1, batch_size)]
        if len(batches) > 1:
            batch_mcse = statistics.stdev(batches) / math.sqrt(len(batches))
    return _status(
        not failures,
        {"draws": len(values), "warmup": warmup, "mean": post_mean, "stdev": stdev,
         "lag1_autocorrelation": rho, "effective_sample_size": effective_n,
         "iid_mcse": iid_mcse, "adjusted_mcse": adjusted_mcse, "relative_mcse": relative_mcse,
         "full_chain_mean": full_mean, "warmup_shift": shift, "warmup_limit": warmup_limit,
         "batch_mcse": batch_mcse, "mcse_target": target},
        failures,
    )


def _normalize_column(values: Sequence[float], direction: str) -> list[float]:
    low, high = min(values), max(values)
    if abs(high - low) <= EPS:
        return [0.5] * len(values)
    if direction == "cost":
        return [(high - value) / (high - low) for value in values]
    if direction != "benefit":
        raise ValueError("direction must be benefit or cost")
    return [(value - low) / (high - low) for value in values]


def _rank_order(scores: Sequence[float]) -> list[int]:
    return sorted(range(len(scores)), key=lambda index: (-scores[index], index))


def _kendall_tau(left: Sequence[int], right: Sequence[int]) -> float:
    positions = {item: index for index, item in enumerate(right)}
    concordant = discordant = 0
    for i, first in enumerate(left):
        for second in left[i + 1:]:
            if positions[first] < positions[second]:
                concordant += 1
            else:
                discordant += 1
    total = concordant + discordant
    return (concordant - discordant) / total if total else 1.0


def ranking_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Detect top-rank and pairwise reversals under plausible weight changes."""
    matrix = [[float(value) for value in row] for row in payload.get("matrix", [])]
    if len(matrix) < 2 or not matrix[0] or any(len(row) != len(matrix[0]) for row in matrix):
        raise ValueError("matrix must contain at least two equal-width rows")
    if any(not math.isfinite(value) for row in matrix for value in row):
        raise ValueError("matrix values must be finite")
    columns = len(matrix[0])
    weights = _numbers(payload.get("weights", [1.0] * columns), "weights", columns)
    if len(weights) != columns or any(weight < 0 for weight in weights) or sum(weights) <= EPS:
        raise ValueError("weights must be nonnegative and nonzero")
    directions = list(payload.get("directions", ["benefit"] * columns))
    if len(directions) != columns:
        raise ValueError("directions and matrix width must match")
    method = str(payload.get("method", "weighted_sum")).lower()
    if method not in {"weighted_sum", "topsis"}:
        raise ValueError("ranking method must be weighted_sum or topsis")

    def score(selected_weights: list[float], selected_directions: list[str]) -> list[float]:
        normalized = [_normalize_column([row[col] for row in matrix], selected_directions[col]) for col in range(columns)]
        total = sum(selected_weights)
        normalized_weights = [weight / total for weight in selected_weights]
        weighted = [
            [normalized[col][row] * normalized_weights[col] for col in range(columns)]
            for row in range(len(matrix))
        ]
        if method == "weighted_sum":
            return [sum(row) for row in weighted]
        positive = [max(row[col] for row in weighted) for col in range(columns)]
        negative = [min(row[col] for row in weighted) for col in range(columns)]
        result = []
        for row in weighted:
            distance_positive = math.sqrt(sum((value - ideal) ** 2 for value, ideal in zip(row, positive)))
            distance_negative = math.sqrt(sum((value - anti) ** 2 for value, anti in zip(row, negative)))
            result.append(distance_negative / max(distance_positive + distance_negative, EPS))
        return result

    scores = score(weights, directions)
    baseline = _rank_order(scores)
    perturbations = payload.get("perturbations") or []
    rows = []
    failures = []
    threshold = float(payload.get("minimum_kendall", 0.8))
    for index, perturbation in enumerate(perturbations):
        varied_weights = _numbers(perturbation.get("weights", weights), "perturbation weights", columns)
        if len(varied_weights) != columns or any(weight < 0 for weight in varied_weights) or sum(varied_weights) <= EPS:
            raise ValueError("perturbation weights must be nonnegative and nonzero")
        varied_directions = list(perturbation.get("directions", directions))
        if len(varied_directions) != columns:
            raise ValueError("perturbation directions and matrix width must match")
        varied_scores = score(varied_weights, varied_directions)
        order = _rank_order(varied_scores)
        tau = _kendall_tau(baseline, order)
        top_changed = order[0] != baseline[0]
        rows.append({"perturbation": index, "rank_order": order, "top_changed": top_changed, "kendall_tau": tau})
        if top_changed or tau < threshold:
            failures.append(f"perturbation {index}: ranking is unstable")
    return _status(
        not failures,
        {"method": method, "baseline_scores": scores, "baseline_rank_order": baseline, "perturbations": rows,
         "minimum_kendall": threshold},
        failures,
    )


CHECKS = {
    "rolling_origin": rolling_origin_check,
    "optimization": optimization_check,
    "ode": ode_check,
    "monte_carlo": monte_carlo_check,
    "ranking": ranking_check,
}


def run_payload(payload: dict[str, Any]) -> dict[str, Any]:
    checks = payload.get("checks") if isinstance(payload, dict) else None
    if checks is None:
        checks = [payload]
    if not checks:
        return {"schemaVersion": 1, "checks": [], "ok": False,
                "error": "at least one validation check is required"}
    reports = []
    for index, check in enumerate(checks):
        kind = str(check.get("kind", ""))
        if kind not in CHECKS:
            entry = {"check": index, "kind": kind, "status": "failed", "ok": False,
                     "failures": [f"unknown check kind: {kind}"], "evidence": {}}
            for key in ("id", "claim_id", "subproblem_id"):
                if key in check:
                    entry[key] = check[key]
            reports.append(entry)
            continue
        try:
            report = CHECKS[kind](check)
        except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
            report = {"status": "failed", "ok": False, "failures": [str(error)], "evidence": {}}
        report_entry = {"check": index, "kind": kind, **report}
        for key in ("id", "claim_id", "subproblem_id"):
            if key in check:
                report_entry[key] = check[key]
        reports.append(report_entry)
    return {"schemaVersion": 1, "checks": reports, "ok": all(report["ok"] for report in reports)}


def self_test() -> dict[str, Any]:
    payload = {"checks": [
        {"kind": "rolling_origin", "actual": [1, 2, 3, 4, 5, 6, 7, 8],
         "predicted": [0, 2.1, 3.0, 4.1, 5.1, 6.1, 7.0, 8.1],
         "origins": [{"train_end": 3, "horizon": 2}, {"train_end": 5, "horizon": 2}]},
        {"kind": "optimization", "x": [1, 0, 1], "lower": [0, 0, 0], "upper": [1, 1, 1],
         "objective_value": 13, "best_known": 13, "sense": "max",
         "objective_coefficients": [8, 6, 5], "exact_binary_check": True,
         "linear_constraints": [{"coefficients": [4, 3, 2], "sense": "<=", "rhs": 6}]},
        {"kind": "ode", "states": [[1, 2], [0.9, 2.1], [0.8, 2.2]], "invariant_weights": [1, 1],
         "step_runs": [{"step": 0.2, "final_state": [0.8, 2.2]}, {"step": 0.1, "final_state": [0.81, 2.19]}]},
        {"kind": "monte_carlo", "samples": [10 + (i % 3) * 0.01 for i in range(40)], "warmup": 4,
         "mcse_target": 0.01},
        {"kind": "ranking", "matrix": [[9, 1], [6, 4], [2, 8]], "weights": [0.6, 0.4],
         "perturbations": [{"weights": [0.55, 0.45]}, {"weights": [0.65, 0.35]}]},
    ]}
    report = run_payload(payload)
    if not report["ok"]:
        raise AssertionError(json.dumps(report, indent=2))
    false_optimum = optimization_check({
        "x": [1, 0, 0], "objective_value": 8, "best_known": 8, "sense": "max",
        "objective_coefficients": [8, 6, 5], "exact_binary_check": True,
        "linear_constraints": [{"coefficients": [4, 3, 2], "sense": "<=", "rhs": 6}],
    })
    if false_optimum["ok"] or "reported objective is not exact-binary optimal" not in false_optimum["failures"]:
        raise AssertionError("exact binary validation accepted a false optimum")
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run reproducible mathematical-modeling result checks")
    parser.add_argument("--input", type=Path, help="JSON file containing one check or {checks: [...]}")
    parser.add_argument("--output", type=Path, help="write report JSON to this path")
    parser.add_argument("--self-test", action="store_true", help="run built-in checks")
    args = parser.parse_args(argv)
    if args.self_test:
        report = self_test()
    elif args.input:
        report = run_payload(json.loads(args.input.read_text(encoding="utf-8")))
    else:
        parser.error("provide --input or --self-test")
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    else:
        print(encoded)
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
