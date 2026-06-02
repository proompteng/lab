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


def test_status_payload_loader_fail_closed_cases(
    tmp_path: Path, monkeypatch: object
) -> None:
    non_object = tmp_path / "status-list.json"
    non_object.write_text("[]")
    payload, source, error = census.load_status_payload(
        status_fixture_json=non_object,
        status_service_url=None,
        timeout_seconds=0.1,
    )
    assert payload == {}
    assert source == f"fixture_json:{non_object}"
    assert error == "status_fixture_json_not_object"

    payload, source, error = census.load_status_payload(
        status_fixture_json=None,
        status_service_url=None,
        timeout_seconds=0.1,
    )
    assert payload == {}
    assert source is None
    assert error is None

    class _FailingUrlopen:
        def __call__(self, *_args: object, **_kwargs: object) -> object:
            raise OSError("offline")

    monkeypatch.setattr(census.urllib.request, "urlopen", _FailingUrlopen())
    payload, source, error = census.load_status_payload(
        status_fixture_json=None,
        status_service_url="https://status.invalid/hpairs",
        timeout_seconds=0.1,
    )
    assert payload == {}
    assert source == "https://status.invalid/hpairs"
    assert error == "offline"


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def test_status_url_non_object_payload_blocks(monkeypatch: object) -> None:
    monkeypatch.setattr(
        census.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _FakeResponse(b"[]"),
    )

    payload, source, error = census.load_status_payload(
        status_fixture_json=None,
        status_service_url="https://status.invalid/hpairs",
        timeout_seconds=0.1,
    )

    assert payload == {}
    assert source == "https://status.invalid/hpairs"
    assert error == "status_service_payload_not_object"


def test_configuration_route_and_target_blocker_branches() -> None:
    identity = census.RuntimeEvidenceIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
    )
    totals = {
        "trade_decision_count": 0,
        "execution_count": 0,
        "execution_order_event_count": 0,
        "runtime_ledger_bucket_count": 0,
        "runtime_submitted_order_count": 0,
        "fill_lifecycle_event_count": 0,
    }

    no_status = census._configured_candidate_truth(
        {},
        totals=totals,
        identity=identity,
        status_source=None,
        status_read_error="timeout",
    )
    assert census.STATUS_SERVICE_NOT_PROVIDED_BLOCKER in no_status["blockers"]
    assert census.STATUS_SERVICE_READ_ERROR_BLOCKER in no_status["blockers"]

    missing_target = census._configured_candidate_truth(
        {"unrelated": True},
        totals=totals,
        identity=identity,
        status_source="fixture_json:status.json",
        status_read_error=None,
    )
    assert census.CONFIGURED_CANDIDATE_MISSING_BLOCKER in missing_target["blockers"]

    mismatch = census._configured_candidate_truth(
        {"target": {"candidate_id": "other-candidate"}},
        totals=totals,
        identity=identity,
        status_source="fixture_json:status.json",
        status_read_error=None,
    )
    assert census.CONFIGURED_CANDIDATE_MISMATCH_BLOCKER in mismatch["blockers"]

    route = census._routeability_truth(
        {"route": {"route_enabled": False}, "status": {"simple_submit_enabled": "yes"}},
        totals=totals,
        blockers=[census.SUBMITTED_ORDERS_MISSING_BLOCKER],
        identifier_counts={
            "trade_decision_ids_count": 0,
            "execution_ids_count": 0,
            "execution_order_event_ids_count": 0,
            "source_window_ids_count": 0,
        },
    )
    assert "routeability_flags_disabled" in route["blockers"]
    assert route["route_flags"] == {
        "route_enabled": False,
        "simple_submit_enabled": True,
    }


def test_target_sequence_matching_and_mismatch_branches() -> None:
    identity = census.RuntimeEvidenceIdentity(
        hypothesis_id=DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=DEFAULT_HPAIRS_CANDIDATE_ID,
        runtime_strategy_name=DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        account_label=DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage="paper",
    )

    first_match = census._target_from_status(
        {
            "targets": [
                {"candidate_id": "wrong"},
                {"hypothesis_id": DEFAULT_HPAIRS_HYPOTHESIS_ID},
            ]
        },
        identity,
    )
    assert first_match == {"hypothesis_id": DEFAULT_HPAIRS_HYPOTHESIS_ID}

    fallback_first = census._target_from_status(
        {"targets": [{"candidate_id": "wrong"}]}, identity
    )
    assert fallback_first == {"candidate_id": "wrong"}
    assert census._target_from_status({"targets": []}, identity) == {}

    assert census._target_matches({"candidate_id": "wrong"}, identity) is False
    assert census._target_matches({"hypothesis_id": "wrong"}, identity) is False
    assert census._target_matches({"account_label": "ALPACA_PAPER"}, identity) is False
    assert census._target_matches({"runtime_strategy_name": "other"}, identity) is False


def test_low_level_json_and_parse_helpers_cover_fail_closed_branches() -> None:
    aware = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)
    naive = datetime(2026, 6, 2, 12, 0)

    assert census._parse_cli_timestamp(None) is None
    assert census._parse_cli_timestamp("2026-06-02T12:00:00Z") == aware
    try:
        census._parse_cli_timestamp("not-a-timestamp")
    except ValueError as exc:
        assert "invalid timestamp" in str(exc)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("invalid timestamp should raise")

    assert census._parse_timestamp(aware) == aware
    assert census._parse_timestamp(None) is None
    assert census._parse_timestamp("bad") is None
    assert census._as_values({"a": 1}) == [1]
    assert census._as_values(None) == []
    assert census._text(None, default="missing") == "missing"
    assert census._int("nan") == 0
    assert census._decimal("nan") == census.Decimal("0")
    assert census._bool_or_none("enabled") is True
    assert census._bool_or_none("disabled") is False
    assert census._bool_or_none(1) is True
    assert census._utc(naive).tzinfo is timezone.utc
    assert census._isoformat(aware) == "2026-06-02T12:00:00Z"
    assert census._json_default(census.Decimal("1.20")) == "1.2"
    assert census._json_default(aware) == "2026-06-02T12:00:00Z"
    assert census._json_default(Path("x")) == "x"


def test_identifier_counts_include_forward_compatible_runtime_payload_values() -> None:
    rows = source_census.CensusSourceRows()
    counts = census._identifier_counts(
        rows,
        {
            "trading_days": [
                {
                    "source_window_id_count": 1,
                    "execution_order_event_ref_count": 1,
                    "execution_ref_count": 1,
                    "trade_decision_ref_count": 1,
                }
            ],
            "runtime_ledger_buckets": [
                {
                    "payload": {
                        "source_window_ids": ["window-a", "window-b"],
                        "execution_order_event_ids": ["event-a"],
                        "execution_ids": ["execution-a"],
                        "trade_decision_ids": ["decision-a"],
                    }
                }
            ],
        },
    )

    assert counts == {
        "source_window_ids_count": 2,
        "execution_order_event_ids_count": 1,
        "execution_ids_count": 1,
        "trade_decision_ids_count": 1,
    }


def test_main_stdout_dsn_default_and_read_error_paths(
    monkeypatch: object, capsys: object
) -> None:
    fixture_rows = _rows(_fixture(days=1, include_buckets=False))

    monkeypatch.setattr(
        census.source_census, "load_fixture_rows", lambda _path: fixture_rows
    )
    assert census.main(["--fixture-json", "fixture.json"]) == 0
    stdout = capsys.readouterr().out
    assert "torghut.hpairs-runtime-live-paper-evidence-census.v1" in stdout

    calls: list[str] = []

    def _fake_load_dsn_rows(
        *_args: object, **_kwargs: object
    ) -> source_census.CensusSourceRows:
        calls.append("dsn")
        return fixture_rows

    def _fake_load_default_session_rows(
        *_args: object, **_kwargs: object
    ) -> source_census.CensusSourceRows:
        calls.append("default")
        return fixture_rows

    monkeypatch.setattr(census, "load_dsn_rows", _fake_load_dsn_rows)
    monkeypatch.setattr(
        census, "load_default_session_rows", _fake_load_default_session_rows
    )
    assert census.main(["--dsn", "sqlite:///:memory:"]) == 0
    assert census.main([]) == 0
    assert calls == ["dsn", "default"]

    def _raise_load_dsn_rows(
        *_args: object, **_kwargs: object
    ) -> source_census.CensusSourceRows:
        raise ValueError("missing table")

    monkeypatch.setattr(census, "load_dsn_rows", _raise_load_dsn_rows)
    assert census.main(["--dsn", "sqlite:///:memory:"]) == 0
    assert "missing table" in capsys.readouterr().out
