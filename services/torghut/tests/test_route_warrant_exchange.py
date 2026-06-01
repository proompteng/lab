from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.trading.evidence_clock_arbiter import build_evidence_clock_arbiter_and_exchange
from app.trading.route_warrant_exchange import (
    ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION,
    build_route_warrant_exchange,
)


NOW = datetime(2026, 5, 13, 1, 15, tzinfo=timezone.utc)


def _base_inputs() -> dict[str, Any]:
    # fmt: off
    return {
        "account_label": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "torghut_revision": "torghut-00326",
        "source_commit": "abc123",
        "build": {"commit": "abc123", "active_revision": "torghut-00326", "image_digest": "sha256:ready"},
        "hypothesis_payload": {"summary": {"promotion_eligible_total": 1}, "items": [{"hypothesis_id": "H-MICRO-01", "candidate_id": "candidate-micro", "strategy_id": "strategy-micro", "promotion_eligible": True, "reasons": []}]},
        "quant_evidence": {"ok": True, "status": "ok", "latest_metrics_count": 180, "stage_count": 3, "ingestion_ok": True, "materialization_ok": True, "compute_ok": True, "latest_metrics_updated_at": NOW.isoformat(), "receipt_id": "jangar-quant:ready"},
        "market_context_status": {"status": "healthy", "last_updated_at": NOW.isoformat(), "last_domain_states": {}},
        "tca_summary": {"order_count": 72, "filled_execution_count": 72, "last_computed_at": NOW.isoformat(), "latest_execution_created_at": NOW.isoformat(), "avg_abs_slippage_bps": "4.5", "expected_shortfall_sample_count": 80},
        "empirical_jobs_status": {"ready": True, "status": "ready", "updated_at": NOW.isoformat(), "authority": "empirical-jobs:ready"},
        "proof_floor_receipt": {"schema_version": "torghut.profitability-proof-floor.v1", "route_state": "paper_candidate", "capital_state": "paper_allowed", "max_notional": "25", "generated_at": NOW.isoformat()},
        "routeability_repair_acceptance_ledger": {"ledger_id": "routeability:accepted", "aggregate_state": "accepted", "accepted_routeable_candidate_count": 1, "aggregate_blocking_reason_codes": [], "generated_at": NOW.isoformat()},
        "profit_signal_quorum": {"quorum_set_id": "profit-quorum:ready", "aggregate_decision": "paper_candidate", "aggregate_reason_codes": [], "generated_at": NOW.isoformat(), "quorums": [{"quorum_id": "quorum:H-MICRO-01", "hypothesis_id": "H-MICRO-01", "candidate_id": "candidate-micro", "strategy_id": "strategy-micro", "decision": "paper_candidate"}]},
        "profit_freshness_frontier": {"frontier_id": "profit-freshness-frontier:ready", "frontier_state": "ready", "summary": {"ranked_daily_net_pnl_repair_count": 0, "selected_expected_daily_net_pnl_unlock": None}},
        "live_submission_gate": {"allowed": True, "reason": "ready", "blocked_reasons": []},
        "torghut_custody_ref": {"packet_id": "jangar-custody:paper", "decision": "paper_candidate", "fresh_until": (NOW + timedelta(minutes=5)).isoformat()},
        "clickhouse_ta_status": {"state": "current", "latest_signal_at": NOW.isoformat(), "symbol_count": 8},
        "rollout_status": {"state": "current", "route_workloads_ok": True, "verified_at": NOW.isoformat()},
        "consumer_evidence_receipt": {"schema_version": "torghut.consumer-evidence-receipt.v1", "receipt_id": "torghut-consumer-evidence:ready"},
    }
    # fmt: on


def _build(**overrides: object) -> dict[str, object]:
    payload = _base_inputs()
    payload.update(overrides)
    arbiter, exchange = build_evidence_clock_arbiter_and_exchange(
        account_label=payload["account_label"],
        window=payload["window"],
        trading_mode=payload["trading_mode"],
        torghut_revision=payload["torghut_revision"],
        build=payload["build"],
        hypothesis_payload=payload["hypothesis_payload"],
        quant_evidence=payload["quant_evidence"],
        market_context_status=payload["market_context_status"],
        tca_summary=payload["tca_summary"],
        empirical_jobs_status=payload["empirical_jobs_status"],
        proof_floor_receipt=payload["proof_floor_receipt"],
        routeability_repair_acceptance_ledger=payload[
            "routeability_repair_acceptance_ledger"
        ],
        profit_signal_quorum=payload["profit_signal_quorum"],
        live_submission_gate=payload["live_submission_gate"],
        torghut_custody_ref=payload["torghut_custody_ref"],
        clickhouse_ta_status=payload["clickhouse_ta_status"],
        rollout_status=payload["rollout_status"],
        now=NOW,
    )
    return build_route_warrant_exchange(
        account_label=payload["account_label"],
        window=payload["window"],
        trading_mode=payload["trading_mode"],
        torghut_revision=payload["torghut_revision"],
        source_commit=payload["source_commit"],
        build=payload["build"],
        consumer_evidence_receipt=payload["consumer_evidence_receipt"],
        evidence_clock_arbiter=arbiter,
        routeable_profit_candidate_exchange=exchange,
        routeability_repair_acceptance_ledger=payload[
            "routeability_repair_acceptance_ledger"
        ],
        profit_freshness_frontier=payload["profit_freshness_frontier"],
        live_submission_gate=payload["live_submission_gate"],
        quant_evidence=payload["quant_evidence"],
        tca_summary=payload["tca_summary"],
        empirical_jobs_status=payload["empirical_jobs_status"],
        market_context_status=payload["market_context_status"],
        now=NOW,
    )


def _packet_for(warrant: dict[str, object], dependency: str) -> dict[str, object]:
    for raw_packet in warrant["repair_packets"]:
        packet = dict(raw_packet)
        if packet["target_dependency"] == dependency:
            return packet
    raise AssertionError(f"missing repair packet for {dependency}")


def test_current_warrant_reaches_paper_candidate_without_widening_notional() -> None:
    warrant = _build()

    assert warrant["schema_version"] == ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION
    assert warrant["warrant_state"] == "paper_candidate"
    assert warrant["accepted_routeable_candidate_count"] == 1
    assert warrant["max_notional"] == "0"
    assert warrant["repair_packets"] == []
    assert warrant["capital_gate_safety"]["max_notional"] == "0"


def test_fresh_compute_with_stale_ingestion_materialization_stays_repair_only() -> None:
    quant = {
        **_base_inputs()["quant_evidence"],
        "latest_metrics_count": 180,
        "stage_count": 3,
        "ingestion_ok": False,
        "materialization_ok": False,
    }

    warrant = _build(quant_evidence=quant)

    assert warrant["warrant_state"] == "repair_only"
    assert warrant["accepted_routeable_candidate_count"] == 0
    assert warrant["max_notional"] == "0"
    packet = _packet_for(warrant, "ingestion_materialization")
    assert packet["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert "torghut_quant_ingestion_degraded" in packet["reason_codes"]
    assert packet["expected_output_receipt"] == (
        "torghut.quant-ingestion-materialization-current-receipt.v1"
    )


def test_stale_active_tca_blocks_routeable_candidates() -> None:
    stale_tca = {
        **_base_inputs()["tca_summary"],
        "last_computed_at": (NOW - timedelta(days=2)).isoformat(),
        "latest_execution_created_at": (NOW - timedelta(days=30)).isoformat(),
    }

    warrant = _build(tca_summary=stale_tca)

    assert warrant["warrant_state"] == "repair_only"
    assert warrant["accepted_routeable_candidate_count"] == 0
    assert warrant["fill_tca_or_slippage_quality"]["state"] == "stale"
    packet = _packet_for(warrant, "active_tca")
    assert packet["target_value_gate"] == "fill_tca_or_slippage_quality"
    assert "execution_tca_stale" in packet["reason_codes"]


def test_high_slippage_active_tca_keeps_warrant_repair_only() -> None:
    high_slippage_tca = {
        **_base_inputs()["tca_summary"],
        "avg_abs_slippage_bps": "9.25",
        "slippage_guardrail_bps": "8",
    }

    warrant = _build(tca_summary=high_slippage_tca)

    assert warrant["warrant_state"] == "repair_only"
    assert warrant["accepted_routeable_candidate_count"] == 0
    assert warrant["max_notional"] == "0"
    assert warrant["fill_tca_or_slippage_quality"]["state"] == "stale"
    packet = _packet_for(warrant, "active_tca")
    assert packet["target_value_gate"] == "fill_tca_or_slippage_quality"
    assert "execution_tca_slippage_guardrail_exceeded" in packet["reason_codes"]
    assert (
        packet["expected_output_receipt"]
        == "torghut.active-session-tca-current-receipt.v1"
    )


def test_stale_empirical_jobs_block_routeable_candidates() -> None:
    empirical_jobs = {
        **_base_inputs()["empirical_jobs_status"],
        "ready": False,
        "status": "degraded",
        "stale_jobs": ["benchmark_parity"],
        "reason": "empirical_jobs_not_ready",
    }

    warrant = _build(empirical_jobs_status=empirical_jobs)

    assert warrant["warrant_state"] == "repair_only"
    assert warrant["accepted_routeable_candidate_count"] == 0
    packet = _packet_for(warrant, "empirical")
    assert packet["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert "empirical_jobs_not_ready" in packet["reason_codes"]


def test_disabled_live_submission_keeps_warrant_zero_notional_repair_only() -> None:
    warrant = _build(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "generated_at": NOW.isoformat(),
        },
        live_submission_gate={
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
        },
    )

    assert warrant["warrant_state"] == "repair_only"
    assert warrant["accepted_routeable_candidate_count"] == 0
    assert warrant["capital_gate_safety"]["live_submission_allowed"] is False
    packet = _packet_for(warrant, "submission")
    assert packet["target_value_gate"] == "capital_gate_safety"
    assert "simple_submit_disabled" in packet["reason_codes"]


def test_repair_packets_are_zero_notional_and_single_receipt() -> None:
    warrant = _build(
        quant_evidence={
            **_base_inputs()["quant_evidence"],
            "ingestion_ok": False,
            "materialization_ok": False,
        },
        tca_summary={
            **_base_inputs()["tca_summary"],
            "last_computed_at": (NOW - timedelta(days=2)).isoformat(),
        },
    )

    assert warrant["repair_packets"]
    for raw_packet in warrant["repair_packets"]:
        packet = dict(raw_packet)
        assert packet["max_notional"] == "0"
        assert packet["promotion_authority"] is False
        assert packet["capital_authority"] == "none"
        assert isinstance(packet["expected_output_receipt"], str)
        assert packet["expected_output_receipt"].startswith("torghut.")
        assert packet["target_value_gate"] in {
            "post_cost_daily_net_pnl",
            "routeable_candidate_count",
            "zero_notional_or_stale_evidence_rate",
            "fill_tca_or_slippage_quality",
            "capital_gate_safety",
        }
