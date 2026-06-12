# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Profit freshness frontier projection for zero-notional repair selection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from ..market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_18 import *
from .part_02_tca_dimension import *


def build_profit_freshness_frontier(
    *,
    account_label: str | None,
    trading_mode: str,
    proof_window: str | None,
    torghut_revision: str | None,
    proof_floor_receipt: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    jangar_reliability_settlement_ref: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build an observe-only frontier that ranks zero-notional proof repairs."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    account = account_label or _text(proof_floor_receipt.get("account_label")) or None
    feature_dimension = _hypothesis_dimension(
        name="feature_coverage",
        reason_names=["feature_rows_missing", "required_feature_set_unavailable"],
        hypothesis_payload=hypothesis_payload,
        generated_at=observed_at,
    )
    drift_dimension = _hypothesis_dimension(
        name="drift_checks",
        reason_names=["drift_checks_missing"],
        hypothesis_payload=hypothesis_payload,
        generated_at=observed_at,
    )
    dimensions = [
        _signal_dimension(
            quant_evidence=quant_evidence,
            hypothesis_payload=hypothesis_payload,
            generated_at=observed_at,
        ),
        _market_dimension(
            market_context_status=market_context_status,
            hypothesis_payload=hypothesis_payload,
            generated_at=observed_at,
        ),
        _empirical_dimension(
            empirical_jobs_status=empirical_jobs_status,
            generated_at=observed_at,
        ),
        feature_dimension,
        drift_dimension,
        _tca_dimension(
            proof_floor_receipt=proof_floor_receipt,
            routeability_ledger=routeability_repair_acceptance_ledger,
            route_reacquisition_board=route_reacquisition_board,
            generated_at=observed_at,
        ),
        _route_readiness_dimension(
            routeability_ledger=routeability_repair_acceptance_ledger,
            generated_at=observed_at,
        ),
        _schema_dimension(
            proof_floor_receipt=proof_floor_receipt,
            generated_at=observed_at,
        ),
        _jangar_dimension(
            jangar_reliability_settlement_ref=jangar_reliability_settlement_ref,
            generated_at=observed_at,
        ),
    ]
    aggregate_blockers = _unique(
        [
            _text(reason)
            for dimension in dimensions
            for reason in _sequence(dimension.get("reason_codes"))
        ]
    )
    active_lots = [
        _repair_lot(
            dimension=dimension,
            routeability_ledger=routeability_repair_acceptance_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            jangar_reliability_settlement_ref=jangar_reliability_settlement_ref,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs_status,
        )
        for dimension in dimensions
        if _text(dimension.get("state")) != "current"
        and _text(dimension.get("dimension")) in _REPAIRABLE_DIMENSIONS
    ]
    active_lots.sort(
        key=lambda lot: (
            -(_float(lot.get("repair_priority")) or 0.0),
            _text(lot.get("lot_id")),
        )
    )
    if active_lots:
        active_lots[0] = {
            **active_lots[0],
            "state": "selected_zero_notional_repair",
        }
    selected_repairs = active_lots[:1]
    selected_daily_net_pnl_unlock: Decimal | None = None
    for repair in selected_repairs:
        value = _decimal(repair.get("expected_daily_net_pnl_unlock"))
        if value is not None:
            selected_daily_net_pnl_unlock = (
                selected_daily_net_pnl_unlock or Decimal("0")
            ) + value
    accepted_routeable_count = _int(
        routeability_repair_acceptance_ledger.get("accepted_routeable_candidate_count")
    )
    all_dimensions_current = not active_lots
    proof_floor_ready = _text(
        proof_floor_receipt.get("route_state")
    ) != "repair_only" and _text(proof_floor_receipt.get("capital_state")) not in {
        "zero_notional",
        "",
    }
    live_gate_allows = _bool(live_submission_gate.get("allowed"))
    paper_replay_candidate_count = (
        accepted_routeable_count
        if all_dimensions_current and proof_floor_ready and live_gate_allows
        else 0
    )
    frontier_state = "ready" if all_dimensions_current else "repair_only"
    if any(
        _text(dimension.get("dimension")) == "jangar_settlement"
        for dimension in dimensions
        if _text(dimension.get("state")) != "current"
    ):
        frontier_state = "held"
    frontier_id = _stable_ref(
        "profit-freshness-frontier",
        {
            "account": account,
            "trading_mode": trading_mode,
            "proof_window": proof_window,
            "torghut_revision": torghut_revision,
            "routeability_ledger": routeability_repair_acceptance_ledger.get(
                "ledger_id"
            ),
            "dimension_states": {
                _text(dimension.get("dimension")): _text(dimension.get("state"))
                for dimension in dimensions
            },
            "selected_repairs": [
                _text(repair.get("lot_id")) for repair in selected_repairs
            ],
        },
    )
    return {
        "schema_version": PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION,
        "frontier_id": frontier_id,
        "account_label": account,
        "trading_mode": trading_mode,
        "proof_window": proof_window,
        "torghut_revision": torghut_revision,
        "jangar_reliability_settlement_ref": dict(jangar_reliability_settlement_ref),
        "generated_at": generated_at,
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "freshness_dimensions": dimensions,
        "repair_lots": active_lots,
        "selected_zero_notional_repairs": selected_repairs,
        "frontier_state": frontier_state,
        "aggregate_blocking_reason_codes": aggregate_blockers,
        "capital_posture": {
            "capital_state": "zero_notional",
            "paper_notional_limit": "0",
            "live_notional_limit": "0",
            "paper_replay_candidate_count": paper_replay_candidate_count,
            "capital_behavior_changed": False,
            "graduation_rule": (
                "paper replay requires current freshness dimensions, accepted routeability, "
                "live gate allowance, and existing capital gates"
            ),
        },
        "next_zero_notional_action": _text(
            selected_repairs[0].get("zero_notional_action")
            if selected_repairs
            else None,
            "observe_profit_freshness_frontier",
        ),
        "summary": {
            "dimension_count": len(dimensions),
            "current_dimension_count": sum(
                1
                for dimension in dimensions
                if _text(dimension.get("state")) == "current"
            ),
            "active_repair_lot_count": len(active_lots),
            "selected_repair_count": len(selected_repairs),
            "accepted_routeable_candidate_count": accepted_routeable_count,
            "ranked_daily_net_pnl_repair_count": sum(
                1
                for repair in active_lots
                if repair.get("expected_daily_net_pnl_unlock") is not None
            ),
            "selected_expected_daily_net_pnl_unlock": _decimal_text(
                selected_daily_net_pnl_unlock
            ),
            "quality_frontier_packet_count": len(
                _sequence(quality_adjusted_profit_frontier.get("packets"))
            ),
            "target_notional_ranked_repair_count": sum(
                1 for repair in active_lots if repair.get("target_notional_rankings")
            ),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "profit_freshness_frontier_projection_enabled": False,
            "zero_notional_repair_execution_enabled": False,
            "live_submit_enabled": False,
        },
    }


__all__ = [
    "PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION",
    "build_profit_freshness_frontier",
]


__all__ = [name for name in globals() if not name.startswith("__")]
