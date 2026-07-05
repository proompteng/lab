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
    )

    assert status["effective_submit_mode"] == "blocked"
    assert status["can_submit_now"] is False
    assert status["authority_scope"] == "none"
    assert status["reason"] == "kill_switch_enabled"
    assert status["operational_submission_gate"]["blocked_reasons"] == [
        "kill_switch_enabled"
    ]


def test_submission_authority_blocks_disabled_testnet_after_hours_gate() -> None:
    status = build_submission_authority_status(
        {
            "allowed": False,
            "reason": "testnet_after_hours_disabled",
            "blocked_reasons": ["testnet_after_hours_disabled"],
            "execution_route": {
                "route": "testnet",
                "alpaca_regular_session_open": False,
            },
        },
    )

    assert status["effective_submit_mode"] == "blocked"
    assert status["can_submit_now"] is False
    assert status["reason"] == "testnet_after_hours_disabled"
    assert status["operational_submission_gate"]["blocked_reasons"] == [
        "testnet_after_hours_disabled"
    ]


def test_submission_authority_keeps_unknown_false_gate_closed() -> None:
    status = build_submission_authority_status(
        {
            "allowed": False,
            "reason": "new_operational_disable",
            "blocked_reasons": ["new_operational_disable"],
        },
    )

    assert status["effective_submit_mode"] == "blocked"
    assert status["can_submit_now"] is False
    assert status["reason"] == "new_operational_disable"
    assert status["operational_submission_gate"]["blocked_reasons"] == [
        "new_operational_disable"
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
            "reason": "non_operational_diagnostic",
            "blocked_reasons": [
                "proof_collection_pending",
                "promotion_status_not_ready",
                "research_evidence_missing",
            ],
            "execution_route": {
                "route": "testnet",
                "alpaca_regular_session_open": False,
            },
        },
    )

    assert status["effective_submit_mode"] == "operational_submission"
    assert status["can_submit_now"] is True
    assert status["authority_scope"] == "operational_submission"
    assert status["reason"] == "operational_submission_ready"
    assert status["operational_submission_gate"]["blocked_reasons"] == []
