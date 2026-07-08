from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


def _payload() -> dict[str, object]:
    return {
        "schema_version": "torghut.proofs.v1",
        "generated_at": "2026-06-08T20:00:00+00:00",
        "kind": "runtime_window",
        "window": {
            "selector": "next",
            "start": "2026-06-08T13:30:00+00:00",
            "end": "2026-06-08T20:00:00+00:00",
            "closed": True,
        },
        "live_submission_gate": {
            "allowed": False,
            "reason": "accepted_ta_signal_stale",
            "clickhouse_ta_freshness": {
                "accepted_sources": ["ta"],
                "accepted_lag_seconds": 900,
                "accepted_source_state": "stale",
                "blocking_reason": "accepted_ta_signal_stale",
            },
        },
        "proofs": [],
        "summary": {
            "target_count": 0,
            "proof_count": 0,
            "state_counts": {},
            "blocker_counts": {},
            "ready_count": 0,
            "import_due_count": 0,
            "blocked_count": 0,
            "live_submission_allowed": False,
            "live_submission_reason": "accepted_ta_signal_stale",
            "accepted_source_state": "stale",
            "accepted_lag_seconds": 900,
        },
        "promotion_authority": {
            "allowed": False,
            "final_promotion_allowed": False,
            "reason": "proof_collection_only",
            "blockers": ["live_runtime_ledger_authority_required"],
        },
    }


def test_trading_proofs_endpoint_uses_canonical_contract() -> None:
    client = TestClient(app)
    with patch(
        "app.api.proofs._build_trading_proofs_payload", return_value=_payload()
    ) as build:
        response = client.get(
            "/trading/proofs?kind=runtime_window&limit=2&window=next&full_audit=true"
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == "torghut.proofs.v1"
    assert payload["live_submission_gate"]["reason"] == "accepted_ta_signal_stale"
    assert payload["summary"]["accepted_source_state"] == "stale"
    build.assert_called_once_with(
        kind="runtime_window",
        limit=2,
        window="next",
        full_audit=True,
    )


def test_paper_route_proof_endpoints_are_removed() -> None:
    client = TestClient(app)
    with patch("app.api.proofs._build_trading_proofs_payload", return_value=_payload()):
        evidence = client.get("/trading/paper-route-evidence?target_limit=1")
        target_plan = client.get("/trading/paper-route-target-plan")

    assert evidence.status_code == 404
    assert target_plan.status_code == 404
