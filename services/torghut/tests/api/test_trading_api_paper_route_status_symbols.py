from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.api import proof_floor_payloads
from app.api.proof_floor_payloads.paper_route_probe_targets import (
    bounded_paper_route_probe_target_symbols,
)
from app.config import settings


def test_bounded_probe_targets_fall_back_to_static_symbols_without_promotion() -> None:
    original_static_symbols = settings.trading_static_symbols_raw
    try:
        settings.trading_static_symbols_raw = "AAPL,nvda,AAPL"
        symbols = bounded_paper_route_probe_target_symbols(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "targets": [
                        {
                            "source_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "promotion_allowed": False,
                            "final_promotion_allowed": False,
                            "final_promotion_authorized": False,
                        }
                    ],
                }
            }
        )
    finally:
        settings.trading_static_symbols_raw = original_static_symbols

    assert symbols == ["AAPL", "NVDA"]


def test_bounded_probe_targets_return_explicit_symbols() -> None:
    symbols = bounded_paper_route_probe_target_symbols(
        {
            "runtime_ledger_paper_probation_import_plan": {
                "targets": [
                    {
                        "source_collection_authorized": True,
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "final_promotion_authorized": False,
                        "paper_route_probe_symbols": "aapl,msft",
                        "target_symbols": ["NVDA"],
                        "paper_route_probe_symbol_actions": {"amzn": "buy"},
                    }
                ],
            }
        }
    )

    assert symbols == ["AAPL", "MSFT", "NVDA", "AMZN"]


def test_bounded_probe_targets_return_empty_without_targets_or_authorization() -> None:
    assert bounded_paper_route_probe_target_symbols({}) == []
    assert (
        bounded_paper_route_probe_target_symbols(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "targets": [{"source_collection_authorized": False}]
                }
            }
        )
        == []
    )


def test_bounded_probe_targets_block_plan_promotion() -> None:
    assert (
        bounded_paper_route_probe_target_symbols(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "promotion_allowed": Decimal("1"),
                    "targets": [
                        {
                            "source_collection_authorized": True,
                            "paper_route_probe_symbols": ["AAPL"],
                        }
                    ],
                }
            }
        )
        == []
    )


def test_bounded_probe_target_symbols_do_not_fall_back_when_promotion_allowed() -> None:
    original_static_symbols = settings.trading_static_symbols_raw
    try:
        settings.trading_static_symbols_raw = "AAPL,NVDA"
        symbols = bounded_paper_route_probe_target_symbols(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                    "targets": [
                        {
                            "source_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "promotion_allowed": True,
                            "final_promotion_allowed": False,
                        }
                    ],
                }
            }
        )
    finally:
        settings.trading_static_symbols_raw = original_static_symbols

    assert symbols == []


def test_profitability_payload_injects_bounded_probe_target_symbols(
    monkeypatch,
) -> None:
    original_static_symbols = settings.trading_static_symbols_raw
    captured: dict[str, object] = {}

    def fake_receipt(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {"ok": True}

    try:
        settings.trading_static_symbols_raw = "AAPL,NVDA"
        monkeypatch.setattr(
            proof_floor_payloads._proof_floor,
            "build_profitability_proof_floor_receipt",
            fake_receipt,
        )

        payload = proof_floor_payloads.build_profitability_proof_floor_payload(
            state=SimpleNamespace(market_session_open=False),
            torghut_revision="rev-test",
            live_submission_gate={
                "runtime_ledger_paper_probation_import_plan": {
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "targets": [
                        {
                            "source_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "promotion_allowed": False,
                            "final_promotion_allowed": False,
                            "final_promotion_authorized": False,
                        }
                    ],
                }
            },
            hypothesis_payload={},
            empirical_jobs_status={},
            quant_evidence={},
            market_context_status={},
            tca_summary={},
            simple_lane_status={"paper_route_probe_enabled": True},
        )
    finally:
        settings.trading_static_symbols_raw = original_static_symbols

    assert payload == {"ok": True}
    assert captured["paper_route_probe_target_symbols"] == ["AAPL", "NVDA"]
