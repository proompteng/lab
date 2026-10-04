from __future__ import annotations

import argparse
import json
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)
from app.trading.discovery.autoresearch import StrategyAutoresearchProgram
from app.trading.discovery.portfolio_optimizer import PortfolioCandidateSpec
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS,
    _boolish,
    _decimal,
    _mapping,
    _oracle_blockers,
    _resolve_existing_path,
    _string,
    _string_list_from_value,
)


def _runtime_closure_payload(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    program: StrategyAutoresearchProgram,
    manifest: MlxSnapshotManifest,
    portfolio: PortfolioCandidateSpec | None,
) -> Mapping[str, Any]:
    execution_context = RuntimeClosureExecutionContext(
        strategy_configmap_path=_resolve_existing_path(args.strategy_configmap),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=str(args.clickhouse_username)
        if args.clickhouse_username
        else None,
        clickhouse_password=str(args.clickhouse_password)
        if args.clickhouse_password
        else None,
        start_equity=_decimal(args.start_equity, default="31590.02"),
        chunk_minutes=int(args.chunk_minutes),
        symbols=tuple(
            symbol.strip() for symbol in str(args.symbols).split(",") if symbol.strip()
        ),
        progress_log_interval_seconds=int(args.progress_log_seconds),
        shadow_validation_artifact_path=_resolve_existing_path(
            cast(Path, getattr(args, "shadow_validation_artifact"))
        )
        if getattr(args, "shadow_validation_artifact", None) is not None
        else None,
    )
    return write_runtime_closure_bundle(
        run_root=output_dir,
        runner_run_id=epoch_id,
        program=program,
        best_candidate=portfolio,
        manifest=manifest,
        execution_context=execution_context if portfolio is not None else None,
    ).to_payload()


def _portfolio_needs_runtime_closure_proof(portfolio: PortfolioCandidateSpec) -> bool:
    scorecard = _mapping(portfolio.objective_scorecard)
    if _boolish(scorecard.get("oracle_passed")):
        return False
    if not _boolish(scorecard.get("target_met")):
        return False
    blockers = _oracle_blockers(scorecard)
    return bool(blockers) and blockers <= _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS


def _load_json_mapping_artifact(path_value: Any) -> dict[str, Any]:
    path_text = _string(path_value)
    if not path_text:
        return {}
    try:
        payload = json.loads(Path(path_text).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return _mapping(payload)


def _runtime_closure_artifact_refs(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    refs: list[str] = []
    root = _string(runtime_closure.get("root"))
    if root:
        summary_path = Path(root) / "summary.json"
        if summary_path.exists():
            refs.append(str(summary_path))
    for key in (
        "candidate_configmap_path",
        "gate_report_path",
        "parity_replay_path",
        "parity_report_path",
        "approval_replay_path",
        "approval_report_path",
        "exact_replay_ledger_artifact_path",
        "exact_replay_ledger_artifact_ref",
        "runtime_ledger_artifact_path",
        "runtime_ledger_artifact_ref",
        "shadow_validation_path",
        "portfolio_proof_receipt_path",
        "market_impact_stress_report_path",
        "market_impact_stress_artifact_path",
        "delay_adjusted_depth_stress_report_path",
        "delay_depth_stress_report_path",
        "latency_depth_stress_artifact_path",
        "double_oos_report_path",
        "double_oos_artifact_path",
        "walkforward_double_oos_report_path",
        "stress_metrics_path",
        "profitability_stage_manifest_path",
        "promotion_prerequisites_path",
        "replay_plan_path",
    ):
        ref = _string(runtime_closure.get(key))
        if ref and Path(ref).exists() and ref not in refs:
            refs.append(ref)
    return tuple(refs)


def _runtime_report_summary_int(
    report: Mapping[str, Any], key: str, *, default: int = 0
) -> int:
    value = _mapping(report.get("summary")).get(key)
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def _runtime_report_int(value: Any, *, default: int = 0) -> int:
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def _runtime_closure_ledger_datetime(
    value: Any, *, date_end: bool = False
) -> datetime | None:
    text = _string(value)
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=UTC)
            return parsed + timedelta(days=1) if date_end else parsed
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _runtime_closure_exact_replay_bucket_range(
    ledger: Mapping[str, Any],
) -> tuple[datetime, datetime] | None:
    start = _runtime_closure_ledger_datetime(
        ledger.get("window_start")
        or ledger.get("bucket_started_at")
        or ledger.get("started_at")
        or ledger.get("start"),
    )
    end = _runtime_closure_ledger_datetime(
        ledger.get("window_end")
        or ledger.get("bucket_ended_at")
        or ledger.get("ended_at")
        or ledger.get("end"),
        date_end=True,
    )
    if start is None or end is None or end <= start:
        return None
    return (start, end)


def _runtime_closure_replay_bucket_has_authority(bucket: RuntimeLedgerBucket) -> bool:
    return (
        not bucket.blockers
        and bucket.fill_count > 0
        and bucket.decision_count > 0
        and bucket.submitted_order_count > 0
        and bucket.closed_trade_count > 0
        and bucket.open_position_count == 0
        and bucket.filled_notional > 0
        and bool(bucket.cost_basis_counts)
        and bool(bucket.execution_policy_hash_counts)
        and bool(bucket.cost_model_hash_counts)
        and bool(bucket.lineage_hash_counts)
        and bucket.pnl_basis == POST_COST_PNL_BASIS
    )


def _runtime_closure_exact_replay_bucket(
    *,
    ledger: Mapping[str, Any],
    rows: Sequence[Mapping[str, object]],
) -> RuntimeLedgerBucket | None:
    bucket_range = _runtime_closure_exact_replay_bucket_range(ledger)
    if bucket_range is None:
        return None
    buckets = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[bucket_range],
        require_order_lifecycle=True,
    )
    if len(buckets) != 1:
        return None
    bucket = buckets[0]
    if not _runtime_closure_replay_bucket_has_authority(bucket):
        return None
    return bucket


def _runtime_report_source_markers(report: Mapping[str, Any]) -> list[str]:
    return sorted(set(_string_list_from_value(report.get("source_markers"))))


def _market_impact_default_source_markers() -> list[str]:
    return [
        "double_square_root_impact_arxiv_2502_16246_2025",
        "realistic_market_impact_arxiv_2603_29086_2026",
    ]


def _runtime_closure_start_equity(runtime_closure: Mapping[str, Any]) -> Decimal:
    replay_plan = _load_json_mapping_artifact(runtime_closure.get("replay_plan_path"))
    execution_context = _mapping(replay_plan.get("execution_context"))
    return _decimal(execution_context.get("start_equity"))


def _portfolio_executable_max_notional(portfolio: PortfolioCandidateSpec) -> Decimal:
    max_notional = Decimal("0")
    base_per_leg_notional = Decimal("50000")
    for sleeve in portfolio.sleeves:
        explicit_max = _decimal(sleeve.get("max_notional_per_trade"))
        if explicit_max > 0:
            max_notional = max(max_notional, explicit_max)
            continue
        weight = _decimal(sleeve.get("weight"), default="1")
        if weight <= 0:
            weight = Decimal("1")
        max_notional = max(max_notional, base_per_leg_notional * weight)
    return max_notional


def _runtime_closure_exact_replay_ledger_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    # Exact-replay rows are useful diagnostics, but they are not runtime or
    # live-paper ledger authority. Final proof must come from source-backed
    # runtime-ledger materialization instead of replay artifacts.
    return {}


def _runtime_closure_market_impact_stress_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    market_impact_report_path = _string(
        runtime_closure.get("market_impact_stress_report_path")
        or runtime_closure.get("market_impact_stress_artifact_path")
    )
    market_impact_report = _load_json_mapping_artifact(market_impact_report_path)
    if not market_impact_report:
        return {}
    model = _string(
        market_impact_report.get("model")
        or market_impact_report.get("impact_model")
        or market_impact_report.get("cost_model")
    )
    cost_bps = str(
        _decimal(
            market_impact_report.get("impact_cost_bps")
            or market_impact_report.get("market_impact_cost_bps")
            or market_impact_report.get("cost_shock_bps")
        )
    )
    net_pnl_per_day = str(
        _decimal(
            market_impact_report.get("post_impact_net_pnl_per_day")
            or market_impact_report.get("stressed_net_pnl_per_day")
            or market_impact_report.get("net_pnl_per_day")
        )
    )
    components = _mapping(market_impact_report.get("market_impact_stress_components"))
    source_markers = _runtime_report_source_markers(market_impact_report)
    if not source_markers:
        source_markers = sorted(
            set(_string_list_from_value(components.get("source_markers")))
        )
    if not source_markers and (components or model):
        source_markers = _market_impact_default_source_markers()
    if not components and model and _decimal(cost_bps) > 0:
        components = {
            "selected_model": model,
            "selected_cost_bps": cost_bps,
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "source_markers": source_markers,
        }
    elif components and source_markers and "source_markers" not in components:
        components = {**components, "source_markers": source_markers}
    return {
        "market_impact_stress_passed": _boolish(
            market_impact_report.get("objective_met")
            or market_impact_report.get("passed")
        ),
        "market_impact_stress_artifact_ref": market_impact_report_path,
        "market_impact_stress_source_markers": source_markers,
        "market_impact_stress_model": model,
        "market_impact_stress_cost_bps": cost_bps,
        "market_impact_stress_components": components,
        "nonlinear_market_impact_stress_passed": _boolish(
            market_impact_report.get("objective_met")
            or market_impact_report.get("passed")
        ),
        "nonlinear_market_impact_stress_model": model,
        "nonlinear_market_impact_stress_cost_bps": cost_bps,
        "nonlinear_market_impact_stress_net_pnl_per_day": net_pnl_per_day,
        "permanent_impact_decay_model": _string(
            market_impact_report.get("permanent_impact_decay_model")
            or "exponential_decay_proxy"
        ),
        "market_impact_liquidity_evidence_present": _boolish(
            market_impact_report.get("liquidity_evidence_present")
            or market_impact_report.get("market_impact_liquidity_evidence_present")
        ),
        "market_impact_stress_net_pnl_per_day": net_pnl_per_day,
    }


def _runtime_closure_delay_adjusted_depth_stress_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    delay_depth_report_path = _string(
        runtime_closure.get("delay_adjusted_depth_stress_report_path")
        or runtime_closure.get("delay_depth_stress_report_path")
        or runtime_closure.get("latency_depth_stress_artifact_path")
    )
    delay_depth_report = _load_json_mapping_artifact(delay_depth_report_path)
    if not delay_depth_report:
        return {}
    checked_at = _string(
        delay_depth_report.get("generated_at") or delay_depth_report.get("checked_at")
    )
    fillable_notional_per_day = _decimal(
        delay_depth_report.get("fillable_notional_per_day")
        or delay_depth_report.get("depth_fillable_notional_per_day")
    )
    stress_ms = _decimal(
        delay_depth_report.get("stress_delay_ms") or delay_depth_report.get("delay_ms")
    )
    latency_grid = cast(
        Sequence[Any],
        delay_depth_report.get("latency_grid_ms")
        or delay_depth_report.get("delay_grid_ms")
        or (),
    )
    if not latency_grid and stress_ms > 0:
        latency_grid = ("50", "150", "250")
    fill_survival_sample_count = max(
        _runtime_report_int(
            delay_depth_report.get("delay_adjusted_depth_fill_survival_sample_count")
        ),
        _runtime_report_int(delay_depth_report.get("fill_survival_sample_count")),
    )
    fill_survival_rate = _decimal(
        delay_depth_report.get("delay_adjusted_depth_fill_survival_rate")
        or delay_depth_report.get("fill_survival_fill_rate")
        or delay_depth_report.get("fill_survival_rate")
    )
    fill_survival_evidence_present = _boolish(
        delay_depth_report.get("delay_adjusted_depth_fill_survival_evidence_present")
        or delay_depth_report.get("fill_survival_evidence_present")
        or (fill_survival_sample_count > 0)
    )
    queue_position_survival_evidence_present = _boolish(
        delay_depth_report.get("queue_position_survival_fill_curve_evidence_present")
        or delay_depth_report.get("queue_position_survival_evidence_present")
    )
    queue_position_survival_sample_count = max(
        _runtime_report_int(
            delay_depth_report.get("queue_position_survival_sample_count")
        ),
        _runtime_report_int(
            delay_depth_report.get("queue_position_survival_fill_sample_count")
        ),
    )
    if (
        queue_position_survival_evidence_present
        and queue_position_survival_sample_count == 0
    ):
        queue_position_survival_sample_count = fill_survival_sample_count
    queue_position_survival_fill_rate = _decimal(
        delay_depth_report.get("queue_position_survival_fill_rate")
        or (
            fill_survival_rate
            if queue_position_survival_evidence_present
            else Decimal("0")
        )
    )
    queue_position_survival_queue_ratio_p95 = _decimal(
        delay_depth_report.get("queue_position_survival_queue_ratio_p95")
    )
    queue_ahead_depletion_sample_count = max(
        _runtime_report_int(
            delay_depth_report.get(
                "queue_position_survival_queue_ahead_depletion_sample_count"
            )
        ),
        _runtime_report_int(
            delay_depth_report.get(
                "delay_adjusted_depth_queue_ahead_depletion_sample_count"
            )
        ),
        _runtime_report_int(
            delay_depth_report.get("queue_ahead_depletion_sample_count")
        ),
    )
    queue_ahead_depletion_evidence_present = _boolish(
        delay_depth_report.get(
            "queue_position_survival_queue_ahead_depletion_evidence_present"
        )
        or delay_depth_report.get(
            "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
        )
        or delay_depth_report.get("queue_ahead_depletion_evidence_present")
        or (queue_ahead_depletion_sample_count > 0)
    )
    queue_position_survival_net_pnl_per_day = _decimal(
        delay_depth_report.get(
            "post_cost_net_pnl_after_queue_position_survival_fill_stress"
        )
        or delay_depth_report.get("post_queue_position_survival_net_pnl_per_day")
        or (
            delay_depth_report.get("post_delay_depth_net_pnl_per_day")
            if queue_position_survival_evidence_present
            and queue_ahead_depletion_evidence_present
            else Decimal("0")
        )
    )
    return {
        "delay_adjusted_depth_stress_checks_total": max(
            _runtime_report_int(delay_depth_report.get("stress_case_count")),
            _runtime_report_int(delay_depth_report.get("case_count")),
            _runtime_report_int(delay_depth_report.get("trading_day_count")),
        ),
        "delay_adjusted_depth_stress_passed": _boolish(
            delay_depth_report.get("objective_met") or delay_depth_report.get("passed")
        ),
        "delay_adjusted_depth_stress_checked_at": checked_at,
        "delay_adjusted_depth_stress_artifact_ref": delay_depth_report_path,
        "delay_adjusted_depth_stress_source_markers": _runtime_report_source_markers(
            delay_depth_report
        ),
        "delay_adjusted_depth_stress_report": dict(delay_depth_report),
        "delay_adjusted_depth_stress_model": _string(
            delay_depth_report.get("model") or delay_depth_report.get("stress_model")
        ),
        "delay_adjusted_depth_stress_ms": str(stress_ms),
        "delay_adjusted_depth_latency_grid_ms": [str(item) for item in latency_grid],
        "delay_adjusted_depth_grid_max_stress_ms": str(
            max((_decimal(item) for item in latency_grid), default=stress_ms)
        ),
        "delay_adjusted_depth_liquidity_evidence_present": bool(
            fillable_notional_per_day > 0
        ),
        "delay_adjusted_depth_liquidity_missing_day_count": _runtime_report_int(
            delay_depth_report.get("missing_liquidity_day_count")
        ),
        "delay_adjusted_depth_fillable_notional_per_day": str(
            fillable_notional_per_day
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": str(
            _decimal(
                delay_depth_report.get("worst_active_day_fillable_notional")
                or fillable_notional_per_day
            )
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": str(
            _decimal(
                delay_depth_report.get("p10_active_day_fillable_notional")
                or fillable_notional_per_day
            )
        ),
        "delay_adjusted_depth_tail_coverage_passed": _boolish(
            delay_depth_report.get("tail_coverage_passed")
            if "tail_coverage_passed" in delay_depth_report
            else fillable_notional_per_day > 0
        ),
        "delay_adjusted_depth_fill_survival_evidence_present": fill_survival_evidence_present,
        "delay_adjusted_depth_fill_survival_sample_count": fill_survival_sample_count,
        "delay_adjusted_depth_fill_survival_rate": str(fill_survival_rate),
        "queue_position_survival_fill_curve_evidence_present": (
            queue_position_survival_evidence_present
        ),
        "queue_position_survival_sample_count": queue_position_survival_sample_count,
        "queue_position_survival_fill_rate": str(queue_position_survival_fill_rate),
        "queue_position_survival_queue_ratio_p95": str(
            queue_position_survival_queue_ratio_p95
        ),
        "queue_position_survival_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_position_survival_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "queue_ahead_depletion_evidence_present": queue_ahead_depletion_evidence_present,
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_stress_net_pnl_per_day": str(
            _decimal(
                delay_depth_report.get("post_delay_depth_net_pnl_per_day")
                or delay_depth_report.get("stressed_net_pnl_per_day")
            )
        ),
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
            queue_position_survival_net_pnl_per_day
        ),
    }


def _runtime_closure_double_oos_update(
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    double_oos_report_path = _string(
        runtime_closure.get("double_oos_report_path")
        or runtime_closure.get("double_oos_artifact_path")
        or runtime_closure.get("walkforward_double_oos_report_path")
    )
    double_oos_report = _load_json_mapping_artifact(double_oos_report_path)
    if not double_oos_report:
        return {}
    return {
        "double_oos_passed": _boolish(
            double_oos_report.get("objective_met") or double_oos_report.get("passed")
        ),
        "double_oos_artifact_ref": double_oos_report_path,
        "double_oos_source_markers": _runtime_report_source_markers(double_oos_report),
        "double_oos_independent_window_count": max(
            _runtime_report_int(double_oos_report.get("independent_window_count")),
            _runtime_report_int(double_oos_report.get("window_count")),
            _runtime_report_int(double_oos_report.get("fold_count")),
        ),
        "double_oos_pass_rate": str(_decimal(double_oos_report.get("pass_rate"))),
        "double_oos_net_pnl_per_day": str(
            _decimal(
                double_oos_report.get("net_pnl_per_day")
                or double_oos_report.get("post_double_oos_net_pnl_per_day")
            )
        ),
        "double_oos_cost_shock_net_pnl_per_day": str(
            _decimal(
                double_oos_report.get("cost_shock_net_pnl_per_day")
                or double_oos_report.get("post_cost_shock_net_pnl_per_day")
                or double_oos_report.get("market_impact_stress_net_pnl_per_day")
            )
        ),
    }


def _runtime_closure_scorecard_update(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    parity_report = _load_json_mapping_artifact(
        runtime_closure.get("parity_report_path")
    )
    approval_report = _load_json_mapping_artifact(
        runtime_closure.get("approval_report_path")
    )
    shadow_validation = _load_json_mapping_artifact(
        runtime_closure.get("shadow_validation_path")
    )
    parity_pass = _boolish(parity_report.get("objective_met"))
    approval_pass = _boolish(approval_report.get("objective_met"))
    artifact_refs = _runtime_closure_artifact_refs(runtime_closure)
    executable_artifact_refs = tuple(
        ref
        for ref in (
            _string(runtime_closure.get("parity_replay_path")),
            _string(runtime_closure.get("approval_replay_path")),
        )
        if ref and Path(ref).exists()
    )
    executable_report = approval_report if approval_report else parity_report
    filled_order_count = _runtime_report_summary_int(executable_report, "filled_count")
    submitted_order_count = _runtime_report_summary_int(
        executable_report, "decision_count"
    )
    shadow_status = _string(shadow_validation.get("status")) or "missing"
    market_impact_update = _runtime_closure_market_impact_stress_update(runtime_closure)
    delay_depth_update = _runtime_closure_delay_adjusted_depth_stress_update(
        runtime_closure
    )
    double_oos_update = _runtime_closure_double_oos_update(runtime_closure)
    exact_replay_ledger_update = _runtime_closure_exact_replay_ledger_update(
        runtime_closure
    )
    runtime_closure_source_markers = sorted(
        set(
            _string_list_from_value(
                market_impact_update.get("market_impact_stress_source_markers")
            )
            + _string_list_from_value(
                delay_depth_update.get("delay_adjusted_depth_stress_source_markers")
            )
            + _string_list_from_value(
                double_oos_update.get("double_oos_source_markers")
            )
        )
    )
    return {
        "runtime_closure_proof": {
            "status": _string(runtime_closure.get("status")) or "missing",
            "parity_objective_met": parity_pass,
            "approval_objective_met": approval_pass,
            "shadow_status": shadow_status,
            "artifact_refs": list(artifact_refs),
            "executable_replay_artifact_refs": list(executable_artifact_refs),
            "market_impact_stress_artifact_ref": market_impact_update.get(
                "market_impact_stress_artifact_ref", ""
            ),
            "delay_adjusted_depth_stress_artifact_ref": delay_depth_update.get(
                "delay_adjusted_depth_stress_artifact_ref", ""
            ),
            "double_oos_artifact_ref": double_oos_update.get(
                "double_oos_artifact_ref", ""
            ),
            "exact_replay_ledger_artifact_ref": exact_replay_ledger_update.get(
                "exact_replay_ledger_artifact_ref", ""
            ),
        },
        "runtime_closure_artifact_refs": list(artifact_refs),
        "shadow_parity_status": "within_budget"
        if shadow_status == "within_budget"
        else shadow_status,
        "executable_replay_passed": (
            parity_pass and approval_pass and bool(executable_artifact_refs)
        ),
        "executable_replay_artifact_refs": list(executable_artifact_refs),
        "executable_replay_artifact_ref": executable_artifact_refs[-1]
        if executable_artifact_refs
        else "",
        "executable_replay_order_count": filled_order_count,
        "executable_replay_submitted_order_count": submitted_order_count,
        "executable_replay_account_buying_power": str(
            _runtime_closure_start_equity(runtime_closure)
        ),
        "executable_replay_max_notional_per_trade": str(
            _portfolio_executable_max_notional(portfolio)
        ),
        "runtime_closure_source_markers": runtime_closure_source_markers,
        **exact_replay_ledger_update,
        **market_impact_update,
        **delay_depth_update,
        **double_oos_update,
    }


def _runtime_closure_pending_promotion_steps(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    return tuple(
        step
        for step in (
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
            )
        )
        if step and step != "promotion_review"
    )


def _runtime_closure_promotion_prerequisite_blockers(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    prerequisites = _mapping(runtime_closure.get("promotion_prerequisites"))
    if not prerequisites:
        return ("promotion_prerequisites_missing",)
    if _boolish(prerequisites.get("allowed")):
        return ()
    reasons = tuple(
        reason
        for reason in (
            _string(item)
            for item in cast(Sequence[Any], prerequisites.get("reasons") or ())
        )
        if reason
    )
    return reasons or ("promotion_prerequisites_denied",)


def _promotion_readiness_payload(
    *,
    oracle_candidate_found: bool,
    status: str,
    blockers: Sequence[str],
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    blocker_list = list(
        dict.fromkeys(_string(item) for item in blockers if _string(item))
    )
    if oracle_candidate_found:
        blocker_list = list(
            dict.fromkeys(
                (
                    *blocker_list,
                    *_runtime_closure_pending_promotion_steps(runtime_closure),
                    *_runtime_closure_promotion_prerequisite_blockers(runtime_closure),
                )
            )
        )
    if oracle_candidate_found and not blocker_list:
        return {
            "status": "promotion_ready",
            "promotable": True,
            "blockers": [],
        }
    return {
        "status": "blocked_pending_promotion_prerequisites"
        if oracle_candidate_found and blocker_list
        else status,
        "promotable": False,
        "blockers": blocker_list,
    }


__all__ = [
    "_runtime_closure_payload",
    "_portfolio_needs_runtime_closure_proof",
    "_load_json_mapping_artifact",
    "_runtime_closure_artifact_refs",
    "_runtime_report_summary_int",
    "_runtime_report_int",
    "_runtime_closure_ledger_datetime",
    "_runtime_closure_exact_replay_bucket_range",
    "_runtime_closure_replay_bucket_has_authority",
    "_runtime_closure_exact_replay_bucket",
    "_runtime_report_source_markers",
    "_market_impact_default_source_markers",
    "_runtime_closure_start_equity",
    "_portfolio_executable_max_notional",
    "_runtime_closure_exact_replay_ledger_update",
    "_runtime_closure_market_impact_stress_update",
    "_runtime_closure_delay_adjusted_depth_stress_update",
    "_runtime_closure_double_oos_update",
    "_runtime_closure_scorecard_update",
    "_runtime_closure_pending_promotion_steps",
    "_runtime_closure_promotion_prerequisite_blockers",
    "_promotion_readiness_payload",
]
