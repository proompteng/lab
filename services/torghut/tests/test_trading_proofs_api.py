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
        "proofs": [],
        "summary": {
            "target_count": 0,
            "proof_count": 0,
            "state_counts": {},
            "blocker_counts": {},
            "ready_count": 0,
            "import_due_count": 0,
            "blocked_count": 0,
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
        "app.main._build_trading_proofs_payload", return_value=_payload()
    ) as build:
        response = client.get(
            "/trading/proofs?kind=runtime_window&limit=2&window=next&full_audit=true"
        )

    assert response.status_code == 200
    assert response.json()["schema_version"] == "torghut.proofs.v1"
    build.assert_called_once_with(
        kind="runtime_window",
        limit=2,
        window="next",
        full_audit=True,
    )


def test_deprecated_paper_route_endpoints_return_proof_payload() -> None:
    client = TestClient(app)
    with patch("app.main._build_trading_proofs_payload", return_value=_payload()):
        evidence = client.get("/trading/paper-route-evidence?target_limit=1")
        target_plan = client.get("/trading/paper-route-target-plan")

    assert evidence.status_code == 200
    assert target_plan.status_code == 200
    assert evidence.json()["schema_version"] == "torghut.proofs.v1"
    assert target_plan.json()["schema_version"] == "torghut.proofs.v1"
    assert evidence.json()["deprecated_endpoint"] is True
    assert target_plan.json()["deprecated_endpoint"] is True
    assert evidence.json()["replacement_endpoint"] == "/trading/proofs"
    assert target_plan.json()["replacement_endpoint"] == "/trading/proofs"
