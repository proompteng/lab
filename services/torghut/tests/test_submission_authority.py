from __future__ import annotations

from app.trading.submission_authority import build_submission_authority_status


def test_submission_authority_allows_operational_submission() -> None:
    status = build_submission_authority_status(
        {
            "operational_submission_gate": {
                "allowed": True,
                "reason": "operational_submission_ready",
                "blocked_reasons": [],
                "execution_route": {
                    "route": "testnet",
                    "alpaca_regular_session_open": False,
                },
            },
        },
        simple_lane_status={
            "submit_enabled": True,
            "live_submit_enabled": True,
            "paper_route_probe_enabled": True,
            "paper_route_probe_allow_live_mode": True,
            "max_notional_per_order": 100.0,
            "max_notional_per_symbol": 250.0,
            "max_gross_exposure_pct_equity": 0.05,
        },
    )

    assert status["effective_submit_mode"] == "operational_submission"
    assert status["can_submit_now"] is True
    assert status["authority_scope"] == "operational_submission"
    assert status["reason"] == "operational_submission_ready"
    assert status["operational_submission_gate"] == {
        "allowed": True,
        "reason": "operational_submission_ready",
        "blocked_reasons": [],
        "execution_route": {
            "route": "testnet",
            "alpaca_regular_session_open": False,
        },
    }
    assert "simple_lane_contract" not in status
    assert "promotion_allowed" not in status
    assert "final_promotion_allowed" not in status


def test_submission_authority_blocks_on_operational_blocker() -> None:
    status = build_submission_authority_status(
        {
            "operational_submission_gate": {
                "allowed": False,
                "reason": "kill_switch_enabled",
                "blocked_reasons": ["kill_switch_enabled"],
                "execution_route": {
                    "route": "alpaca",
                    "alpaca_regular_session_open": True,
                },
            },
        },
        simple_lane_status={"submit_enabled": True, "live_submit_enabled": True},
    )

    assert status["effective_submit_mode"] == "blocked"
    assert status["can_submit_now"] is False
    assert status["authority_scope"] == "none"
    assert status["reason"] == "kill_switch_enabled"
    assert status["operational_submission_gate"]["blocked_reasons"] == [
        "kill_switch_enabled"
    ]


def test_submission_authority_accepts_compatibility_gate_payload() -> None:
    status = build_submission_authority_status(
        {
            "allowed": True,
            "reason": "operational_submission_ready",
            "blocked_reasons": [],
            "execution_route": {
                "route": "alpaca",
                "alpaca_regular_session_open": True,
            },
        },
        simple_lane_status={"submit_enabled": True, "live_submit_enabled": True},
    )

    assert status["effective_submit_mode"] == "operational_submission"
    assert status["can_submit_now"] is True
    assert status["authority_scope"] == "operational_submission"
    assert status["operational_submission_gate"]["execution_route"] == {
        "route": "alpaca",
        "alpaca_regular_session_open": True,
    }


def test_submission_authority_diagnostic_reasons_do_not_block() -> None:
    status = build_submission_authority_status(
        {
            "allowed": False,
            "reason": "hypothesis_not_promotion_eligible",
            "blocked_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "hypothesis_not_promotion_eligible",
                "runtime_ledger_profit_target_source_collection_pending",
                "runtime_ledger_source_collection_pending",
                "runtime_profit_target_import_required",
                "runtime_window_import_required",
            ],
            "execution_route": {
                "route": "testnet",
                "alpaca_regular_session_open": False,
            },
        },
        simple_lane_status={"submit_enabled": True, "live_submit_enabled": True},
    )

    assert status["effective_submit_mode"] == "operational_submission"
    assert status["can_submit_now"] is True
    assert status["authority_scope"] == "operational_submission"
    assert status["reason"] == "operational_submission_ready"
    assert status["operational_submission_gate"]["blocked_reasons"] == []
