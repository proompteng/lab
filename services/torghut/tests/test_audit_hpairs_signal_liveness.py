from __future__ import annotations

import json
from pathlib import Path

from scripts import audit_hpairs_signal_liveness as audit


def _base_fixture() -> dict[str, object]:
    return {
        "target": {
            "hypothesis_id": audit.DEFAULT_HPAIRS_HYPOTHESIS_ID,
            "candidate_id": audit.DEFAULT_HPAIRS_CANDIDATE_ID,
            "account_label": audit.DEFAULT_HPAIRS_ACCOUNT_LABEL,
            "observed_stage": audit.DEFAULT_OBSERVED_STAGE,
            "runtime_strategy_name": audit.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            "symbols": ["AAPL", "AMZN"],
            "route_enabled": True,
            "bounded_evidence_collection_authorized": True,
        },
        "features": {
            "symbols": {
                "AAPL": {
                    "ready": True,
                    "age_seconds": 12,
                    "timestamp": "2026-06-01T14:31:00Z",
                },
                "AMZN": {
                    "ready": True,
                    "age_seconds": 10,
                    "timestamp": "2026-06-01T14:31:00Z",
                },
            },
        },
        "quotes": {
            "symbols": {
                "AAPL": {"bid": 201.01, "ask": 201.03, "age_seconds": 3},
                "AMZN": {"bid": 190.01, "ask": 190.05, "age_seconds": 4},
            },
        },
        "signal": {"score": 1.25, "threshold": 1.0, "direction": "pair_convergence"},
        "risk": {"vetoes": []},
        "route": {"route_eligible": True},
        "status": {"simple_submit_enabled": True},
    }


def _run_fixture(tmp_path: Path, fixture: dict[str, object]) -> dict[str, object]:
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps(fixture, sort_keys=True))

    exit_code = audit.main(["--fixture-json", str(path)])

    assert exit_code == 0
    return audit.build_liveness_report(
        fixture,
        audit.AuditExpectations(
            hypothesis_id=audit.DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=audit.DEFAULT_HPAIRS_CANDIDATE_ID,
            account_label=audit.DEFAULT_HPAIRS_ACCOUNT_LABEL,
            observed_stage=audit.DEFAULT_OBSERVED_STAGE,
            runtime_strategy=audit.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            max_quote_age_seconds=90.0,
            max_feature_age_seconds=180.0,
            max_signal_lag_seconds=90.0,
        ),
    )


def test_wrong_account_fixture_classifies_wrong_account(tmp_path: Path) -> None:
    fixture = _base_fixture()
    target = fixture["target"]
    assert isinstance(target, dict)
    target["account_label"] = "ALPACA_PAPER"

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "wrong_account"
    assert "account_label_mismatch" in report["blocker_codes"]
    assert (
        report["account_stage_runtime_strategy"]["expected_account_label"]
        == "TORGHUT_SIM"
    )


def test_missing_quotes_and_features_fixture_classifies_no_market_data(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    fixture["features"] = {"symbols": {"AAPL": {"ready": True, "age_seconds": 12}}}
    fixture["quotes"] = {
        "symbols": {"AAPL": {"bid": 201.01, "ask": 201.03, "age_seconds": 3}}
    }

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "no_market_data"
    assert "latest_features_not_ready" in report["blocker_codes"]
    assert "latest_quotes_not_ready" in report["blocker_codes"]
    assert report["latest_feature_availability"]["missing_symbols"] == ["AMZN"]
    assert report["latest_quote_availability"]["missing_symbols"] == ["AMZN"]


def test_threshold_miss_fixture_classifies_signal_below_threshold(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    fixture["signal"] = {"score": 0.25, "threshold": 1.0}

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "signal_below_threshold"
    assert "signal_below_threshold" in report["blocker_codes"]
    assert report["signal_threshold_status"]["passes"] is False


def test_risk_veto_fixture_classifies_risk_veto(tmp_path: Path) -> None:
    fixture = _base_fixture()
    fixture["risk"] = {"vetoes": ["max_position_notional_exceeded"]}

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "risk_veto"
    assert "risk_veto" in report["blocker_codes"]
    assert report["entry_exit_vetoes"]["risk_vetoes"] == [
        "max_position_notional_exceeded"
    ]


def test_route_disabled_fixture_classifies_route_disabled(tmp_path: Path) -> None:
    fixture = _base_fixture()
    fixture["route"] = {"route_eligible": False, "blockers": ["paper_route_closed"]}

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "route_disabled"
    assert "route_disabled" in report["blocker_codes"]
    assert "paper_route_closed" in report["blocker_codes"]
    assert report["route_eligibility_flags"]["disabled_flags"] == ["route_eligible"]


def test_collection_disabled_fixture_classifies_evidence_collection_disabled(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    target = fixture["target"]
    assert isinstance(target, dict)
    target["bounded_evidence_collection_authorized"] = False

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "evidence_collection_disabled"
    assert "evidence_collection_disabled" in report["blocker_codes"]
    assert report["evidence_collection_flags"]["disabled_flags"] == [
        "bounded_evidence_collection_authorized"
    ]


def test_zero_runtime_materialization_classifies_materialize_runtime_buckets(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    fixture["observed"] = {
        "hpairs_decisions": 0,
        "hpairs_order_events": 0,
        "hpairs_runtime_buckets": 0,
        "recent_window": "2026-06-01T14:00:00Z/PT30M",
    }

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "materialize_runtime_buckets"
    assert "runtime_materialization_missing" in report["blocker_codes"]
    assert report["runtime_materialization_status"]["zero_fields"] == [
        "decision_count",
        "order_event_count",
        "runtime_bucket_count",
    ]
    assert report["ready_to_submit_sim_order"] is False


def test_missing_drift_checks_fixture_classifies_materialize_drift_checks(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    fixture["status"] = {
        "simple_submit_enabled": True,
        "market_session_open": True,
        "signal_lag_seconds": 14,
        "drift_detection_checks_total": 0,
    }

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "materialize_drift_checks"
    assert "drift_checks_missing" in report["blocker_codes"]
    assert report["signal_drift_readiness"]["drift_checks_present"] is False
    assert report["ready_to_submit_sim_order"] is False


def test_stale_signal_lag_fixture_classifies_wait_for_fresh_signal_window(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    fixture["status"] = {
        "simple_submit_enabled": True,
        "market_session_open": True,
        "signal_lag_seconds": 9_958,
        "drift_detection_checks_total": 3,
    }

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "wait_for_fresh_signal_window"
    assert "signal_lag_exceeded" in report["blocker_codes"]
    assert report["signal_drift_readiness"]["fresh_signal_window"] is False
    assert report["ready_to_submit_sim_order"] is False


def test_closed_market_fixture_classifies_wait_for_market_session_open(
    tmp_path: Path,
) -> None:
    fixture = _base_fixture()
    fixture["status"] = {
        "simple_submit_enabled": True,
        "market_session_open": False,
        "signal_lag_seconds": 14,
        "drift_detection_checks_total": 3,
    }

    report = _run_fixture(tmp_path, fixture)

    assert report["next_action"] == "wait_for_market_session_open"
    assert "market_session_closed" in report["blocker_codes"]
    assert report["signal_drift_readiness"]["ready"] is False
    assert report["ready_to_submit_sim_order"] is False


def test_ready_fixture_classifies_ready_to_submit_sim_order(
    tmp_path: Path, capsys: object
) -> None:
    fixture = _base_fixture()
    fixture["status"] = {
        "simple_submit_enabled": True,
        "market_session_open": True,
        "signal_lag_seconds": 14,
        "drift_detection_checks_total": 3,
    }
    path = tmp_path / "ready.json"
    path.write_text(json.dumps(fixture, sort_keys=True))

    exit_code = audit.main(["--fixture-json", str(path), "--fail-on-blockers"])
    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert exit_code == 0
    assert payload["next_action"] == "ready_to_submit_sim_order"
    assert payload["blocker_codes"] == []
    assert payload["ready_to_submit_sim_order"] is True
    assert "H-PAIRS liveness READY" in captured.err


def _expectations() -> audit.AuditExpectations:
    return audit.AuditExpectations(
        hypothesis_id=audit.DEFAULT_HPAIRS_HYPOTHESIS_ID,
        candidate_id=audit.DEFAULT_HPAIRS_CANDIDATE_ID,
        account_label=audit.DEFAULT_HPAIRS_ACCOUNT_LABEL,
        observed_stage=audit.DEFAULT_OBSERVED_STAGE,
        runtime_strategy=audit.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        max_quote_age_seconds=90.0,
        max_feature_age_seconds=180.0,
        max_signal_lag_seconds=90.0,
    )


def test_no_target_empty_fixture_reports_no_target_and_missing_inputs() -> None:
    report = audit.build_liveness_report({}, _expectations())

    assert report["next_action"] == "no_target"
    assert {
        "target_missing",
        "latest_features_missing",
        "latest_quotes_missing",
    }.issubset(set(report["blocker_codes"]))
    assert report["unsupported_reasons"] == ["score", "threshold"]


def test_target_list_nested_status_and_vetoes_are_diagnosed() -> None:
    fixture = _base_fixture()
    target = fixture.pop("target")
    assert isinstance(target, dict)
    target["symbols"] = {"aapl": {}, "amzn": {}}
    target["observed_stage"] = "live"
    target["runtime_strategy_name"] = "other-strategy"
    target["entry_vetoes"] = ["entry_closed"]
    fixture["targets"] = [{"candidate_id": "other"}, target]
    fixture["status"] = {
        "live_submission_gate": {
            "simple_lane": {
                "submit_enabled": "disabled",
                "blocked_reasons": ["simple_submit_disabled"],
            },
        },
    }

    report = audit.build_liveness_report(fixture, _expectations())

    assert report["next_action"] == "wrong_account"
    assert "observed_stage_mismatch" in report["blocker_codes"]
    assert "runtime_strategy_mismatch" in report["blocker_codes"]
    assert "entry_veto_present" in report["blocker_codes"]
    assert "simple_submit_disabled" in report["blocker_codes"]
    assert report["simple_submit_flag_state"]["disabled_flags"] == ["submit_enabled"]
    assert report["symbol_universe"]["symbols"] == ["AAPL", "AMZN"]


def test_latest_and_by_symbol_market_data_shapes_cover_stale_and_invalid_quotes() -> (
    None
):
    fixture = _base_fixture()
    fixture["features"] = {
        "latest": {
            "timestamp": "2026-06-01T14:32:00Z",
            "symbols": {
                "AAPL": {"ready": "yes", "staleness_seconds": "181"},
                "AMZN": {"ready": "yes", "staleness_seconds": "1"},
            },
        },
    }
    fixture["quotes"] = {
        "by_symbol": {
            "aapl": {"bid_price": "202", "ask_price": "201", "age_seconds": "1"},
            "amzn": {
                "bid_price": "190",
                "ask_price": "191",
                "age_seconds": "not-a-number",
            },
        },
    }

    report = audit.build_liveness_report(fixture, _expectations())

    assert report["next_action"] == "no_market_data"
    assert report["latest_feature_availability"]["stale_symbols"] == ["AAPL"]
    assert report["latest_quote_availability"]["not_ready_symbols"] == ["AAPL"]
    assert "latest_features_not_ready" in report["blocker_codes"]
    assert "latest_quotes_not_ready" in report["blocker_codes"]


def test_symbol_fallback_from_features_and_unsupported_symbol_universe() -> None:
    fixture = {
        "target": {
            "hypothesis_id": audit.DEFAULT_HPAIRS_HYPOTHESIS_ID,
            "candidate_id": audit.DEFAULT_HPAIRS_CANDIDATE_ID,
            "account_label": audit.DEFAULT_HPAIRS_ACCOUNT_LABEL,
            "observed_stage": audit.DEFAULT_OBSERVED_STAGE,
            "runtime_strategy_name": audit.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            "route_enabled": True,
        },
        "features": {"symbols": {"MSFT": {"ready": True}}},
        "quotes": {"symbols": {"MSFT": {"bid": 1, "ask": 2}}},
        "signal": {"passes_threshold": True},
        "status": {"simple_submit_enabled": True},
    }

    report = audit.build_liveness_report(fixture, _expectations())

    assert report["symbol_universe"]["symbols"] == ["MSFT"]
    assert report["next_action"] == "ready_to_submit_sim_order"

    fixture["features"] = {}
    fixture["quotes"] = {}
    report_without_symbols = audit.build_liveness_report(fixture, _expectations())
    assert report_without_symbols["next_action"] == "no_market_data"
    assert (
        "unsupported_symbol_universe_inputs" in report_without_symbols["blocker_codes"]
    )


def test_paper_route_probe_symbols_drive_market_data_liveness() -> None:
    fixture = _base_fixture()
    target = fixture["target"]
    assert isinstance(target, dict)
    target.pop("symbols")
    target["paper_route_probe_symbols"] = ["amzn", "aapl"]

    report = audit.build_liveness_report(fixture, _expectations())

    assert report["symbol_universe"]["symbols"] == ["AAPL", "AMZN"]
    assert report["next_action"] == "ready_to_submit_sim_order"


def test_helper_normalizers_cover_non_fixture_shapes(tmp_path: Path) -> None:
    assert audit._text(123) == "123"
    assert audit._bool_or_none("enabled") is True
    assert audit._bool_or_none("disabled") is False
    assert audit._bool_or_none(1) is True
    assert audit._float_or_none("") is None
    assert audit._float_or_none("bad") is None
    assert audit._unique_text_items({"a": 1, "b": 2}) == ["a", "b"]
    assert audit._unique_text_items(7) == ["7"]
    assert audit._unique_text_items(["x", "x", None]) == ["x"]
    assert audit.stable_json({"value": object()}).endswith("\n")

    non_object = tmp_path / "array.json"
    non_object.write_text("[]")
    try:
        audit._read_json_path(non_object)
    except ValueError as exc:
        assert "must contain a JSON object" in str(exc)
    else:  # pragma: no cover - defensive assertion branch
        raise AssertionError("expected non-object JSON to fail")


def test_cli_inputs_support_overrides_status_url_errors_and_fail_on_blockers(
    tmp_path: Path, monkeypatch: object
) -> None:
    base_path = tmp_path / "base.json"
    target_path = tmp_path / "target.json"
    bad_path = tmp_path / "bad.json"
    base_path.write_text(json.dumps(_base_fixture()))
    target_path.write_text(json.dumps({"account_label": "ALPACA_PAPER"}))
    bad_path.write_text("[]")

    class _FakeResponse:
        def __enter__(self) -> _FakeResponse:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b'{"simple_lane":{"submit_enabled":false}}'

    def _fake_urlopen(_request: object, timeout: float) -> _FakeResponse:
        assert timeout == 0.25
        return _FakeResponse()

    monkeypatch.setattr(audit.urllib.request, "urlopen", _fake_urlopen)
    args = audit.parse_args(
        [
            "--fixture-json",
            str(base_path),
            "--target-json",
            str(target_path),
            "--status-url",
            "http://127.0.0.1/status",
            "--http-timeout-seconds",
            "0.25",
        ]
    )
    merged = audit._load_cli_source(args)
    assert merged["target"] == {"account_label": "ALPACA_PAPER"}
    assert merged["status"] == {"simple_lane": {"submit_enabled": False}}

    assert audit.main(["--fixture-json", str(bad_path), "--fail-on-blockers"]) == 1
    assert audit.main(["--fixture-json", str(base_path), "--fail-on-blockers"]) == 0
