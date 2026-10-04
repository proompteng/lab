from __future__ import annotations

from datetime import datetime, timezone

from app.trading.consumer_evidence import (
    build_consumer_evidence_canary,
    build_route_proven_profit_receipt,
    build_torghut_consumer_evidence_receipt,
)


def test_consumer_evidence_receipt_keeps_zero_notional_with_precise_blockers() -> None:
    proof_floor = {
        "schema_version": "torghut.profitability-proof-floor.v1",
        "generated_at": "2026-05-08T02:30:00+00:00",
        "route_state": "repair_only",
        "capital_state": "zero_notional",
        "max_notional": "0",
        "blocking_reasons": ["execution_tca_route_universe_incomplete"],
        "proof_dimensions": [
            {
                "dimension": "execution_tca",
                "state": "fail",
                "reason": "execution_tca_route_universe_incomplete",
            }
        ],
        "route_reacquisition_book": {
            "summary": {"expected_unblock_value": 14},
        },
    }
    receipt = build_torghut_consumer_evidence_receipt(
        now=datetime(2026, 5, 8, 2, 30, tzinfo=timezone.utc),
        forecast_service_status={
            "status": "degraded",
            "authority": "blocked",
            "message": "registry_empty",
        },
        empirical_jobs_status={
            "ready": True,
            "status": "healthy",
            "candidate_ids": ["chip-paper-microbar-composite@execution-proof"],
            "dataset_snapshot_refs": ["torghut-chip-full-day-20260505-4c330ce9-r1"],
        },
        proof_floor=proof_floor,
        live_submission_gate={
            "allowed": False,
            "reason": "simple_submit_disabled",
            "capital_stage": "shadow",
        },
    )

    assert receipt["schema_version"] == "torghut.consumer-evidence-receipt.v1"
    assert str(receipt["receipt_id"]).startswith("torghut-consumer-evidence:")
    assert receipt["fresh_until"] == "2026-05-08T02:31:00+00:00"
    assert receipt["candidate_id"] == "chip-paper-microbar-composite@execution-proof"
    assert (
        receipt["dataset_snapshot_ref"] == "torghut-chip-full-day-20260505-4c330ce9-r1"
    )
    assert receipt["empirical_jobs_state"] == "healthy"
    assert receipt["forecast_registry_state"] == "degraded"
    assert receipt["tca_state"] == "fail"
    assert receipt["paper_readiness_state"] == "blocked"
    assert receipt["live_readiness_state"] == "blocked"
    assert receipt["max_notional"] == "0"
    assert receipt["reason_codes"] == [
        "forecast_registry_degraded",
        "simple_submit_disabled",
        "execution_tca_route_universe_incomplete",
    ]

    route_proven_receipt = build_route_proven_profit_receipt(
        consumer_evidence_receipt=receipt,
        proof_floor=proof_floor,
        source_commit="abc123",
        serving_revision="torghut-00301",
        image_digest="sha256:test",
    )

    assert (
        route_proven_receipt["schema_version"]
        == "torghut.route-proven-profit-receipt.v1"
    )
    assert str(route_proven_receipt["receipt_id"]).startswith(
        "torghut-route-proven-profit:"
    )
    assert route_proven_receipt["serving_revision"] == "torghut-00301"
    assert route_proven_receipt["image_digest"] == "sha256:test"
    assert str(route_proven_receipt["route_canary_id"]).startswith(
        "torghut-consumer-evidence-canary:"
    )
    assert str(route_proven_receipt["jangar_parity_escrow_ref"]).startswith(
        "jangar-source-serving-parity:"
    )
    assert route_proven_receipt["proof_floor_state"] == "repair_only"
    assert route_proven_receipt["capital_state"] == "zero_notional"
    assert route_proven_receipt["route_repair_value"] == 14
    assert route_proven_receipt["decision"] == "repair"
    assert route_proven_receipt["consumer_evidence_receipt_id"] == receipt["receipt_id"]
    assert route_proven_receipt["route_canary"] == build_consumer_evidence_canary(
        source_commit="abc123",
        serving_revision="torghut-00301",
        image_digest="sha256:test",
    )


def test_consumer_evidence_receipt_marks_ready_without_notional_blockers() -> None:
    receipt = build_torghut_consumer_evidence_receipt(
        now=datetime(2026, 5, 8, 2, 30, tzinfo=timezone.utc),
        forecast_service_status={
            "status": "healthy",
            "authority": "empirical",
            "promotion_authority_eligible_models": ["chronos"],
        },
        empirical_jobs_status={
            "ready": True,
            "status": "healthy",
            "candidate_ids": ["candidate-a"],
            "dataset_snapshot_refs": ["dataset-a"],
        },
        proof_floor={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "max_notional": "100",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "fresh",
                }
            ],
        },
        live_submission_gate={
            "allowed": True,
            "reason": "allowed",
            "capital_stage": "paper",
        },
    )

    assert receipt["forecast_registry_state"] == "ready"
    assert receipt["paper_readiness_state"] == "ready"
    assert receipt["reason_codes"] == []
