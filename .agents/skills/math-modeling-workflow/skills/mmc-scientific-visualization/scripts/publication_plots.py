"""Signed publication-plot recipe for mathematical-modeling results.

Execute this module through the built-in recipe tool with a JSON figure contract.
It never invents domain data and exports figures, plotted data, provenance, and QA.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import struct
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#000000"]


def apply_style():
    plt.rcParams.update({
        "font.size": 8,
        "axes.labelsize": 8,
        "axes.titlesize": 9,
        "legend.fontsize": 7,
        "xtick.labelsize": 7,
        "ytick.labelsize": 7,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": False,
        "savefig.bbox": "tight",
        "savefig.transparent": False,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "none",
    })


def export_figure(fig, output_stem, plotted_rows=None, manifest=None, dpi=300):
    stem = Path(output_stem)
    stem.parent.mkdir(parents=True, exist_ok=True)
    exports = []
    for extension in ("pdf", "svg", "png"):
        target = stem.with_suffix(f".{extension}")
        fig.savefig(target, dpi=dpi if extension == "png" else None)
        exports.append(target.as_posix())
    if plotted_rows:
        data_target = stem.with_name(f"{stem.name}_data.csv")
        keys = list(plotted_rows[0])
        with data_target.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=keys)
            writer.writeheader()
            writer.writerows(plotted_rows)
    else:
        data_target = None
    manifest_target = stem.with_name(f"{stem.name}_manifest.json")
    payload = dict(manifest or {})
    artifacts = []
    for target in [Path(item) for item in exports] + ([data_target] if data_target else []):
        artifacts.append({
            "path": target.as_posix(),
            "bytes": target.stat().st_size,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        })
    png_target = stem.with_suffix(".png")
    with png_target.open("rb") as handle:
        header = handle.read(24)
    width_px, height_px = struct.unpack(">II", header[16:24])
    pixels = plt.imread(png_target)
    rgb = pixels[..., :3]
    ink = np.any(rgb < 0.985, axis=2)
    edge = max(2, int(min(width_px, height_px) * 0.003))
    edge_contact = bool(
        np.any(ink[:edge, :]) or np.any(ink[-edge:, :])
        or np.any(ink[:, :edge]) or np.any(ink[:, -edge:])
    )
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    text_boxes = [
        artist.get_window_extent(renderer)
        for artist in fig.findobj(match=matplotlib.text.Text)
        if artist.get_visible() and artist.get_text().strip()
    ]
    text_bounds_valid = all(
        all(math.isfinite(value) for value in (box.x0, box.y0, box.x1, box.y1))
        and box.width > 0 and box.height > 0
        for box in text_boxes
    )
    font_sizes = [
        float(artist.get_fontsize())
        for artist in fig.findobj(match=matplotlib.text.Text)
        if artist.get_visible() and artist.get_text().strip()
    ]
    numeric_values = [
        value for row in plotted_rows or [] for value in row.values()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]
    checks = {
        "exports_nonempty": all(item["bytes"] > 0 for item in artifacts),
        "vector_exports_present": stem.with_suffix(".pdf").exists() and stem.with_suffix(".svg").exists(),
        "plotted_data_present": data_target is not None and data_target.exists(),
        "minimum_raster_size": width_px >= 900 and height_px >= 600,
        "nonblank_canvas": float(np.mean(ink)) >= 0.002,
        "no_edge_clipping": not edge_contact,
        "text_bounds_valid": text_bounds_valid,
        "minimum_font_size": not font_sizes or min(font_sizes) >= 6.0,
        "plotted_values_finite": all(math.isfinite(float(value)) for value in numeric_values),
        "claim_declared": bool((manifest or {}).get("claim")),
        "uncertainty_declared": bool((manifest or {}).get("uncertainty")),
    }
    qa_target = stem.with_name(f"{stem.name}_qa.json")
    qa = {
        "status": "PASS" if all(checks.values()) else "FAIL",
        "png_dimensions_px": [width_px, height_px],
        "declared_dpi": dpi,
        "plotted_rows": len(plotted_rows or []),
        "nonwhite_fraction": float(np.mean(ink)),
        "minimum_font_points": min(font_sizes) if font_sizes else None,
        "checks": checks,
    }
    qa_target.write_text(json.dumps(qa, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    payload.update({
        "schema_version": 1,
        "exports": exports,
        "plotted_data": data_target.as_posix() if data_target else None,
        "qa_report": qa_target.as_posix(),
        "artifacts": artifacts,
    })
    manifest_target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def line_interval(x, center, lower, upper, *, xlabel, ylabel, label=None, color=COLORS[0], width=3.35):
    apply_style()
    x = np.asarray(x)
    center, lower, upper = map(lambda value: np.asarray(value, dtype=float), (center, lower, upper))
    if not (x.shape == center.shape == lower.shape == upper.shape):
        raise ValueError("line interval arrays must share a shape")
    fig, ax = plt.subplots(figsize=(width, width * 0.64), constrained_layout=True)
    ax.fill_between(x, lower, upper, color=color, alpha=0.18, linewidth=0)
    ax.plot(x, center, color=color, linewidth=1.6, label=label)
    ax.scatter(x, center, color=color, s=9, zorder=3)
    ax.set(xlabel=xlabel, ylabel=ylabel)
    if label:
        ax.legend(frameon=False)
    return fig


def prediction_diagnostics(actual, predicted, *, unit="", groups=None, width=7.0):
    apply_style()
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    if actual.shape != predicted.shape or actual.ndim != 1 or actual.size < 3:
        raise ValueError("actual and predicted must be equal one-dimensional arrays")
    residual = predicted - actual
    fig, axes = plt.subplots(2, 2, figsize=(width, width * 0.72), constrained_layout=True)
    low = float(min(actual.min(), predicted.min()))
    high = float(max(actual.max(), predicted.max()))
    axes[0, 0].scatter(actual, predicted, s=16, alpha=0.75, color=COLORS[0])
    axes[0, 0].plot([low, high], [low, high], linestyle="--", color="#555555", linewidth=1)
    axes[0, 0].set(xlabel=f"Observed {unit}".strip(), ylabel=f"Predicted {unit}".strip())
    axes[0, 1].scatter(predicted, residual, s=16, alpha=0.75, color=COLORS[1])
    axes[0, 1].axhline(0, linestyle="--", color="#555555", linewidth=1)
    axes[0, 1].set(xlabel=f"Predicted {unit}".strip(), ylabel=f"Residual {unit}".strip())
    axes[1, 0].hist(residual, bins="auto", color=COLORS[2], alpha=0.75, edgecolor="white")
    axes[1, 0].axvline(0, linestyle="--", color="#555555", linewidth=1)
    axes[1, 0].set(xlabel=f"Residual {unit}".strip(), ylabel="Count")
    if groups is None:
        order = np.argsort(predicted)
        axes[1, 1].plot(np.arange(actual.size), np.abs(residual)[order], color=COLORS[3], linewidth=1.2)
        axes[1, 1].set(xlabel="Cases ordered by prediction", ylabel=f"Absolute error {unit}".strip())
    else:
        groups = np.asarray(groups)
        labels = list(dict.fromkeys(groups.tolist()))
        values = [np.abs(residual[groups == label]) for label in labels]
        axes[1, 1].boxplot(values, labels=labels, showfliers=True)
        axes[1, 1].set(xlabel="Group", ylabel=f"Absolute error {unit}".strip())
    for label, ax in zip("ABCD", axes.ravel()):
        ax.text(0.01, 0.99, label, transform=ax.transAxes, va="top", fontweight="bold")
    return fig


def tornado(parameters, low_values, high_values, base_value, *, xlabel, width=4.8):
    apply_style()
    parameters = np.asarray(parameters)
    low_values = np.asarray(low_values, dtype=float) - base_value
    high_values = np.asarray(high_values, dtype=float) - base_value
    impact = np.maximum(np.abs(low_values), np.abs(high_values))
    order = np.argsort(impact)
    fig, ax = plt.subplots(figsize=(width, max(2.4, 0.34 * len(parameters))), constrained_layout=True)
    y = np.arange(len(order))
    ax.barh(y, low_values[order], color=COLORS[0], alpha=0.8, label="Low scenario")
    ax.barh(y, high_values[order], color=COLORS[1], alpha=0.8, label="High scenario")
    ax.axvline(0, color="#333333", linewidth=0.8)
    ax.set(yticks=y, yticklabels=parameters[order], xlabel=xlabel)
    ax.legend(frameon=False)
    return fig


def pareto_front(objective_x, objective_y, *, xlabel, ylabel, minimize_x=True, minimize_y=True, width=3.8):
    apply_style()
    x = np.asarray(objective_x, dtype=float)
    y = np.asarray(objective_y, dtype=float)
    if x.shape != y.shape or x.ndim != 1:
        raise ValueError("Pareto objectives must be equal one-dimensional arrays")
    transformed = np.column_stack([x if minimize_x else -x, y if minimize_y else -y])
    nondominated = np.ones(len(x), dtype=bool)
    for i, point in enumerate(transformed):
        dominates_i = np.all(transformed <= point, axis=1) & np.any(transformed < point, axis=1)
        if np.any(dominates_i):
            nondominated[i] = False
    order = np.argsort(x[nondominated])
    fig, ax = plt.subplots(figsize=(width, width * 0.78), constrained_layout=True)
    ax.scatter(x[~nondominated], y[~nondominated], s=14, color="#AAAAAA", label="Dominated")
    ax.scatter(x[nondominated], y[nondominated], s=22, color=COLORS[0], label="Nondominated", zorder=3)
    ax.plot(x[nondominated][order], y[nondominated][order], color=COLORS[0], linewidth=1)
    ax.set(xlabel=xlabel, ylabel=ylabel)
    ax.legend(frameon=False)
    return fig, nondominated


def taylor_diagram(correlations, standard_deviations, labels, *, reference_sd=1.0, width=4.2):
    apply_style()
    correlations = np.clip(np.asarray(correlations, dtype=float), -1, 1)
    deviations = np.asarray(standard_deviations, dtype=float)
    angles = np.arccos(correlations)
    fig = plt.figure(figsize=(width, width * 0.78), constrained_layout=True)
    ax = fig.add_subplot(111, projection="polar")
    ax.set_thetamin(0)
    ax.set_thetamax(180)
    ax.scatter([0], [reference_sd], marker="*", s=80, color="#111111", label="Observation")
    for index, (angle, deviation, label) in enumerate(zip(angles, deviations, labels)):
        ax.scatter([angle], [deviation], s=28, color=COLORS[index % len(COLORS)], label=label)
    ticks = np.array([1.0, 0.9, 0.7, 0.5, 0.0, -0.5, -1.0])
    ax.set_thetagrids(np.degrees(np.arccos(ticks)), labels=[f"{value:g}" for value in ticks])
    ax.set_xlabel("Correlation (angle); standard deviation (radius)")
    ax.legend(frameon=False, bbox_to_anchor=(1.22, 1.05))
    return fig


def _binary_curves(y_true, scores):
    y = np.asarray(y_true, dtype=int)
    score = np.asarray(scores, dtype=float)
    if y.shape != score.shape or y.ndim != 1 or set(np.unique(y)) != {0, 1}:
        raise ValueError("binary curves require aligned labels containing both 0 and 1")
    order = np.argsort(-score, kind="stable")
    y = y[order]
    tp = np.cumsum(y == 1)
    fp = np.cumsum(y == 0)
    positives = int(tp[-1])
    negatives = int(fp[-1])
    tpr = np.concatenate([[0.0], tp / positives, [1.0]])
    fpr = np.concatenate([[0.0], fp / negatives, [1.0]])
    precision = np.concatenate([[1.0], tp / np.maximum(tp + fp, 1)])
    recall = np.concatenate([[0.0], tp / positives])
    return fpr, tpr, recall, precision


def roc_pr_with_ci(y_true, scores, *, bootstrap=200, seed=0, width=7.0):
    apply_style()
    y = np.asarray(y_true, dtype=int)
    score = np.asarray(scores, dtype=float)
    fpr, tpr, recall, precision = _binary_curves(y, score)
    roc_grid = np.linspace(0, 1, 101)
    recall_grid = np.linspace(0, 1, 101)
    roc_draws, pr_draws = [], []
    rng = np.random.default_rng(seed)
    for _ in range(max(20, int(bootstrap))):
        indices = rng.integers(0, len(y), len(y))
        if len(np.unique(y[indices])) < 2:
            continue
        bfpr, btpr, brecall, bprecision = _binary_curves(y[indices], score[indices])
        roc_draws.append(np.interp(roc_grid, bfpr, btpr))
        order = np.argsort(brecall)
        pr_draws.append(np.interp(recall_grid, brecall[order], bprecision[order]))
    if len(roc_draws) < 10:
        raise ValueError("too few valid bootstrap resamples for interval estimation")
    roc_low, roc_high = np.quantile(np.asarray(roc_draws), [0.025, 0.975], axis=0)
    pr_low, pr_high = np.quantile(np.asarray(pr_draws), [0.025, 0.975], axis=0)
    fig, axes = plt.subplots(1, 2, figsize=(width, width * 0.42), constrained_layout=True)
    axes[0].fill_between(roc_grid, roc_low, roc_high, color=COLORS[0], alpha=0.16, linewidth=0)
    axes[0].plot(fpr, tpr, color=COLORS[0], linewidth=1.5)
    axes[0].plot([0, 1], [0, 1], color="#777777", linestyle="--", linewidth=0.8)
    axes[0].set(xlabel="False-positive rate", ylabel="True-positive rate", xlim=(0, 1), ylim=(0, 1))
    axes[1].fill_between(recall_grid, pr_low, pr_high, color=COLORS[1], alpha=0.16, linewidth=0)
    axes[1].plot(recall, precision, color=COLORS[1], linewidth=1.5)
    axes[1].set(xlabel="Recall", ylabel="Precision", xlim=(0, 1), ylim=(0, 1))
    for label, ax in zip("AB", axes):
        ax.text(0.01, 0.99, label, transform=ax.transAxes, va="top", fontweight="bold")
    rows = [
        {"curve": "roc", "x": float(x), "y": float(value)} for x, value in zip(fpr, tpr)
    ] + [{"curve": "pr", "x": float(x), "y": float(value)} for x, value in zip(recall, precision)]
    return fig, rows, {"bootstrap_resamples": len(roc_draws)}


def raincloud(groups, *, ylabel, seed=0, width=4.8):
    apply_style()
    labels = list(groups)
    values = [np.asarray(groups[label], dtype=float) for label in labels]
    if any(value.ndim != 1 or value.size < 2 for value in values):
        raise ValueError("each raincloud group requires at least two values")
    fig, ax = plt.subplots(figsize=(width, max(2.6, 0.55 * len(labels))), constrained_layout=True)
    positions = np.arange(1, len(labels) + 1)
    parts = ax.violinplot(values, positions=positions, vert=False, showextrema=False, widths=0.75)
    rng = np.random.default_rng(seed)
    for index, (body, value) in enumerate(zip(parts["bodies"], values)):
        body.set_facecolor(COLORS[index % len(COLORS)])
        body.set_alpha(0.22)
        jitter = rng.normal(0, 0.045, value.size)
        ax.scatter(value, positions[index] + jitter, s=8, alpha=0.45, color=COLORS[index % len(COLORS)])
    ax.boxplot(values, positions=positions, vert=False, widths=0.18, showfliers=False, patch_artist=True,
               boxprops={"facecolor": "white", "edgecolor": "#333333"}, medianprops={"color": "#111111"})
    ax.set(yticks=positions, yticklabels=labels, xlabel=ylabel)
    rows = [{"group": label, "value": float(value)} for label, group in groups.items() for value in group]
    return fig, rows


def matrix_heatmap(matrix, row_labels, column_labels, *, colorbar_label="", width=5.2):
    apply_style()
    values = np.asarray(matrix, dtype=float)
    if values.ndim != 2 or values.shape != (len(row_labels), len(column_labels)):
        raise ValueError("matrix dimensions must match row and column labels")
    fig, ax = plt.subplots(figsize=(width, max(2.8, width * values.shape[0] / max(values.shape[1], 1))), constrained_layout=True)
    image = ax.imshow(values, aspect="auto", cmap="viridis")
    ax.set(xticks=np.arange(len(column_labels)), xticklabels=column_labels,
           yticks=np.arange(len(row_labels)), yticklabels=row_labels)
    ax.tick_params(axis="x", rotation=45)
    colorbar = fig.colorbar(image, ax=ax, shrink=0.8)
    colorbar.set_label(colorbar_label)
    if values.size <= 100:
        threshold = float(np.nanmedian(values))
        for row in range(values.shape[0]):
            for column in range(values.shape[1]):
                ax.text(column, row, f"{values[row, column]:.2g}", ha="center", va="center",
                        color="white" if values[row, column] < threshold else "black", fontsize=6)
    rows = [
        {"row": row_label, "column": column_label, "value": float(values[row, column])}
        for row, row_label in enumerate(row_labels) for column, column_label in enumerate(column_labels)
    ]
    return fig, rows


def convergence_trace(iterations, objective, *, ylabel, violation=None, width=4.8):
    apply_style()
    iteration = np.asarray(iterations)
    values = np.asarray(objective, dtype=float)
    if iteration.shape != values.shape or iteration.ndim != 1:
        raise ValueError("iterations and objective must be aligned")
    fig, ax = plt.subplots(figsize=(width, width * 0.62), constrained_layout=True)
    ax.plot(iteration, values, color=COLORS[0], linewidth=1.5, label="Objective")
    ax.set(xlabel="Iteration", ylabel=ylabel)
    rows = [{"iteration": int(step), "objective": float(value)} for step, value in zip(iteration, values)]
    if violation is not None:
        residual = np.asarray(violation, dtype=float)
        if residual.shape != values.shape:
            raise ValueError("violation must align with objective")
        second = ax.twinx()
        second.plot(iteration, residual, color=COLORS[1], linewidth=1.1, linestyle="--")
        second.set_ylabel("Maximum constraint violation")
        for row, value in zip(rows, residual):
            row["max_violation"] = float(value)
    return fig, rows


def _self_test(output_directory):
    target = Path(output_directory)
    target.mkdir(parents=True, exist_ok=True)
    x = np.arange(8)
    center = np.array([1, 1.4, 1.8, 2.1, 2.5, 2.8, 3.0, 3.2])
    fig = line_interval(x, center, center - 0.2, center + 0.2, xlabel="Time", ylabel="Response")
    export_figure(fig, target / "line_interval_demo", [{"x": int(a), "center": float(b)} for a, b in zip(x, center)], {
        "demo_only": True, "claim": "The response rises over time.", "uncertainty": "Illustrative interval",
    })
    plt.close(fig)
    fig, mask = pareto_front([1, 2, 3, 2.5], [5, 3.2, 2.4, 4.5], xlabel="Cost", ylabel="Risk")
    export_figure(fig, target / "pareto_demo", [{"nondominated": bool(value)} for value in mask], {
        "demo_only": True, "claim": "The frontier exposes the cost-risk tradeoff.", "uncertainty": "Deterministic demo",
    })
    plt.close(fig)


def render_spec(spec):
    kind = spec.get("kind")
    data = spec.get("data") or {}
    labels = spec.get("labels") or {}
    if kind == "line_interval":
        fig = line_interval(
            data["x"], data["center"], data["lower"], data["upper"],
            xlabel=labels["x"], ylabel=labels["y"], label=labels.get("series"),
        )
        rows = [
            {"x": x, "center": center, "lower": lower, "upper": upper}
            for x, center, lower, upper in zip(data["x"], data["center"], data["lower"], data["upper"])
        ]
        return fig, rows, {}
    if kind == "prediction_diagnostics":
        fig = prediction_diagnostics(
            data["actual"], data["predicted"], unit=labels.get("unit", ""), groups=data.get("groups"),
        )
        rows = [
            {"actual": actual, "predicted": predicted, "residual": predicted - actual}
            for actual, predicted in zip(data["actual"], data["predicted"])
        ]
        return fig, rows, {}
    if kind == "tornado":
        fig = tornado(
            data["parameters"], data["low_values"], data["high_values"], data["base_value"],
            xlabel=labels["x"],
        )
        rows = [
            {"parameter": name, "low_value": low, "high_value": high, "base_value": data["base_value"]}
            for name, low, high in zip(data["parameters"], data["low_values"], data["high_values"])
        ]
        return fig, rows, {}
    if kind == "pareto_front":
        fig, mask = pareto_front(
            data["objective_x"], data["objective_y"], xlabel=labels["x"], ylabel=labels["y"],
            minimize_x=bool(data.get("minimize_x", True)), minimize_y=bool(data.get("minimize_y", True)),
        )
        rows = [
            {"objective_x": x, "objective_y": y, "nondominated": bool(accepted)}
            for x, y, accepted in zip(data["objective_x"], data["objective_y"], mask)
        ]
        return fig, rows, {"nondominated_count": int(np.sum(mask))}
    if kind == "taylor":
        fig = taylor_diagram(
            data["correlations"], data["standard_deviations"], data["series_labels"],
            reference_sd=float(data.get("reference_sd", 1.0)),
        )
        rows = [
            {"series": name, "correlation": correlation, "standard_deviation": deviation}
            for name, correlation, deviation in zip(data["series_labels"], data["correlations"], data["standard_deviations"])
        ]
        return fig, rows, {}
    if kind == "roc_pr_ci":
        return roc_pr_with_ci(
            data["y_true"], data["scores"],
            bootstrap=int(data.get("bootstrap", 200)), seed=int(data.get("seed", 0)),
        )
    if kind == "raincloud":
        fig, rows = raincloud(data["groups"], ylabel=labels["x"], seed=int(data.get("seed", 0)))
        return fig, rows, {"groups": len(data["groups"])}
    if kind == "heatmap":
        fig, rows = matrix_heatmap(
            data["matrix"], data["row_labels"], data["column_labels"],
            colorbar_label=labels.get("colorbar", ""),
        )
        return fig, rows, {}
    if kind == "convergence":
        fig, rows = convergence_trace(
            data["iterations"], data["objective"], ylabel=labels["y"], violation=data.get("violation"),
        )
        return fig, rows, {}
    raise ValueError(f"unsupported figure kind: {kind}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Render a publication figure from a JSON figure contract")
    parser.add_argument("--spec", help="JSON figure contract")
    parser.add_argument("--output", help="output path without extension")
    parser.add_argument("--self-test-output")
    args = parser.parse_args()
    if args.self_test_output:
        _self_test(args.self_test_output)
        return 0
    if not args.spec:
        parser.error("--spec and --output are required unless --self-test-output is used")
    if not args.output:
        parser.error("--output is required with --spec")
    source = Path(args.spec).read_bytes()
    spec = json.loads(source.decode("utf-8"))
    for required in ("kind", "claim", "data", "labels"):
        if required not in spec:
            raise ValueError(f"figure spec requires {required}")
    fig, rows, extra = render_spec(spec)
    try:
        payload = export_figure(fig, args.output, rows, {
            "kind": spec["kind"],
            "claim": spec["claim"],
            "uncertainty": spec.get("uncertainty"),
            "source_spec_sha256": hashlib.sha256(source).hexdigest(),
            **extra,
        })
    finally:
        plt.close(fig)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
