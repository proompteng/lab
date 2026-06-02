from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.trading.runtime_authority_verifier import (
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
)
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
)
from scripts import audit_hpairs_source_proof_census as census


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
    day_index: int, *, source_backed: bool = True, open_positions: int = 0
) -> dict[str, object]:
    start = _iso(day_index, 14)
    return {
        "id": f"ledger-{day_index}",
        "run_id": "hpairs-runtime-run",
        "candidate_id": DEFAULT_HPAIRS_CANDIDATE_ID,
        "hypothesis_id": DEFAULT_HPAIRS_HYPOTHESIS_ID,
        "observed_stage": "paper",
        "bucket_started_at": start,
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
        "closed_trade_count": 20,
        "open_position_count": open_positions,
        "filled_notional": "600000",
        "gross_strategy_pnl": "610",
        "cost_amount": "10",
        "net_strategy_pnl_after_costs": "600",
        "post_cost_expectancy_bps": "10",
        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "pnl_basis": POST_COST_PNL_BASIS,
        "execution_policy_hash_counts": {"policy-hash": 1},
        "cost_model_hash_counts": {"cost-hash": 1},
        "lineage_hash_counts": {"lineage-hash": 1},
        "blockers": [],
        "payload": _source_payload(day_index) if source_backed else {},
    }


def _fixture(*, days: int = 20, source_backed: bool = True) -> dict[str, object]:
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
            _ledger_bucket(day, source_backed=source_backed) for day in range(days)
        ],
    }


def _report(payload: dict[str, object]) -> dict[str, object]:
    rows = census.CensusSourceRows(
        trade_decisions=census._row_list(payload.get("trade_decisions")),
        executions=census._row_list(payload.get("executions")),
        execution_order_events=census._row_list(payload.get("execution_order_events")),
        execution_tca_metrics=census._row_list(payload.get("execution_tca_metrics")),
        order_feed_source_windows=census._row_list(
            payload.get("order_feed_source_windows")
        ),
        runtime_ledger_buckets=census._row_list(payload.get("runtime_ledger_buckets")),
    )
    return census.build_source_proof_census(
        rows,
        identity=census.CensusIdentity(
            hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            observed_stage="paper",
        ),
    )


def _ladder_step(report: dict[str, object], step: str) -> dict[str, object]:
    ladder = report["blocker_ladder"]
    assert isinstance(ladder, list)
    for item in ladder:
        assert isinstance(item, dict)
        if item["step"] == step:
            return item
    raise AssertionError(f"missing ladder step {step}")


def test_full_source_backed_census_is_authority_candidate_ready() -> None:
    report = _report(_fixture())

    assert report["verdict"]["classification"] == census.AUTHORITY_CANDIDATE_READY
    assert report["blockers"] == []
    assert report["totals"]["trade_decision_count"] == 20
    assert report["totals"]["execution_count"] == 20
    assert report["totals"]["filled_execution_count"] == 20
    assert report["totals"]["execution_order_event_count"] == 20
    assert report["totals"]["fill_lifecycle_event_count"] == 20
    assert report["totals"]["linked_order_event_fill_count"] == 20
    assert report["totals"]["execution_order_events_with_execution_ref_count"] == 20
    assert (
        report["totals"]["execution_order_events_with_filled_notional_delta_count"]
        == 20
    )
    assert report["totals"]["tca_cost_row_count"] == 20
    assert report["totals"]["source_window_count"] == 20
    assert report["totals"]["runtime_ledger_bucket_count"] == 20
    assert report["totals"]["blocker_free_runtime_ledger_bucket_count"] == 20
    assert report["totals"]["runtime_submitted_order_count"] == 400
    assert report["totals"]["runtime_ledger_source_materialization_count"] == 20
    assert report["totals"]["runtime_ledger_clean_authority_trading_day_count"] == 20
    assert report["totals"]["closed_trade_count"] == 400
    assert report["totals"]["filled_notional"] == "12000000"
    assert report["totals"]["target_implied_notional_gap"] == "0"
    assert report["totals"]["post_cost_pnl"] == "12000"
    assert report["source"]["runtime_stage"] == "paper"
    assert report["source"]["replay_outputs_count_as_runtime_proof"] is False
    assert report["source"]["synthetic_proof_created"] is False
    assert report["verdict"]["next_blocker"] is None
    assert (
        _ladder_step(report, "source_windows_refs_offsets_present")["status"]
        == census.LADDER_PASS
    )
    assert (
        _ladder_step(report, "runtime_ledger_source_materialization_present")["status"]
        == census.LADDER_PASS
    )
    assert (
        _ladder_step(
            report, "twenty_authority_grade_trading_days_daily_post_cost_distribution"
        )["status"]
        == census.LADDER_PASS
    )
    assert [item["step"] for item in report["blocker_ladder"]] == [
        "decisions_present",
        "submitted_orders_present",
        "fill_lifecycle_present",
        "linked_executions_present",
        "source_windows_refs_offsets_present",
        "runtime_ledger_source_materialization_present",
        "closed_round_trips_present",
        "explicit_costs_present",
        "filled_notional_present_and_target_implied",
        "flat_no_open_positions_after_grace",
        "twenty_authority_grade_trading_days_daily_post_cost_distribution",
    ]


def test_missing_submitted_orders_and_fills_are_machine_readable_blockers() -> None:
    payload = _fixture()
    payload["executions"] = []
    payload["execution_order_events"] = []
    for bucket in payload["runtime_ledger_buckets"]:
        bucket["submitted_order_count"] = 0
        bucket["fill_count"] = 0
        bucket["payload"]["execution_ids"] = []
        bucket["payload"]["execution_order_event_ids"] = []

    report = _report(payload)

    assert report["verdict"]["classification"] == census.LIFECYCLE_MISSING
    assert census.SUBMITTED_ORDERS_MISSING_BLOCKER in report["blockers"]
    assert AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER in report["blockers"]
    assert (
        _ladder_step(report, "submitted_orders_present")["status"]
        == census.LADDER_BLOCKED
    )
    assert (
        _ladder_step(report, "fill_lifecycle_present")["status"]
        == census.LADDER_BLOCKED
    )


def test_missing_decisions_reports_exact_trade_decision_ref_gap() -> None:
    payload = _fixture()
    payload["trade_decisions"] = []
    for bucket in payload["runtime_ledger_buckets"]:
        bucket["decision_count"] = 0
        bucket["payload"]["trade_decision_ids"] = []

    report = _report(payload)

    assert report["verdict"]["classification"] == census.LIFECYCLE_MISSING
    assert AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER in report["blockers"]
    assert RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER in report["blockers"]
    assert (
        report["missing_source_ref_categories"][
            RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER
        ]
        is True
    )


def test_missing_executions_reports_fill_and_execution_ref_gap() -> None:
    payload = _fixture()
    payload["executions"] = []
    for bucket in payload["runtime_ledger_buckets"]:
        bucket["fill_count"] = 0
        bucket["payload"]["execution_ids"] = []

    report = _report(payload)

    assert report["verdict"]["classification"] == census.LIFECYCLE_MISSING
    assert AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER in report["blockers"]
    assert census.RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER in report["blockers"]


def test_missing_order_event_refs_and_source_offsets_are_exact_source_ref_gaps() -> (
    None
):
    payload = _fixture()
    for event in payload["execution_order_events"]:
        event.pop("source_offset")
        event.pop("source_window_id")
        event.pop("filled_notional_delta")
    for bucket in payload["runtime_ledger_buckets"]:
        bucket["payload"]["execution_order_event_ids"] = []
        bucket["payload"]["source_offsets"] = []
        bucket["payload"]["source_window_ids"] = []

    report = _report(payload)

    assert report["verdict"]["classification"] == census.SOURCE_REFS_MISSING
    assert (
        RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER in report["blockers"]
    )
    assert RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER in report["blockers"]
    assert (
        report["missing_source_ref_categories"][
            RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER
        ]
        is True
    )


def test_order_events_missing_execution_and_decision_refs_are_exact_source_ref_gaps() -> (
    None
):
    payload = _fixture()
    for event in payload["execution_order_events"]:
        event.pop("execution_id")
        event.pop("trade_decision_id")

    report = _report(payload)

    assert report["verdict"]["classification"] == census.SOURCE_REFS_MISSING
    assert census.RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER in report["blockers"]
    assert RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER in report["blockers"]


def test_missing_tca_costs_are_economics_missing() -> None:
    payload = _fixture()
    payload["execution_tca_metrics"] = []
    for bucket in payload["runtime_ledger_buckets"]:
        bucket["cost_amount"] = "0"
        bucket["cost_model_hash_counts"] = {}
        bucket["payload"]["execution_economics_complete"] = False
        bucket["payload"]["cost_basis_counts"] = {}

    report = _report(payload)

    assert report["verdict"]["classification"] == census.ECONOMICS_MISSING
    assert AUTHORITY_EXPLICIT_COSTS_BLOCKER in report["blockers"]
    assert census.EXECUTION_ECONOMICS_MISSING_BLOCKER in report["blockers"]


def test_open_positions_are_called_out_after_source_and_economics_are_present() -> None:
    payload = _fixture()
    payload["runtime_ledger_buckets"][-1] = _ledger_bucket(19, open_positions=1)

    report = _report(payload)

    assert report["verdict"]["classification"] == census.OPEN_POSITIONS
    assert AUTHORITY_OPEN_POSITIONS_BLOCKER in report["blockers"]
    assert report["totals"]["open_position_count"] == 1


def test_runtime_bucket_aggregate_only_is_source_refs_missing() -> None:
    report = _report(_fixture(source_backed=False))

    assert report["verdict"]["classification"] == census.SOURCE_REFS_MISSING
    assert report["totals"]["blocker_free_runtime_ledger_bucket_count"] == 0
    assert report["totals"]["runtime_ledger_source_materialization_count"] == 0
    assert census.RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER in report["blockers"]
    assert (
        census.RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER
        in report["blockers"]
    )
    assert (
        _ladder_step(report, "runtime_ledger_source_materialization_present")["status"]
        == census.LADDER_BLOCKED
    )


def test_json_output_is_stable_and_cli_reads_fixture(tmp_path: Path, capsys) -> None:  # type: ignore[no-untyped-def]
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps(_fixture()))

    exit_code = census.main(["--fixture-json", str(path), "--fail-on-blockers"])
    first = capsys.readouterr().out
    report = json.loads(first)

    assert exit_code == 0
    assert first == census.census_json(report)
    assert list(report) == sorted(report)
    assert report["schema_version"] == census.SCHEMA_VERSION
    assert report["source"]["read_only"] is True
    assert report["source"]["writes_proof"] is False
    assert report["source"]["modifies_rows"] is False


def test_empty_fixture_has_no_source_activity_verdict() -> None:
    report = _report({})

    assert report["verdict"]["classification"] == census.NO_SOURCE_ACTIVITY
    assert report["totals"]["runtime_ledger_bucket_count"] == 0
    assert _ladder_step(report, "decisions_present")["status"] == census.LADDER_BLOCKED
    assert report["verdict"]["next_blocker"] == {
        "step": "decisions_present",
        "status": census.LADDER_BLOCKED,
        "blocker_codes": [
            AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
            RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
        ],
        "next_action": "run the strategy through paper/live routing until durable TradeDecision rows exist",
    }


def test_partial_evidence_ladder_points_at_order_feed_lifecycle() -> None:
    full = _fixture()
    payload = {
        "trade_decisions": full["trade_decisions"],
        "executions": full["executions"],
        "execution_order_events": [],
        "execution_tca_metrics": [],
        "order_feed_source_windows": [],
        "runtime_ledger_buckets": [],
    }

    report = _report(payload)

    assert _ladder_step(report, "decisions_present")["status"] == census.LADDER_PASS
    assert (
        _ladder_step(report, "submitted_orders_present")["status"]
        == census.LADDER_BLOCKED
    )
    assert (
        _ladder_step(report, "fill_lifecycle_present")["status"]
        == census.LADDER_BLOCKED
    )
    assert report["verdict"]["next_blocker"]["step"] == "submitted_orders_present"
    assert (
        census.ORDER_FEED_LIFECYCLE_MISSING_BLOCKER
        in report["verdict"]["next_blocker"]["blocker_codes"]
    )


def test_too_few_source_backed_days_are_distribution_missing() -> None:
    report = _report(_fixture(days=5))

    assert report["verdict"]["classification"] == census.AUTHORITY_DISTRIBUTION_MISSING
    assert census.AUTHORITY_TRADING_DAYS_BLOCKER in report["blockers"]


def test_session_loader_normalizes_bounded_sqlalchemy_rows(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from types import SimpleNamespace

    start = datetime(2026, 5, 1, 14, tzinfo=timezone.utc)
    end = start + timedelta(hours=7)
    decision = SimpleNamespace(
        id="decision-0",
        strategy_id="strategy-0",
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        symbol="AAA",
        status="executed",
        decision_hash="decision-hash",
        created_at=start,
        executed_at=start + timedelta(minutes=1),
    )
    execution = SimpleNamespace(
        id="execution-0",
        trade_decision_id="decision-0",
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        alpaca_order_id="order-0",
        client_order_id="decision-hash",
        symbol="AAA",
        side="buy",
        status="filled",
        filled_qty="10",
        avg_fill_price="100",
        created_at=start + timedelta(minutes=2),
        updated_at=start + timedelta(minutes=3),
        order_feed_last_event_ts=start + timedelta(minutes=3),
    )
    event = SimpleNamespace(
        id="event-0",
        source_topic="alpaca.trade_updates",
        source_partition=0,
        source_offset=11,
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        event_ts=start + timedelta(minutes=3),
        created_at=start + timedelta(minutes=3),
        symbol="AAA",
        alpaca_order_id="order-0",
        client_order_id="decision-hash",
        event_type="fill",
        status="filled",
        filled_qty="10",
        filled_qty_delta="10",
        avg_fill_price="100",
        filled_notional_delta="1000",
        execution_id="execution-0",
        trade_decision_id="decision-0",
        source_window_id="window-0",
    )
    tca = SimpleNamespace(
        id="tca-0",
        execution_id="execution-0",
        trade_decision_id="decision-0",
        strategy_id="strategy-0",
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        symbol="AAA",
        side="buy",
        filled_qty="10",
        shortfall_notional="1",
        realized_shortfall_bps="1",
        computed_at=start + timedelta(minutes=4),
    )
    source_window = SimpleNamespace(
        id="window-0",
        consumer_group="torghut-order-feed",
        source_topic="alpaca.trade_updates",
        source_partition=0,
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        window_started_at=start,
        window_ended_at=end,
        start_offset=10,
        end_offset=12,
        consumed_count=2,
        inserted_count=1,
        gap_count=0,
        status="complete",
    )
    ledger_bucket = SimpleNamespace(
        row_id="ledger-0",
        run_id="run-0",
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        observed_stage="paper",
        bucket_started_at=start,
        bucket_ended_at=end,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        strategy_family="pairs",
        fill_count=20,
        decision_count=20,
        submitted_order_count=20,
        cancelled_order_count=0,
        rejected_order_count=0,
        unfilled_order_count=0,
        closed_trade_count=20,
        open_position_count=0,
        filled_notional="600000",
        gross_strategy_pnl="610",
        cost_amount="10",
        net_strategy_pnl_after_costs="600",
        post_cost_expectancy_bps="10",
        ledger_schema_version=EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        pnl_basis=POST_COST_PNL_BASIS,
        execution_policy_hash_counts={"policy": 1},
        cost_model_hash_counts={"cost": 1},
        lineage_hash_counts={"lineage": 1},
        blockers=(),
        payload=_source_payload(0),
    )

    class ExecuteResult:
        def all(self) -> list[tuple[SimpleNamespace, str]]:
            return [(decision, DEFAULT_HPAIRS_RUNTIME_STRATEGY)]

    class ScalarResult:
        def __init__(self, rows: list[SimpleNamespace]) -> None:
            self.rows = rows

        def all(self) -> list[SimpleNamespace]:
            return self.rows

    class FakeSession:
        def __init__(self) -> None:
            self.scalar_results = [[execution], [event], [tca], [source_window]]

        def execute(self, statement: object) -> ExecuteResult:
            assert statement is not None
            return ExecuteResult()

        def scalars(self, statement: object) -> ScalarResult:
            assert statement is not None
            return ScalarResult(self.scalar_results.pop(0))

    monkeypatch.setattr(
        census, "load_runtime_authority_rows", lambda *args, **kwargs: [ledger_bucket]
    )

    rows = census._load_session_rows(
        FakeSession(),  # type: ignore[arg-type]
        identity=census.CensusIdentity(
            hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            observed_stage="paper",
        ),
        started_at=start,
        ended_at=end,
    )

    assert rows.trade_decisions[0]["id"] == "decision-0"
    assert rows.executions[0]["id"] == "execution-0"
    assert rows.execution_order_events[0]["source_offset"] == 11
    assert rows.execution_tca_metrics[0]["id"] == "tca-0"
    assert rows.order_feed_source_windows[0]["id"] == "window-0"
    assert rows.runtime_ledger_buckets[0]["id"] == "ledger-0"


def test_dsn_loader_opens_session_and_delegates(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    identity = census.CensusIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
    )
    expected = census.CensusSourceRows(trade_decisions=[{"id": "decision"}])

    class FakeSession:
        def __enter__(self) -> "FakeSession":
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:  # type: ignore[no-untyped-def]
            return None

    monkeypatch.setattr(census, "create_engine", lambda dsn: f"engine:{dsn}")
    monkeypatch.setattr(census, "sessionmaker", lambda bind: lambda: FakeSession())
    monkeypatch.setattr(census, "_load_session_rows", lambda *args, **kwargs: expected)

    rows = census.load_dsn_rows(
        "sqlite:///:memory:", identity=identity, started_at=None, ended_at=None
    )

    assert rows is expected


def test_main_reports_read_errors_as_json(tmp_path: Path, capsys) -> None:  # type: ignore[no-untyped-def]
    missing = tmp_path / "missing.json"

    exit_code = census.main(["--fixture-json", str(missing)])
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert "source_proof_census_read_error" in payload["blockers"]
    assert payload["verdict"]["classification"] == census.NO_SOURCE_ACTIVITY


def test_normalizers_fail_closed_on_invalid_shapes() -> None:
    assert census._row_list({"not": "a list"}) == []
    assert census._parse_cli_timestamp(None) is None
    assert census._parse_timestamp("not-a-timestamp") is None
    assert census._sequence("not-a-sequence") == ()
    assert census._mapping("not-a-mapping") == {}
    assert census._int("not-an-int") == 0
    assert census._decimal("not-a-decimal") == 0
    assert census._utc(datetime(2026, 5, 1)).tzinfo is timezone.utc

    try:
        census._parse_cli_timestamp("not-a-timestamp")
    except ValueError as exc:
        assert "invalid timestamp" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("invalid timestamp should fail")
