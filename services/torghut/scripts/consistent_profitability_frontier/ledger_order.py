from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.reporting import summarize_replay_profitability
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from scripts.consistent_profitability_frontier.common import (
    OrderTypeAblationPolicy,
    _daily_filled_notional,
    _int_mapping,
    _mapping,
    _nonnegative_int_metric,
    _replay_tape_selection_metadata,
    _truthy_metric,
    _write_json_output,
)


def _order_lifecycle_metrics(payload: Mapping[str, Any]) -> dict[str, Any]:
    lifecycle = _mapping(payload.get("order_lifecycle"))
    if not lifecycle:
        return {}
    queue_ahead_depletion_sample_count = _nonnegative_int_metric(
        lifecycle.get("queue_ahead_depletion_sample_count")
        or lifecycle.get("queue_depletion_sample_count")
    )
    queue_ahead_depletion_evidence_present = _truthy_metric(
        lifecycle.get("queue_ahead_depletion_evidence_present")
    ) or (
        queue_ahead_depletion_sample_count > 0
        and (
            lifecycle.get("queue_ahead_depletion_rate") is not None
            or lifecycle.get("queue_ahead_depleted_qty_p50") is not None
            or lifecycle.get("queue_ahead_depletion_time_ms_p50") is not None
        )
    )
    metrics: dict[str, Any] = {
        "order_lifecycle": lifecycle,
        "fill_survival_evidence_present": bool(
            lifecycle.get("fill_survival_evidence_present")
        ),
        "fill_survival_sample_count": int(
            lifecycle.get("fill_survival_sample_count")
            or lifecycle.get("submitted_order_count")
            or 0
        ),
        "fill_survival_fill_rate": str(lifecycle.get("fill_rate") or "0"),
        "fill_time_ms_avg": str(lifecycle.get("fill_time_ms_avg") or ""),
        "fill_time_ms_p50": lifecycle.get("fill_time_ms_p50"),
        "fill_time_ms_p95": lifecycle.get("fill_time_ms_p95"),
        "pending_age_ms_p95": lifecycle.get("pending_age_ms_p95"),
        "max_censored_pending_age_ms": lifecycle.get("max_censored_pending_age_ms"),
        "spread_bps_avg_at_order": str(lifecycle.get("spread_bps_avg_at_order") or ""),
        "spread_bps_p95_at_order": str(lifecycle.get("spread_bps_p95_at_order") or ""),
        "depth_notional_min_at_order": str(
            lifecycle.get("depth_notional_min_at_order") or ""
        ),
        "depth_notional_avg_at_order": str(
            lifecycle.get("depth_notional_avg_at_order") or ""
        ),
        "queue_touch_qty_avg": str(lifecycle.get("queue_touch_qty_avg") or ""),
        "queue_touch_notional_avg": str(
            lifecycle.get("queue_touch_notional_avg") or ""
        ),
        "order_qty_to_touch_qty_ratio_p95": str(
            lifecycle.get("order_qty_to_touch_qty_ratio_p95") or ""
        ),
        "queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "fill_probability_by_latency_bucket": _mapping(
            lifecycle.get("fill_probability_by_latency_bucket")
        ),
        "fill_probability_by_latency_threshold_ms": _mapping(
            lifecycle.get("fill_probability_by_latency_threshold_ms")
        ),
    }
    for key in (
        "queue_ahead_depletion_rate",
        "queue_ahead_qty_p95",
        "queue_ahead_depleted_qty_p50",
        "queue_ahead_depleted_qty_p95",
        "queue_ahead_depletion_time_ms_p50",
        "queue_ahead_depletion_time_ms_p95",
    ):
        if key in lifecycle:
            metrics[key] = lifecycle[key]
    survivorship = _mapping(lifecycle.get("post_cost_survivorship"))
    if survivorship:
        metrics["post_cost_survivorship"] = survivorship
        metrics["post_cost_survival_rate"] = str(
            survivorship.get("post_cost_survival_rate") or "0"
        )
        metrics["gross_positive_killed_by_cost_count"] = int(
            survivorship.get("gross_positive_killed_by_cost_count") or 0
        )
    return metrics


def _order_type_execution_metrics(payload: Mapping[str, Any]) -> dict[str, Any]:
    decision_counts = _int_mapping(payload.get("decision_count_by_order_type"))
    filled_counts = _int_mapping(payload.get("filled_count_by_order_type"))
    market_decision_count = max(0, decision_counts.get("market", 0))
    limit_decision_count = max(0, decision_counts.get("limit", 0))
    market_limit_sample_count = market_decision_count + limit_decision_count
    metrics: dict[str, Any] = {}
    if decision_counts:
        metrics["decision_count_by_order_type"] = decision_counts
    if filled_counts:
        metrics["filled_count_by_order_type"] = filled_counts
    if "limit_fill_rate" in payload:
        metrics["limit_fill_rate"] = str(payload.get("limit_fill_rate") or "0")
    if market_limit_sample_count > 0:
        metrics["market_limit_order_mix_sample_count"] = market_limit_sample_count
        metrics["market_limit_order_mix_evidence_present"] = True
    if market_decision_count > 0 and limit_decision_count > 0:
        metrics["market_limit_order_mix_passed"] = True
    if limit_decision_count > 0:
        metrics["limit_fill_probability_sample_count"] = limit_decision_count
        metrics["limit_fill_probability_evidence_present"] = (
            "limit_fill_rate" in payload or filled_counts.get("limit", 0) > 0
        )
    return metrics


def _normalized_order_type(value: Any) -> str:
    raw_value = str(value or "").strip().lower()
    if raw_value in {"limit", "prefer_limit"}:
        return "limit"
    return "market"


def _selected_entry_order_type(
    *,
    candidate_params: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
) -> str:
    if "entry_order_type" in candidate_params:
        return _normalized_order_type(candidate_params.get("entry_order_type"))
    if "entry_order_type" in strategy_overrides:
        return _normalized_order_type(strategy_overrides.get("entry_order_type"))
    return "market"


def _forced_order_type_sample_count(
    payload: Mapping[str, Any],
    *,
    order_type: str,
) -> int:
    decision_counts = _int_mapping(payload.get("decision_count_by_order_type"))
    if decision_counts:
        return max(0, decision_counts.get(order_type, 0))
    return max(0, int(payload.get("decision_count") or 0))


def _payload_digest(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _artifact_run_dir_name(json_output: Path) -> str:
    raw_name = json_output.stem.strip()
    safe_name = "".join(
        character if character.isalnum() or character in "._-" else "-"
        for character in raw_name
    ).strip(".-_")
    return safe_name or "frontier-run"


def _order_type_ablation_artifact_dir(
    *,
    args: argparse.Namespace,
    root: Path,
) -> Path:
    json_output = getattr(args, "json_output", None)
    if isinstance(json_output, Path):
        return (
            json_output.parent
            / "frontier-artifacts"
            / _artifact_run_dir_name(json_output)
        )
    return root / "frontier-artifacts"


def _frontier_ledger_text(value: Any) -> str:
    return str(value or "").strip()


def _frontier_ledger_datetime(value: Any, *, date_end: bool = False) -> datetime | None:
    text = _frontier_ledger_text(value)
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
            return parsed + timedelta(days=1) if date_end else parsed
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _frontier_exact_replay_bucket_range(
    *,
    ledger_payload: Mapping[str, Any],
    full_window_start: date | None,
    full_window_end: date | None,
) -> tuple[datetime, datetime] | None:
    full_window = _mapping(ledger_payload.get("full_window"))
    start = _frontier_ledger_datetime(
        ledger_payload.get("window_start")
        or ledger_payload.get("bucket_started_at")
        or ledger_payload.get("started_at")
        or ledger_payload.get("start")
        or full_window.get("start_date")
        or (full_window_start.isoformat() if full_window_start is not None else "")
    )
    end = _frontier_ledger_datetime(
        ledger_payload.get("window_end")
        or ledger_payload.get("bucket_ended_at")
        or ledger_payload.get("ended_at")
        or ledger_payload.get("end")
        or full_window.get("end_date")
        or (full_window_end.isoformat() if full_window_end is not None else ""),
        date_end=True,
    )
    if start is None or end is None or end <= start:
        return None
    return (start, end)


def _frontier_exact_replay_rows(
    ledger_payload: Mapping[str, Any],
    raw_rows: Sequence[object],
) -> list[Mapping[str, object]]:
    defaults = {
        key: ledger_payload.get(key)
        for key in (
            "account_label",
            "source",
            "execution_policy_hash",
            "cost_model_hash",
            "lineage_hash",
            "replay_data_hash",
            "cost_basis",
        )
        if ledger_payload.get(key) not in (None, "")
    }
    rows: list[Mapping[str, object]] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, Mapping):
            return []
        row = dict(cast(Mapping[str, object], raw_row))
        for key, value in defaults.items():
            row.setdefault(key, value)
        rows.append(row)
    return rows


def _frontier_exact_replay_bucket_has_authority(bucket: RuntimeLedgerBucket) -> bool:
    return (
        not bucket.blockers
        and bucket.fill_count > 0
        and bucket.decision_count > 0
        and bucket.submitted_order_count > 0
        and bucket.closed_trade_count > 0
        and bucket.open_position_count == 0
        and bucket.filled_notional > 0
        and bucket.post_cost_expectancy_bps is not None
        and bool(bucket.cost_basis_counts)
        and bool(bucket.execution_policy_hash_counts)
        and bool(bucket.cost_model_hash_counts)
        and bool(bucket.lineage_hash_counts)
        and bucket.pnl_basis == POST_COST_PNL_BASIS
    )


def _frontier_exact_replay_bucket(
    *,
    ledger_payload: Mapping[str, Any],
    raw_rows: Sequence[object],
    full_window_start: date | None,
    full_window_end: date | None,
) -> RuntimeLedgerBucket | None:
    bucket_range = _frontier_exact_replay_bucket_range(
        ledger_payload=ledger_payload,
        full_window_start=full_window_start,
        full_window_end=full_window_end,
    )
    if bucket_range is None:
        return None
    runtime_rows = _frontier_exact_replay_rows(ledger_payload, raw_rows)
    if not runtime_rows:
        return None
    buckets = build_runtime_ledger_buckets(
        runtime_rows,
        bucket_ranges=[bucket_range],
        require_order_lifecycle=True,
    )
    if len(buckets) != 1:
        return None
    bucket = buckets[0]
    if not _frontier_exact_replay_bucket_has_authority(bucket):
        return None
    return bucket


def _exact_replay_ledger_artifact_update(
    *,
    args: argparse.Namespace,
    root: Path,
    candidate_index: int,
    candidate_id: str,
    full_window_payload: Mapping[str, Any],
    dataset_snapshot_id: str = "",
    replay_lineage: Mapping[str, Any] | None = None,
    candidate_evaluation_key: Mapping[str, Any] | None = None,
    replay_tape_validation: Mapping[str, Any] | None = None,
    candidate_search_key: str = "",
    candidate_symbols: Sequence[str] = (),
    full_window_start: date | None = None,
    full_window_end: date | None = None,
    proof_only_reason: str = "",
) -> dict[str, Any]:
    ledger_payload = _mapping(full_window_payload.get("exact_replay_ledger"))
    raw_rows = ledger_payload.get("runtime_ledger_rows")
    if not isinstance(raw_rows, list) or not raw_rows:
        return {}
    runtime_bucket = _frontier_exact_replay_bucket(
        ledger_payload=ledger_payload,
        raw_rows=cast(Sequence[object], raw_rows),
        full_window_start=full_window_start,
        full_window_end=full_window_end,
    )
    if runtime_bucket is None:
        return {}
    try:
        fill_row_count = int(ledger_payload.get("fill_row_count") or 0)
    except (TypeError, ValueError):
        return {}
    if fill_row_count != runtime_bucket.fill_count:
        return {}
    artifact_dir = _order_type_ablation_artifact_dir(args=args, root=root)
    artifact_path = (
        artifact_dir / f"candidate-{candidate_index:04d}-exact-replay-ledger.json"
    )
    artifact_ref = str(artifact_path)
    artifact_payload = {
        **ledger_payload,
        "artifact_ref": artifact_ref,
        "artifact_kind": "exact_replay_ledger",
        "candidate_id": candidate_id,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_proof": False,
        "authority": "exact_replay_probation_only",
        "authority_blockers": [
            "source_backed_runtime_ledger_required",
            "live_paper_runtime_evidence_required",
        ],
    }
    if dataset_snapshot_id:
        artifact_payload["dataset_snapshot_id"] = dataset_snapshot_id
    if replay_lineage:
        artifact_payload["replay_lineage"] = dict(replay_lineage)
        artifact_payload["replay_lineage_hash"] = str(
            replay_lineage.get("lineage_hash") or ""
        )
    if candidate_evaluation_key:
        artifact_payload["candidate_evaluation_key_payload"] = dict(
            candidate_evaluation_key
        )
        artifact_payload["candidate_evaluation_key"] = str(
            candidate_evaluation_key.get("candidate_evaluation_key") or ""
        )
    if replay_tape_validation:
        artifact_payload["replay_tape"] = {
            **_replay_tape_selection_metadata(replay_tape_validation),
            "status": str(replay_tape_validation.get("status") or ""),
            "tape_path": str(replay_tape_validation.get("tape_path") or ""),
            "manifest_path": str(replay_tape_validation.get("manifest_path") or ""),
            "artifact_refs": dict(
                cast(
                    Mapping[str, Any], replay_tape_validation.get("artifact_refs") or {}
                )
            ),
        }
    if candidate_search_key:
        artifact_payload["candidate_search_key"] = candidate_search_key
    if candidate_symbols:
        artifact_payload["candidate_symbols"] = list(candidate_symbols)
    if full_window_start is not None and full_window_end is not None:
        artifact_payload["full_window"] = {
            "start_date": full_window_start.isoformat(),
            "end_date": full_window_end.isoformat(),
        }
    if proof_only_reason:
        artifact_payload["proof_only"] = True
        artifact_payload["proof_only_reason"] = proof_only_reason
    _write_json_output(artifact_path, artifact_payload)
    update: dict[str, Any] = {
        "exact_replay_ledger_artifact_ref": artifact_ref,
        "exact_replay_ledger_artifact_row_count": len(raw_rows),
        "exact_replay_ledger_artifact_fill_count": fill_row_count,
        "runtime_ledger_closed_trade_count": runtime_bucket.closed_trade_count,
        "runtime_ledger_open_position_count": runtime_bucket.open_position_count,
        "runtime_ledger_filled_notional": str(runtime_bucket.filled_notional),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            runtime_bucket.net_strategy_pnl_after_costs
        ),
        "runtime_ledger_post_cost_expectancy_bps": str(
            runtime_bucket.post_cost_expectancy_bps
        ),
        "runtime_ledger_cost_basis_counts": dict(runtime_bucket.cost_basis_counts),
        "runtime_ledger_cost_basis_count": sum(
            runtime_bucket.cost_basis_counts.values()
        ),
        "runtime_ledger_pnl_basis": POST_COST_PNL_BASIS,
        "runtime_ledger_pnl_source": "exact_replay_runtime_ledger",
        "exact_replay_ledger_artifact_proof_authority": False,
        "promotion_authority": False,
        "final_promotion_authority": False,
        "promotion_authority_blockers": [
            "source_backed_runtime_ledger_required",
            "live_paper_runtime_evidence_required",
        ],
    }
    if proof_only_reason:
        update["exact_replay_ledger_artifact_proof_only"] = True
        update["exact_replay_ledger_artifact_proof_only_reason"] = proof_only_reason
    return update


def _order_type_replay_arm_summary(
    *,
    order_type: str,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    summary = summarize_replay_profitability(payload)
    daily_filled_notional = _daily_filled_notional(payload)
    total_filled_notional = sum(daily_filled_notional.values(), Decimal("0"))
    avg_filled_notional_per_day = (
        total_filled_notional / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    arm_summary: dict[str, Any] = {
        "order_type": order_type,
        "start_date": summary.start_date,
        "end_date": summary.end_date,
        "trading_day_count": summary.trading_day_count,
        "net_pnl": str(summary.net_pnl),
        "net_per_day": str(summary.net_per_day),
        "active_days": summary.active_days,
        "decision_count": summary.decision_count,
        "filled_count": summary.filled_count,
        "sample_count": _forced_order_type_sample_count(payload, order_type=order_type),
        "limit_fill_rate": str(payload.get("limit_fill_rate", "0")),
        "total_filled_notional": str(total_filled_notional),
        "avg_filled_notional_per_day": str(avg_filled_notional_per_day),
        "payload_sha256": _payload_digest(payload),
        "daily_net": {day: str(value) for day, value in summary.daily_net.items()},
        "daily_filled_notional": {
            day: str(value) for day, value in daily_filled_notional.items()
        },
    }
    arm_summary.update(_order_type_execution_metrics(payload))
    return arm_summary


def _order_type_ablation_payload(
    *,
    candidate_index: int,
    candidate_id: str,
    policy: OrderTypeAblationPolicy,
    candidate_params: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    market_payload: Mapping[str, Any],
    limit_payload: Mapping[str, Any],
    start_date: date,
    end_date: date,
) -> tuple[dict[str, Any], dict[str, Any]]:
    selected_order_type = _selected_entry_order_type(
        candidate_params=candidate_params,
        strategy_overrides=strategy_overrides,
    )
    alternative_order_type = "limit" if selected_order_type == "market" else "market"
    market_summary = _order_type_replay_arm_summary(
        order_type="market",
        payload=market_payload,
    )
    limit_summary = _order_type_replay_arm_summary(
        order_type="limit",
        payload=limit_payload,
    )
    selected_summary = (
        market_summary if selected_order_type == "market" else limit_summary
    )
    alternative_summary = (
        limit_summary if selected_order_type == "market" else market_summary
    )
    selected_net_per_day = Decimal(str(selected_summary["net_per_day"]))
    alternative_net_per_day = Decimal(str(alternative_summary["net_per_day"]))
    opportunity_cost_per_day = max(
        Decimal("0"),
        alternative_net_per_day - selected_net_per_day,
    )
    selected_notional = Decimal(str(selected_summary["avg_filled_notional_per_day"]))
    alternative_notional = Decimal(
        str(alternative_summary["avg_filled_notional_per_day"])
    )
    opportunity_cost_denominator = max(selected_notional, alternative_notional)
    opportunity_cost_bps = (
        opportunity_cost_per_day / opportunity_cost_denominator * Decimal("10000")
        if opportunity_cost_denominator > 0
        else Decimal("0")
    )
    market_sample_count = int(market_summary["sample_count"])
    limit_sample_count = int(limit_summary["sample_count"])
    sample_count = market_sample_count + limit_sample_count
    passed = (
        sample_count >= policy.min_sample_count
        and opportunity_cost_bps <= policy.max_opportunity_cost_bps
        and selected_net_per_day >= alternative_net_per_day
    )
    artifact_payload: dict[str, Any] = {
        "schema_version": "torghut.order-type-ablation.v1",
        "candidate_index": candidate_index,
        "candidate_id": candidate_id,
        "window": {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        },
        "policy": policy.to_payload(),
        "candidate_params": dict(candidate_params),
        "strategy_overrides": dict(strategy_overrides),
        "selected_order_type": selected_order_type,
        "alternative_order_type": alternative_order_type,
        "market": market_summary,
        "limit": limit_summary,
        "market_sample_count": market_sample_count,
        "limit_sample_count": limit_sample_count,
        "sample_count": sample_count,
        "selected_net_per_day": str(selected_net_per_day),
        "alternative_net_per_day": str(alternative_net_per_day),
        "opportunity_cost_per_day": str(opportunity_cost_per_day),
        "opportunity_cost_denominator": str(opportunity_cost_denominator),
        "opportunity_cost_bps": str(opportunity_cost_bps),
        "passed": passed,
    }
    scorecard_update = {
        "order_type_ablation_sample_count": sample_count,
        "order_type_ablation_passed": passed,
        "order_type_ablation_selected_order_type": selected_order_type,
        "order_type_ablation_alternative_order_type": alternative_order_type,
        "order_type_opportunity_cost_bps": str(opportunity_cost_bps),
        "order_type_opportunity_cost_evidence_present": True,
        "opportunity_cost_evidence_present": True,
        "market_limit_order_mix_evidence_present": sample_count > 0,
        "market_limit_order_mix_sample_count": sample_count,
        "market_limit_execution_policy_passed": passed,
        "limit_fill_probability_sample_count": limit_sample_count,
        "limit_fill_probability_evidence_present": limit_sample_count > 0,
    }
    return artifact_payload, scorecard_update


__all__ = [
    "_order_lifecycle_metrics",
    "_order_type_execution_metrics",
    "_normalized_order_type",
    "_selected_entry_order_type",
    "_forced_order_type_sample_count",
    "_payload_digest",
    "_artifact_run_dir_name",
    "_order_type_ablation_artifact_dir",
    "_frontier_ledger_text",
    "_frontier_ledger_datetime",
    "_frontier_exact_replay_bucket_range",
    "_frontier_exact_replay_rows",
    "_frontier_exact_replay_bucket_has_authority",
    "_frontier_exact_replay_bucket",
    "_exact_replay_ledger_artifact_update",
    "_order_type_replay_arm_summary",
    "_order_type_ablation_payload",
]
