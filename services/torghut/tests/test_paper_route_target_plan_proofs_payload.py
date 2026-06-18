from __future__ import annotations

from app.trading.paper_route_target_plan import (
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
)
from app.trading.runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
)


def test_proofs_payload_configured_collection_targets_keep_paper_stage() -> None:
    plan = paper_route_target_plan_from_payload(
        {
            "schema_version": "torghut.proofs.v1",
            "proofs": [
                {
                    "identity": {
                        "account_label": "TORGHUT_SIM",
                        "candidate_id": (
                            "configured:microbar-cross-sectional-pairs-v1"
                        ),
                        "hypothesis_id": (
                            "configured-paper-collection:"
                            "microbar-cross-sectional-pairs-v1"
                        ),
                        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                        "source_account_label": "TORGHUT_SIM",
                        "source_decision_mode": (
                            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                        ),
                        "source_kind": ("configured_simple_lane_paper_data_collection"),
                        "source_plan_ref": (
                            "configured-simple-lane-paper-data-collection"
                        ),
                        "strategy_family": "microbar_cross_sectional_pairs_v1",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "target_notional": "100",
                    },
                    "symbols": ["AAPL", "AMZN"],
                    "window": {
                        "start": "2026-06-18T13:30:00+00:00",
                        "end": "2026-06-18T20:00:00+00:00",
                    },
                    "account_state": {
                        "blockers": [],
                        "clean_baseline": True,
                    },
                }
            ],
        }
    )

    assert plan["source"] == "trading_proofs_endpoint"
    assert plan["target_count"] == 1
    target = plan["targets"][0]
    assert target["observed_stage"] == "paper"
    assert target["source_plan_ref"] == "configured-simple-lane-paper-data-collection"
    assert target["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
    assert target["target_symbol_actions"] == {"AAPL": "buy", "AMZN": "buy"}
    assert target["paper_route_probe_symbol_actions"] == {
        "AAPL": "buy",
        "AMZN": "buy",
    }
    assert paper_route_target_plan_probe_symbols(plan) == {"AAPL", "AMZN"}
