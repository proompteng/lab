from __future__ import annotations

from typing import Any, cast
from unittest.mock import patch

from sqlalchemy.orm import Session

from app.trading import paper_route_evidence as adapter


def test_deprecated_evidence_builders_delegate_to_proofs_payload() -> None:
    proof_payload = {"schema_version": "torghut.proofs.v1", "proofs": []}
    session = cast(Session, object())

    with patch.object(adapter, "build_proofs_payload", return_value=proof_payload) as build:
        evidence = adapter.build_paper_route_evidence_audit(
            session,
            live_submission_gate={"gate": "ok"},
            route_reacquisition_book={"book": "ok"},
            lookback_hours=99,
            target_limit=3,
            include_runtime_window_import_audit=False,
            target_account_audit_available=False,
        )
        target_plan = adapter.build_paper_route_target_plan_payload(
            session,
            live_submission_gate={"gate": "ok"},
            route_reacquisition_book={"book": "ok"},
            target_limit=4,
            include_runtime_window_import_audit=True,
        )

    assert evidence["deprecated_endpoint"] is True
    assert evidence["replacement_endpoint"] == "/trading/proofs"
    assert target_plan["deprecated_endpoint"] is True
    assert build.call_args_list[0].kwargs["window"] == "auto"
    assert build.call_args_list[0].kwargs["limit"] == 3
    assert build.call_args_list[0].kwargs["full_audit"] is False
    assert build.call_args_list[0].kwargs["target_account_audit_available"] is False
    assert build.call_args_list[1].kwargs["window"] == "next"
    assert build.call_args_list[1].kwargs["limit"] == 4
    assert build.call_args_list[1].kwargs["full_audit"] is True


def test_legacy_target_summary_uses_quantity_and_symbol_fallbacks() -> None:
    target: dict[str, Any] = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "candidate-1",
        "strategy_name": "pairs-v1",
        "runtime_strategy_name": "pairs-v1",
        "account_label": "TORGHUT_SIM",
        "source_kind": "runtime_window",
        "symbols": "msft,goog",
        "target_notional": "not-a-number",
        "paper_route_probe_effective_max_notional": "25",
        "target_symbol_quantities": {"MSFT": "2", "GOOG": "3"},
    }

    summary = adapter.paper_route_target_summaries([target])[0]

    assert summary["symbols"] == ["GOOG", "MSFT"]
    assert summary["symbol_quantities"] == {"GOOG": "3", "MSFT": "2"}
    assert summary["bounded_paper_collection_notional"] == "25"

