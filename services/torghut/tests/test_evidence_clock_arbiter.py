from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.trading.evidence_clock_arbiter import (
    EVIDENCE_CLOCK_ARBITER_SCHEMA_VERSION,
    ROUTEABLE_PROFIT_CANDIDATE_EXCHANGE_SCHEMA_VERSION,
    build_evidence_clock_arbiter_and_exchange,
)


NOW = datetime(2026, 5, 12, 16, 45, tzinfo=timezone.utc)


def _base_inputs() -> dict[str, Any]:
    return {
        "account_label": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "torghut_revision": "torghut-00320",
        "build": {
            "commit": "abc123",
            "active_revision": "torghut-00320",
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
            "symbol_count": 8,
        },
        "rollout_status": {
            "state": "current",
            "route_workloads_ok": True,
            "verified_at": NOW.isoformat(),
        },
        "now": NOW,
    }


def _build(**overrides: object) -> tuple[dict[str, object], dict[str, object]]:
    payload = _base_inputs()
    payload.update(overrides)
    return build_evidence_clock_arbiter_and_exchange(**payload)


def _clock(payload: dict[str, object], name: str) -> dict[str, object]:
    for raw_clock in payload["clocks"]:
        clock = dict(raw_clock)
        if clock["name"] == name:
            return clock
    raise AssertionError(f"missing clock {name}")


def test_all_current_clocks_mint_routeable_candidate_with_zero_notional() -> None:
    arbiter, exchange = _build()

    assert arbiter["schema_version"] == EVIDENCE_CLOCK_ARBITER_SCHEMA_VERSION
    assert (
        exchange["schema_version"] == ROUTEABLE_PROFIT_CANDIDATE_EXCHANGE_SCHEMA_VERSION
    )
    assert arbiter["routeable_candidate_count"] == 1
    assert arbiter["capital_decision"] == "paper_candidate"
    assert arbiter["max_notional"] == "0"
    assert exchange["routeable_candidates"][0]["candidate_id"] == "candidate-micro"
    assert exchange["routeable_candidates"][0]["max_notional"] == "0"
    assert exchange["zero_notional_repair_lots"] == []
    assert _clock(arbiter, "postgres_tca")["state"] == "current"
    assert all(clock["name"] != "market_context" for clock in arbiter["clocks"])


def test_stale_market_context_is_diagnostic_not_routeability_clock() -> None:
    arbiter, exchange = _build(
        market_context_status={
            "status": "degraded",
            "last_updated_at": (NOW - timedelta(days=2)).isoformat(),
            "last_domain_states": {
                "technicals": {"state": "stale"},
                "regime": {"state": "stale"},
            },
            "blocking_reasons": ["market_context_technicals_stale"],
        }
    )

    assert arbiter["routeable_candidate_count"] == 1
    assert exchange["routeable_candidates"][0]["candidate_id"] == "candidate-micro"
    assert exchange["zero_notional_repair_lots"] == []
    assert all(clock["name"] != "market_context" for clock in arbiter["clocks"])
    assert all(
        lot["repair_class"] != "market_context_domain_refresh"
        for lot in exchange["zero_notional_repair_lots"]
    )


def test_fresh_clickhouse_cannot_mint_candidate_when_postgres_tca_is_stale() -> None:
    stale_tca = {
        **_base_inputs()["tca_summary"],
        "last_computed_at": (NOW - timedelta(days=4)).isoformat(),
        "latest_execution_created_at": (NOW - timedelta(days=40)).isoformat(),
    }

    arbiter, exchange = _build(tca_summary=stale_tca)

    assert _clock(arbiter, "clickhouse_ta")["state"] == "current"
    tca_clock = _clock(arbiter, "postgres_tca")
    assert tca_clock["state"] == "stale"
    assert "execution_tca_stale" in tca_clock["reason_codes"]
    assert "active_session_execution_samples_stale" in tca_clock["reason_codes"]
    assert arbiter["routeable_candidate_count"] == 0
    assert exchange["routeable_candidates"] == []
    assert any(
        lot["target_value_gate"] == "fill_tca_or_slippage_quality"
        for lot in exchange["zero_notional_repair_lots"]
    )


def test_fresh_tca_above_slippage_guardrail_blocks_routeable_candidate() -> None:
    high_slippage_tca = {
        **_base_inputs()["tca_summary"],
        "avg_abs_slippage_bps": "9.25",
        "slippage_guardrail_bps": "8",
    }

    arbiter, exchange = _build(tca_summary=high_slippage_tca)

    assert arbiter["routeable_candidate_count"] == 0
    tca_clock = _clock(arbiter, "postgres_tca")
    assert tca_clock["state"] == "stale"
    assert "execution_tca_slippage_guardrail_exceeded" in tca_clock["reason_codes"]
    assert tca_clock["details"]["slippage_guardrail_bps"] == "8"
    assert exchange["routeable_candidates"] == []
    assert any(
        lot["target_value_gate"] == "fill_tca_or_slippage_quality"
        for lot in exchange["zero_notional_repair_lots"]
    )


def test_global_quant_latest_does_not_override_missing_scoped_stages() -> None:
    quant = {
        **_base_inputs()["quant_evidence"],
        "status": "ok",
        "latest_metrics_count": 4536,
        "stage_count": 0,
    }

    arbiter, exchange = _build(quant_evidence=quant)

    quant_clock = _clock(arbiter, "torghut_quant")
    assert quant_clock["state"] == "split"
    assert "torghut_quant_scoped_stages_missing" in quant_clock["reason_codes"]
    assert arbiter["routeable_candidate_count"] == 0
    assert any(
        lot["repair_class"] == "quant_ingestion_repair"
        for lot in exchange["zero_notional_repair_lots"]
    )


def test_repair_only_capital_gate_keeps_every_candidate_zero_notional() -> None:
    arbiter, exchange = _build(
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

    assert arbiter["capital_decision"] == "repair_only"
    assert arbiter["routeable_candidate_count"] == 0
    capital_clock = _clock(arbiter, "capital_gate")
    assert capital_clock["state"] == "blocked"
    assert "simple_submit_disabled" in capital_clock["reason_codes"]
    assert exchange["capital_safety_ref"]["max_notional"] == "0"
    assert exchange["routeable_candidates"] == []


def test_missing_lineage_rejects_candidate_and_targets_routeable_count_repair() -> None:
    hypothesis_payload = {
        "summary": {"promotion_eligible_total": 0},
        "items": [
            {
                "hypothesis_id": "H-REV-01",
                "candidate_id": "",
                "strategy_id": "",
                "promotion_eligible": False,
                "reasons": ["strategy_hypothesis_lineage_missing"],
            }
        ],
    }

    arbiter, exchange = _build(hypothesis_payload=hypothesis_payload)

    lineage_clock = _clock(arbiter, "hypothesis_lineage")
    assert lineage_clock["state"] == "stale"
    assert "hypothesis_candidate_id_missing" in lineage_clock["reason_codes"]
    assert exchange["rejected_candidates"][0]["hypothesis_id"] == "H-REV-01"
    assert any(
        lot["target_value_gate"] == "routeable_candidate_count"
        for lot in exchange["zero_notional_repair_lots"]
    )
