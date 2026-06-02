from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.repair_receipt_frontier import (
    REPAIR_RECEIPT_FRONTIER_SCHEMA_VERSION,
    build_repair_receipt_frontier,
)


NOW = datetime(2026, 5, 13, 12, 30, tzinfo=timezone.utc)


def _source_ledger(
    *,
    state: str = "digest_unknown",
    reasons: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.source-serving-repair-receipt-ledger.v1",
        "ledger_id": f"source-serving-repair-receipt-ledger:{state}",
        "source_serving_state": state,
        "reason_codes": reasons
        if reasons is not None
        else ["serving_image_digest_missing"],
        "route_warrant_ref": "route-warrant:test",
        "repair_bid_settlement_ref": "repair-bid-settlement-ledger:test",
        "route_evidence_clearinghouse_ref": "route-evidence-clearinghouse:test",
        "max_notional": "0",
    }


def _repair_bid_ledger(*, compacted_lots: list[dict[str, object]]) -> dict[str, object]:
    return {
        "schema_version": "torghut.repair-bid-settlement-ledger.v1",
        "ledger_id": "repair-bid-settlement-ledger:test",
        "compacted_lots": compacted_lots,
        "max_notional": "0",
    }


def _compacted_lot(**overrides: object) -> dict[str, object]:
    lot: dict[str, object] = {
        "lot_id": "compacted-repair-lot:feature",
        "lot_class": "feature_lineage",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "expected_gate_delta": "retire_feature_rows_missing",
        "priority": 95,
        "required_input_refs": ["route-evidence-clearinghouse:test"],
        "required_output_receipt": "torghut.feature-lineage-current-receipt.v1",
        "validation_commands": [
            "pytest services/torghut/tests/test_repair_bid_settlement.py -k feature_lineage"
        ],
        "max_runtime_seconds": 1200,
        "max_notional": "0",
        "dispatchable": True,
        "hold_reason_codes": [],
        "state": "selected",
    }
    lot.update(overrides)
    return lot


def _profit_frontier(
    *, selected_repairs: list[dict[str, object]] | None = None
) -> dict[str, object]:
    return {
        "schema_version": "torghut.profit-freshness-frontier.v1",
        "frontier_id": "profit-freshness-frontier:test",
        "freshness_dimensions": [
            {"dimension": "feature_coverage", "state": "missing"},
            {"dimension": "tca_fill_quality", "state": "stale"},
        ],
        "aggregate_blocking_reason_codes": [
            "feature_rows_missing",
            "execution_tca_stale",
        ],
        "selected_zero_notional_repairs": selected_repairs
        if selected_repairs is not None
        else [
            {
                "lot_id": "profit-freshness-repair-lot:feature",
                "blocked_dimension": "feature_coverage",
                "symbol_set": ["NVDA"],
                "hypothesis_id": "H-NVDA",
                "zero_notional_action": "rebuild_required_feature_rows",
                "expected_profit_unlock_bps": 16,
                "repair_cost_class": "medium",
                "before_refs": ["hypothesis:H-NVDA"],
                "state": "selected_zero_notional_repair",
            }
        ],
        "summary": {
            "accepted_routeable_candidate_count": 0,
            "selected_expected_daily_net_pnl_unlock": None,
        },
    }


def _route_warrant(*, routeable_count: int = 0) -> dict[str, object]:
    return {
        "schema_version": "torghut.route-warrant-exchange.v1",
        "warrant_id": "route-warrant:test",
        "warrant_state": "repair_only" if routeable_count == 0 else "paper_candidate",
        "accepted_routeable_candidate_count": routeable_count,
        "max_notional": "0",
    }


def _build(
    *,
    source_ledger: Mapping[str, Any] | None = None,
    repair_bid_ledger: Mapping[str, Any] | None = None,
    profit_frontier: Mapping[str, Any] | None = None,
    route_warrant: Mapping[str, Any] | None = None,
    live_submission_gate: Mapping[str, Any] | None = None,
    proof_floor: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_repair_receipt_frontier(
        account_label="PA3SX7FYNUTF",
        window="15m",
        trading_mode="live",
        torghut_revision="torghut-00340",
        source_commit="abc123",
        source_serving_repair_receipt_ledger=source_ledger or _source_ledger(),
        freshness_carry_ledger={
            "schema_version": "torghut.freshness-carry-ledger.v1",
            "ledger_id": "freshness-carry-ledger:test",
        },
        repair_bid_settlement_ledger=repair_bid_ledger
        or _repair_bid_ledger(compacted_lots=[_compacted_lot()]),
        profit_freshness_frontier=profit_frontier or _profit_frontier(),
        route_warrant_exchange=route_warrant or _route_warrant(),
        live_submission_gate=live_submission_gate
        or {"allowed": False, "reason": "simple_submit_disabled"},
        proof_floor_receipt=proof_floor
        or {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
        },
        now=NOW,
    )


def _lots_by_class(frontier: Mapping[str, object]) -> dict[str, Mapping[str, Any]]:
    return {
        cast(str, lot["lot_class"]): cast(Mapping[str, Any], lot)
        for lot in cast(list[Mapping[str, Any]], frontier["lots"])
    }


def _lot_by_id(frontier: Mapping[str, object], lot_id: object) -> Mapping[str, Any]:
    for lot in cast(list[Mapping[str, Any]], frontier["lots"]):
        if lot["lot_id"] == lot_id:
            return lot
    raise AssertionError(f"missing lot {lot_id}")


def test_source_serving_gap_preempts_non_source_repair_dispatch() -> None:
    frontier = _build()

    assert frontier["schema_version"] == REPAIR_RECEIPT_FRONTIER_SCHEMA_VERSION
    assert frontier["frontier_state"] == "repair_only"
    assert frontier["max_notional"] == "0"
    assert frontier["capital_state"] == "zero_notional"

    lots_by_class = _lots_by_class(frontier)
    source_lot = lots_by_class["source_serving"]
    feature_lot = lots_by_class["feature_rows"]

    assert source_lot["dispatchable"] is True
    assert frontier["selected_lot_id"] == source_lot["lot_id"]
    assert feature_lot["dispatchable"] is False
    assert "source_serving_not_converged" in feature_lot["hold_reason_codes"]
    assert feature_lot["max_notional"] == "0"
    assert source_lot["target_value_gate"] == "capital_gate_safety"
    assert frontier["summary"]["source_serving_state"] == "digest_unknown"


def test_converged_source_allows_compacted_lot_dispatch_without_notional() -> None:
    frontier = _build(
        source_ledger=_source_ledger(state="converged", reasons=[]),
    )
    lots_by_class = _lots_by_class(frontier)
    feature_lot = lots_by_class["feature_rows"]

    assert feature_lot["dispatchable"] is True
    assert feature_lot["max_notional"] == "0"
    assert feature_lot["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert feature_lot["lot_id"] in frontier["dispatchable_lot_ids"]
    assert frontier["selected_lot_id"] in frontier["dispatchable_lot_ids"]


def test_retired_market_context_profit_repair_is_not_frontier_lot() -> None:
    frontier = _build(
        source_ledger=_source_ledger(state="converged", reasons=[]),
        repair_bid_ledger=_repair_bid_ledger(compacted_lots=[]),
        profit_frontier=_profit_frontier(
            selected_repairs=[
                {
                    "lot_id": "profit-freshness-repair-lot:market-context",
                    "blocked_dimension": "market_context",
                    "zero_notional_action": "refresh_stale_market_context_domains",
                    "expected_profit_unlock_bps": 20,
                    "repair_cost_class": "low",
                    "before_refs": ["market_context:diagnostic"],
                    "state": "selected_zero_notional_repair",
                }
            ]
        ),
    )

    assert {
        lot["source_lot_ref"]
        for lot in cast(list[Mapping[str, Any]], frontier["lots"])
    }.isdisjoint({"profit-freshness-repair-lot:market-context"})


def test_paper_cutover_blocking_lots_rank_ahead_of_generic_stale_evidence() -> None:
    frontier = _build(
        source_ledger=_source_ledger(state="converged", reasons=[]),
        repair_bid_ledger=_repair_bid_ledger(
            compacted_lots=[
                _compacted_lot(
                    lot_id="compacted-repair-lot:feature",
                    lot_class="feature_lineage",
                    target_value_gate="zero_notional_or_stale_evidence_rate",
                    expected_gate_delta="retire_feature_rows_missing",
                    priority=95,
                ),
                _compacted_lot(
                    lot_id="compacted-repair-lot:tca",
                    lot_class="execution_tca",
                    target_value_gate="fill_tca_or_slippage_quality",
                    expected_gate_delta="retire_execution_tca_not_current",
                    priority=90,
                ),
            ]
        ),
        profit_frontier=_profit_frontier(selected_repairs=[]),
    )
    lots_by_class = _lots_by_class(frontier)
    tca_lot = lots_by_class["execution_tca"]

    assert tca_lot["dispatchable"] is True
    assert tca_lot["target_value_gate"] == "fill_tca_or_slippage_quality"
    assert frontier["selected_lot_id"] == tca_lot["lot_id"]


def test_converged_source_does_not_select_route_warrant_as_source_repair() -> None:
    frontier = _build(
        source_ledger=_source_ledger(
            state="converged",
            reasons=["route_warrant_repair_only"],
        ),
    )
    lots_by_class = _lots_by_class(frontier)
    feature_lot = lots_by_class["feature_rows"]
    selected_lot = _lot_by_id(frontier, frontier["selected_lot_id"])

    assert "source_serving" not in lots_by_class
    assert feature_lot["dispatchable"] is True
    assert feature_lot["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert selected_lot["dispatchable"] is True
    assert selected_lot["lot_class"] != "source_serving"
    assert frontier["summary"]["source_serving_state"] == "converged"
    assert any(
        requirement["requirement"] == "routeable_candidate_available"
        and requirement["state"] == "block"
        for requirement in cast(
            list[Mapping[str, Any]], frontier["paper_cutover_requirements"]
        )
    )


def test_nonzero_input_lot_is_rejected_but_frontier_stays_zero_notional() -> None:
    frontier = _build(
        source_ledger=_source_ledger(state="converged", reasons=[]),
        repair_bid_ledger=_repair_bid_ledger(
            compacted_lots=[_compacted_lot(max_notional="25")]
        ),
        profit_frontier=_profit_frontier(selected_repairs=[]),
    )
    feature_lot = _lots_by_class(frontier)["feature_rows"]

    assert frontier["max_notional"] == "0"
    assert feature_lot["max_notional"] == "0"
    assert feature_lot["dispatchable"] is False
    assert "notional_nonzero" in feature_lot["hold_reason_codes"]
    assert feature_lot["settlement_status"] == "rejected"


def test_empty_frontier_promotes_only_to_paper_candidate_until_live_requirements_pass() -> (
    None
):
    frontier = _build(
        source_ledger=_source_ledger(state="converged", reasons=[]),
        repair_bid_ledger=_repair_bid_ledger(compacted_lots=[]),
        profit_frontier={
            "schema_version": "torghut.profit-freshness-frontier.v1",
            "frontier_id": "profit-freshness-frontier:ready",
            "freshness_dimensions": [
                {"dimension": "feature_coverage", "state": "current"},
                {"dimension": "tca_fill_quality", "state": "current"},
            ],
            "aggregate_blocking_reason_codes": [],
            "selected_zero_notional_repairs": [],
            "summary": {"selected_expected_daily_net_pnl_unlock": None},
        },
        route_warrant=_route_warrant(routeable_count=2),
        live_submission_gate={"allowed": False, "reason": "simple_submit_disabled"},
        proof_floor={
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
        },
    )

    assert frontier["lots"] == []
    assert frontier["frontier_state"] == "paper_candidate"
    assert all(
        requirement["state"] == "pass"
        for requirement in cast(
            list[Mapping[str, Any]], frontier["paper_cutover_requirements"]
        )
    )
    live_requirements = cast(
        list[Mapping[str, Any]], frontier["live_cutover_requirements"]
    )
    assert any(
        requirement["requirement"] == "live_submission_enabled"
        and requirement["state"] == "block"
        for requirement in live_requirements
    )
    runtime_requirement = next(
        requirement
        for requirement in live_requirements
        if requirement["requirement"] == "runtime_ledger_source_proof_current"
    )
    assert runtime_requirement["state"] == "block"
    assert runtime_requirement["reason_codes"] == [
        "runtime_ledger_source_proof_missing"
    ]
    assert frontier["promotion_authority"] is False


def test_live_candidate_requires_source_backed_runtime_ledger_proof() -> None:
    base_kwargs = {
        "source_ledger": _source_ledger(state="converged", reasons=[]),
        "repair_bid_ledger": _repair_bid_ledger(compacted_lots=[]),
        "profit_frontier": {
            "schema_version": "torghut.profit-freshness-frontier.v1",
            "frontier_id": "profit-freshness-frontier:ready",
            "freshness_dimensions": [
                {"dimension": "feature_coverage", "state": "current"},
                {"dimension": "tca_fill_quality", "state": "current"},
            ],
            "aggregate_blocking_reason_codes": [],
            "selected_zero_notional_repairs": [],
            "summary": {"selected_expected_daily_net_pnl_unlock": None},
        },
        "route_warrant": _route_warrant(routeable_count=2),
        "live_submission_gate": {
            "allowed": True,
            "reason": "ready",
            "human_approved_capital_limits": True,
        },
    }

    missing_runtime_proof = _build(
        **base_kwargs,
        proof_floor={
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "human_approved_capital_limits": True,
        },
    )
    assert missing_runtime_proof["frontier_state"] == "paper_candidate"

    source_backed_runtime_proof = _build(
        **base_kwargs,
        proof_floor={
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "human_approved_capital_limits": True,
            "runtime_ledger_source_proof": {
                "receipt_id": "runtime-ledger-source-proof:H-PAIRS-01",
                "state": "current",
                "source_backed": True,
                "closed_round_trips": True,
                "explicit_costs": True,
                "flat_after_close_grace": True,
            },
        },
    )
    assert source_backed_runtime_proof["frontier_state"] == "live_candidate"
    assert source_backed_runtime_proof["promotion_authority"] is False
