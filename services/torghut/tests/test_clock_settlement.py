from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.trading.clock_settlement import (
    CLOCK_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
    build_clock_settlement_receipt,
)
from app.trading.evidence_clock_arbiter import build_evidence_clock_arbiter_and_exchange


NOW = datetime(2026, 5, 12, 16, 45, tzinfo=timezone.utc)


def _base_inputs_core() -> dict[str, Any]:
    return {
        "account_label": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "torghut_revision": "torghut-00324",
        "build": {
            "commit": "abc123",
            "active_revision": "torghut-00324",
            "image_digest": "sha256:ready",
        },
        "hypothesis_payload": {
            "summary": {"promotion_eligible_total": 1},
            "items": [
                {
                    "hypothesis_id": "H-MICRO-01",
                    "candidate_id": "candidate-micro",
                    "strategy_id": "strategy-micro",
                    "promotion_eligible": True,
                    "promotion_decision_id": "promotion-micro",
                    "reasons": [],
                }
            ],
        },
        "quant_evidence": {
            "ok": True,
            "status": "ok",
            "latest_metrics_count": 180,
            "stage_count": 3,
            "latest_metrics_updated_at": NOW.isoformat(),
        },
        "market_context_status": {
            "status": "healthy",
            "last_updated_at": NOW.isoformat(),
            "last_domain_states": {},
        },
        "tca_summary": {
            "order_count": 72,
            "filled_execution_count": 72,
            "last_computed_at": NOW.isoformat(),
            "latest_execution_created_at": NOW.isoformat(),
            "avg_abs_slippage_bps": "4.5",
            "expected_shortfall_sample_count": 80,
        },
        "empirical_jobs_status": {
            "ready": True,
            "status": "ready",
            "updated_at": NOW.isoformat(),
        },
        "proof_floor_receipt": {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "max_notional": "25",
            "generated_at": NOW.isoformat(),
        },
        "routeability_repair_acceptance_ledger": {
            "ledger_id": "routeability:accepted",
            "aggregate_state": "accepted",
            "accepted_routeable_candidate_count": 1,
            "aggregate_blocking_reason_codes": [],
            "generated_at": NOW.isoformat(),
        },
        "profit_signal_quorum": {
            "quorum_set_id": "profit-quorum:ready",
            "aggregate_decision": "paper_candidate",
            "aggregate_reason_codes": [],
            "generated_at": NOW.isoformat(),
            "quorums": [
                {
                    "quorum_id": "quorum:H-MICRO-01",
                    "hypothesis_id": "H-MICRO-01",
                    "candidate_id": "candidate-micro",
                    "strategy_id": "strategy-micro",
                    "decision": "paper_candidate",
                }
            ],
        },
        "live_submission_gate": {
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
        },
        "torghut_custody_ref": {
            "packet_id": "jangar-custody:paper",
            "decision": "paper_candidate",
            "fresh_until": (NOW + timedelta(minutes=5)).isoformat(),
        },
        "clickhouse_ta_status": {
            "state": "current",
            "latest_signal_at": NOW.isoformat(),
            "source_ref": "torghut.ta_signals",
            "symbol_count": 8,
        },
        "rollout_status": _rollout_status(),
        "now": NOW,
    }


def _rollout_status() -> dict[str, object]:
    return {
        "state": "current",
        "route_workloads_ok": True,
        "verified_at": NOW.isoformat(),
    }


def _base_inputs() -> dict[str, Any]:
    payload = _base_inputs_core()
    payload.update(
        {
            "rollout_status": _rollout_status(),
            "now": NOW,
        }
    )
    return payload


def _arbiter(
    *,
    include_clickhouse_clock: bool,
) -> tuple[dict[str, object], dict[str, object], dict[str, Any]]:
    payload = _base_inputs()
    clickhouse_ta_status = (
        payload["clickhouse_ta_status"] if include_clickhouse_clock else None
    )
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
        clickhouse_ta_status=clickhouse_ta_status,
        rollout_status=payload["rollout_status"],
        now=NOW,
    )
    return arbiter, exchange, payload


def _receipt(
    arbiter: dict[str, object],
    exchange: dict[str, object],
    payload: dict[str, Any],
) -> dict[str, object]:
    return build_clock_settlement_receipt(
        account_label=payload["account_label"],
        window=payload["window"],
        trading_mode=payload["trading_mode"],
        torghut_revision=payload["torghut_revision"],
        source_commit=payload["build"]["commit"],
        build=payload["build"],
        evidence_clock_arbiter=arbiter,
        routeable_profit_candidate_exchange=exchange,
        clickhouse_ta_status=payload["clickhouse_ta_status"],
        quant_evidence=payload["quant_evidence"],
        tca_summary=payload["tca_summary"],
        empirical_jobs_status=payload["empirical_jobs_status"],
        profit_signal_quorum=payload["profit_signal_quorum"],
        rollout_status=payload["rollout_status"],
        now=NOW,
    )


def _witness(receipt: dict[str, object], witness_class: str) -> dict[str, object]:
    for raw_witness in receipt["direct_data_witnesses"]:
        witness = dict(raw_witness)
        if witness["witness_class"] == witness_class:
            return witness
    raise AssertionError(f"missing witness {witness_class}")


def test_fresh_clickhouse_with_missing_published_clock_emits_wiring_split() -> None:
    arbiter, exchange, payload = _arbiter(include_clickhouse_clock=False)

    receipt = _receipt(arbiter, exchange, payload)

    assert receipt["schema_version"] == CLOCK_SETTLEMENT_RECEIPT_SCHEMA_VERSION
    assert receipt["max_notional"] == "0"
    clickhouse_witness = _witness(receipt, "clickhouse_ta")
    assert clickhouse_witness["direct_freshness_state"] == "current"
    assert clickhouse_witness["matching_published_clock_state"] == "missing"
    assert clickhouse_witness["freshness_state"] == "split"
    assert "clock_wiring_split" in clickhouse_witness["split_reason_codes"]
    packet = receipt["repair_execution_packets"][0]
    assert packet["repair_class"] == "clock_wiring_split"
    assert packet["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert packet["max_notional"] == "0"
    assert "paper_canary" in packet["forbidden_action_classes"]


def test_settled_clickhouse_clock_has_no_clock_wiring_packet() -> None:
    arbiter, exchange, payload = _arbiter(include_clickhouse_clock=True)

    receipt = _receipt(arbiter, exchange, payload)

    clickhouse_witness = _witness(receipt, "clickhouse_ta")
    assert clickhouse_witness["direct_freshness_state"] == "current"
    assert clickhouse_witness["matching_published_clock_state"] == "current"
    assert clickhouse_witness["split_reason_codes"] == []
    assert all(
        packet["repair_class"] != "clock_wiring_split"
        for packet in receipt["repair_execution_packets"]
    )
    assert receipt["routeable_candidate_count"] == 1
    assert receipt["max_notional"] == "0"


def test_after_hours_clickhouse_ta_witness_matches_published_clock_staleness_gate() -> (
    None
):
    arbiter, exchange, payload = _arbiter(include_clickhouse_clock=True)
    stale_after_hours = NOW - timedelta(hours=8)
    payload["clickhouse_ta_status"] = {
        **payload["clickhouse_ta_status"],
        "latest_signal_at": stale_after_hours.isoformat(),
        "accepted_source_state": "outside_regular_session",
        "regular_session_open": False,
        "market_session_state": "after_hours",
    }
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

    receipt = _receipt(arbiter, exchange, payload)

    clickhouse_witness = _witness(receipt, "clickhouse_ta")
    assert clickhouse_witness["direct_freshness_state"] == "current"
    assert clickhouse_witness["matching_published_clock_state"] == "current"
    assert "clickhouse_ta_stale" not in clickhouse_witness["reason_codes"]
    assert clickhouse_witness["split_reason_codes"] == []
