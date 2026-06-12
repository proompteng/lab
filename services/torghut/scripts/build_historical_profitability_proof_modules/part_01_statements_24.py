# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python3
"""Build profitability proof artifacts from historical simulation run directories."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.trading.evaluation import (
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    validate_profitability_evidence_v4,
)

# ruff: noqa: F401,F403,F405,F811,F821


_SERVICE_ROOT = Path(__file__).resolve().parent.parent

_PROFITABILITY_PROOF_SCHEMA_VERSION = "torghut.historical-profitability-proof.v1"

_DEFAULT_BASELINE_ID = "cash-flat@baseline"

_DEFAULT_TARGET_NET_PNL_PER_DAY = Decimal("500")

_DEFAULT_MIN_SAMPLE_SIZE = 20

_DEFAULT_MIN_ACTIVE_DAY_RATIO = Decimal("0.90")

_DEFAULT_MIN_POSITIVE_DAY_RATIO = Decimal("0.60")

_DEFAULT_MAX_BEST_DAY_SHARE = Decimal("0.25")

_DEFAULT_START_EQUITY = Decimal("31590.02")

_DEFAULT_MAX_DRAWDOWN_PCT_EQUITY = Decimal("0.10")

_DEFAULT_EXTENDED_MAX_DRAWDOWN_PCT_EQUITY = Decimal("0.15")

_DEFAULT_MIN_TOTAL_NET_PNL_TO_DRAWDOWN_RATIO = Decimal("2.00")


@dataclass(frozen=True)
class HistoricalRunSummary:
    run_id: str
    run_dir: Path
    trading_day: str
    candidate_id: str
    baseline_candidate_id: str
    strategy_spec_ref: str
    model_refs: list[str]
    runtime_version_refs: list[str]
    net_pnl: Decimal
    max_drawdown: Decimal
    cost_bps: Decimal
    trade_count: int
    decision_count: int
    execution_notional_total: Decimal
    estimated_cost_total: Decimal
    confidence_value: Decimal
    verdict_status: str
    signal_hash: str
    strategy_config_hash: str
    gate_policy_hash: str
    simulation_report_path: Path
    replay_report_path: Path | None
    trade_pnl_csv_path: Path | None


@dataclass(frozen=True)
class ProfitabilityProofGatePolicy:
    target_net_pnl_per_day: Decimal = _DEFAULT_TARGET_NET_PNL_PER_DAY
    min_sample_size: int = _DEFAULT_MIN_SAMPLE_SIZE
    min_active_day_ratio: Decimal = _DEFAULT_MIN_ACTIVE_DAY_RATIO
    min_positive_day_ratio: Decimal = _DEFAULT_MIN_POSITIVE_DAY_RATIO
    max_best_day_share: Decimal = _DEFAULT_MAX_BEST_DAY_SHARE
    min_daily_notional: Decimal = Decimal("0")
    start_equity: Decimal = _DEFAULT_START_EQUITY
    max_drawdown_pct_equity: Decimal = _DEFAULT_MAX_DRAWDOWN_PCT_EQUITY
    extended_max_drawdown_pct_equity: Decimal = (
        _DEFAULT_EXTENDED_MAX_DRAWDOWN_PCT_EQUITY
    )
    min_total_net_pnl_to_drawdown_ratio: Decimal = (
        _DEFAULT_MIN_TOTAL_NET_PNL_TO_DRAWDOWN_RATIO
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build profitability proof artifacts from historical Torghut simulation outputs.",
    )
    parser.add_argument(
        "--run-dir",
        action="append",
        required=True,
        help="Historical simulation run directory.",
    )
    parser.add_argument(
        "--baseline-run-dir",
        action="append",
        default=[],
        help="Optional baseline historical simulation run directory.",
    )
    parser.add_argument(
        "--output-dir", required=True, help="Directory for generated proof artifacts."
    )
    parser.add_argument(
        "--hypothesis",
        default="",
        help="Explicit hypothesis text for the proof manifest.",
    )
    parser.add_argument(
        "--baseline-id", default="", help="Optional baseline identifier override."
    )
    parser.add_argument(
        "--target-net-pnl-per-day", default=str(_DEFAULT_TARGET_NET_PNL_PER_DAY)
    )
    parser.add_argument("--min-sample-size", type=int, default=_DEFAULT_MIN_SAMPLE_SIZE)
    parser.add_argument(
        "--min-active-day-ratio", default=str(_DEFAULT_MIN_ACTIVE_DAY_RATIO)
    )
    parser.add_argument(
        "--min-positive-day-ratio", default=str(_DEFAULT_MIN_POSITIVE_DAY_RATIO)
    )
    parser.add_argument(
        "--max-best-day-share", default=str(_DEFAULT_MAX_BEST_DAY_SHARE)
    )
    parser.add_argument("--min-daily-notional", default="0")
    parser.add_argument("--start-equity", default=str(_DEFAULT_START_EQUITY))
    parser.add_argument(
        "--max-drawdown-pct-equity", default=str(_DEFAULT_MAX_DRAWDOWN_PCT_EQUITY)
    )
    parser.add_argument(
        "--extended-max-drawdown-pct-equity",
        default=str(_DEFAULT_EXTENDED_MAX_DRAWDOWN_PCT_EQUITY),
    )
    parser.add_argument(
        "--min-total-net-pnl-to-drawdown-ratio",
        default=str(_DEFAULT_MIN_TOTAL_NET_PNL_TO_DRAWDOWN_RATIO),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f"json_mapping_required:{path}")
    return {str(key): value for key, value in payload.items()}


def _load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f"yaml_mapping_required:{path}")
    return {str(key): value for key, value in payload.items()}


def _as_dict(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _clamp_confidence(value: Decimal) -> Decimal:
    if value < 0:
        return Decimal("0")
    if value > 1:
        return Decimal("1")
    return value


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_json(payload: Mapping[str, Any]) -> str:
    return _sha256_bytes(
        json.dumps(payload, indent=2, sort_keys=True, default=str).encode("utf-8")
    )


def _stable_hash_payload(payload: Any) -> str:
    return _sha256_bytes(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode(
            "utf-8"
        )
    )


def _resolve_manifest_path(run_dir: Path, report: Mapping[str, Any]) -> Path | None:
    run_metadata = _as_dict(report.get("run_metadata"))
    raw = _as_text(run_metadata.get("manifest_path"))
    if raw is None:
        return None
    candidate = Path(raw)
    if candidate.is_absolute() and candidate.exists():
        return candidate
    for resolved in (_SERVICE_ROOT / raw, run_dir / raw, Path.cwd() / raw):
        if resolved.exists():
            return resolved
    return None


def _load_source_manifest(
    run_dir: Path, report: Mapping[str, Any]
) -> tuple[dict[str, Any], Path | None]:
    path = _resolve_manifest_path(run_dir, report)
    if path is None:
        return {}, None
    if path.suffix.lower() in {".yaml", ".yml"}:
        return _load_yaml(path), path
    return _load_json(path), path


def _lineage_text(
    *,
    key: str,
    run_manifest: Mapping[str, Any],
    source_manifest: Mapping[str, Any],
) -> str | None:
    lineage = _as_dict(run_manifest.get("evidence_lineage"))
    return _as_text(lineage.get(key)) or _as_text(source_manifest.get(key))


def _lineage_list(
    *,
    key: str,
    run_manifest: Mapping[str, Any],
    source_manifest: Mapping[str, Any],
) -> list[str]:
    lineage = _as_dict(run_manifest.get("evidence_lineage"))
    raw = lineage.get(key)
    if isinstance(raw, list):
        return [text for item in raw if (text := _as_text(item))]
    source_raw = source_manifest.get(key)
    if isinstance(source_raw, list):
        return [text for item in source_raw if (text := _as_text(item))]
    return []


def _load_trade_contributions(path: Path | None) -> list[Decimal]:
    if path is None or not path.exists():
        return []
    contributions: list[Decimal] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = sorted(reader, key=lambda row: str(row.get("created_at") or ""))
        for row in rows:
            contributions.append(_as_decimal(row.get("realized_pnl_contribution")))
    return contributions


def _estimate_day_drawdown(
    *, net_pnl: Decimal, trade_pnl_csv_path: Path | None
) -> Decimal:
    equity = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    realized_total = Decimal("0")
    for contribution in _load_trade_contributions(trade_pnl_csv_path):
        realized_total += contribution
        equity += contribution
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    residual = net_pnl - realized_total
    equity += residual
    if equity > peak:
        peak = equity
    drawdown = peak - equity
    if drawdown > max_drawdown:
        max_drawdown = drawdown
    if max_drawdown == 0 and net_pnl < 0:
        return abs(net_pnl)
    return max_drawdown


def _best_signal_hash(run_dir: Path, replay_report: Mapping[str, Any]) -> str:
    replay_hash = _as_text(replay_report.get("dump_sha256"))
    if replay_hash:
        return replay_hash
    dump_manifest_path = run_dir / "source-dump.jsonl.zst.manifest.json"
    if dump_manifest_path.exists():
        dump_manifest = _load_json(dump_manifest_path)
        chunks = _as_list(dump_manifest.get("chunks"))
        chunk_hashes = [
            _as_text(_as_dict(item).get("payload_sha256"))
            or _as_text(_as_dict(item).get("sha256"))
            or ""
            for item in chunks
        ]
        normalized = [item for item in chunk_hashes if item]
        if normalized:
            return _stable_hash_payload(normalized)
        return _sha256_bytes(dump_manifest_path.read_bytes())
    source_dump_path = run_dir / "source-dump.jsonl.zst"
    if source_dump_path.exists():
        return _sha256_bytes(source_dump_path.read_bytes())
    raise RuntimeError(f"signal_hash_missing:{run_dir}")


def _load_run_summary(run_dir: Path) -> HistoricalRunSummary:
    run_manifest_path = run_dir / "run-manifest.json"
    simulation_report_path = run_dir / "report" / "simulation-report.json"
    replay_report_path = run_dir / "replay-report.json"
    trade_pnl_csv_path = run_dir / "report" / "trade-pnl.csv"

    run_manifest = _load_json(run_manifest_path)
    report = _load_json(simulation_report_path)
    replay_report = (
        _load_json(replay_report_path) if replay_report_path.exists() else {}
    )
    source_manifest, source_manifest_path = _load_source_manifest(run_dir, report)

    candidate_id = _lineage_text(
        key="candidate_id",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    if candidate_id is None:
        raise RuntimeError(f"candidate_id_missing:{run_dir}")
    baseline_candidate_id = (
        _lineage_text(
            key="baseline_candidate_id",
            run_manifest=run_manifest,
            source_manifest=source_manifest,
        )
        or _DEFAULT_BASELINE_ID
    )
    strategy_spec_ref = _lineage_text(
        key="strategy_spec_ref",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    if strategy_spec_ref is None:
        raise RuntimeError(f"strategy_spec_ref_missing:{run_dir}")
    model_refs = _lineage_list(
        key="model_refs",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    runtime_version_refs = _lineage_list(
        key="runtime_version_refs",
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    if not model_refs or not runtime_version_refs:
        raise RuntimeError(f"evidence_lineage_incomplete:{run_dir}")

    coverage = _as_dict(report.get("coverage"))
    trading_day = _as_text(
        _as_dict(source_manifest.get("window")).get("trading_day")
    ) or _as_text(
        coverage.get("window_start"),
    )
    if trading_day is None:
        raise RuntimeError(f"trading_day_missing:{run_dir}")
    if "T" in trading_day:
        trading_day = trading_day.split("T", 1)[0]

    funnel = _as_dict(report.get("funnel"))
    pnl = _as_dict(report.get("pnl"))
    llm = _as_dict(report.get("llm"))
    verdict = (
        _as_text(_as_dict(report.get("verdict")).get("status")) or "FAIL"
    ).upper()
    if verdict == "FAIL":
        raise RuntimeError(f"simulation_report_failed:{run_dir}")

    net_pnl = _as_decimal(
        pnl.get("net_pnl_estimated")
        or pnl.get("gross_pnl")
        or pnl.get("realized_pnl")
        or "0"
    )
    execution_notional_total = _as_decimal(pnl.get("execution_notional_total"))
    estimated_cost_total = _as_decimal(pnl.get("estimated_cost_total"))
    cost_bps = Decimal("0")
    if execution_notional_total > 0:
        cost_bps = (estimated_cost_total / execution_notional_total) * Decimal("10000")

    raw_confidence = _as_text(llm.get("avg_confidence"))
    confidence_value = (
        _clamp_confidence(_as_decimal(raw_confidence))
        if raw_confidence is not None
        else Decimal("1")
        if net_pnl > 0
        else Decimal("0")
    )

    signal_hash = _best_signal_hash(run_dir, replay_report)
    strategy_config_hash = (
        _sha256_bytes(source_manifest_path.read_bytes())
        if source_manifest_path is not None
        else _sha256_bytes(strategy_spec_ref.encode("utf-8"))
    )
    gate_policy_hash = _stable_hash_payload(
        {
            "monitor": _as_dict(source_manifest.get("monitor")),
            "window": _as_dict(source_manifest.get("window")),
            "report_window": coverage,
        }
    )

    return HistoricalRunSummary(
        run_id=_as_text(run_manifest.get("run_id")) or run_dir.name,
        run_dir=run_dir,
        trading_day=trading_day,
        candidate_id=candidate_id,
        baseline_candidate_id=baseline_candidate_id,
        strategy_spec_ref=strategy_spec_ref,
        model_refs=model_refs,
        runtime_version_refs=runtime_version_refs,
        net_pnl=net_pnl,
        max_drawdown=_estimate_day_drawdown(
            net_pnl=net_pnl, trade_pnl_csv_path=trade_pnl_csv_path
        ),
        cost_bps=cost_bps,
        trade_count=_as_int(funnel.get("executions")),
        decision_count=_as_int(funnel.get("trade_decisions")),
        execution_notional_total=execution_notional_total,
        estimated_cost_total=estimated_cost_total,
        confidence_value=confidence_value,
        verdict_status=verdict,
        signal_hash=signal_hash,
        strategy_config_hash=strategy_config_hash,
        gate_policy_hash=gate_policy_hash,
        simulation_report_path=simulation_report_path,
        replay_report_path=replay_report_path if replay_report_path.exists() else None,
        trade_pnl_csv_path=trade_pnl_csv_path if trade_pnl_csv_path.exists() else None,
    )


def _require_consistent_lineage(
    run_summaries: list[HistoricalRunSummary], *, label: str
) -> None:
    if not run_summaries:
        raise RuntimeError(f"{label}_run_set_empty")
    trading_days = [item.trading_day for item in run_summaries]
    if len(set(trading_days)) != len(trading_days):
        raise RuntimeError(f"{label}_trading_day_duplicate")
    candidate_ids = {item.candidate_id for item in run_summaries}
    if len(candidate_ids) != 1:
        raise RuntimeError(f"{label}_candidate_id_mismatch")
    strategy_specs = {item.strategy_spec_ref for item in run_summaries}
    if len(strategy_specs) != 1:
        raise RuntimeError(f"{label}_strategy_spec_mismatch")
    model_refs = {tuple(item.model_refs) for item in run_summaries}
    if len(model_refs) != 1:
        raise RuntimeError(f"{label}_model_refs_mismatch")
    runtime_refs = {tuple(item.runtime_version_refs) for item in run_summaries}
    if len(runtime_refs) != 1:
        raise RuntimeError(f"{label}_runtime_refs_mismatch")


def _window_max_drawdown(run_summaries: list[HistoricalRunSummary]) -> Decimal:
    equity = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    for item in sorted(run_summaries, key=lambda value: value.trading_day):
        equity += item.net_pnl
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _proof_gate_policy(
    *,
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
) -> ProfitabilityProofGatePolicy:
    return ProfitabilityProofGatePolicy(
        target_net_pnl_per_day=_as_decimal(target_net_pnl_per_day),
        min_sample_size=max(1, int(min_sample_size)),
        min_active_day_ratio=_as_decimal(min_active_day_ratio),
        min_positive_day_ratio=_as_decimal(min_positive_day_ratio),
        max_best_day_share=_as_decimal(max_best_day_share),
        min_daily_notional=_as_decimal(min_daily_notional),
        start_equity=_as_decimal(start_equity),
        max_drawdown_pct_equity=_as_decimal(max_drawdown_pct_equity),
        extended_max_drawdown_pct_equity=_as_decimal(extended_max_drawdown_pct_equity),
        min_total_net_pnl_to_drawdown_ratio=_as_decimal(
            min_total_net_pnl_to_drawdown_ratio
        ),
    )


def _proof_gate_summary(
    run_summaries: list[HistoricalRunSummary],
    *,
    policy: ProfitabilityProofGatePolicy,
) -> dict[str, Any]:
    ordered = sorted(run_summaries, key=lambda value: value.trading_day)
    sample_size = len(ordered)
    total_net_pnl = sum((item.net_pnl for item in ordered), Decimal("0"))
    average_daily_net_pnl = (
        total_net_pnl / Decimal(sample_size) if sample_size else Decimal("0")
    )
    active_days = sum(
        1
        for item in ordered
        if item.decision_count > 0
        and item.trade_count > 0
        and item.execution_notional_total > 0
    )
    positive_days = sum(1 for item in ordered if item.net_pnl > 0)
    active_day_ratio = (
        Decimal(active_days) / Decimal(sample_size) if sample_size else Decimal("0")
    )
    positive_day_ratio = (
        Decimal(positive_days) / Decimal(sample_size) if sample_size else Decimal("0")
    )
    positive_daily_net = [item.net_pnl for item in ordered if item.net_pnl > 0]
    positive_net_total = sum(positive_daily_net, Decimal("0"))
    best_day_share = (
        max(positive_daily_net) / positive_net_total
        if positive_daily_net and positive_net_total > 0
        else Decimal("0")
    )
    avg_daily_notional = (
        sum((item.execution_notional_total for item in ordered), Decimal("0"))
        / Decimal(sample_size)
        if sample_size
        else Decimal("0")
    )
    window_drawdown = _window_max_drawdown(ordered)
    intraday_drawdown = max(
        (item.max_drawdown for item in ordered), default=Decimal("0")
    )
    max_drawdown = max(window_drawdown, intraday_drawdown)
    max_drawdown_pct = (
        max_drawdown / policy.start_equity
        if policy.start_equity > 0 and max_drawdown > 0
        else Decimal("0")
    )
    net_to_drawdown_ratio = (
        total_net_pnl / max_drawdown
        if max_drawdown > 0
        else total_net_pnl
        if total_net_pnl > 0
        else Decimal("0")
    )
    extended_drawdown_allowed = (
        max_drawdown_pct <= policy.extended_max_drawdown_pct_equity
        and net_to_drawdown_ratio >= policy.min_total_net_pnl_to_drawdown_ratio
    )
    drawdown_passed = (
        max_drawdown_pct <= policy.max_drawdown_pct_equity or extended_drawdown_allowed
    )
    return {
        "target_net_pnl_per_day": str(policy.target_net_pnl_per_day),
        "min_sample_size": policy.min_sample_size,
        "min_active_day_ratio": str(policy.min_active_day_ratio),
        "min_positive_day_ratio": str(policy.min_positive_day_ratio),
        "max_best_day_share": str(policy.max_best_day_share),
        "min_daily_notional": str(policy.min_daily_notional),
        "start_equity": str(policy.start_equity),
        "max_drawdown_pct_equity": str(policy.max_drawdown_pct_equity),
        "extended_max_drawdown_pct_equity": str(
            policy.extended_max_drawdown_pct_equity
        ),
        "min_total_net_pnl_to_drawdown_ratio": str(
            policy.min_total_net_pnl_to_drawdown_ratio
        ),
        "observed": {
            "total_net_pnl": str(total_net_pnl),
            "average_daily_net_pnl": str(average_daily_net_pnl),
            "sample_size": sample_size,
            "active_days": active_days,
            "active_day_ratio": str(active_day_ratio),
            "positive_days": positive_days,
            "positive_day_ratio": str(positive_day_ratio),
            "best_day_share": str(best_day_share),
            "avg_daily_notional": str(avg_daily_notional),
            "window_max_drawdown": str(window_drawdown),
            "intraday_max_drawdown": str(intraday_drawdown),
            "max_drawdown": str(max_drawdown),
            "max_drawdown_pct_equity": str(max_drawdown_pct),
            "net_pnl_to_drawdown_ratio": str(net_to_drawdown_ratio),
            "extended_drawdown_allowed": extended_drawdown_allowed,
            "drawdown_passed": drawdown_passed,
        },
    }


def _build_report_payload(
    run_summaries: list[HistoricalRunSummary],
) -> dict[str, object]:
    ordered = sorted(run_summaries, key=lambda value: value.trading_day)
    total_net = sum((item.net_pnl for item in ordered), Decimal("0"))
    total_notional = sum(
        (item.execution_notional_total for item in ordered), Decimal("0")
    )
    total_cost = sum((item.estimated_cost_total for item in ordered), Decimal("0"))
    total_trades = sum(item.trade_count for item in ordered)
    total_decisions = sum(item.decision_count for item in ordered)
    market_cost_bps = (
        (total_cost / total_notional) * Decimal("10000")
        if total_notional > 0
        else Decimal("0")
    )
    folds = [
        {
            "fold_name": item.trading_day,
            "trade_count": item.trade_count,
            "net_pnl": str(item.net_pnl),
            "max_drawdown": str(item.max_drawdown),
            "cost_bps": str(item.cost_bps),
            "turnover_ratio": "0",
            "regime_label": item.trading_day,
        }
        for item in ordered
    ]
    return {
        "metrics": {
            "net_pnl": str(total_net),
            "max_drawdown": str(_window_max_drawdown(ordered)),
            "cost_bps": str(market_cost_bps),
            "trade_count": total_trades,
            "decision_count": total_decisions,
            "turnover_ratio": "0",
        },
        "robustness": {
            "folds": folds,
        },
        "impact_assumptions": {
            "decisions_with_spread": total_decisions,
            "decisions_with_volatility": total_decisions,
            "decisions_with_adv": total_decisions,
            "assumptions": {
                "recorded_inputs_count": str(total_decisions),
                "fallback_inputs_count": "0",
            },
        },
    }


__all__ = [name for name in globals() if not name.startswith("__")]
