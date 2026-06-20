from __future__ import annotations

from typing import Any

from app.trading.paper_route_target_summaries import paper_route_target_summaries


def test_target_summary_uses_quantity_and_symbol_fallbacks() -> None:
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

    summary = paper_route_target_summaries([target])[0]

    assert summary["symbols"] == ["GOOG", "MSFT"]
    assert summary["symbol_quantities"] == {"GOOG": "3", "MSFT": "2"}
    assert summary["bounded_paper_collection_notional"] == "25"
