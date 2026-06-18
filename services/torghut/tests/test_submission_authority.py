from __future__ import annotations

from app.trading.submission_authority import build_submission_authority_status


def test_submission_authority_surfaces_bounded_collection_submit_mode() -> None:
    status = build_submission_authority_status(
        {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "runtime_ledger_source_collection_pending",
            ],
            "capital_stage": "shadow",
            "capital_state": "blocked",
            "bounded_live_paper_collection_gate": {
                "allowed": True,
                "active": True,
                "reason": "bounded_live_paper_collection_ready",
                "authority_scope": "bounded_evidence_collection_only",
                "source_collection_target_count": 1,
                "source_collection_profit_target_count": 1,
                "paper_route_probe_max_notional": "100",
                "market_session_open": True,
                "capital_gate_blocked_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "runtime_ledger_source_collection_pending",
                ],
                "collection_only_blockers": [
                    "alpha_readiness_not_promotion_eligible",
                    "runtime_ledger_source_collection_pending",
                ],
                "hard_blockers": [],
            },
        },
        simple_lane_status={
            "submit_enabled": True,
            "paper_route_probe_enabled": True,
            "paper_route_probe_allow_live_mode": True,
            "max_notional_per_order": 100.0,
            "max_notional_per_symbol": 250.0,
            "max_gross_exposure_pct_equity": 0.05,
        },
    )

    assert status["effective_submit_mode"] == "bounded_live_paper_collection"
    assert status["can_submit_now"] is True
    assert status["authority_scope"] == "bounded_evidence_collection_only"
    assert status["reason"] == "bounded_live_paper_collection_ready"
    assert status["capital_promotion_gate"] == {
        "allowed": False,
        "reason": "alpha_readiness_not_promotion_eligible",
        "blocked_reasons": [
            "alpha_readiness_not_promotion_eligible",
            "runtime_ledger_source_collection_pending",
        ],
        "capital_stage": "shadow",
        "capital_state": "blocked",
        "certificate_id": None,
    }
    assert status["bounded_collection_gate"]["hard_blockers"] == []
    assert status["bounded_collection_gate"]["source_collection_target_count"] == 1
    assert status["simple_lane_contract"]["max_notional_per_order"] == 100.0
    assert "promotion_allowed" not in status
    assert "final_promotion_allowed" not in status


def test_submission_authority_blocks_on_hard_bounded_collection_blocker() -> None:
    status = build_submission_authority_status(
        {
            "allowed": False,
            "reason": "empirical_jobs_not_ready",
            "blocked_reasons": ["empirical_jobs_not_ready"],
            "bounded_live_paper_collection_gate": {
                "allowed": False,
                "active": False,
                "reason": "empirical_jobs_not_ready",
                "blocked_reasons": ["empirical_jobs_not_ready"],
                "authority_scope": "bounded_evidence_collection_only",
                "hard_blockers": ["empirical_jobs_not_ready"],
            },
        },
        simple_lane_status={"submit_enabled": True},
    )

    assert status["effective_submit_mode"] == "blocked"
    assert status["can_submit_now"] is False
    assert status["authority_scope"] == "none"
    assert status["reason"] == "empirical_jobs_not_ready"
    assert status["bounded_collection_gate"]["hard_blockers"] == [
        "empirical_jobs_not_ready"
    ]


def test_submission_authority_prefers_capital_promotion_when_allowed() -> None:
    status = build_submission_authority_status(
        {
            "allowed": True,
            "reason": "live_submission_allowed",
            "blocked_reasons": [],
            "capital_stage": "live",
            "capital_state": "authorized",
            "certificate_id": "cert-1",
            "bounded_live_paper_collection_gate": {
                "allowed": True,
                "active": True,
                "reason": "bounded_live_paper_collection_ready",
            },
        },
        simple_lane_status={"submit_enabled": True},
    )

    assert status["effective_submit_mode"] == "capital_promotion"
    assert status["can_submit_now"] is True
    assert status["authority_scope"] == "capital_promotion"
    assert status["reason"] == "live_submission_allowed"
    assert status["capital_promotion_gate"]["certificate_id"] == "cert-1"
