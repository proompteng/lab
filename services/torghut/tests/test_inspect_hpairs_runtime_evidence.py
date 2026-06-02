from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.trading.runtime_authority_verifier import (
    AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_BLOCKER,
    AUTHORITY_MEAN_PNL_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_TRADING_DAYS_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
)
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
)
from scripts import audit_hpairs_source_proof_census as source_census
from scripts import inspect_hpairs_runtime_evidence as census


def _iso(day_index: int, hour: int = 14) -> str:
    return (
        (datetime(2026, 5, 1, hour, tzinfo=timezone.utc) + timedelta(days=day_index))
        .isoformat()
        .replace("+00:00", "Z")
    )


def _source_payload(day_index: int) -> dict[str, object]:
    return {
        "source_window_start": _iso(day_index, 14),
        "source_window_end": _iso(day_index, 21),
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_row_counts": {
            "trade_decisions": 1,
            "executions": 1,
            "execution_order_events": 1,
            "order_feed_source_windows": 1,
        },
        "trade_decision_ids": [f"decision-{day_index}"],
        "execution_ids": [f"execution-{day_index}"],
        "execution_order_event_ids": [f"event-{day_index}"],
        "source_window_ids": [f"window-{day_index}"],
        "source_offsets": [
            {"topic": "alpaca.trade_updates", "partition": 0, "offset": day_index}
        ],
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "order_feed_lifecycle_complete": True,
        "execution_economics_complete": True,
        "cost_basis_counts": {"explicit_broker_fee_runtime": 1},
    }


def _ledger_bucket(
    day_index: int,
    *,
    source_backed: bool = True,
    open_positions: int = 0,
    net_pnl: str = "600",
    filled_notional: str = "600000",
    closed_trades: int = 20,
) -> dict[str, object]:
    return {
        "id": f"ledger-{day_index}",
        "run_id": "hpairs-runtime-run",
        "candidate_id": DEFAULT_HPAIRS_CANDIDATE_ID,
        "hypothesis_id": DEFAULT_HPAIRS_HYPOTHESIS_ID,
        "observed_stage": "paper",
        "bucket_started_at": _iso(day_index, 14),
        "bucket_ended_at": _iso(day_index, 21),
        "account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
        "runtime_strategy_name": DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        "strategy_family": "pairs",
        "fill_count": 20,
        "decision_count": 20,
        "submitted_order_count": 20,
        "cancelled_order_count": 0,
        "rejected_order_count": 0,
        "unfilled_order_count": 0,
        "closed_trade_count": closed_trades,
        "open_position_count": open_positions,
        "filled_notional": filled_notional,
        "gross_strategy_pnl": str(int(net_pnl) + 10),
        "cost_amount": "10",
        "net_strategy_pnl_after_costs": net_pnl,
        "post_cost_expectancy_bps": "10",
        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "pnl_basis": POST_COST_PNL_BASIS,
        "execution_policy_hash_counts": {"policy-hash": 1},
        "cost_model_hash_counts": {"cost-hash": 1},
        "lineage_hash_counts": {"lineage-hash": 1},
        "blockers": [],
        "payload": _source_payload(day_index) if source_backed else {},
    }


def _fixture(
    *,
    days: int = 20,
    source_backed: bool = True,
    open_positions: int = 0,
    net_pnl: str = "600",
    filled_notional: str = "600000",
    include_buckets: bool = True,
) -> dict[str, object]:
    return {
        "trade_decisions": [
            {
                "id": f"decision-{day}",
                "strategy_name": DEFAULT_HPAIRS_RUNTIME_STRATEGY,
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "status": "executed",
                "created_at": _iso(day, 14),
            }
            for day in range(days)
        ],
        "executions": [
            {
                "id": f"execution-{day}",
                "trade_decision_id": f"decision-{day}",
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "status": "filled",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "created_at": _iso(day, 15),
            }
            for day in range(days)
        ],
        "execution_order_events": [
            {
                "id": f"event-{day}",
                "execution_id": f"execution-{day}",
                "trade_decision_id": f"decision-{day}",
                "source_window_id": f"window-{day}",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": day,
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "event_type": "fill",
                "status": "filled",
                "filled_qty_delta": "10",
                "avg_fill_price": "100",
                "filled_notional_delta": "1000",
                "event_ts": _iso(day, 15),
            }
            for day in range(days)
        ],
        "execution_tca_metrics": [
            {
                "id": f"tca-{day}",
                "execution_id": f"execution-{day}",
                "trade_decision_id": f"decision-{day}",
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "filled_qty": "10",
                "shortfall_notional": "1",
                "computed_at": _iso(day, 16),
            }
            for day in range(days)
        ],
        "order_feed_source_windows": [
            {
                "id": f"window-{day}",
                "alpaca_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "window_started_at": _iso(day, 14),
                "window_ended_at": _iso(day, 21),
                "start_offset": day,
                "end_offset": day + 1,
                "status": "complete",
            }
            for day in range(days)
        ],
        "runtime_ledger_buckets": [
            _ledger_bucket(
                day,
                source_backed=source_backed,
                open_positions=open_positions if day == days - 1 else 0,
                net_pnl=net_pnl,
                filled_notional=filled_notional,
            )
            for day in range(days)
        ]
        if include_buckets
        else [],
    }


def _status() -> dict[str, object]:
    return {
        "target": {
            "hypothesis_id": DEFAULT_HPAIRS_HYPOTHESIS_ID,
            "candidate_id": DEFAULT_HPAIRS_CANDIDATE_ID,
            "runtime_strategy_name": DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            "account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
            "route_enabled": True,
        },
        "route": {"paper_route_eligible": True},
        "status": {"simple_submit_enabled": True},
    }


def _rows(payload: dict[str, object]) -> source_census.CensusSourceRows:
    return source_census.CensusSourceRows(
        trade_decisions=source_census._row_list(payload.get("trade_decisions")),
        executions=source_census._row_list(payload.get("executions")),
        execution_order_events=source_census._row_list(
            payload.get("execution_order_events")
        ),
        execution_tca_metrics=source_census._row_list(
            payload.get("execution_tca_metrics")
        ),
        order_feed_source_windows=source_census._row_list(
            payload.get("order_feed_source_windows")
        ),
        runtime_ledger_buckets=source_census._row_list(
            payload.get("runtime_ledger_buckets")
        ),
    )


def _report(
    payload: dict[str, object], status: dict[str, object] | None = None
) -> dict[str, object]:
    return census.build_runtime_evidence_census(
        _rows(payload),
        identity=census.RuntimeEvidenceIdentity(
            hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            observed_stage="paper",
        ),
        status_payload=status or _status(),
        status_source="fixture_json:status.json",
    )


def test_no_runtime_ledger_buckets_emit_blockers() -> None:
    report = _report(_fixture(include_buckets=False))

    assert (
        report["truths"]["runtime_ledger_source_authority_evidence"][
            "runtime_ledger_bucket_count"
        ]
        == 0
    )
    assert AUTHORITY_EVIDENCE_MISSING_BLOCKER in report["blockers"]
    assert (
        report["truths"]["final_500_day_profitability_proof"]["authority_proof_passed"]
        is False
    )


def test_aggregate_only_buckets_are_not_authority() -> None:
    report = _report(_fixture(source_backed=False))
    source_authority = report["truths"]["runtime_ledger_source_authority_evidence"]

    assert source_authority["aggregate_only_buckets_count_as_authority"] is False
    assert source_authority["aggregate_only_bucket_count"] == 20
    assert census.AGGREGATE_ONLY_RUNTIME_LEDGER_BLOCKER in source_authority["blockers"]
    assert (
        report["truths"]["final_500_day_profitability_proof"]["authority_proof_passed"]
        is False
    )


def test_source_backed_rows_with_fills_and_costs_produce_evidence_fields() -> None:
    report = _report(_fixture())

    assert (
        report["truths"]["routeability_submission_evidence"][
            "source_backed_decisions_present"
        ]
        is True
    )
    assert (
        report["truths"]["routeability_submission_evidence"]["fill_lifecycle_present"]
        is True
    )
    assert report["aggregate_summary"]["trading_days"] == 20
    assert report["aggregate_summary"]["mean_daily_net_pnl_after_costs"] == "600"
    assert report["aggregate_summary"]["source_window_ids_count"] == 20
    assert report["aggregate_summary"]["execution_order_event_ids_count"] == 20
    assert report["aggregate_summary"]["execution_ids_count"] == 20
    assert report["aggregate_summary"]["trade_decision_ids_count"] == 20
    assert (
        report["aggregate_summary"]["explicit_cost_coverage"]["coverage_ratio"] == "1"
    )
    assert (
        report["truths"]["final_500_day_profitability_proof"]["authority_proof_passed"]
        is True
    )
    assert report["profitability_claimed"] is False


def test_open_positions_block_final_proof() -> None:
    report = _report(_fixture(open_positions=1))

    final_proof = report["truths"]["final_500_day_profitability_proof"]
    assert final_proof["authority_proof_passed"] is False
    assert final_proof["open_position_count"] == 1
    assert AUTHORITY_OPEN_POSITIONS_BLOCKER in final_proof["blockers"]


def test_insufficient_days_profit_and_notional_block_final_proof() -> None:
    report = _report(_fixture(days=2, net_pnl="100", filled_notional="1000"))

    final_blockers = report["truths"]["final_500_day_profitability_proof"]["blockers"]
    assert AUTHORITY_TRADING_DAYS_BLOCKER in final_blockers
    assert AUTHORITY_MEAN_PNL_BLOCKER in final_blockers
    assert AUTHORITY_FILLED_NOTIONAL_BLOCKER in final_blockers


def test_json_output_is_stable(tmp_path: Path) -> None:
    fixture_path = tmp_path / "fixture.json"
    status_path = tmp_path / "status.json"
    fixture_path.write_text(json.dumps(_fixture(days=2), sort_keys=True))
    status_path.write_text(json.dumps(_status(), sort_keys=True))

    output_path = tmp_path / "out.json"
    exit_code = census.main(
        [
            "--fixture-json",
            str(fixture_path),
            "--status-fixture-json",
            str(status_path),
            "--output-json",
            str(output_path),
        ]
    )

    assert exit_code == 0
    first = output_path.read_text()
    second = census.stable_json(json.loads(first))
    assert first == second
    loaded = json.loads(first)
    assert loaded["schema_version"] == census.SCHEMA_VERSION
    assert list(loaded["truths"].keys()) == [
        "final_500_day_profitability_proof",
        "merged_configured_candidate",
        "routeability_submission_evidence",
        "runtime_ledger_source_authority_evidence",
    ]
