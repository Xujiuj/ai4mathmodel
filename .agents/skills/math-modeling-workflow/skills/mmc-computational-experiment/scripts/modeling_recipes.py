"""Small numerical recipes with explicit validation outputs.

These functions are templates, not a universal solver. Adapt the data interface and
persist their returned diagnostics in each subproblem result contract.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
from pathlib import Path

import numpy as np


def regression_metrics(actual, predicted):
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    if actual.shape != predicted.shape or actual.size == 0:
        raise ValueError("actual and predicted must be nonempty and shape-compatible")
    residual = predicted - actual
    mae = float(np.mean(np.abs(residual)))
    rmse = float(np.sqrt(np.mean(residual**2)))
    denominator = float(np.sum((actual - np.mean(actual)) ** 2))
    r2 = float(1 - np.sum(residual**2) / denominator) if denominator > 0 else None
    return {"mae": mae, "rmse": rmse, "r2": r2, "bias": float(np.mean(residual))}


def ols_fit(features, target, add_intercept=True):
    matrix = np.asarray(features, dtype=float)
    response = np.asarray(target, dtype=float)
    if matrix.ndim == 1:
        matrix = matrix[:, None]
    if matrix.ndim != 2 or response.ndim != 1 or matrix.shape[0] != response.size or response.size < 2:
        raise ValueError("features and target must define compatible observations")
    if not np.isfinite(matrix).all() or not np.isfinite(response).all():
        raise ValueError("OLS inputs must be finite")
    design = np.column_stack([np.ones(response.size), matrix]) if add_intercept else matrix
    coefficients, _, rank, singular = np.linalg.lstsq(design, response, rcond=None)
    predictions = design @ coefficients
    return {
        "coefficients": coefficients.tolist(),
        "add_intercept": bool(add_intercept),
        "rank": int(rank),
        "condition_number": float(np.linalg.cond(design)),
        "singular_values": singular.tolist(),
        "predicted": predictions.tolist(),
        "metrics": regression_metrics(response, predictions),
    }


def ahp_weights(pairwise, consistency_threshold=0.1, reciprocity_tolerance=1e-6):
    matrix = np.asarray(pairwise, dtype=float)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1] or matrix.shape[0] < 2:
        raise ValueError("AHP pairwise matrix must be square with at least two criteria")
    if not np.isfinite(matrix).all() or np.any(matrix <= 0):
        raise ValueError("AHP comparisons must be positive and finite")
    reciprocity_error = float(np.max(np.abs(matrix * matrix.T - 1)))
    diagonal_error = float(np.max(np.abs(np.diag(matrix) - 1)))
    eigenvalues, eigenvectors = np.linalg.eig(matrix)
    dominant_index = int(np.argmax(eigenvalues.real))
    dominant = float(eigenvalues[dominant_index].real)
    vector = np.abs(eigenvectors[:, dominant_index].real)
    weights = vector / vector.sum()
    size = matrix.shape[0]
    consistency_index = max((dominant - size) / (size - 1), 0.0)
    random_index = {1: 0.0, 2: 0.0, 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24,
                    7: 1.32, 8: 1.41, 9: 1.45, 10: 1.49}.get(size)
    consistency_ratio = consistency_index / random_index if random_index else 0.0 if size <= 2 else None
    accepted = reciprocity_error <= reciprocity_tolerance and diagonal_error <= reciprocity_tolerance
    if consistency_ratio is not None:
        accepted = accepted and consistency_ratio < consistency_threshold
    return {
        "weights": weights.tolist(),
        "lambda_max": dominant,
        "consistency_index": consistency_index,
        "consistency_ratio": consistency_ratio,
        "consistency_threshold": consistency_threshold,
        "reciprocity_error": reciprocity_error,
        "accepted": bool(accepted),
    }


def gm11_forecast(series, forecast_steps=1):
    values = np.asarray(series, dtype=float)
    if values.ndim != 1 or values.size < 4 or not np.isfinite(values).all() or np.any(values <= 0):
        raise ValueError("GM(1,1) requires at least four positive finite observations")
    if int(forecast_steps) < 0:
        raise ValueError("forecast_steps must be nonnegative")
    accumulated = np.cumsum(values)
    background = -0.5 * (accumulated[1:] + accumulated[:-1])
    design = np.column_stack([background, np.ones(values.size - 1)])
    development, input_term = np.linalg.lstsq(design, values[1:], rcond=None)[0]
    if abs(development) < 1e-12:
        raise ValueError("GM(1,1) development coefficient is numerically zero")
    total = values.size + int(forecast_steps)
    accumulated_hat = np.asarray([
        (values[0] - input_term / development) * math.exp(-development * index)
        + input_term / development
        for index in range(total)
    ])
    restored = np.concatenate([[values[0]], np.diff(accumulated_hat)])
    fitted = restored[:values.size]
    ratios = values[:-1] / values[1:]
    lower = math.exp(-2 / (values.size + 1))
    upper = math.exp(2 / (values.size + 1))
    return {
        "development_coefficient": float(development),
        "input_term": float(input_term),
        "fitted": fitted.tolist(),
        "forecast": restored[values.size:].tolist(),
        "metrics": regression_metrics(values, fitted),
        "level_ratio_bounds": [lower, upper],
        "level_ratio_admissible": bool(np.all((ratios > lower) & (ratios < upper))),
    }


def deterministic_kmeans(features, clusters, max_iterations=100, tolerance=1e-8):
    data = np.asarray(features, dtype=float)
    count = int(clusters)
    if data.ndim != 2 or data.shape[0] < count or count < 2 or not np.isfinite(data).all():
        raise ValueError("k-means requires a finite two-dimensional matrix and 2 <= clusters <= rows")
    if np.unique(data, axis=0).shape[0] < count:
        raise ValueError("clusters cannot exceed the number of unique rows")
    mean = data.mean(axis=0)
    centers = [data[int(np.argmin(np.sum((data - mean) ** 2, axis=1)))]]
    while len(centers) < count:
        distances = np.min(np.stack([np.sum((data - center) ** 2, axis=1) for center in centers]), axis=0)
        centers.append(data[int(np.argmax(distances))])
    centers = np.asarray(centers, dtype=float)
    iterations = 0
    for iterations in range(1, int(max_iterations) + 1):
        squared = np.stack([np.sum((data - center) ** 2, axis=1) for center in centers], axis=1)
        labels = np.argmin(squared, axis=1)
        updated = np.asarray([data[labels == index].mean(axis=0) for index in range(count)])
        shift = float(np.max(np.linalg.norm(updated - centers, axis=1)))
        centers = updated
        if shift <= tolerance:
            break
    squared = np.stack([np.sum((data - center) ** 2, axis=1) for center in centers], axis=1)
    labels = np.argmin(squared, axis=1)
    return {
        "centers": centers.tolist(),
        "labels": labels.tolist(),
        "cluster_sizes": [int(np.sum(labels == index)) for index in range(count)],
        "inertia": float(np.sum(squared[np.arange(data.shape[0]), labels])),
        "iterations": iterations,
        "converged": iterations < int(max_iterations),
    }


def split_indices(strategy, length=None, test_fraction=0.2, seed=2025, groups=None,
                  time_values=None, coordinates=None, block_size=None):
    if not 0 < float(test_fraction) < 1:
        raise ValueError("test_fraction must lie between zero and one")
    rng = np.random.default_rng(int(seed))
    strategy = str(strategy).lower()
    if strategy == "iid":
        size = int(length or 0)
        order = np.arange(size)
        rng.shuffle(order)
        test_count = max(1, min(size - 1, int(math.ceil(size * test_fraction))))
        test = sorted(order[:test_count].tolist())
    elif strategy in {"group", "spatial"}:
        if strategy == "group":
            memberships = list(groups or [])
        else:
            if not coordinates or not block_size or float(block_size) <= 0:
                raise ValueError("spatial split requires coordinates and positive block_size")
            memberships = [
                (math.floor(float(point[0]) / float(block_size)), math.floor(float(point[1]) / float(block_size)))
                for point in coordinates
            ]
        size = len(memberships)
        unique = sorted(set(memberships), key=repr)
        if len(unique) < 2:
            raise ValueError("grouped split requires at least two distinct groups or blocks")
        rng.shuffle(unique)
        group_count = max(1, min(len(unique) - 1, int(math.ceil(len(unique) * test_fraction))))
        selected = set(unique[:group_count])
        test = [index for index, membership in enumerate(memberships) if membership in selected]
    elif strategy == "time":
        values = list(time_values or [])
        size = len(values)
        if size < 2:
            raise ValueError("time split requires at least two ordered values")
        order = sorted(range(size), key=lambda index: values[index])
        test_count = max(1, min(size - 1, int(math.ceil(size * test_fraction))))
        test = sorted(order[-test_count:])
    else:
        raise ValueError("strategy must be iid, group, time, or spatial")
    if size < 2 or not test or len(test) >= size:
        raise ValueError("split must leave nonempty train and test sets")
    test_set = set(test)
    train = [index for index in range(size) if index not in test_set]
    audit = {"index_overlap": bool(set(train) & test_set), "train_rows": len(train), "test_rows": len(test)}
    if strategy in {"group", "spatial"}:
        audit["group_overlap"] = bool({memberships[index] for index in train} & {memberships[index] for index in test})
    return {"strategy": strategy, "seed": int(seed), "train_indices": train, "test_indices": test, "audit": audit}


def shortest_path(edges, source, target, directed=False):
    graph = {}
    for edge in edges:
        if len(edge) != 3:
            raise ValueError("each edge must contain source, target, and weight")
        left, right, weight = edge
        weight = float(weight)
        if not math.isfinite(weight) or weight < 0:
            raise ValueError("Dijkstra recipe requires finite nonnegative weights")
        graph.setdefault(str(left), []).append((str(right), weight))
        graph.setdefault(str(right), [])
        if not directed:
            graph[str(right)].append((str(left), weight))
    source, target = str(source), str(target)
    if source not in graph or target not in graph:
        raise ValueError("source and target must occur in the graph")
    distances = {source: 0.0}
    previous = {}
    queue = [(0.0, source)]
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if node == target:
            break
        for neighbor, weight in graph[node]:
            candidate = distance + weight
            if candidate < distances.get(neighbor, math.inf):
                distances[neighbor] = candidate
                previous[neighbor] = node
                heapq.heappush(queue, (candidate, neighbor))
    if target not in distances:
        return {"reachable": False, "distance": None, "path": []}
    path = [target]
    while path[-1] != source:
        path.append(previous[path[-1]])
    return {"reachable": True, "distance": distances[target], "path": list(reversed(path))}


def binary_linear_program(objective, constraints, maximize=False, tolerance=1e-9):
    coefficients = np.asarray(objective, dtype=float)
    if coefficients.ndim != 1 or coefficients.size < 1 or coefficients.size > 20:
        raise ValueError("binary exact baseline supports between one and twenty variables")
    if not np.isfinite(coefficients).all():
        raise ValueError("objective coefficients must be finite")
    normalized = []
    for constraint in constraints:
        lhs = np.asarray(constraint["coefficients"], dtype=float)
        sense = constraint["sense"]
        rhs = float(constraint["rhs"])
        if lhs.shape != coefficients.shape or sense not in {"<=", ">=", "=="} or not np.isfinite(lhs).all() or not math.isfinite(rhs):
            raise ValueError("invalid binary linear constraint")
        normalized.append((lhs, sense, rhs))
    best_value = -math.inf if maximize else math.inf
    best = None
    feasible_count = 0
    for mask in range(1 << coefficients.size):
        decision = np.asarray([(mask >> index) & 1 for index in range(coefficients.size)], dtype=float)
        feasible = True
        for lhs, sense, rhs in normalized:
            value = float(lhs @ decision)
            if sense == "<=" and value > rhs + tolerance:
                feasible = False
            elif sense == ">=" and value < rhs - tolerance:
                feasible = False
            elif sense == "==" and abs(value - rhs) > tolerance:
                feasible = False
            if not feasible:
                break
        if not feasible:
            continue
        feasible_count += 1
        value = float(coefficients @ decision)
        if best is None or (maximize and value > best_value + tolerance) or (not maximize and value < best_value - tolerance):
            best_value, best = value, decision.astype(int).tolist()
    if best is None:
        return {"status": "infeasible", "decision": None, "objective_value": None,
                "assignments_checked": 1 << coefficients.size, "feasible_assignments": 0}
    return {
        "status": "optimal",
        "sense": "max" if maximize else "min",
        "decision": best,
        "objective_value": best_value,
        "assignments_checked": 1 << coefficients.size,
        "feasible_assignments": feasible_count,
        "optimality_gap": 0.0,
    }


def rolling_origins(length, minimum_train, horizon, step=1):
    if minimum_train < 2 or horizon < 1 or step < 1:
        raise ValueError("invalid rolling-origin configuration")
    return [
        {"train": [0, origin], "test": [origin, origin + horizon]}
        for origin in range(minimum_train, length - horizon + 1, step)
    ]


def entropy_topsis(matrix, directions):
    data = np.asarray(matrix, dtype=float)
    if data.ndim != 2 or data.shape[0] < 2 or data.shape[1] != len(directions):
        raise ValueError("matrix/direction mismatch")
    oriented = np.empty_like(data)
    for column, direction in enumerate(directions):
        values = data[:, column]
        spread = float(np.max(values) - np.min(values))
        if spread == 0:
            oriented[:, column] = 0.0
        elif direction == "benefit":
            oriented[:, column] = (values - np.min(values)) / spread
        elif direction == "cost":
            oriented[:, column] = (np.max(values) - values) / spread
        else:
            raise ValueError("direction must be benefit or cost")
    shifted = oriented + 1e-12
    proportions = shifted / shifted.sum(axis=0)
    entropy = -(proportions * np.log(proportions)).sum(axis=0) / math.log(data.shape[0])
    diversity = 1 - entropy
    weights = diversity / diversity.sum() if diversity.sum() > 0 else np.full(data.shape[1], 1 / data.shape[1])
    weighted = oriented * weights
    positive = weighted.max(axis=0)
    negative = weighted.min(axis=0)
    d_positive = np.linalg.norm(weighted - positive, axis=1)
    d_negative = np.linalg.norm(weighted - negative, axis=1)
    closeness = d_negative / np.maximum(d_positive + d_negative, 1e-15)
    return {
        "weights": weights.tolist(),
        "closeness": closeness.tolist(),
        "rank_order": np.argsort(-closeness).tolist(),
        "normalized": oriented.tolist(),
    }


def constraint_report(values, lower=None, upper=None, equality=None, tolerance=1e-7):
    values = np.asarray(values, dtype=float)
    violations = []
    if lower is not None:
        lower = np.asarray(lower, dtype=float)
        violations.extend(np.maximum(lower - values, 0).ravel())
    if upper is not None:
        upper = np.asarray(upper, dtype=float)
        violations.extend(np.maximum(values - upper, 0).ravel())
    if equality is not None:
        violations.extend(np.abs(np.asarray(equality, dtype=float)).ravel())
    maximum = float(max(violations, default=0.0))
    return {"feasible": maximum <= tolerance, "max_violation": maximum, "tolerance": tolerance}


def monte_carlo_summary(samples, confidence=0.95):
    values = np.asarray(samples, dtype=float)
    if values.ndim != 1 or values.size < 2 or not np.isfinite(values).all():
        raise ValueError("samples must contain at least two finite values")
    alpha = 1 - confidence
    standard_error = float(np.std(values, ddof=1) / math.sqrt(values.size))
    return {
        "draws": int(values.size),
        "mean": float(np.mean(values)),
        "standard_error": standard_error,
        "interval": np.quantile(values, [alpha / 2, 1 - alpha / 2]).tolist(),
        "q05_q50_q95": np.quantile(values, [0.05, 0.5, 0.95]).tolist(),
    }


def markov_diagnostics(transition, tolerance=1e-10):
    matrix = np.asarray(transition, dtype=float)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
        raise ValueError("transition matrix must be square")
    row_error = np.abs(matrix.sum(axis=1) - 1)
    return {
        "valid": bool(np.all(matrix >= -tolerance) and np.max(row_error) <= tolerance),
        "minimum_entry": float(matrix.min()),
        "maximum_row_sum_error": float(row_error.max()),
    }


def sensitivity_table(base_parameters, evaluator, relative_changes=(-0.2, -0.1, 0.1, 0.2)):
    base_parameters = dict(base_parameters)
    base_value = float(evaluator(base_parameters))
    rows = []
    for name, original in base_parameters.items():
        if not isinstance(original, (int, float)) or original == 0:
            continue
        for change in relative_changes:
            varied = dict(base_parameters)
            varied[name] = original * (1 + change)
            value = float(evaluator(varied))
            elasticity = ((value - base_value) / base_value) / change if base_value != 0 else None
            rows.append({"parameter": name, "relative_change": change, "value": value, "elasticity": elasticity})
    return {"base_value": base_value, "rows": rows}


def _self_test():
    report = {
        "regression": regression_metrics([1, 2, 3], [1.1, 1.9, 3.2]),
        "ols": ols_fit([[0], [1], [2]], [1, 3, 5]),
        "ahp": ahp_weights([[1, 2, 4], [0.5, 1, 2], [0.25, 0.5, 1]]),
        "gm11": gm11_forecast([10, 12, 15, 18, 22], 2),
        "clusters": deterministic_kmeans([[0, 0], [0, 1], [8, 8], [9, 8]], 2),
        "split": split_indices("group", groups=["a", "a", "b", "b"], test_fraction=0.5),
        "path": shortest_path([["a", "b", 1], ["b", "c", 2], ["a", "c", 5]], "a", "c"),
        "binary": binary_linear_program(
            [8, 6, 5], [{"coefficients": [4, 3, 2], "sense": "<=", "rhs": 6}], maximize=True,
        ),
        "origins": rolling_origins(20, 10, 2, 3),
        "ranking": entropy_topsis([[2, 5], [3, 4], [5, 2]], ["benefit", "cost"]),
        "constraints": constraint_report([1, 2], lower=[0, 0], upper=[2, 2]),
        "simulation": monte_carlo_summary([1, 2, 3, 4]),
        "markov": markov_diagnostics([[0.8, 0.2], [0.1, 0.9]]),
    }
    assert report["constraints"]["feasible"]
    assert report["markov"]["valid"]
    assert report["ahp"]["accepted"]
    assert report["path"]["distance"] == 3
    assert report["binary"]["objective_value"] == 13
    assert not report["split"]["audit"]["group_overlap"]
    print(json.dumps(report, indent=2))


def run_contract(contract):
    operation = contract.get("operation")
    if operation == "regression_metrics":
        return regression_metrics(contract["actual"], contract["predicted"])
    if operation == "ols_fit":
        return ols_fit(contract["features"], contract["target"], bool(contract.get("add_intercept", True)))
    if operation == "ahp_weights":
        return ahp_weights(
            contract["pairwise"], float(contract.get("consistency_threshold", 0.1)),
            float(contract.get("reciprocity_tolerance", 1e-6)),
        )
    if operation == "gm11_forecast":
        return gm11_forecast(contract["series"], int(contract.get("forecast_steps", 1)))
    if operation == "deterministic_kmeans":
        return deterministic_kmeans(
            contract["features"], int(contract["clusters"]),
            int(contract.get("max_iterations", 100)), float(contract.get("tolerance", 1e-8)),
        )
    if operation == "split_indices":
        return split_indices(
            contract["strategy"], contract.get("length"), float(contract.get("test_fraction", 0.2)),
            int(contract.get("seed", 2025)), contract.get("groups"), contract.get("time_values"),
            contract.get("coordinates"), contract.get("block_size"),
        )
    if operation == "shortest_path":
        return shortest_path(
            contract["edges"], contract["source"], contract["target"], bool(contract.get("directed", False)),
        )
    if operation == "binary_linear_program":
        return binary_linear_program(
            contract["objective"], contract.get("constraints", []), bool(contract.get("maximize", False)),
            float(contract.get("tolerance", 1e-9)),
        )
    if operation == "rolling_origins":
        return rolling_origins(
            int(contract["length"]), int(contract["minimum_train"]),
            int(contract["horizon"]), int(contract.get("step", 1)),
        )
    if operation == "entropy_topsis":
        return entropy_topsis(contract["matrix"], contract["directions"])
    if operation == "constraint_report":
        return constraint_report(
            contract["values"], contract.get("lower"), contract.get("upper"),
            contract.get("equality"), float(contract.get("tolerance", 1e-7)),
        )
    if operation == "monte_carlo_summary":
        return monte_carlo_summary(contract["samples"], float(contract.get("confidence", 0.95)))
    if operation == "markov_diagnostics":
        return markov_diagnostics(contract["transition"], float(contract.get("tolerance", 1e-10)))
    raise ValueError(f"unsupported operation: {operation}")


def main():
    parser = argparse.ArgumentParser(description="Run a deterministic modeling recipe from a JSON contract")
    parser.add_argument("--input", help="input JSON contract")
    parser.add_argument("--output", help="write result JSON")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test or not args.input:
        _self_test()
        return 0
    contract = json.loads(Path(args.input).read_text(encoding="utf-8"))
    payload = {
        "schema_version": 1,
        "operation": contract.get("operation"),
        "result": run_contract(contract),
    }
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
