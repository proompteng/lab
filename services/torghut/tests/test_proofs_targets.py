from __future__ import annotations

from datetime import datetime, timezone

from app.trading.paper_route_target_plan import paper_route_target_plan_from_payload
from app.trading.proofs.targets import (
    latest_closed_regular_equities_session_window,
    next_regular_equities_session_window,
    select_proof_targets,
)


def test_next_and_latest_closed_windows_are_regular_session_bounds() -> None:
    generated_at = datetime(2026, 6, 8, 12, 0, tzinfo=timezone.utc)

    next_start, next_end = next_regular_equities_session_window(generated_at)
    latest_start, latest_end = latest_closed_regular_equities_session_window(
        generated_at
    )

    assert next_start.isoformat() == "2026-06-08T13:30:00+00:00"
    assert next_end.isoformat() == "2026-06-08T20:00:00+00:00"
    assert latest_start.isoformat() == "2026-06-05T13:30:00+00:00"
    assert latest_end.isoformat() == "2026-06-05T20:00:00+00:00"


def test_select_proof_targets_dedupes_identity_window() -> None:
    generated_at = datetime(2026, 6, 8, 12, 0, tzinfo=timezone.utc)
    target = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "candidate-1",
        "runtime_strategy_name": "pairs-v1",
        "account_label": "TORGHUT_SIM",
        "window_start": "2026-06-08T13:30:00+00:00",
        "window_end": "2026-06-08T20:00:00+00:00",
        "paper_route_probe_symbols": ["AAPL", "AMZN"],
    }

    targets = select_proof_targets(
        live_submission_gate={
            "runtime_ledger_paper_probation_import_plan": {
                "targets": [target, dict(target)]
            }
        },
        route_reacquisition_book={},
        limit=20,
        window="auto",
        generated_at=generated_at,
    )

    assert len(targets) == 1
    assert targets[0].symbols == ("AAPL", "AMZN")


def test_target_plan_parser_accepts_proofs_payload() -> None:
    plan = paper_route_target_plan_from_payload(
        {
            "schema_version": "torghut.proofs.v1",
            "proofs": [
                {
                    "identity": {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "candidate-1",
                        "runtime_strategy_name": "pairs-v1",
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "runtime_window",
                        "target_notional": "1000000",
                    },
                    "window": {
                        "start": "2026-06-08T13:30:00+00:00",
                        "end": "2026-06-08T20:00:00+00:00",
                    },
                    "symbols": ["AAPL", "AMZN"],
                }
            ],
        }
    )

    assert plan["source"] == "trading_proofs_endpoint"
    assert plan["target_count"] == 1
    assert plan["targets"][0]["hypothesis_id"] == "H-PAIRS-01"
    assert plan["targets"][0]["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
