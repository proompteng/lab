# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Rank exact replay ledger artifacts with runtime-ledger PnL semantics."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast

from app.trading.discovery.adaptive_market_limit_allocation_stress import (
    extract_adaptive_market_limit_allocation_stress,
)
from app.trading.discovery.cluster_lob_features import extract_cluster_lob_features
from app.trading.discovery.lob_reality_gap_stress import (
    extract_lob_reality_gap_stress,
)
from app.trading.discovery.order_book_observability_stress import (
    extract_order_book_observability_stress,
)
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.models import SignalEnvelope
from app.trading.runtime_ledger import RuntimeLedgerBucket, build_runtime_ledger_buckets

# ruff: noqa: F401,F811,F821

from .shared_context import (
    EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION,
    EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION,
    EXECUTION_QUALITY_SCHEMA_VERSION,
    ReplayLedgerCandidateRanking,
    ReplayLedgerRankingFailure,
    ReplayLedgerRankingPolicy,
    CLOSING_AUCTION_CLEARING_PRICE_FIELDS as _CLOSING_AUCTION_CLEARING_PRICE_FIELDS,
    CLOSING_AUCTION_FIELDS as _CLOSING_AUCTION_FIELDS,
    CLOSING_AUCTION_PROJECTION_FIELDS as _CLOSING_AUCTION_PROJECTION_FIELDS,
    CLOSING_WINDOW_FIELDS as _CLOSING_WINDOW_FIELDS,
    EXECUTION_QUALITY_SOURCE_PAPERS as _EXECUTION_QUALITY_SOURCE_PAPERS,
    EXECUTION_SHORTFALL_FIELDS as _EXECUTION_SHORTFALL_FIELDS,
    FILL_STATUS_FIELDS as _FILL_STATUS_FIELDS,
    LIMIT_FILL_PROBABILITY_FIELDS as _LIMIT_FILL_PROBABILITY_FIELDS,
    LIVE_PROMOTION_AUTHORITIES as _LIVE_PROMOTION_AUTHORITIES,
    OPPORTUNITY_COST_FIELDS as _OPPORTUNITY_COST_FIELDS,
    ORDER_TYPE_FIELDS as _ORDER_TYPE_FIELDS,
    PRICE_IMPROVEMENT_FIELDS as _PRICE_IMPROVEMENT_FIELDS,
    QUEUE_POSITION_FIELDS as _QUEUE_POSITION_FIELDS,
    TERMINAL_INVENTORY_PATH_FIELDS as _TERMINAL_INVENTORY_PATH_FIELDS,
    full_window_bucket as _full_window_bucket,
    ledger_window as _ledger_window,
    runtime_rows_with_defaults as _runtime_rows_with_defaults,
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
    rank_replay_ledger_files,
    rank_replay_ledger_payload,
)


def _row_helpers() -> Any:
    from . import row_has_fill_status

    return row_has_fill_status


def _safe_divide(numerator: Decimal, denominator: Decimal) -> Decimal:
    return _row_helpers()._safe_divide(numerator, denominator)


def _best_day_share(daily_net: Mapping[str, Decimal], total_net: Decimal) -> Decimal:
    return _row_helpers()._best_day_share(daily_net, total_net)


def _dedupe(values: Sequence[str]) -> list[str]:
    return _row_helpers()._dedupe(values)


def _text(value: object) -> str:
    return _row_helpers()._text(value)


def _event_type(row: Mapping[str, object]) -> str:
    return _row_helpers()._event_type(row)


def _positive_decimal(value: object) -> Decimal | None:
    return _row_helpers()._positive_decimal(value)


def _row_has_fill_status(row: Mapping[str, object]) -> bool:
    return _row_helpers()._row_has_fill_status(row)


def _max_single_fill_notional(rows: Sequence[Mapping[str, object]]) -> Decimal:
    return _row_helpers()._max_single_fill_notional(rows)


def _utc(value: datetime) -> datetime:
    return _row_helpers()._utc(value)


def _promotion_blockers(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, object]],
    full_bucket: RuntimeLedgerBucket,
    total_net: Decimal,
    daily_net: Mapping[str, Decimal],
    window_weekday_count: int,
    avg_filled_notional_per_window_weekday: Decimal,
    max_single_fill_notional_pct_equity: Decimal | None,
    policy: ReplayLedgerRankingPolicy,
) -> list[str]:
    blockers = list(full_bucket.blockers)
    blockers.extend(_candidate_identity_blockers(payload))
    blockers.extend(_cost_lineage_blockers(payload=payload, rows=rows))
    stage = str(payload.get("stage") or "").lower()
    promotion_authority = str(payload.get("promotion_authority") or "").lower()
    if (
        stage not in {"paper", "live"}
        and promotion_authority not in _LIVE_PROMOTION_AUTHORITIES
    ):
        blockers.append("replay_artifact_only_not_live")
    if window_weekday_count < policy.min_window_weekday_count:
        blockers.append("window_weekday_count_below_min_observed_trading_days")
    if (
        _safe_divide(total_net, Decimal(window_weekday_count))
        < policy.target_net_pnl_per_day
    ):
        blockers.append("window_net_pnl_per_day_below_target")
    if avg_filled_notional_per_window_weekday < policy.min_avg_filled_notional_per_day:
        blockers.append("avg_filled_notional_per_day_below_min")
    if _best_day_share(daily_net, total_net) > policy.max_best_day_share:
        blockers.append("best_day_share_above_max")
    if max_single_fill_notional_pct_equity is None:
        blockers.append("start_equity_missing_for_exposure_check")
    elif max_single_fill_notional_pct_equity > policy.max_gross_exposure_pct_equity:
        blockers.append("max_single_fill_notional_pct_equity_above_max")
    return _dedupe(blockers)


def _candidate_id(*, payload: Mapping[str, Any], artifact_ref: str) -> str:
    return _text(payload.get("candidate_id")) or Path(artifact_ref).stem


def _candidate_identity_blockers(payload: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    candidate_id = _text(payload.get("candidate_id"))
    identity = _mapping(payload.get("candidate_identity"))
    identity_candidate_id = _text(identity.get("candidate_id"))
    identity_hash = _text(
        payload.get("candidate_identity_hash")
        or identity.get("candidate_identity_hash")
    )
    if not candidate_id:
        blockers.append("candidate_id_missing")
    if not identity:
        blockers.append("candidate_identity_missing")
    if not identity_hash:
        blockers.append("candidate_identity_hash_missing")
    if identity_candidate_id and candidate_id and identity_candidate_id != candidate_id:
        blockers.append("candidate_identity_candidate_id_mismatch")
    return blockers


def _cost_lineage_blockers(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, object]],
) -> list[str]:
    blockers: list[str] = []
    cost_lineage = _mapping(payload.get("cost_lineage"))
    cost_lineage_hash = _text(
        payload.get("cost_lineage_hash") or cost_lineage.get("cost_lineage_hash")
    )
    warning_contract = _string_list(cost_lineage.get("warning_contract"))
    capacity_summary = _capacity_lineage_summary(rows)
    fill_count = capacity_summary["fill_count"]
    if not cost_lineage:
        blockers.append("exact_replay_cost_lineage_missing")
    if not cost_lineage_hash:
        blockers.append("exact_replay_cost_lineage_hash_missing")
    if not _text(cost_lineage.get("adv_source")):
        blockers.append("adv_capacity_lineage_missing")
    if not warning_contract:
        blockers.append("adv_capacity_warning_contract_missing")
    if fill_count > 0:
        if capacity_summary["fills_with_adv_notional"] < fill_count:
            blockers.append("fill_adv_notional_missing")
        if capacity_summary["fills_with_participation_rate"] < fill_count:
            blockers.append("fill_capacity_participation_missing")
        if capacity_summary["fills_with_capacity_warning_contract"] < fill_count:
            blockers.append("fill_capacity_warning_contract_missing")
    if capacity_summary["capacity_warning_counts"].get("participation_exceeds_max", 0):
        blockers.append("adv_capacity_limit_breached")
    return blockers


def _capacity_lineage_summary(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, Any]:
    fill_rows = [row for row in rows if _event_type(row) == "fill"]
    warning_counts: dict[str, int] = {}
    fills_with_capacity_warning_contract = 0
    for row in fill_rows:
        warnings = row.get("capacity_warning_codes")
        if isinstance(warnings, Sequence) and not isinstance(
            warnings, (str, bytes, bytearray)
        ):
            fills_with_capacity_warning_contract += 1
            for warning in cast(Sequence[object], warnings):
                text = _text(warning)
                if text:
                    warning_counts[text] = warning_counts.get(text, 0) + 1
    return {
        "fill_count": len(fill_rows),
        "fills_with_adv_notional": sum(
            1 for row in fill_rows if _positive_decimal(row.get("adv_notional"))
        ),
        "fills_with_participation_rate": sum(
            1 for row in fill_rows if _positive_decimal(row.get("participation_rate"))
        ),
        "fills_with_capacity_warning_contract": fills_with_capacity_warning_contract,
        "capacity_warning_counts": warning_counts,
    }


def _execution_quality_summary(
    *,
    rows: Sequence[Mapping[str, object]],
    total_filled_notional: Decimal,
    window_weekday_count: int,
) -> Mapping[str, object]:
    submitted_rows = [row for row in rows if _event_type(row) == "order_submitted"]
    fill_rows = [row for row in rows if _event_type(row) == "fill"]
    order_type_by_order_id: dict[str, str] = {}
    for row in rows:
        order_id = _text(row.get("order_id"))
        order_type = _normalized_order_type(_first_text(row, _ORDER_TYPE_FIELDS))
        if order_id and order_type:
            order_type_by_order_id[order_id] = order_type

    submitted_order_types = [
        _order_type_for_row(row, order_type_by_order_id) for row in submitted_rows
    ]
    fill_order_types = [
        _order_type_for_row(row, order_type_by_order_id) for row in fill_rows
    ]
    order_type_counts = _count_texts(
        order_type for order_type in submitted_order_types if order_type
    )
    order_type_fill_counts = _count_texts(
        order_type for order_type in fill_order_types if order_type
    )
    limit_order_count = sum(
        count
        for order_type, count in order_type_counts.items()
        if "limit" in order_type
    )
    limit_fill_count = sum(
        count
        for order_type, count in order_type_fill_counts.items()
        if "limit" in order_type
    )
    market_order_count = order_type_counts.get("market", 0)
    order_type_sample_count = sum(
        1 for order_type in submitted_order_types if order_type
    )
    fill_order_type_sample_count = sum(
        1 for order_type in fill_order_types if order_type
    )
    route_tca_samples = [
        value
        for row in fill_rows
        if (value := _first_decimal(row, _EXECUTION_SHORTFALL_FIELDS)) is not None
    ]
    price_improvement_samples = [
        value
        for row in fill_rows
        if (value := _first_decimal(row, _PRICE_IMPROVEMENT_FIELDS)) is not None
    ]
    opportunity_cost_samples = [
        value
        for row in rows
        if (value := _first_decimal(row, _OPPORTUNITY_COST_FIELDS)) is not None
    ]
    queue_position_sample_count = sum(
        1 for row in rows if _first_decimal(row, _QUEUE_POSITION_FIELDS) is not None
    )
    limit_fill_probability_samples = [
        value
        for row in rows
        if (value := _first_decimal(row, _LIMIT_FILL_PROBABILITY_FIELDS)) is not None
    ]
    closing_window_sample_count = sum(
        1 for row in rows if _first_evidence(row, _CLOSING_WINDOW_FIELDS)
    )
    closing_auction_sample_count = sum(
        1 for row in rows if _first_evidence(row, _CLOSING_AUCTION_FIELDS)
    )
    closing_auction_projection_sample_count = sum(
        1 for row in rows if _first_evidence(row, _CLOSING_AUCTION_PROJECTION_FIELDS)
    )
    closing_auction_clearing_price_sample_count = sum(
        1
        for row in rows
        if _first_evidence(row, _CLOSING_AUCTION_CLEARING_PRICE_FIELDS)
    )
    terminal_inventory_path_sample_count = sum(
        1 for row in rows if _first_evidence(row, _TERMINAL_INVENTORY_PATH_FIELDS)
    )
    filled_status_count = sum(1 for row in rows if _row_has_fill_status(row))
    blockers: list[str] = []
    penalty_bps = Decimal("0")
    if submitted_rows and order_type_sample_count < len(submitted_rows):
        blockers.append("order_type_mix_evidence_incomplete")
        penalty_bps += Decimal("4")
    if fill_rows and fill_order_type_sample_count < len(fill_rows):
        blockers.append("fill_order_type_evidence_incomplete")
        penalty_bps += Decimal("3")
    if fill_rows and len(route_tca_samples) < len(fill_rows):
        blockers.append("execution_shortfall_evidence_incomplete")
        penalty_bps += Decimal("6")
    if (
        limit_order_count > 0
        and len(limit_fill_probability_samples) < limit_order_count
    ):
        blockers.append("limit_fill_probability_evidence_incomplete")
        penalty_bps += Decimal("6")
    if limit_order_count > 0 and queue_position_sample_count < limit_order_count:
        blockers.append("queue_position_survival_evidence_incomplete")
        penalty_bps += Decimal("6")
    if limit_order_count > 0 and not price_improvement_samples:
        blockers.append("price_improvement_evidence_incomplete")
        penalty_bps += Decimal("2")
    if limit_order_count > 0 and not opportunity_cost_samples:
        blockers.append("nonfill_opportunity_cost_evidence_incomplete")
        penalty_bps += Decimal("2")
    if submitted_rows and closing_window_sample_count == 0:
        blockers.append("closing_window_evidence_incomplete")
        penalty_bps += Decimal("4")
    if submitted_rows and closing_auction_sample_count == 0:
        blockers.append("closing_auction_evidence_incomplete")
        penalty_bps += Decimal("4")
    if submitted_rows and closing_auction_projection_sample_count == 0:
        blockers.append("closing_auction_projection_evidence_incomplete")
        penalty_bps += Decimal("6")
    if submitted_rows and closing_auction_clearing_price_sample_count == 0:
        blockers.append("closing_auction_clearing_price_evidence_incomplete")
        penalty_bps += Decimal("6")
    if fill_rows and terminal_inventory_path_sample_count == 0:
        blockers.append("terminal_inventory_path_evidence_incomplete")
        penalty_bps += Decimal("6")
    limit_fill_rate = (
        _safe_divide(Decimal(limit_fill_count), Decimal(limit_order_count))
        if limit_order_count > 0
        else None
    )
    if limit_fill_rate is not None and limit_fill_rate < Decimal("0.50"):
        blockers.append("limit_fill_rate_below_execution_quality_floor")
        penalty_bps += (Decimal("0.50") - limit_fill_rate) * Decimal("20")
    avg_shortfall_bps = _average_decimal(route_tca_samples)
    if avg_shortfall_bps is not None and avg_shortfall_bps > Decimal("8"):
        blockers.append("execution_shortfall_bps_above_quality_floor")
        penalty_bps += avg_shortfall_bps - Decimal("8")
    avg_opportunity_cost_bps = _average_decimal(opportunity_cost_samples)
    if avg_opportunity_cost_bps is not None and avg_opportunity_cost_bps > Decimal("8"):
        blockers.append("nonfill_opportunity_cost_bps_above_quality_floor")
        penalty_bps += avg_opportunity_cost_bps - Decimal("8")
    penalty_amount = _safe_divide(total_filled_notional * penalty_bps, Decimal("10000"))
    return {
        "schema_version": EXECUTION_QUALITY_SCHEMA_VERSION,
        "source_papers": [dict(item) for item in _EXECUTION_QUALITY_SOURCE_PAPERS],
        "proof_neutrality": {
            "research_ranking_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_closing_auction_mechanism_evidence": True,
            "requires_terminal_inventory_path_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_model_fill_probability_as_fill_authority": True,
            "rejects_closing_auction_projection_as_price_authority": True,
            "rejects_terminal_inventory_path_as_position_authority": True,
            "rejects_adjusted_pnl_as_promotion_authority": True,
        },
        "submitted_order_count": len(submitted_rows),
        "fill_count": len(fill_rows),
        "order_type_sample_count": order_type_sample_count,
        "fill_order_type_sample_count": fill_order_type_sample_count,
        "order_type_counts": order_type_counts,
        "order_type_fill_counts": order_type_fill_counts,
        "market_order_count": market_order_count,
        "limit_order_count": limit_order_count,
        "limit_fill_count": limit_fill_count,
        "limit_fill_rate": limit_fill_rate,
        "filled_status_count": filled_status_count,
        "execution_shortfall_sample_count": len(route_tca_samples),
        "avg_execution_shortfall_bps": avg_shortfall_bps,
        "price_improvement_sample_count": len(price_improvement_samples),
        "avg_price_improvement_bps": _average_decimal(price_improvement_samples),
        "nonfill_opportunity_cost_sample_count": len(opportunity_cost_samples),
        "avg_nonfill_opportunity_cost_bps": avg_opportunity_cost_bps,
        "queue_position_sample_count": queue_position_sample_count,
        "limit_fill_probability_sample_count": len(limit_fill_probability_samples),
        "avg_limit_fill_probability": _average_decimal(limit_fill_probability_samples),
        "closing_window_sample_count": closing_window_sample_count,
        "closing_auction_sample_count": closing_auction_sample_count,
        "closing_auction_projection_sample_count": (
            closing_auction_projection_sample_count
        ),
        "closing_auction_clearing_price_sample_count": (
            closing_auction_clearing_price_sample_count
        ),
        "terminal_inventory_path_sample_count": terminal_inventory_path_sample_count,
        "execution_quality_blockers": tuple(_dedupe(blockers)),
        "execution_quality_penalty_bps": penalty_bps,
        "execution_quality_penalty_amount": penalty_amount,
        "execution_quality_penalty_per_window_weekday": _safe_divide(
            penalty_amount,
            Decimal(window_weekday_count),
        ),
    }


def _lob_reality_gap_stress_summary(
    rows: Sequence[Mapping[str, object]],
) -> Mapping[str, object]:
    signal_rows = _lob_signal_rows(rows)
    warnings: list[str] = []
    if not signal_rows:
        warnings.append("missing_lob_reality_gap_rows")
        stress_payload: dict[str, object] = {
            "schema_version": "torghut.lob-reality-gap-stress.v2",
            "status": "preview_only_lob_reality_gap_stress_ranking",
            "source_papers": [],
            "row_count": 0,
            "replay_rank_penalty_bps": 0.0,
            "warnings": list(warnings),
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        }
    else:
        stress_payload = extract_lob_reality_gap_stress(signal_rows).to_payload()
        warnings.extend(_string_list(stress_payload.get("warnings")))

    warning_penalty_bps = Decimal(len(warnings)) * Decimal("2")
    raw_penalty_bps = _decimal(stress_payload.get("replay_rank_penalty_bps"))
    effective_penalty_bps = (raw_penalty_bps or Decimal("0")) + warning_penalty_bps
    blockers = tuple(f"lob_reality_gap_{warning}" for warning in _dedupe(warnings))
    return {
        **stress_payload,
        "lob_reality_gap_blockers": blockers,
        "lob_reality_gap_warning_penalty_bps": warning_penalty_bps,
        "effective_replay_rank_penalty_bps": effective_penalty_bps,
    }


def _microstructure_stress_summary(
    rows: Sequence[Mapping[str, object]],
) -> Mapping[str, object]:
    signal_rows = _lob_signal_rows(rows)
    warnings: list[str] = []
    if not signal_rows:
        warnings.append("missing_microstructure_signal_rows")
        adaptive_payload: dict[str, object] = {}
        order_book_payload: dict[str, object] = {}
        cluster_lob_payload: dict[str, object] = {}
    else:
        adaptive_payload = extract_adaptive_market_limit_allocation_stress(
            signal_rows
        ).to_payload()
        order_book_payload = extract_order_book_observability_stress(
            signal_rows,
            max_notional=_max_single_fill_notional(rows),
        ).to_payload()
        cluster_lob_payload = extract_cluster_lob_features(signal_rows).to_payload()
        warnings.extend(
            f"adaptive_market_limit_{warning}"
            for warning in _string_list(adaptive_payload.get("warnings"))
        )
        warnings.extend(
            f"order_book_observability_{warning}"
            for warning in _string_list(order_book_payload.get("warnings"))
        )
        warnings.extend(
            f"cluster_lob_{warning}"
            for warning in _string_list(cluster_lob_payload.get("warnings"))
        )

    adaptive_penalty_bps = _stress_penalty_bps(adaptive_payload)
    order_book_penalty_bps = _stress_penalty_bps(order_book_payload)
    cluster_warning_penalty_bps = Decimal(
        len(_string_list(cluster_lob_payload.get("warnings")))
    )
    warning_penalty_bps = Decimal(len(_dedupe(warnings))) * Decimal("1.5")
    effective_penalty_bps = min(
        Decimal("250"),
        (adaptive_penalty_bps * Decimal("0.5"))
        + (order_book_penalty_bps * Decimal("0.5"))
        + cluster_warning_penalty_bps
        + warning_penalty_bps,
    )
    blockers = tuple(
        f"microstructure_stress_{warning}" for warning in _dedupe(warnings)
    )
    return {
        "schema_version": EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION,
        "status": "preview_only_exact_replay_microstructure_stress_ranking",
        "source_papers": _dedupe_source_papers(
            (
                adaptive_payload.get("source_papers"),
                order_book_payload.get("source_papers"),
                cluster_lob_payload.get("source_papers"),
            )
        ),
        "stress_components": {
            "adaptive_market_limit_allocation": _payload_object(adaptive_payload),
            "order_book_observability": _payload_object(order_book_payload),
            "cluster_lob": _payload_object(cluster_lob_payload),
        },
        "adaptive_market_limit_penalty_bps": adaptive_penalty_bps,
        "order_book_observability_penalty_bps": order_book_penalty_bps,
        "cluster_lob_warning_penalty_bps": cluster_warning_penalty_bps,
        "microstructure_warning_penalty_bps": warning_penalty_bps,
        "effective_replay_rank_penalty_bps": effective_penalty_bps,
        "warnings": _dedupe(warnings),
        "microstructure_stress_blockers": blockers,
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_preview_stress_as_promotion_authority": True,
        },
        "research_ranking_only": True,
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _stress_penalty_bps(payload: Mapping[str, object]) -> Decimal:
    for key in (
        "replay_rank_penalty_bps",
        "effective_replay_rank_penalty_bps",
    ):
        value = _decimal(payload.get(key))
        if value is not None:
            return max(Decimal("0"), value)
    ranking_features = _mapping(payload.get("ranking_features"))
    value = _decimal(ranking_features.get("replay_rank_penalty_bps"))
    return max(Decimal("0"), value or Decimal("0"))


def _dedupe_source_papers(
    groups: Sequence[object],
) -> list[Mapping[str, object]]:
    seen: set[str] = set()
    papers: list[Mapping[str, object]] = []
    for group in groups:
        if not isinstance(group, Sequence) or isinstance(group, (str, bytes)):
            continue
        for item in cast(Sequence[object], group):
            if not isinstance(item, Mapping):
                continue
            source_id = _text(cast(Mapping[str, object], item).get("source_id"))
            if not source_id or source_id in seen:
                continue
            seen.add(source_id)
            papers.append(cast(Mapping[str, object], item))
    return papers


def _lob_signal_rows(
    rows: Sequence[Mapping[str, object]],
) -> tuple[SignalEnvelope, ...]:
    signals: list[SignalEnvelope] = []
    for index, row in enumerate(rows):
        event_ts = _row_event_ts(row)
        symbol = _text(row.get("symbol"))
        if event_ts is None or not symbol:
            continue
        signals.append(
            SignalEnvelope(
                event_ts=event_ts,
                symbol=symbol,
                timeframe=_text(row.get("timeframe")) or None,
                ingest_ts=_row_ingest_ts(row),
                seq=index,
                source=_text(row.get("source")) or "exact_replay_ledger",
                payload={str(key): value for key, value in row.items()},
            )
        )
    return tuple(signals)


def _row_event_ts(row: Mapping[str, object]) -> datetime | None:
    for key in (
        "event_ts",
        "executed_at",
        "timestamp",
        "created_at",
        "submitted_at",
        "filled_at",
    ):
        if (parsed := _parse_window_datetime(row.get(key))) is not None:
            return parsed
    return None


def _row_ingest_ts(row: Mapping[str, object]) -> datetime | None:
    for key in ("ingest_ts", "ingested_at", "observed_at"):
        if (parsed := _parse_window_datetime(row.get(key))) is not None:
            return parsed
    return None


def _daily_bucket_ranges(
    start: datetime,
    end: datetime,
) -> list[tuple[datetime, datetime]]:
    ranges: list[tuple[datetime, datetime]] = []
    current_date = start.date()
    current = datetime.combine(current_date, time.min, tzinfo=timezone.utc)
    if current < start:
        current = start
    while current < end:
        next_day = datetime.combine(
            current.date() + timedelta(days=1),
            time.min,
            tzinfo=timezone.utc,
        )
        bucket_end = min(next_day, end)
        ranges.append((current, bucket_end))
        current = bucket_end
    return ranges


def _parse_window_datetime(value: object, *, date_end: bool = False) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
            return parsed + timedelta(days=1) if date_end else parsed
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    for item in cast(Sequence[object], value):
        text = _text(item)
        if text:
            result.append(text)
    return result


def _payload_object(value: object) -> object:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): _payload_object(item)
            for key, item in sorted(cast(Mapping[object, object], value).items())
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_payload_object(item) for item in cast(Sequence[object], value)]
    return value


def _first_text(row: Mapping[str, object], fields: Sequence[str]) -> str:
    for field in fields:
        text = _text(row.get(field))
        if text:
            return text
    return ""


def _first_decimal(
    row: Mapping[str, object],
    fields: Sequence[str],
) -> Decimal | None:
    for field in fields:
        value = _decimal(row.get(field))
        if value is not None:
            return value
    return None


def _first_evidence(row: Mapping[str, object], fields: Sequence[str]) -> bool:
    for field in fields:
        if _evidence_present(row.get(field)):
            return True
    return False


def _evidence_present(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        return True
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, Mapping):
        return bool(cast(Mapping[object, object], value))
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return bool(cast(Sequence[object], value))
    return bool(str(value).strip())


def _decimal(value: object) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _average_decimal(values: Sequence[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _normalized_order_type(value: str) -> str:
    normalized = value.lower().replace("-", "_").replace(" ", "_").strip()
    if not normalized:
        return ""
    if "market" in normalized and "limit" in normalized:
        return "marketable_limit"
    if "limit" in normalized or "passive" in normalized:
        return "limit"
    if "market" in normalized:
        return "market"
    return normalized


def _order_type_for_row(
    row: Mapping[str, object],
    order_type_by_order_id: Mapping[str, str],
) -> str:
    direct = _normalized_order_type(_first_text(row, _ORDER_TYPE_FIELDS))
    if direct:
        return direct
    return order_type_by_order_id.get(_text(row.get("order_id")), "")


def _count_texts(values: Iterable[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


# Public aliases used by split-module consumers.
candidate_id = _candidate_id
capacity_lineage_summary = _capacity_lineage_summary
daily_bucket_ranges = _daily_bucket_ranges
dedupe_source_papers = _dedupe_source_papers
execution_quality_summary = _execution_quality_summary
lob_reality_gap_stress_summary = _lob_reality_gap_stress_summary
lob_signal_rows = _lob_signal_rows
mapping = _mapping
microstructure_stress_summary = _microstructure_stress_summary
parse_window_datetime = _parse_window_datetime
payload_object = _payload_object
promotion_blockers = _promotion_blockers
stress_penalty_bps = _stress_penalty_bps
utc = _utc
average_decimal = _average_decimal
candidate_identity_blockers = _candidate_identity_blockers
cost_lineage_blockers = _cost_lineage_blockers
count_texts = _count_texts
decimal = _decimal
evidence_present = _evidence_present
first_decimal = _first_decimal
first_evidence = _first_evidence
first_text = _first_text
normalized_order_type = _normalized_order_type
order_type_for_row = _order_type_for_row
row_event_ts = _row_event_ts
row_ingest_ts = _row_ingest_ts
string_list = _string_list

__all__ = (
    "candidate_id",
    "capacity_lineage_summary",
    "daily_bucket_ranges",
    "dedupe_source_papers",
    "execution_quality_summary",
    "lob_reality_gap_stress_summary",
    "lob_signal_rows",
    "mapping",
    "microstructure_stress_summary",
    "parse_window_datetime",
    "payload_object",
    "promotion_blockers",
    "stress_penalty_bps",
    "utc",
    "average_decimal",
    "candidate_identity_blockers",
    "cost_lineage_blockers",
    "count_texts",
    "decimal",
    "evidence_present",
    "first_decimal",
    "first_evidence",
    "first_text",
    "normalized_order_type",
    "order_type_for_row",
    "row_event_ts",
    "row_ingest_ts",
    "string_list",
)
