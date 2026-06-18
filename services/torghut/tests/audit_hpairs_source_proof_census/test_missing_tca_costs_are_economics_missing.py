from __future__ import annotations

from types import TracebackType
from typing import cast

import pytest

from tests.audit_hpairs_source_proof_census.support import (
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
    Path,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    SimpleNamespace,
    _fixture,
    _ladder_step,
    _ledger_bucket,
    _report,
    _source_payload,
    census,
    datetime,
    json,
    timedelta,
    timezone,
)


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
    assert report["totals"]["runtime_ledger_aggregate_only_bucket_count"] == 20
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


def test_json_output_is_stable_and_cli_reads_fixture(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
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


def test_candidate_config_mismatch_is_first_ladder_blocker() -> None:
    payload = _fixture()
    payload["runtime_ledger_buckets"][0]["candidate_id"] = "other-candidate"
    payload["trade_decisions"][0]["strategy_name"] = "other-strategy"

    report = _report(payload)

    assert report["candidate_config_match"]["matches"] is False
    assert report["totals"]["candidate_config_mismatch_count"] == 2
    assert census.CANDIDATE_CONFIG_MISMATCH_BLOCKER in report["blockers"]
    next_blocker = report["verdict"]["next_blocker"]
    assert isinstance(next_blocker, dict)
    assert next_blocker["step"] == "candidate_config_match"


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


def test_session_loader_normalizes_bounded_sqlalchemy_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
        alpaca_account_label="PA3SX7FYNUTF",
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
        raw_event={
            "_torghut_account_label_alias": {
                "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "source_account_label": "PA3SX7FYNUTF",
            }
        },
        execution_id=None,
        trade_decision_id=None,
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
        alpaca_account_label="PA3SX7FYNUTF",
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
        def mappings(self) -> "ExecuteResult":
            return self

        def all(self) -> list[dict[str, object]]:
            return [
                {
                    "id": decision.id,
                    "strategy_id": decision.strategy_id,
                    "strategy_name": DEFAULT_HPAIRS_RUNTIME_STRATEGY,
                    "alpaca_account_label": decision.alpaca_account_label,
                    "symbol": decision.symbol,
                    "status": decision.status,
                    "decision_hash": decision.decision_hash,
                    "created_at": decision.created_at,
                    "executed_at": decision.executed_at,
                }
            ]

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
            assert "decision_json" not in str(statement)
            return ExecuteResult()

        def scalars(self, statement: object) -> ScalarResult:
            assert statement is not None
            return ScalarResult(self.scalar_results.pop(0))

    monkeypatch.setattr(
        census, "load_runtime_authority_rows", lambda *args, **kwargs: [ledger_bucket]
    )

    rows = census._load_session_rows(
        cast(census.Session, FakeSession()),
        identity=census.CensusIdentity(
            hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            observed_stage="paper",
            source_account_label="PA3SX7FYNUTF",
        ),
        started_at=start,
        ended_at=end,
    )

    assert rows.trade_decisions[0]["id"] == "decision-0"
    assert rows.executions[0]["id"] == "execution-0"
    assert rows.execution_order_events[0]["alpaca_account_label"] == "PA3SX7FYNUTF"
    assert rows.execution_order_events[0]["execution_id"] is None
    assert rows.execution_order_events[0]["trade_decision_id"] is None
    assert rows.execution_order_events[0]["source_offset"] == 11
    assert rows.execution_tca_metrics[0]["id"] == "tca-0"
    assert rows.order_feed_source_windows[0]["alpaca_account_label"] == "PA3SX7FYNUTF"
    assert rows.order_feed_source_windows[0]["id"] == "window-0"
    assert rows.runtime_ledger_buckets[0]["id"] == "ledger-0"


def test_dsn_loader_opens_session_and_delegates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

        def __exit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            traceback: TracebackType | None,
        ) -> None:
            return None

    monkeypatch.setattr(census, "create_engine", lambda dsn, **kwargs: f"engine:{dsn}")
    monkeypatch.setattr(census, "sessionmaker", lambda bind: lambda: FakeSession())
    monkeypatch.setattr(census, "_load_session_rows", lambda *args, **kwargs: expected)

    rows = census.load_dsn_rows(
        "sqlite:///:memory:", identity=identity, started_at=None, ended_at=None
    )

    assert rows is expected


def test_dsn_loader_sqlalchemy_dsn_uses_installed_psycopg_driver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity = census.CensusIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
    )
    captured: dict[str, object] = {}

    class FakeSession:
        def __enter__(self) -> "FakeSession":
            return self

        def __exit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            traceback: TracebackType | None,
        ) -> None:
            return None

    def fake_create_engine(dsn: str, **kwargs: object) -> str:
        captured["dsn"] = dsn
        captured["kwargs"] = kwargs
        return f"engine:{dsn}"

    monkeypatch.setattr(census, "create_engine", fake_create_engine)
    monkeypatch.setattr(census, "sessionmaker", lambda bind: lambda: FakeSession())
    monkeypatch.setattr(
        census, "_load_session_rows", lambda *args, **kwargs: census.CensusSourceRows()
    )

    census.load_dsn_rows(
        "postgresql://user:pass@postgres/torghut",
        identity=identity,
        started_at=None,
        ended_at=None,
    )

    assert captured["dsn"] == "postgresql+psycopg://user:pass@postgres/torghut"
    assert captured["kwargs"] == {"pool_pre_ping": True, "future": True}
    assert (
        census._sqlalchemy_dsn("postgres://user:pass@postgres/torghut")
        == "postgresql+psycopg://user:pass@postgres/torghut"
    )
    assert (
        census._sqlalchemy_dsn("postgresql+psycopg://user:pass@postgres/torghut")
        == "postgresql+psycopg://user:pass@postgres/torghut"
    )
    assert (
        census._sqlalchemy_dsn("sqlite+pysqlite:///:memory:")
        == "sqlite+pysqlite:///:memory:"
    )


def test_main_reports_read_errors_as_json(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
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
