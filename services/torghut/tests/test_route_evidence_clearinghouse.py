from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.trading.route_evidence_clearinghouse import (
    build_route_evidence_clearinghouse_packet,
)


NOW = datetime(2026, 5, 12, 16, 45, tzinfo=timezone.utc)

# fmt: off
BASE_PROFIT_QUORUM = {
    "quorum_set_id": "profit-quorum:ready", "aggregate_decision": "paper_candidate",
    "quorums": [{"quorum_id": "quorum:H-MICRO-01", "hypothesis_id": "H-MICRO-01", "candidate_id": "candidate-micro", "strategy_id": "strategy-micro", "route_tca_signal": {"details": {"symbols": ["AAPL"], "post_cost_expectancy_bps_proxy": "12.5"}}}],
}
BASE_TCA = {"order_count": 40, "filled_execution_count": 40, "last_computed_at": NOW.isoformat(), "latest_execution_created_at": NOW.isoformat(), "avg_abs_slippage_bps": "4.5", "expected_shortfall_sample_count": 80}
BASE_INPUTS: dict[str, Any] = {
    "account_label": "PA3SX7FYNUTF", "session_id": "15m", "trading_mode": "live",
    "torghut_revision": "torghut-00324", "source_commit": "abc123",
    "build": {"commit": "abc123", "active_revision": "torghut-00324", "image_digest": "sha256:ready"},
    "proof_floor_receipt": {"schema_version": "torghut.profitability-proof-floor.v1", "route_state": "paper_candidate", "capital_state": "paper_allowed", "max_notional": "25"},
    "profit_signal_quorum": BASE_PROFIT_QUORUM,
    "profit_repair_settlement_ledger": {"aggregate_blocking_reason_codes": []},
    "route_reacquisition_board": {"aggregate_blocking_reason_codes": []},
    "profit_window_custody": {"profit_window_contract": {"windows": [{"decision": "funded"}]}, "profit_lease_projection": {"leases": [{"state": "current"}]}},
    "tca_summary": BASE_TCA,
    "options_catalog_freshness": {"active_contracts": 100, "missing_provider_updated_ts_count": 0, "provider_updated_ts_present": True, "newest_provider_updated_ts": NOW.isoformat(), "newest_last_seen_ts": NOW.isoformat()},
    "image_proof_summary": {"image_digest": "sha256:ready", "active_revision": "torghut-00324", "route_workloads_ok": True, "state": "current"},
    "routeability_acceptance_ledger": {"ledger_id": "routeability:accepted", "aggregate_state": "accepted"},
    "live_submission_gate": {"allowed": True, "reason": "ready"},
    "now": NOW,
}
BLOCKERS = [
    ({"profit_signal_quorum": {"**copy": "option_quorum"}, "options_catalog_freshness": {**BASE_INPUTS["options_catalog_freshness"], "missing_provider_updated_ts_count": 10, "provider_updated_ts_present": False, "newest_provider_updated_ts": None}}, "options_provider_updated_ts_missing", "zero_notional_or_stale_evidence_rate"),
    ({"tca_summary": {**BASE_TCA, "last_computed_at": (NOW - timedelta(days=2)).isoformat(), "latest_execution_created_at": (NOW - timedelta(days=30)).isoformat()}}, "execution_tca_stale", "fill_tca_or_slippage_quality"),
    ({"build": {"commit": "abc123", "active_revision": "torghut-00324"}, "image_proof_summary": {}}, "image_digest_missing", "capital_gate_safety"),
    ({"proof_floor_receipt": {"schema_version": "torghut.profitability-proof-floor.v1", "route_state": "repair_only", "capital_state": "zero_notional", "max_notional": "0"}, "live_submission_gate": {"allowed": False, "reason": "simple_submit_disabled"}}, "simple_submit_disabled", "capital_gate_safety"),
]
# fmt: on


def _build(**overrides: object) -> dict[str, object]:
    payload = deepcopy(BASE_INPUTS)
    payload.update(overrides)
    return build_route_evidence_clearinghouse_packet(**payload)


def _option_quorum() -> dict[str, object]:
    quorum = deepcopy(BASE_PROFIT_QUORUM)
    quorum["quorums"][0]["asset_class"] = "options"
    return quorum


def _has_bid(packet: dict[str, object], value_gate: str) -> bool:
    return any(
        bid["value_gate"] == value_gate for bid in packet["selected_repair_bids"]
    )


def test_current_books_accept_route_claim_without_widening_notional() -> None:
    packet = _build()

    assert packet["schema_version"] == "torghut.route-evidence-clearinghouse-packet.v1"
    assert packet["accepted_routeable_candidate_count"] == 1
    assert packet["route_claims"][0]["routeability_decision"] == "accepted"
    assert packet["max_notional"] == packet["route_claims"][0]["max_notional"] == "0"
    assert packet["selected_repair_bids"] == []


def test_unrelated_catalog_provider_gap_does_not_hold_fresh_option_route() -> None:
    options_catalog = {
        **BASE_INPUTS["options_catalog_freshness"],
        "missing_provider_updated_ts_count": 10,
        "provider_updated_ts_present": False,
        "route_symbol_freshness": {
            "AAPL": {
                "active_contracts": 4,
                "missing_provider_updated_ts_count": 0,
                "provider_updated_ts_present": True,
                "newest_provider_updated_ts": NOW.isoformat(),
                "newest_last_seen_ts": NOW.isoformat(),
            },
            "MSFT": {
                "active_contracts": 1,
                "missing_provider_updated_ts_count": 1,
                "provider_updated_ts_present": False,
                "newest_provider_updated_ts": None,
                "newest_last_seen_ts": NOW.isoformat(),
            },
        },
    }

    packet = _build(
        profit_signal_quorum=_option_quorum(),
        options_catalog_freshness=options_catalog,
    )
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 1
    assert route_claim["source_freshness_decision"] == "current"
    assert "options_provider_updated_ts_missing" not in route_claim["reason_codes"]


def test_route_symbol_provider_gap_holds_only_affected_option_route() -> None:
    quorum = _option_quorum()
    quorum["quorums"].append(
        {
            "quorum_id": "quorum:H-MICRO-02",
            "hypothesis_id": "H-MICRO-02",
            "candidate_id": "candidate-msft",
            "strategy_id": "strategy-msft",
            "asset_class": "options",
            "route_tca_signal": {
                "details": {
                    "symbols": ["MSFT"],
                    "post_cost_expectancy_bps_proxy": "8.5",
                }
            },
        }
    )
    options_catalog = {
        **BASE_INPUTS["options_catalog_freshness"],
        "route_symbol_freshness": {
            "AAPL": {
                "active_contracts": 4,
                "missing_provider_updated_ts_count": 0,
                "provider_updated_ts_present": True,
                "newest_provider_updated_ts": NOW.isoformat(),
                "newest_last_seen_ts": NOW.isoformat(),
            },
            "MSFT": {
                "active_contracts": 2,
                "missing_provider_updated_ts_count": 2,
                "provider_updated_ts_present": False,
                "newest_provider_updated_ts": None,
                "newest_last_seen_ts": NOW.isoformat(),
            },
        },
    }

    packet = _build(
        profit_signal_quorum=quorum,
        options_catalog_freshness=options_catalog,
    )
    claims = {claim["candidate_id"]: claim for claim in packet["route_claims"]}

    assert packet["accepted_routeable_candidate_count"] == 1
    assert claims["candidate-micro"]["source_freshness_decision"] == "current"
    assert claims["candidate-msft"]["source_freshness_decision"] == "hold"
    assert (
        "options_provider_updated_ts_missing"
        in claims["candidate-msft"]["reason_codes"]
    )


def test_requested_route_symbol_without_catalog_row_holds_option_route() -> None:
    packet = _build(
        profit_signal_quorum=_option_quorum(),
        options_catalog_freshness={
            **BASE_INPUTS["options_catalog_freshness"],
            "route_symbols": ["AAPL"],
            "route_symbol_freshness": {},
        },
    )
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 0
    assert route_claim["source_freshness_decision"] == "hold"
    assert "options_route_symbol_catalog_missing" in route_claim["reason_codes"]


@pytest.mark.parametrize(("overrides", "reason", "value_gate"), BLOCKERS)
def test_blocking_evidence_yields_zero_notional_repair_bid(
    overrides: dict[str, object],
    reason: str,
    value_gate: str,
) -> None:
    overrides = (
        {**overrides, "profit_signal_quorum": _option_quorum()}
        if overrides.get("profit_signal_quorum")
        else overrides
    )
    packet = _build(**overrides)
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 0
    assert packet["max_notional"] == route_claim["max_notional"] == "0"
    assert reason in route_claim["reason_codes"]
    assert _has_bid(packet, value_gate)
