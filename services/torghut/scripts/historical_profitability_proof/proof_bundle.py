#!/usr/bin/env python3
"""Build profitability proof artifacts from historical simulation run directories."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping


from app.trading.evaluation import (
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    validate_profitability_evidence_v4,
)

from .proof_core import (
    _DEFAULT_BASELINE_ID,
    _DEFAULT_EXTENDED_MAX_DRAWDOWN_PCT_EQUITY,
    _DEFAULT_MAX_BEST_DAY_SHARE,
    _DEFAULT_MAX_DRAWDOWN_PCT_EQUITY,
    _DEFAULT_MIN_ACTIVE_DAY_RATIO,
    _DEFAULT_MIN_POSITIVE_DAY_RATIO,
    _DEFAULT_MIN_SAMPLE_SIZE,
    _DEFAULT_MIN_TOTAL_NET_PNL_TO_DRAWDOWN_RATIO,
    _DEFAULT_START_EQUITY,
    _DEFAULT_TARGET_NET_PNL_PER_DAY,
    _PROFITABILITY_PROOF_SCHEMA_VERSION,
    HistoricalRunSummary,
    _as_decimal,
    _as_dict,
    _as_int,
    _as_list,
    _as_text,
    _build_report_payload,
    _load_run_summary,
    _parse_args,
    _proof_gate_policy,
    _proof_gate_summary,
    _require_consistent_lineage,
    _sha256_json,
    _stable_hash_payload,
)


def _build_zero_baseline_payload(trading_days: list[str]) -> dict[str, object]:
    return {
        "metrics": {
            "net_pnl": "0",
            "max_drawdown": "0",
            "cost_bps": "0",
            "trade_count": 0,
            "decision_count": 0,
            "turnover_ratio": "0",
        },
        "robustness": {
            "folds": [
                {
                    "fold_name": trading_day,
                    "trade_count": 0,
                    "net_pnl": "0",
                    "max_drawdown": "0",
                    "cost_bps": "0",
                    "turnover_ratio": "0",
                    "regime_label": trading_day,
                }
                for trading_day in trading_days
            ],
        },
        "impact_assumptions": {
            "decisions_with_spread": 0,
            "decisions_with_volatility": 0,
            "decisions_with_adv": 0,
            "assumptions": {
                "recorded_inputs_count": "0",
                "fallback_inputs_count": "0",
            },
        },
    }


def _effect_size(candidate_report_payload: Mapping[str, Any]) -> Decimal:
    folds = _as_list(_as_dict(candidate_report_payload.get("robustness")).get("folds"))
    daily_values = [_as_decimal(_as_dict(item).get("net_pnl")) for item in folds]
    if not daily_values:
        return Decimal("0")
    mean_value = sum(daily_values, Decimal("0")) / Decimal(len(daily_values))
    if len(daily_values) <= 1:
        return mean_value
    variance = sum((value - mean_value) ** 2 for value in daily_values) / Decimal(
        len(daily_values)
    )
    std_dev = variance.sqrt()
    if std_dev <= 0:
        return mean_value
    return mean_value / std_dev


def _artifact_refs(run_summaries: list[HistoricalRunSummary]) -> list[str]:
    refs: list[str] = []
    for item in run_summaries:
        refs.append(str(item.simulation_report_path))
        if item.replay_report_path is not None:
            refs.append(str(item.replay_report_path))
        if item.trade_pnl_csv_path is not None:
            refs.append(str(item.trade_pnl_csv_path))
    return sorted(set(refs))


def _proof_passed(
    *,
    candidate_report_payload: Mapping[str, Any],
    validation_payload: Mapping[str, Any],
    proof_payload: Mapping[str, Any],
) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not bool(validation_payload.get("passed")):
        reasons.append("profitability_evidence_validation_failed")
    market_net = _as_decimal(
        _as_dict(candidate_report_payload.get("metrics")).get("net_pnl")
    )
    if market_net <= 0:
        reasons.append("market_net_pnl_not_positive")
    p_value = _as_decimal(_as_dict(proof_payload.get("statistics")).get("p_value"))
    if p_value > Decimal("0.05"):
        reasons.append("p_value_above_0_05")
    gates = _as_dict(proof_payload.get("proof_gates"))
    observed = _as_dict(gates.get("observed"))
    sample_size = _as_int(observed.get("sample_size"))
    min_sample_size = _as_int(gates.get("min_sample_size"))
    if sample_size < min_sample_size:
        reasons.append("sample_size_below_minimum")
    average_daily_net_pnl = _as_decimal(observed.get("average_daily_net_pnl"))
    target_net_pnl_per_day = _as_decimal(gates.get("target_net_pnl_per_day"))
    if average_daily_net_pnl < target_net_pnl_per_day:
        reasons.append("average_daily_net_pnl_below_target")
    if _as_decimal(observed.get("active_day_ratio")) < _as_decimal(
        gates.get("min_active_day_ratio")
    ):
        reasons.append("active_day_ratio_below_minimum")
    if _as_decimal(observed.get("positive_day_ratio")) < _as_decimal(
        gates.get("min_positive_day_ratio")
    ):
        reasons.append("positive_day_ratio_below_minimum")
    if _as_decimal(observed.get("best_day_share")) > _as_decimal(
        gates.get("max_best_day_share")
    ):
        reasons.append("best_day_share_above_maximum")
    min_daily_notional = _as_decimal(gates.get("min_daily_notional"))
    if (
        min_daily_notional > 0
        and _as_decimal(observed.get("avg_daily_notional")) < min_daily_notional
    ):
        reasons.append("avg_daily_notional_below_minimum")
    if not bool(observed.get("drawdown_passed")):
        reasons.append("max_drawdown_above_limit")
    return (not reasons, reasons)


def build_historical_profitability_bundle(
    *,
    run_dirs: list[Path],
    output_dir: Path,
    hypothesis: str = "",
    baseline_run_dirs: list[Path] | None = None,
    baseline_id: str = "",
    generated_at: datetime | None = None,
    target_net_pnl_per_day: Decimal | str = _DEFAULT_TARGET_NET_PNL_PER_DAY,
    min_sample_size: int = _DEFAULT_MIN_SAMPLE_SIZE,
    min_active_day_ratio: Decimal | str = _DEFAULT_MIN_ACTIVE_DAY_RATIO,
    min_positive_day_ratio: Decimal | str = _DEFAULT_MIN_POSITIVE_DAY_RATIO,
    max_best_day_share: Decimal | str = _DEFAULT_MAX_BEST_DAY_SHARE,
    min_daily_notional: Decimal | str = Decimal("0"),
    start_equity: Decimal | str = _DEFAULT_START_EQUITY,
    max_drawdown_pct_equity: Decimal | str = _DEFAULT_MAX_DRAWDOWN_PCT_EQUITY,
    extended_max_drawdown_pct_equity: Decimal
    | str = _DEFAULT_EXTENDED_MAX_DRAWDOWN_PCT_EQUITY,
    min_total_net_pnl_to_drawdown_ratio: Decimal
    | str = _DEFAULT_MIN_TOTAL_NET_PNL_TO_DRAWDOWN_RATIO,
) -> dict[str, Any]:
    timestamp = generated_at or datetime.now(timezone.utc)
    output_dir.mkdir(parents=True, exist_ok=True)

    candidate_runs = [_load_run_summary(path) for path in run_dirs]
    _require_consistent_lineage(candidate_runs, label="candidate")
    gate_policy = _proof_gate_policy(
        target_net_pnl_per_day=target_net_pnl_per_day,
        min_sample_size=min_sample_size,
        min_active_day_ratio=min_active_day_ratio,
        min_positive_day_ratio=min_positive_day_ratio,
        max_best_day_share=max_best_day_share,
        min_daily_notional=min_daily_notional,
        start_equity=start_equity,
        max_drawdown_pct_equity=max_drawdown_pct_equity,
        extended_max_drawdown_pct_equity=extended_max_drawdown_pct_equity,
        min_total_net_pnl_to_drawdown_ratio=min_total_net_pnl_to_drawdown_ratio,
    )

    candidate_id = candidate_runs[0].candidate_id
    inferred_baseline_id = (
        baseline_id.strip()
        or candidate_runs[0].baseline_candidate_id
        or _DEFAULT_BASELINE_ID
    )

    candidate_report_payload = _build_report_payload(candidate_runs)
    baseline_report_payload: dict[str, object]
    if baseline_run_dirs:
        baseline_runs = [_load_run_summary(path) for path in baseline_run_dirs]
        _require_consistent_lineage(baseline_runs, label="baseline")
        baseline_report_payload = _build_report_payload(baseline_runs)
        inferred_baseline_id = baseline_id.strip() or baseline_runs[0].candidate_id
    else:
        baseline_report_payload = _build_zero_baseline_payload(
            [
                item.trading_day
                for item in sorted(candidate_runs, key=lambda value: value.trading_day)
            ]
        )

    candidate_report_path = output_dir / "candidate-report.json"
    baseline_report_path = output_dir / "baseline-report.json"
    candidate_report_path.write_text(
        json.dumps(candidate_report_payload, indent=2), encoding="utf-8"
    )
    baseline_report_path.write_text(
        json.dumps(baseline_report_payload, indent=2), encoding="utf-8"
    )

    reproducibility_hashes = {
        "signals": _stable_hash_payload([item.signal_hash for item in candidate_runs]),
        "strategy_config": _stable_hash_payload(
            {
                "candidate_id": candidate_id,
                "strategy_spec_ref": candidate_runs[0].strategy_spec_ref,
                "model_refs": candidate_runs[0].model_refs,
                "runtime_version_refs": candidate_runs[0].runtime_version_refs,
                "per_run_hashes": [
                    item.strategy_config_hash for item in candidate_runs
                ],
            }
        ),
        "gate_policy": _stable_hash_payload(
            [item.gate_policy_hash for item in candidate_runs]
        ),
        "candidate_report": _sha256_json(candidate_report_payload),
        "baseline_report": _sha256_json(baseline_report_payload),
    }

    benchmark = execute_profitability_benchmark_v4(
        candidate_id=candidate_id,
        baseline_id=inferred_baseline_id,
        candidate_report_payload=dict(candidate_report_payload),
        baseline_report_payload=dict(baseline_report_payload),
        executed_at=timestamp,
    )
    benchmark_path = output_dir / "profitability-benchmark-v4.json"
    benchmark_path.write_text(
        json.dumps(benchmark.to_payload(), indent=2), encoding="utf-8"
    )

    confidence_values = [item.confidence_value for item in candidate_runs]
    evidence = build_profitability_evidence_v4(
        run_id="historical-oos-profitability",
        candidate_id=candidate_id,
        baseline_id=inferred_baseline_id,
        candidate_report_payload=dict(candidate_report_payload),
        benchmark=benchmark,
        confidence_values=confidence_values,
        reproducibility_hashes=reproducibility_hashes,
        artifact_refs=[
            *_artifact_refs(candidate_runs),
            str(candidate_report_path),
            str(baseline_report_path),
        ],
        generated_at=timestamp,
    )
    evidence_payload = evidence.to_payload()
    evidence_path = output_dir / "profitability-evidence-v4.json"
    evidence_path.write_text(json.dumps(evidence_payload, indent=2), encoding="utf-8")

    validation = validate_profitability_evidence_v4(evidence, checked_at=timestamp)
    validation_payload = validation.to_payload()
    validation_path = output_dir / "profitability-evidence-validation.json"
    validation_path.write_text(
        json.dumps(validation_payload, indent=2), encoding="utf-8"
    )

    benchmark_payload = benchmark.to_payload()
    market_slice = _as_dict(
        next(
            (
                item
                for item in _as_list(benchmark_payload.get("slices"))
                if _as_text(_as_dict(item).get("slice_key")) == "market:all"
            ),
            {},
        )
    )
    proof_payload: dict[str, Any] = {
        "schema_version": _PROFITABILITY_PROOF_SCHEMA_VERSION,
        "generated_at": timestamp.isoformat(),
        "hypothesis": hypothesis.strip()
        or f"{candidate_id} is profitable over the historical OOS replay window",
        "sample_size": len(candidate_runs),
        "window_days": len(candidate_runs),
        "proof_gates": _proof_gate_summary(candidate_runs, policy=gate_policy),
        "statistics": {
            "effect_size": float(_effect_size(candidate_report_payload)),
            "p_value": float(
                _as_decimal(
                    _as_dict(evidence_payload.get("significance")).get(
                        "p_value_two_sided"
                    )
                )
            ),
            "ci_95_low": _as_text(
                _as_dict(evidence_payload.get("significance")).get("ci_95_low")
            )
            or "0",
            "ci_95_high": _as_text(
                _as_dict(evidence_payload.get("significance")).get("ci_95_high")
            )
            or "0",
        },
        "risk_controls": {
            "max_drawdown_delta": float(
                _as_decimal(
                    _as_dict(market_slice.get("deltas")).get("max_drawdown_delta")
                )
            ),
            "market_net_pnl_delta": _as_text(
                _as_dict(market_slice.get("deltas")).get("net_pnl_delta")
            )
            or "0",
            "return_over_drawdown": _as_text(
                _as_dict(evidence_payload.get("risk_adjusted_metrics")).get(
                    "return_over_drawdown"
                )
            )
            or "0",
        },
        "candidate_id": candidate_id,
        "baseline_id": inferred_baseline_id,
        "source_runs": [
            {
                "run_id": item.run_id,
                "trading_day": item.trading_day,
                "verdict_status": item.verdict_status,
                "trade_count": item.trade_count,
                "decision_count": item.decision_count,
                "net_pnl": str(item.net_pnl),
                "max_drawdown": str(item.max_drawdown),
            }
            for item in sorted(candidate_runs, key=lambda value: value.trading_day)
        ],
        "artifacts": {
            "candidate_report": str(candidate_report_path),
            "baseline_report": str(baseline_report_path),
            "profitability_benchmark": str(benchmark_path),
            "profitability_evidence": str(evidence_path),
            "profitability_validation": str(validation_path),
        },
    }
    passed, failed_reasons = _proof_passed(
        candidate_report_payload=candidate_report_payload,
        validation_payload=validation_payload,
        proof_payload=proof_payload,
    )
    proof_payload["passed"] = passed
    proof_payload["failed_reasons"] = failed_reasons
    proof_path = output_dir / "profitability-proof.json"
    proof_path.write_text(json.dumps(proof_payload, indent=2), encoding="utf-8")

    summary = {
        "candidate_id": candidate_id,
        "baseline_id": inferred_baseline_id,
        "output_dir": str(output_dir),
        "profitability_proof_path": str(proof_path),
        "profitability_benchmark_path": str(benchmark_path),
        "profitability_evidence_path": str(evidence_path),
        "profitability_validation_path": str(validation_path),
        "passed": passed,
        "failed_reasons": failed_reasons,
    }
    return summary


def main() -> int:
    args = _parse_args()
    summary = build_historical_profitability_bundle(
        run_dirs=[Path(path) for path in args.run_dir],
        baseline_run_dirs=[Path(path) for path in args.baseline_run_dir],
        output_dir=Path(args.output_dir),
        hypothesis=args.hypothesis,
        baseline_id=args.baseline_id,
        target_net_pnl_per_day=args.target_net_pnl_per_day,
        min_sample_size=args.min_sample_size,
        min_active_day_ratio=args.min_active_day_ratio,
        min_positive_day_ratio=args.min_positive_day_ratio,
        max_best_day_share=args.max_best_day_share,
        min_daily_notional=args.min_daily_notional,
        start_equity=args.start_equity,
        max_drawdown_pct_equity=args.max_drawdown_pct_equity,
        extended_max_drawdown_pct_equity=args.extended_max_drawdown_pct_equity,
        min_total_net_pnl_to_drawdown_ratio=args.min_total_net_pnl_to_drawdown_ratio,
    )
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(json.dumps(summary))
    if not summary.get("passed"):
        raise SystemExit(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
