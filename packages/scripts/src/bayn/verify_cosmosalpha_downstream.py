"""Recompute downstream metrics from saved artifacts without importing CosmosAlpha."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import tomllib

import numpy as np
from scipy.stats import rankdata


TOLERANCE = 1e-12
OUTPUTS = (
    "model_ref",
    "training_curve_ref",
    "predictions_ref",
    "daily_signal_metrics_ref",
    "portfolio_report_ref",
    "portfolio_positions_ref",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def artifact(root, ref):
    key = ref["artifact_id"]
    require(re.fullmatch(r"[0-9a-f]{64}", key) is not None, "Invalid artifact identity")
    path = root / "artifacts" / key[:2] / key
    require(
        ref["checksum"] == "sha256:" + key and sha(path) == key,
        "Artifact content differs",
    )
    require(path.stat().st_size == ref["size_bytes"], "Artifact size differs")
    return path


def table(root, ref):
    with np.load(artifact(root, ref), allow_pickle=False) as data:
        manifest = json.loads(str(data["__cosmosalpha_manifest__"]))
        require(
            manifest["schema_version"] == "columnar-records/1.0", "Unknown table schema"
        )
        columns = {}
        for item in manifest["columns"]:
            values, valid = data[item["data_key"]].copy(), data[item["valid_key"]]
            require(valid.dtype == np.bool_, "Validity flags must be boolean")
            require(
                values.ndim == valid.ndim == 1
                and len(values) == len(valid) == manifest["row_count"],
                "Table shape differs",
            )
            if item["type"] in {"float", "int"}:
                values = values.astype(float)
                values[~valid] = np.nan
            else:
                require(
                    item["type"] == "str" and np.all(valid), "Invalid string column"
                )
            require(item["name"] not in columns, "Duplicate table column")
            columns[item["name"]] = values
        return columns


def keys(data):
    require(np.all(np.char.find(data["instrument"], "|") < 0), "Invalid instrument key")
    result = np.char.add(np.char.add(data["datetime"], "|"), data["instrument"])
    require(np.all(result[1:] > result[:-1]), "Row keys are duplicated or unsorted")
    return result


def signal_metrics(predictions):
    dates = predictions["datetime"]
    bounds = np.r_[0, np.flatnonzero(dates[1:] != dates[:-1]) + 1, len(dates)]
    daily = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        x, y = predictions["score"][lo:hi], predictions["raw_forward_return"][lo:hi]
        valid = np.isfinite(x) & np.isfinite(y)
        x, y = x[valid], y[valid]
        if len(x) < 100 or np.ptp(x) == 0 or np.ptp(y) == 0:
            continue
        ic = float(np.corrcoef(x, y)[0, 1])
        rank_ic = float(np.corrcoef(rankdata(x), rankdata(y))[0, 1])
        require(np.isfinite(ic) and np.isfinite(rank_ic), "Undefined daily correlation")
        daily.append((dates[lo], ic, rank_ic, len(x)))
    require(daily, "No valid predictive metrics")
    result = {
        "valid_date_count": len(daily),
        "effective_sample_count": sum(row[3] for row in daily),
    }
    for name, index in [("ic", 1), ("rank_ic", 2)]:
        values = np.array([row[index] for row in daily])
        mean = float(values.mean())
        std = float(values.std(ddof=1)) if len(values) > 1 else 0.0
        result.update(
            {
                name + "_mean": mean,
                name + "_std": std,
                name + "_ir": mean / std if std > 0 else 0.0,
            }
        )
    return result, daily


def portfolio_metrics(report):
    require(
        len(report["return"]) > 1 and np.all(np.isfinite(report["return"])),
        "Invalid daily portfolio returns",
    )
    require(
        np.all(report["cost"] == 0) and np.all(report["bench"] == 0),
        "Only the frozen zero-cost, zero-benchmark diagnostic is supported",
    )
    returns = report["return"]
    mean, std = float(returns.mean()), float(returns.std(ddof=1))
    cumulative = returns.cumsum()
    return {
        "annualized_return": 238 * mean,
        "information_ratio": float(np.sqrt(238)) * mean / std if std > 0 else 0.0,
        "max_drawdown": float(np.min(cumulative - np.maximum.accumulate(cumulative))),
    }


def verify_run(root, plan, run):
    path = root / "receipts" / run["runId"] / "model-result.json"
    model = read(path)
    model_root = root / "models" / (run["runId"] + "-model")
    require(
        model["source_run_id"] == run["runId"]
        and model["run_id"] == run["runId"] + "-model",
        "Model run identity differs",
    )
    require(
        model["selected_factor_count"] == plan["limits"]["evaluable_factors"],
        "Model did not use the complete pool",
    )
    require(
        read(model_root / "target-consumption.json") == plan["inputs"]["downstream"],
        "Downstream target consumption differs",
    )
    config_path = root / run["downstreamConfig"]
    require(
        sha(config_path) == run["downstreamSha256"],
        "Frozen model configuration differs",
    )
    config = tomllib.loads(config_path.read_text())
    test = config["segments"]["test"]
    require(
        config["backtest"]["return_mode"]
        == model["portfolio_metrics"]["return_mode"]
        == "absolute",
        "Unexpected portfolio return convention",
    )
    for role in OUTPUTS:
        artifact(model_root, model[role])
    predictions = table(model_root, model["predictions_ref"])
    daily = table(model_root, model["daily_signal_metrics_ref"])
    portfolio = table(model_root, model["portfolio_report_ref"])
    returns_path = root / plan["inputs"]["downstream"]["returns"]
    require(
        sha(returns_path) == plan["inputs"]["downstream"]["returnsSha256"],
        "Frozen return metadata differs",
    )
    return_ref = read(returns_path)["return_values_ref"]
    require(
        return_ref["artifact_id"] == plan["inputs"]["downstream"]["targetArtifactId"],
        "Frozen target identity differs",
    )
    target = table(model_root, return_ref)
    target_test = (target["datetime"] >= test["start_date"]) & (
        target["datetime"] <= test["end_date"]
    )
    target = {key: values[target_test] for key, values in target.items()}
    source_keys, prediction_keys = keys(target), keys(predictions)
    locations = np.searchsorted(source_keys, prediction_keys)
    require(
        np.all(locations < len(source_keys)),
        "Prediction key is outside verified targets",
    )
    require(
        np.array_equal(source_keys[locations], prediction_keys),
        "Prediction key differs",
    )
    expected = target["forward_return"][locations]
    actual = predictions["raw_forward_return"]
    require(
        np.all((actual == expected) | (np.isnan(actual) & np.isnan(expected))),
        "Prediction raw target differs from verified source",
    )
    for data in [predictions, daily, portfolio]:
        dates = data["datetime"]
        require(
            len(dates) > 0
            and np.all((dates >= test["start_date"]) & (dates <= test["end_date"])),
            "Output date is outside the test split",
        )
    require(
        np.all(portfolio["datetime"][1:] > portfolio["datetime"][:-1]),
        "Portfolio dates are duplicated or unsorted",
    )
    computed, rows = signal_metrics(predictions)
    require(
        np.array_equal(daily["datetime"], np.array([r[0] for r in rows])),
        "Daily metric dates differ",
    )
    daily_errors = {}
    for name, index in [("ic", 1), ("rank_ic", 2)]:
        error = float(np.max(np.abs(daily[name] - np.array([r[index] for r in rows]))))
        require(np.isfinite(error) and error <= TOLERANCE, "Daily " + name + " differs")
        daily_errors[name] = error
    require(
        np.array_equal(daily["sample_count"], np.array([r[3] for r in rows])),
        "Daily sample counts differ",
    )
    require(
        all(
            model["metrics"][key] == computed[key]
            for key in ["valid_date_count", "effective_sample_count"]
        ),
        "Predictive aggregate counts differ",
    )
    errors = {}
    for values, reported in [
        (computed, model["metrics"]),
        (portfolio_metrics(portfolio), model["portfolio_metrics"]),
    ]:
        for key, value in values.items():
            error = abs(reported[key] - value)
            require(
                np.isfinite(error) and error <= TOLERANCE,
                "Reported " + key + " differs",
            )
            errors[key] = error
    return {
        "runId": run["runId"],
        "modelResultSha256": sha(path),
        "predictionTargetRowsVerified": len(actual),
        "dailySignalRowsVerified": len(rows),
        "portfolioReturnRowsVerified": len(portfolio["datetime"]),
        "metricAbsoluteErrors": errors,
        "dailyCorrelationMaxErrors": daily_errors,
        "outputArtifactsVerified": {
            role: model[role]["artifact_id"] for role in OUTPUTS
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    plan = read(args.root / "plan.json")
    checks, findings = [], []
    for run in plan["runs"]:
        try:
            checks.append(verify_run(args.root, plan, run))
        except (OSError, ValueError, KeyError, TypeError) as error:
            findings.append({"runId": run["runId"], "detail": str(error)})
    require(plan["runs"], "No planned models")
    report = {
        "schemaVersion": "bayn.cosmosalpha-independent-downstream-metrics.v1",
        "experimentId": plan["experimentId"],
        "kind": plan["kind"],
        "verifierSha256": sha(Path(__file__)),
        "absoluteTolerance": TOLERANCE,
        "status": "FAIL" if findings else "PASS",
        "checks": checks,
        "findings": findings,
        "scope": "All planned model outputs, raw prediction-target joins, daily IC/RankIC and seven aggregate metrics. Portfolio math is conditional on saved daily returns; no independent fill replay, feature reconstruction, industry lineage or costed strategy qualification.",
    }
    with args.report.open("x") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(
        json.dumps(
            {
                "status": report["status"],
                "models": len(checks),
                "failures": len(findings),
            }
        )
    )
    return int(bool(findings))


if __name__ == "__main__":
    raise SystemExit(main())
