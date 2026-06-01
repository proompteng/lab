from __future__ import annotations

from copy import deepcopy
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, cast

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


def test_route_symbol_catalog_contract_quality_gaps_hold_option_route() -> None:
    packet = _build(
        profit_signal_quorum=_option_quorum(),
        options_catalog_freshness={
            **BASE_INPUTS["options_catalog_freshness"],
            "route_symbol_freshness": {
                "AAPL": {
                    "active_contracts": 0,
                    "missing_provider_updated_ts_count": 2,
                    "provider_updated_ts_present": False,
                    "newest_provider_updated_ts": NOW.isoformat(),
                    "newest_last_seen_ts": NOW.isoformat(),
                    "missing_close_price_count": 1,
                    "zero_open_interest_count": 1,
                },
            },
        },
    )
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 0
    assert route_claim["source_freshness_decision"] == "hold"
    assert "options_catalog_active_contracts_missing" in route_claim["reason_codes"]
    assert "options_close_price_coverage_incomplete" in route_claim["reason_codes"]
    assert "options_open_interest_coverage_incomplete" in route_claim["reason_codes"]
    assert "options_provider_updated_ts_missing" not in route_claim["reason_codes"]


def test_aggregate_option_catalog_without_active_contracts_holds_route() -> None:
    packet = _build(
        profit_signal_quorum=_option_quorum(),
        options_catalog_freshness={
            **BASE_INPUTS["options_catalog_freshness"],
            "active_contracts": 0,
        },
    )
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 0
    assert route_claim["source_freshness_decision"] == "hold"
    assert "options_catalog_active_contracts_missing" in route_claim["reason_codes"]


def test_aggregate_option_catalog_partial_provider_clocks_hold_route() -> None:
    packet = _build(
        profit_signal_quorum=_option_quorum(),
        options_catalog_freshness={
            **BASE_INPUTS["options_catalog_freshness"],
            "missing_provider_updated_ts_count": 2,
            "provider_updated_ts_present": False,
            "newest_provider_updated_ts": NOW.isoformat(),
        },
    )
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 0
    assert route_claim["source_freshness_decision"] == "hold"
    assert "options_provider_updated_ts_missing" in route_claim["reason_codes"]


def test_nested_route_tca_details_scope_option_catalog_freshness() -> None:
    quorum = _option_quorum()
    quorum["quorums"][0]["route_tca_signal"] = {
        "details": {
            "details": {
                "symbols": ["MSFT"],
                "post_cost_expectancy_bps_proxy": "7.5",
            }
        }
    }

    packet = _build(
        profit_signal_quorum=quorum,
        options_catalog_freshness={
            **BASE_INPUTS["options_catalog_freshness"],
            "route_symbols": ["MSFT"],
            "route_symbol_freshness": {
                "MSFT": {
                    "active_contracts": 2,
                    "missing_provider_updated_ts_count": 2,
                    "provider_updated_ts_present": False,
                    "newest_provider_updated_ts": None,
                    "newest_last_seen_ts": NOW.isoformat(),
                },
            },
        },
    )
    route_claim = packet["route_claims"][0]

    assert packet["accepted_routeable_candidate_count"] == 0
    assert route_claim["symbols"] == ["MSFT"]
    assert route_claim["post_cost_edge_estimate"] == "7.5"
    assert route_claim["source_freshness_decision"] == "hold"
    assert "options_provider_updated_ts_missing" in route_claim["reason_codes"]


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


def test_route_repair_bids_emit_audit_receipts_and_blocker_recommendations() -> None:
    blockers = [
        "stale_quote",
        "missing_bid_ask",
        "session_closed",
        "pair_imbalance",
        "missing_target",
        "blocked_submit",
        "missing_close_flatten_handoff",
        "runtime_import_pending",
    ]
    packet = _build(
        profit_signal_quorum={
            **BASE_PROFIT_QUORUM,
            "aggregate_reason_codes": blockers,
        },
        live_submission_gate={"allowed": False, "reason": "blocked_submit"},
    )

    repair_bids = cast(list[Mapping[str, Any]], packet["selected_repair_bids"])
    by_reason = {bid["reason_codes"][0]: bid for bid in repair_bids}
    assert set(blockers).issubset(by_reason)
    assert by_reason["stale_quote"]["repair_recommendation"] == (
        "refresh_quote_snapshot_and_recompute_route_fillability"
    )
    assert by_reason["missing_bid_ask"]["repair_recommendation"] == (
        "collect_bid_ask_quote_before_routeability_claim"
    )
    assert by_reason["session_closed"]["repair_recommendation"] == (
        "wait_for_regular_session_open_then_refresh_route_probe"
    )
    assert by_reason["pair_imbalance"]["repair_recommendation"] == (
        "repair_pair_leg_balance_before_routeability_claim"
    )
    assert by_reason["missing_target"]["repair_recommendation"] == (
        "collect_target_notional_and_side_plan_before_probe"
    )
    assert by_reason["blocked_submit"]["repair_recommendation"] == (
        "keep_submit_disabled_and_collect_submit_gate_receipt"
    )
    assert by_reason["missing_close_flatten_handoff"]["repair_recommendation"] == (
        "collect_close_flatten_handoff_receipt_before_reentry"
    )
    assert by_reason["runtime_import_pending"]["repair_recommendation"] == (
        "complete_runtime_import_reconciliation_before_authority"
    )
    for bid in by_reason.values():
        receipt = cast(Mapping[str, Any], bid["audit_receipt"])
        assert bid["max_notional"] == "0"
        assert bid["promotion_authority"] is False
        assert receipt["state"] == "audit_only"
        assert receipt["promotion_authority"] is False
        assert receipt["requires_runtime_ledger_source_proof"] is True
    route_claim = cast(Mapping[str, Any], packet["route_claims"][0])
    assert route_claim["promotion_authority"] is False
    assert packet["promotion_authority"] is False
