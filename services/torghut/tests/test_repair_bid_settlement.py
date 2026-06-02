from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.trading.repair_bid_settlement import (
    REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION,
    _expected_gate_delta,
    _int,
    build_repair_bid_settlement_ledger,
)
from app.trading.revenue_repair import _summarize_repair_bid_settlement


NOW = datetime(2026, 5, 13, 3, 20, tzinfo=timezone.utc)


def _reason_codes() -> list[str]:
    reasons: list[str] = []
    reasons.extend(f"quant_pipeline_degraded_stage_{index}" for index in range(10))
    reasons.extend(f"execution_tca_stale_symbol_{index}" for index in range(10))
    reasons.extend(f"rollout_image_missing_workload_{index}" for index in range(10))
    reasons.extend(f"empirical_replay_stale_job_{index}" for index in range(10))
    reasons.extend(f"promotion_custody_missing_decision_{index}" for index in range(10))
    reasons.extend(f"feature_lineage_missing_source_{index}" for index in range(5))
    return reasons


def _clearinghouse_packet(reason_codes: list[str]) -> dict[str, object]:
    return {
        "schema_version": "torghut.route-evidence-clearinghouse-packet.v1",
        "packet_id": "route-evidence-clearinghouse:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": (NOW + timedelta(minutes=1)).isoformat(),
        "accepted_routeable_candidate_count": 2,
        "routeable_candidate_count": 2,
        "zero_notional_or_stale_evidence_rate": 1,
        "fill_tca_or_slippage_quality": {
            "state": "hold",
            "reason_codes": ["execution_tca_stale_symbol_0"],
        },
        "capital_decision": "repair_only",
        "selected_repair_bids": [
            {
                "bid_id": f"route-evidence-repair-bid:{index}",
                "lot_id": f"route-evidence-repair-lot:{index}",
                "reason_codes": [reason],
                "value_gate": "zero_notional_or_stale_evidence_rate",
                "max_notional": "0",
                "required_output_receipt": "raw_receipt",
            }
            for index, reason in enumerate(reason_codes)
        ],
        "route_claims": [
            {
                "route_id": "route:test",
                "routeability_decision": "repair_only",
                "reason_codes": reason_codes,
                "max_notional": "0",
            }
        ],
    }


def _build(
    *,
    reason_codes: list[str] | None = None,
    active_dedupe_keys: list[str] | None = None,
    jangar_status: dict[str, object] | None = None,
    rollout_status: dict[str, object] | None = None,
    profit_freshness_frontier: dict[str, object] | None = None,
) -> dict[str, object]:
    return build_repair_bid_settlement_ledger(
        account_label="PA3SX7FYNUTF",
        session_id="15m",
        trading_mode="live",
        torghut_revision="torghut-00327",
        source_commit="abc123",
        route_evidence_clearinghouse_packet=_clearinghouse_packet(reason_codes or []),
        routeability_acceptance_ledger={
            "ledger_id": "routeability-acceptance-ledger:test",
            "aggregate_state": "blocked",
        },
        active_run_dedupe_state={"active_dedupe_keys": active_dedupe_keys or []},
        jangar_scoped_quant_status=jangar_status or {"ok": True, "status": "healthy"},
        profit_freshness_frontier=profit_freshness_frontier,
        rollout_image_summary=rollout_status
        or {
            "state": "current",
            "image_digest": "sha256:ready",
            "route_workloads_ok": True,
        },
        now=NOW,
    )


def test_scalar_fallbacks_and_empty_revenue_summary_are_explicit() -> None:
    assert _int(None, 7) == 7
    assert _int("not-a-number", 7) == 7
    assert _expected_gate_delta("quant_pipeline", []) == "settle_quant_pipeline"
    assert _summarize_repair_bid_settlement({}) == {
        "ledger_id": None,
        "schema_version": None,
        "capital_decision": "missing",
        "raw_repair_bid_count": 0,
        "compacted_lot_count": 0,
        "selected_lot_count": 0,
        "dispatchable_lot_count": 0,
        "routeable_candidate_count": 0,
    }


def test_raw_repair_bids_compact_into_bounded_zero_notional_lots() -> None:
    reasons = _reason_codes()
    ledger = _build(reason_codes=reasons)

    assert ledger["schema_version"] == REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION
    assert ledger["raw_repair_bid_count"] == 55
    assert ledger["routeable_candidate_count"] == 0
    assert len(ledger["compacted_lots"]) == 6
    assert len(ledger["selected_lot_ids"]) == 5
    assert len(ledger["dispatchable_lot_ids"]) == 3
    assert ledger["max_notional"] == "0"

    compacted_reasons = {
        reason for lot in ledger["compacted_lots"] for reason in lot["raw_reason_codes"]
    }
    assert compacted_reasons == set(reasons)
    assert set(ledger["raw_reason_codes_preserved"]) == set(reasons)


def test_selected_lots_have_one_output_receipt_and_no_notional() -> None:
    ledger = _build(reason_codes=_reason_codes())
    selected_ids = set(ledger["selected_lot_ids"])

    for lot in ledger["compacted_lots"]:
        if lot["lot_id"] not in selected_ids:
            continue
        assert lot["max_notional"] == "0"
        assert lot["required_output_receipt_count"] == 1
        assert isinstance(lot["required_output_receipt"], str)
        assert lot["required_output_receipt"].startswith("torghut.")
        assert lot["target_value_gate"] in {
            "post_cost_daily_net_pnl",
            "routeable_candidate_count",
            "zero_notional_or_stale_evidence_rate",
            "fill_tca_or_slippage_quality",
            "capital_gate_safety",
        }


def test_active_dedupe_key_holds_matching_lot() -> None:
    ledger = _build(
        reason_codes=["execution_tca_stale_symbol_aapl"],
        active_dedupe_keys=["PA3SX7FYNUTF:15m:execution_tca"],
    )
    lot = ledger["compacted_lots"][0]

    assert lot["state"] == "active"
    assert lot["dispatchable"] is False
    assert "dedupe_key_active" in lot["hold_reason_codes"]
    assert ledger["selected_lot_ids"] == []
    assert ledger["dispatchable_lot_ids"] == []
    assert ledger["held_lot_ids"] == [lot["lot_id"]]


def test_degraded_jangar_scoped_quant_status_creates_typed_dispatchable_lot() -> None:
    ledger = _build(
        jangar_status={
            "ok": False,
            "status": "degraded",
            "ingestion_ok": False,
            "materialization_ok": False,
            "receipt_id": "jangar-quant:degraded",
        }
    )
    lot = ledger["compacted_lots"][0]

    assert lot["lot_class"] == "quant_pipeline"
    assert lot["state"] == "selected"
    assert lot["dispatchable"] is True
    assert "jangar_quant_scoped_degraded" in lot["raw_reason_codes"]
    assert "jangar_quant_ingestion_degraded" in lot["raw_reason_codes"]
    assert lot["required_output_receipt"] == "torghut.quant-pipeline-current-receipt.v1"


def test_feature_coverage_preempts_generic_rollout_repair() -> None:
    ledger = _build(
        reason_codes=[
            "quant_pipeline_degraded",
            "execution_tca_stale",
            "route_adjacent_workload_proof_missing",
            "post_cost_expectancy_non_positive",
            "alpha_readiness_not_promotion_eligible",
            "feature_rows_missing",
            "required_feature_set_unavailable",
        ]
    )
    lots_by_class = {lot["lot_class"]: lot for lot in ledger["compacted_lots"]}
    dispatchable_classes = [
        lot["lot_class"]
        for lot in ledger["compacted_lots"]
        if lot.get("dispatchable") is True
    ]

    assert lots_by_class["feature_lineage"]["state"] == "selected"
    assert lots_by_class["feature_lineage"]["dispatchable"] is True
    assert lots_by_class["feature_lineage"]["priority"] == 95
    assert (
        "feature_rows_missing" in lots_by_class["feature_lineage"]["raw_reason_codes"]
    )
    assert (
        "required_feature_set_unavailable"
        in lots_by_class["feature_lineage"]["raw_reason_codes"]
    )
    assert dispatchable_classes == [
        "quant_pipeline",
        "promotion_custody",
        "feature_lineage",
    ]


def test_alpha_readiness_strike_reserves_promotion_custody_dispatch_capacity() -> None:
    ledger = _build(
        reason_codes=[
            "quant_health_not_configured",
            "feature_rows_missing",
            "route_tca_passed_but_dependency_receipts_block_capital",
            "route_adjacent_workload_proof_missing",
            "post_cost_expectancy_non_positive",
            "hypothesis_not_promotion_eligible",
            "alpha_readiness_not_promotion_eligible",
            "simple_submit_disabled",
        ]
    )
    lots_by_class = {lot["lot_class"]: lot for lot in ledger["compacted_lots"]}
    dispatchable_classes = [
        lot["lot_class"]
        for lot in ledger["compacted_lots"]
        if lot.get("dispatchable") is True
    ]

    promotion_lot = lots_by_class["promotion_custody"]
    assert promotion_lot["state"] == "selected"
    assert promotion_lot["dispatchable"] is True
    assert promotion_lot["priority"] == 98
    assert promotion_lot["target_value_gate"] == "routeable_candidate_count"
    assert (
        promotion_lot["required_output_receipt"]
        == "torghut.executable-alpha-receipts.v1"
    )
    assert promotion_lot["expected_gate_delta"] == (
        "retire_alpha_readiness_not_promotion_eligible"
    )
    assert promotion_lot["max_notional"] == "0"
    assert ledger["capital_decision"] == "repair_only"
    assert ledger["max_notional"] == "0"
    assert dispatchable_classes == [
        "quant_pipeline",
        "promotion_custody",
        "feature_lineage",
    ]
    assert lots_by_class["execution_tca"]["dispatchable"] is False
    assert (
        "dispatch_limit_exceeded" in lots_by_class["execution_tca"]["hold_reason_codes"]
    )


def test_profit_freshness_selected_repair_becomes_ticketable_zero_notional_lot() -> (
    None
):
    ledger = _build(
        reason_codes=[
            "quant_health_not_configured",
            "alpha_readiness_not_promotion_eligible",
            "execution_tca_stale",
        ],
        profit_freshness_frontier={
            "frontier_id": "profit-freshness-frontier:test",
            "selected_zero_notional_repairs": [
                {
                    "lot_id": "profit-freshness-repair-lot:empirical",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "blocked_dimension": "empirical_proof",
                    "zero_notional_action": "renew_empirical_proof_jobs",
                    "before_refs": ["empirical:INTC"],
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "state": "selected_zero_notional_repair",
                }
            ],
        },
    )
    lots_by_id = {lot["lot_id"]: lot for lot in ledger["compacted_lots"]}
    profit_lot = lots_by_id["profit-freshness-repair-lot:empirical"]

    assert profit_lot["lot_class"] == "empirical_replay"
    assert profit_lot["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert (
        profit_lot["required_output_receipt"]
        == "torghut.empirical-proof-refresh-receipt.v1"
    )
    assert profit_lot["state"] == "selected"
    assert profit_lot["dispatchable"] is True
    assert profit_lot["max_notional"] == "0"
    assert "profit-freshness-repair-lot:empirical" in ledger["selected_lot_ids"]
    assert "profit-freshness-repair-lot:empirical" in ledger["dispatchable_lot_ids"]
    assert ledger["max_notional"] == "0"


def test_retired_market_context_profit_freshness_repair_is_not_ticketable() -> None:
    ledger = _build(
        profit_freshness_frontier={
            "frontier_id": "profit-freshness-frontier:test",
            "selected_zero_notional_repairs": [
                {
                    "lot_id": "profit-freshness-repair-lot:market-context",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "blocked_dimension": "market_context",
                    "zero_notional_action": "refresh_stale_market_context_domains",
                    "before_refs": ["market_context:INTC"],
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "state": "selected_zero_notional_repair",
                }
            ],
        },
    )

    assert "profit-freshness-repair-lot:market-context" not in {
        lot["lot_id"] for lot in ledger["compacted_lots"]
    }


def test_profit_freshness_nonzero_repair_is_not_compacted_for_dispatch() -> None:
    ledger = _build(
        profit_freshness_frontier={
            "frontier_id": "profit-freshness-frontier:test",
            "selected_zero_notional_repairs": [
                {
                    "lot_id": "profit-freshness-repair-lot:nonzero",
                    "blocked_dimension": "empirical_proof",
                    "zero_notional_action": "renew_empirical_proof_jobs",
                    "paper_notional_limit": "10",
                    "live_notional_limit": "0",
                    "state": "selected_zero_notional_repair",
                }
            ],
        },
    )

    assert "profit-freshness-repair-lot:nonzero" not in {
        lot["lot_id"] for lot in ledger["compacted_lots"]
    }


def test_string_booleans_and_rollout_workload_gaps_create_typed_lots() -> None:
    ledger = _build(
        jangar_status={
            "ok": "false",
            "ready": "false",
            "status": "degraded",
            "ingestion_ok": "false",
            "materialization_ok": "true",
        },
        rollout_status={
            "state": "current",
            "route_workloads_ok": "false",
            "image_digest": "",
        },
    )
    lots_by_class = {lot["lot_class"]: lot for lot in ledger["compacted_lots"]}

    assert (
        "jangar_quant_scoped_not_ready"
        in lots_by_class["quant_pipeline"]["raw_reason_codes"]
    )
    assert (
        "route_adjacent_workloads_degraded"
        in lots_by_class["rollout_image"]["raw_reason_codes"]
    )
    assert "image_digest_missing" in lots_by_class["rollout_image"]["raw_reason_codes"]


def test_active_run_entries_and_stale_datetime_packets_hold_dispatch() -> None:
    packet = _clearinghouse_packet(["execution_tca_stale_symbol_aapl"])
    packet["fresh_until"] = NOW - timedelta(seconds=1)
    ledger = build_repair_bid_settlement_ledger(
        account_label="PA3SX7FYNUTF",
        session_id="15m",
        trading_mode="live",
        torghut_revision="torghut-00327",
        source_commit="abc123",
        route_evidence_clearinghouse_packet=packet,
        active_run_dedupe_state={
            "active_runs": [{"dedupeKey": "PA3SX7FYNUTF:15m:execution_tca"}]
        },
        now=NOW,
    )
    lot = ledger["compacted_lots"][0]

    assert lot["state"] == "active"
    assert "dedupe_key_active" in lot["hold_reason_codes"]
    assert "raw_clearinghouse_packet_stale" in lot["hold_reason_codes"]


def test_legacy_bid_shapes_and_expected_delta_fallbacks_are_stable() -> None:
    packet = _clearinghouse_packet([])
    packet["fresh_until"] = "not-a-date"
    packet["routeable_candidate_count"] = "not-a-number"
    packet["repair_bid_book"] = {
        "repair_bids": [
            {"bid_id": "legacy-exec", "repair_class": "execution_freshness_repair"},
            {"bid_id": "legacy-image", "repair_class": "image_promotion_repair"},
            {
                "bid_id": "legacy-route",
                "repair_class": "routeability_acceptance_repair",
            },
            {"bid_id": "legacy-capital", "value_gate": "capital_gate_safety"},
            {"bid_id": "legacy-source", "repair_class": "source_freshness_repair"},
            {
                "bid_id": "delta-exec",
                "expected_gate_delta": "retire_execution_tca_stale",
            },
        ]
    }
    ledger = build_repair_bid_settlement_ledger(
        account_label="PA3SX7FYNUTF",
        session_id="15m",
        trading_mode="live",
        torghut_revision="torghut-00327",
        source_commit="abc123",
        route_evidence_clearinghouse_packet=packet,
        now=NOW,
    )

    assert ledger["raw_repair_bid_count"] == 6
    assert ledger["routeable_candidate_count"] == 0
    lots_by_class = {lot["lot_class"]: lot for lot in ledger["compacted_lots"]}
    assert lots_by_class["execution_tca"]["raw_reason_codes"] == ["execution_tca_stale"]
    assert "rollout_image" in lots_by_class
