from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.audit_hpairs_source_proof_census.support import *


def test_load_session_rows_keeps_target_only_when_no_canonical_refs() -> None:
    identity = census.CensusIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
        source_account_label="PA3SX7FYNUTF",
    )
    session = _FakeReadSession(
        decision_pairs=[],
        scalar_results=[[], [], [], []],
    )

    with patch(
        "scripts.audit_hpairs_source_proof_census.load_runtime_authority_rows",
        return_value=[],
    ):
        rows = census._load_session_rows(
            session, identity=identity, started_at=None, ended_at=None
        )

    assert rows.execution_order_events == []
    assert rows.order_feed_source_windows == []


def test_load_session_rows_adds_linked_source_account_windows() -> None:
    identity = census.CensusIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
        source_account_label="PA3SX7FYNUTF",
    )
    decision = SimpleNamespace(
        id="decision-1",
        strategy_id="strategy-1",
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        symbol="AAPL",
        status="executed",
        decision_hash="decision-1",
        created_at=datetime(2026, 5, 1, 14, tzinfo=timezone.utc),
        executed_at=None,
    )
    execution = SimpleNamespace(
        id="execution-1",
        trade_decision_id="decision-1",
        alpaca_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        alpaca_order_id="alpaca-order-1",
        client_order_id="client-order-1",
        symbol="AAPL",
        side="buy",
        status="filled",
        filled_qty="1",
        avg_fill_price="100",
        created_at=datetime(2026, 5, 1, 15, tzinfo=timezone.utc),
        updated_at=datetime(2026, 5, 1, 15, tzinfo=timezone.utc),
        order_feed_last_event_ts=datetime(2026, 5, 1, 15, tzinfo=timezone.utc),
    )
    event = SimpleNamespace(
        id="event-1",
        source_topic="alpaca.trade_updates",
        source_partition=0,
        source_offset=42,
        alpaca_account_label="PA3SX7FYNUTF",
        symbol="AAPL",
        event_type="fill",
        event_ts=datetime(2026, 5, 1, 15, tzinfo=timezone.utc),
        status="filled",
        trade_decision_id="decision-1",
        execution_id="execution-1",
        alpaca_order_id="alpaca-order-1",
        client_order_id="client-order-1",
        source_window_id="window-1",
        filled_qty="1",
        filled_qty_delta="1",
        avg_fill_price="100",
        filled_notional_delta="100",
        raw_event=None,
        created_at=datetime(2026, 5, 1, 15, tzinfo=timezone.utc),
    )
    session = _FakeReadSession(
        decision_pairs=[
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
        ],
        scalar_results=[[execution], [event], [], []],
    )

    with patch(
        "scripts.audit_hpairs_source_proof_census.load_runtime_authority_rows",
        return_value=[],
    ):
        rows = census._load_session_rows(
            session, identity=identity, started_at=None, ended_at=None
        )

    assert rows.execution_order_events[0]["alpaca_account_label"] == "PA3SX7FYNUTF"


def test_source_account_matching_helpers_cover_alias_and_mismatch_paths() -> None:
    identity = census.CensusIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
        source_account_label="PA3SX7FYNUTF",
    )

    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "OTHER"},
            identity=identity,
            source_account_label="PA3SX7FYNUTF",
            target_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            canonical_decision_ids={"decision-1"},
            canonical_execution_ids={"execution-1"},
            canonical_order_ids=set(),
            canonical_client_order_ids=set(),
        )
        is False
    )
    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "decision_id": "decision-1"},
            identity=identity,
            source_account_label="PA3SX7FYNUTF",
            target_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            canonical_decision_ids={"decision-1"},
            canonical_execution_ids=set(),
            canonical_order_ids=set(),
            canonical_client_order_ids=set(),
        )
        is True
    )
    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "execution_id": "execution-1"},
            identity=identity,
            source_account_label="PA3SX7FYNUTF",
            target_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            canonical_decision_ids=set(),
            canonical_execution_ids={"execution-1"},
            canonical_order_ids=set(),
            canonical_client_order_ids=set(),
        )
        is True
    )
    assert (
        census._source_window_row_matches_identity(
            {"alpaca_account_label": "OTHER"},
            identity=identity,
            source_account_label="PA3SX7FYNUTF",
            target_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            canonical_source_window_ids={"window-1"},
        )
        is False
    )
    assert (
        census._source_window_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "source_window_id": "window-1"},
            identity=identity,
            source_account_label="PA3SX7FYNUTF",
            target_account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
            canonical_source_window_ids={"window-1"},
        )
        is True
    )
    assert census._text_values("decision-1") == {"decision-1"}
    assert census._row_aliases_target_account(
        {"canonical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL},
        DEFAULT_HPAIRS_ACCOUNT_LABEL,
    )
    assert census._row_aliases_target_account(
        {"payload": {"logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL}},
        DEFAULT_HPAIRS_ACCOUNT_LABEL,
    )
    assert census._row_aliases_target_account(
        {"aliases": [{"account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL}]},
        DEFAULT_HPAIRS_ACCOUNT_LABEL,
    )
    assert census._value_mentions_text(
        DEFAULT_HPAIRS_ACCOUNT_LABEL, DEFAULT_HPAIRS_ACCOUNT_LABEL
    )
    assert census._value_mentions_text(
        [DEFAULT_HPAIRS_ACCOUNT_LABEL], DEFAULT_HPAIRS_ACCOUNT_LABEL
    )
    assert census._value_mentions_text(
        {"account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL},
        DEFAULT_HPAIRS_ACCOUNT_LABEL,
    )
    assert not census._value_mentions_text("OTHER", DEFAULT_HPAIRS_ACCOUNT_LABEL)


def test_full_source_backed_census_is_authority_candidate_ready() -> None:
    report = _report(_fixture())

    assert report["verdict"]["classification"] == census.AUTHORITY_CANDIDATE_READY
    assert report["blockers"] == []
    assert report["totals"]["trade_decision_count"] == 20
    assert report["totals"]["matched_trade_decision_count"] == 20
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
    assert (
        report["totals"]["execution_order_events_with_source_window_and_offset_count"]
        == 20
    )
    assert report["totals"]["tca_cost_row_count"] == 20
    assert report["totals"]["execution_tca_metric_count"] == 20
    assert report["totals"]["source_window_count"] == 20
    assert report["totals"]["runtime_ledger_bucket_count"] == 20
    assert report["totals"]["blocker_free_runtime_ledger_bucket_count"] == 20
    assert report["totals"]["runtime_ledger_evidence_grade_bucket_count"] == 20
    assert report["totals"]["runtime_ledger_aggregate_only_bucket_count"] == 0
    assert report["totals"]["runtime_submitted_order_count"] == 400
    assert report["totals"]["runtime_ledger_source_materialization_count"] == 20
    assert report["totals"]["runtime_ledger_clean_authority_trading_day_count"] == 20
    assert report["totals"]["closed_trade_count"] == 400
    assert report["totals"]["open_position_count"] == 0
    assert report["totals"]["filled_notional"] == "12000000"
    assert report["totals"]["explicit_cost_required_bucket_count"] == 20
    assert report["totals"]["explicit_cost_coverage_complete"] is True
    assert report["totals"]["target_implied_notional_gap"] == "0"
    assert report["totals"]["post_cost_pnl"] == "12000"
    assert report["source"]["runtime_stage"] == "paper"
    assert report["candidate_config_match"]["matches"] is True
    assert report["candidate_config_match"]["mismatch_count"] == 0
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
        "candidate_config_match",
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


def test_source_account_rows_linked_to_logical_account_count_as_source_proof() -> None:
    payload = _fixture()
    for row in payload["execution_order_events"]:
        assert isinstance(row, dict)
        row["alpaca_account_label"] = "PA3SX7FYNUTF"
    for row in payload["order_feed_source_windows"]:
        assert isinstance(row, dict)
        row["alpaca_account_label"] = "PA3SX7FYNUTF"

    report = _report(payload, source_account_label="PA3SX7FYNUTF")

    assert report["identity"]["account_label"] == DEFAULT_HPAIRS_ACCOUNT_LABEL
    assert report["identity"]["source_account_label"] == "PA3SX7FYNUTF"
    assert report["candidate_config_match"]["matches"] is True
    assert report["candidate_config_match"]["mismatch_count"] == 0
    assert report["totals"]["execution_order_event_count"] == 20
    assert report["totals"]["source_window_count"] == 20
    assert report["totals"]["execution_order_events_with_source_window_count"] == 20
    assert report["verdict"]["classification"] == census.AUTHORITY_CANDIDATE_READY


def test_source_account_rows_linked_by_order_ids_count_as_source_proof() -> None:
    payload = _fixture()
    for event in payload["execution_order_events"]:
        assert isinstance(event, dict)
        day = str(event["id"]).removeprefix("event-")
        event["alpaca_account_label"] = "PA3SX7FYNUTF"
        event["alpaca_order_id"] = f"alpaca-order-{day}"
        event["client_order_id"] = f"client-order-{day}"
        event.pop("execution_id")
        event.pop("trade_decision_id")
    for execution in payload["executions"]:
        assert isinstance(execution, dict)
        day = str(execution["id"]).removeprefix("execution-")
        execution["alpaca_order_id"] = f"alpaca-order-{day}"
        execution["client_order_id"] = f"client-order-{day}"
    for window in payload["order_feed_source_windows"]:
        assert isinstance(window, dict)
        window["alpaca_account_label"] = "PA3SX7FYNUTF"

    report = _report(payload, source_account_label="PA3SX7FYNUTF")

    assert report["candidate_config_match"]["matches"] is True
    assert report["totals"]["execution_order_event_count"] == 20
    assert (
        report["totals"]["execution_order_events_with_direct_execution_ref_count"] == 0
    )
    assert (
        report["totals"]["execution_order_events_with_direct_trade_decision_ref_count"]
        == 0
    )
    assert report["totals"]["execution_order_events_with_broker_order_link_count"] == 20
    assert report["totals"]["execution_order_events_with_client_order_link_count"] == 20
    assert report["totals"]["execution_order_events_with_execution_ref_count"] == 20
    assert (
        report["totals"]["execution_order_events_with_trade_decision_ref_count"] == 20
    )
    assert report["verdict"]["classification"] == census.AUTHORITY_CANDIDATE_READY
    assert (
        census.SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER not in report["blockers"]
    )
    assert (
        census.SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER not in report["blockers"]
    )


def test_source_account_mismatched_refs_with_alias_remain_source_ref_blockers() -> None:
    payload = _fixture()
    for event in payload["execution_order_events"]:
        assert isinstance(event, dict)
        event["alpaca_account_label"] = "PA3SX7FYNUTF"
        event["trade_decision_id"] = "decision-other"
        event["execution_id"] = "execution-other"
        event["raw_event"] = {
            "_torghut_account_label_alias": {
                "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                "source_account_label": "PA3SX7FYNUTF",
            }
        }
    for window in payload["order_feed_source_windows"]:
        assert isinstance(window, dict)
        window["alpaca_account_label"] = "PA3SX7FYNUTF"

    report = _report(payload, source_account_label="PA3SX7FYNUTF")

    assert report["totals"]["execution_order_event_count"] == 0
    assert report["candidate_config_match"]["matches"] is False
    assert (
        report["candidate_config_match"][
            "source_account_canonical_ref_mismatch_order_event_count"
        ]
        == 20
    )
    assert census.SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER in report["blockers"]
    assert report["missing_source_ref_categories"][
        census.SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER
    ]
    assert report["verdict"]["classification"] == census.SOURCE_REFS_MISSING


def test_alias_only_source_account_scope_is_not_promotion_grade_proof() -> None:
    payload = _fixture()
    for event in payload["execution_order_events"]:
        assert isinstance(event, dict)
        event["alpaca_account_label"] = "PA3SX7FYNUTF"
        event.pop("trade_decision_id")
        event.pop("execution_id")
        event.pop("alpaca_order_id", None)
        event.pop("client_order_id", None)
        event["raw_event"] = {
            "aliases": [{"logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL}]
        }
    for window in payload["order_feed_source_windows"]:
        assert isinstance(window, dict)
        window["alpaca_account_label"] = "PA3SX7FYNUTF"

    report = _report(payload, source_account_label="PA3SX7FYNUTF")

    assert report["source"]["writes_proof"] is False
    assert report["source"]["synthetic_proof_created"] is False
    assert report["totals"]["execution_order_event_count"] == 0
    assert (
        report["candidate_config_match"]["source_account_alias_only_order_event_count"]
        == 20
    )
    assert census.SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER in report["blockers"]
    assert report["verdict"]["authority_candidate_ready"] is False
    assert report["verdict"]["classification"] == census.SOURCE_REFS_MISSING
    assert "promotion_allowed" not in report
    assert "final_promotion_allowed" not in report
    assert report["runtime_authority"].get("promotion_allowed") is None


def test_unrelated_source_account_rows_remain_mismatches_not_proof() -> None:
    payload = _fixture()
    for row in payload["execution_order_events"]:
        assert isinstance(row, dict)
        row["alpaca_account_label"] = "PA3SX7FYNUTF"
    for row in payload["order_feed_source_windows"]:
        assert isinstance(row, dict)
        row["alpaca_account_label"] = "PA3SX7FYNUTF"
    events = payload["execution_order_events"]
    windows = payload["order_feed_source_windows"]
    assert isinstance(events, list)
    assert isinstance(windows, list)
    events.append(
        {
            "id": "event-unrelated-pa",
            "execution_id": "execution-unrelated-pa",
            "trade_decision_id": "decision-unrelated-pa",
            "source_window_id": "window-unrelated-pa",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "source_offset": 9999,
            "alpaca_account_label": "PA3SX7FYNUTF",
            "event_type": "fill",
            "status": "filled",
            "filled_qty_delta": "10",
            "avg_fill_price": "100",
            "filled_notional_delta": "1000",
            "raw_event": {
                "_torghut_account_label_alias": {
                    "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                    "source_account_label": "PA3SX7FYNUTF",
                }
            },
            "event_ts": _iso(0, 16),
        }
    )
    windows.append(
        {
            "id": "window-unrelated-pa",
            "alpaca_account_label": "PA3SX7FYNUTF",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "window_started_at": _iso(0, 16),
            "window_ended_at": _iso(0, 17),
            "start_offset": 9999,
            "end_offset": 10000,
            "status": "complete",
            "raw_event": {
                "_torghut_account_label_alias": {
                    "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
                    "source_account_label": "PA3SX7FYNUTF",
                }
            },
        }
    )

    report = _report(payload, source_account_label="PA3SX7FYNUTF")

    assert report["totals"]["execution_order_event_count"] == 20
    assert report["totals"]["source_window_count"] == 20
    assert report["candidate_config_match"]["matches"] is False
    assert report["candidate_config_match"]["execution_order_event_mismatch_count"] == 1
    assert (
        report["candidate_config_match"]["order_feed_source_window_mismatch_count"] == 1
    )
    assert census.CANDIDATE_CONFIG_MISMATCH_BLOCKER in report["blockers"]
    assert census.SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER in report["blockers"]
    assert report["verdict"]["classification"] == census.SOURCE_REFS_MISSING


def test_source_account_scope_requires_matching_refs_before_alias_fallback() -> None:
    identity = census.CensusIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
        source_account_label="PA3SX7FYNUTF",
    )
    common = {
        "identity": identity,
        "source_account_label": "PA3SX7FYNUTF",
        "target_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
        "canonical_decision_ids": {"decision-0"},
        "canonical_execution_ids": {"execution-0"},
        "canonical_order_ids": {"order-0"},
        "canonical_client_order_ids": {"client-order-0"},
    }

    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "other-account"}, **common
        )
        is False
    )
    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "trade_decision_id": "decision-0"},
            **common,
        )
        is True
    )
    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "decision_id": "decision-0"},
            **common,
        )
        is True
    )
    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "execution_id": "execution-0"},
            **common,
        )
        is True
    )
    assert (
        census._source_event_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "alpaca_order_id": "order-0"},
            **common,
        )
        is True
    )
    assert (
        census._source_event_row_matches_identity(
            {
                "alpaca_account_label": "PA3SX7FYNUTF",
                "client_order_id": "client-order-0",
            },
            **common,
        )
        is True
    )
    assert (
        census._source_event_row_matches_identity(
            {
                "alpaca_account_label": "PA3SX7FYNUTF",
                "trade_decision_id": "decision-other",
                "raw_event": {
                    "_torghut_account_label_alias": {
                        "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL
                    }
                },
            },
            **common,
        )
        is False
    )
    assert (
        census._source_event_row_matches_identity(
            {
                "alpaca_account_label": "PA3SX7FYNUTF",
                "alpaca_order_id": "order-other",
                "raw_event": {
                    "_torghut_account_label_alias": {
                        "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL
                    }
                },
            },
            **common,
        )
        is False
    )
    assert (
        census._source_event_row_matches_identity(
            {
                "alpaca_account_label": "PA3SX7FYNUTF",
                "raw_event": {
                    "nested": {
                        "canonical": {"account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL}
                    }
                },
            },
            **common,
        )
        is False
    )

    window_common = {
        "identity": identity,
        "source_account_label": "PA3SX7FYNUTF",
        "target_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL,
        "canonical_source_window_ids": {"window-0"},
    }
    assert (
        census._source_window_row_matches_identity(
            {"alpaca_account_label": "other-account"}, **window_common
        )
        is False
    )
    assert (
        census._source_window_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "id": "window-0"},
            **window_common,
        )
        is True
    )
    assert (
        census._source_window_row_matches_identity(
            {"alpaca_account_label": "PA3SX7FYNUTF", "source_window_id": "window-0"},
            **window_common,
        )
        is True
    )
    assert (
        census._source_window_row_matches_identity(
            {
                "alpaca_account_label": "PA3SX7FYNUTF",
                "id": "window-other",
                "raw_event": {
                    "_torghut_account_label_alias": {
                        "logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL
                    }
                },
            },
            **window_common,
        )
        is False
    )
    assert (
        census._source_window_row_matches_identity(
            {
                "alpaca_account_label": "PA3SX7FYNUTF",
                "raw_event": {
                    "aliases": [{"logical_account_label": DEFAULT_HPAIRS_ACCOUNT_LABEL}]
                },
            },
            **window_common,
        )
        is False
    )
    assert census._text_values("decision-0") == {"decision-0"}
    assert (
        census._row_aliases_target_account(
            {"items": [{"materialized": {"account": DEFAULT_HPAIRS_ACCOUNT_LABEL}}]},
            DEFAULT_HPAIRS_ACCOUNT_LABEL,
        )
        is True
    )


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
