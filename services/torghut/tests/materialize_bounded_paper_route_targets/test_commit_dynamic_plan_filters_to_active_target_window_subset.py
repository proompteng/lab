from __future__ import annotations

from tests.materialize_bounded_paper_route_targets.support import (
    Any,
    Path,
    _CapturingConnection,
    _FakeResponse,
    _RaisingConnection,
    _count_decisions,
    _hpairs_target,
    _plan,
    _run_cli,
    _write_plan,
    cli,
    json,
    pytest,
)


def test_commit_dynamic_plan_filters_to_active_target_window_subset(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    future_target = _hpairs_target(
        candidate_id="future-window-candidate",
        source_plan_ref="paper-route-plan:future-window-candidate",
        window_start="2026-06-01T15:00:00+00:00",
        window_end="2026-06-01T16:00:00+00:00",
    )
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(
                _hpairs_target(),
                future_target,
            )
        },
    }
    monkeypatch.setattr(cli, "_fetch_plan_url_payload", lambda *_, **__: payload)

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "25",
            "--commit",
            "--allow-dynamic-target-plan",
            "--skip-unless-active-target-window",
            "--now-utc",
            "2026-06-01T14:00:00+00:00",
            "--confirm-account-label",
            "TORGHUT_SIM",
            "--confirm-dsn-env",
            "DB_DSN",
            "--confirm-hypothesis-id",
            "H-PAIRS-01",
            "--confirm-runtime-strategy-name",
            "microbar-cross-sectional-pairs-v1",
            "--confirm-selected-plan-source",
            cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "25",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["materialized"] is True
    assert report["skipped"] is False
    assert report["source_target_count"] == 2
    assert report["target_count"] == 1
    assert report["active_target_window_filter_applied"] is True
    assert report["target_window_check"]["active"] is False
    assert report["target_window_check"]["active_count"] == 1
    assert report["target_window_check"]["inactive_count"] == 1
    assert report["candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
    assert report["source_targets"][1]["candidate_id"] == "future-window-candidate"
    assert report["materialized_decision_count"] == 2
    assert report["route_submission_count"] == 2
    assert report["promotion_allowed"] is False
    assert report["final_promotion_allowed"] is False
    assert report["capital_promotion_allowed"] is False
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_commit_dynamic_plan_requires_active_target_window_without_skip(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(_hpairs_target())
        },
    }
    monkeypatch.setattr(cli, "_fetch_plan_url_payload", lambda *_, **__: payload)

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "25",
            "--commit",
            "--allow-dynamic-target-plan",
            "--require-active-target-window",
            "--now-utc",
            "2026-06-01T13:00:00+00:00",
            "--confirm-account-label",
            "TORGHUT_SIM",
            "--confirm-dsn-env",
            "DB_DSN",
            "--confirm-hypothesis-id",
            "H-PAIRS-01",
            "--confirm-runtime-strategy-name",
            "microbar-cross-sectional-pairs-v1",
            "--confirm-selected-plan-source",
            cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "25",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 2
    assert cli.ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER in report["blockers"]
    assert report["skipped"] is False
    assert report["materialized"] is False
    assert report["target_window_check"]["active"] is False
    assert _count_decisions(sqlite_dsn) == 0


def test_commit_dynamic_confirmation_rejects_wrong_selected_plan_source(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(_hpairs_target())
        },
    }
    monkeypatch.setattr(cli, "_fetch_plan_url_payload", lambda *_, **__: payload)

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "25",
            "--commit",
            "--allow-dynamic-target-plan",
            "--confirm-account-label",
            "TORGHUT_SIM",
            "--confirm-dsn-env",
            "DB_DSN",
            "--confirm-hypothesis-id",
            "H-PAIRS-01",
            "--confirm-runtime-strategy-name",
            "microbar-cross-sectional-pairs-v1",
            "--confirm-selected-plan-source",
            "payload",
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "25",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 2
    assert (
        "paper_route_materialization_commit_confirm_selected_plan_source_missing"
        in report["blockers"]
    )
    assert report["materialized"] is False
    assert _count_decisions(sqlite_dsn) == 0


def test_paper_route_target_plan_missing_dsn_live_capital_mode_and_empty_plan_are_blockers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("DB_DSN", raising=False)
    plan_path = _write_plan(tmp_path, _plan())

    exit_code, payload = _run_cli(
        [
            "--plan-json",
            str(plan_path),
            "--max-notional",
            "25",
            "--capital-mode",
            "live",
        ],
        capsys,
    )

    assert exit_code == 2
    blockers = set(payload["blockers"])
    assert "paper_route_materialization_database_dsn_env_missing" in blockers
    assert "paper_route_materialization_non_live_capital_mode_required" in blockers
    assert "paper_route_materialization_target_plan_targets_missing" in blockers


def test_paper_route_target_plan_rejects_exceeded_notional_and_missing_actions(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(
        tmp_path,
        _plan(
            _hpairs_target(
                paper_route_probe_symbol_actions={},
                paper_route_probe_symbol_quantities={},
                target_quantity="",
                target_notional="50",
            )
        ),
    )

    exit_code, payload = _run_cli(
        ["--plan-json", str(plan_path), "--max-notional", "25"],
        capsys,
    )

    assert exit_code == 2
    blockers = set(payload["blockers"])
    assert (
        "paper_route_materialization_target_0_target_notional_exceeds_max" in blockers
    )
    assert "paper_route_materialization_target_0_symbol_actions_missing" in blockers
    assert _count_decisions(sqlite_dsn) == 0


def test_paper_route_target_plan_writes_json_output_file_for_safe_dry_run(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(tmp_path, _plan(_hpairs_target()))
    output_path = tmp_path / "reports" / "materialization.json"

    exit_code, payload = _run_cli(
        [
            "--plan-json",
            str(plan_path),
            "--max-notional",
            "25",
            "--output",
            str(output_path),
        ],
        capsys,
    )

    written = json.loads(output_path.read_text(encoding="utf-8"))
    assert exit_code == 0
    assert written["schema_version"] == cli.SCHEMA_VERSION
    assert written["dry_run"] is True
    assert written == payload
    assert _count_decisions(sqlite_dsn) == 0


def test_paper_route_target_plan_url_load_failure_is_reported_without_materialization(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code, payload = _run_cli(
        [
            "--plan-url",
            "file:///tmp/target-plan.json",
            "--max-notional",
            "25",
        ],
        capsys,
    )

    assert exit_code == 2
    assert (
        "paper_route_materialization_plan_load_failed:paper_route_target_plan_invalid_scheme:file"
        in payload["blockers"]
    )
    assert payload["plan_source"] == {"kind": "unavailable"}


def test_plan_url_fetch_rejects_missing_host() -> None:
    payload = cli._fetch_plan_url_payload_once("http://", timeout_seconds=1)

    assert payload == {"load_error": "paper_route_target_plan_invalid_host"}


def test_plan_url_fetch_requests_json_path_query_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _CapturingConnection.instances = []
    _CapturingConnection.response = _FakeResponse(
        200,
        json.dumps({"targets": [_hpairs_target()]}).encode("utf-8"),
    )
    monkeypatch.setattr(cli, "HTTPConnection", _CapturingConnection)

    payload = cli._fetch_plan_url_payload_once(
        "http://torghut-sim.torghut.svc.cluster.local:8080/trading/paper-route-target-plan?target_limit=1",
        timeout_seconds=0,
    )

    assert payload["targets"][0]["hypothesis_id"] == "H-PAIRS-01"
    assert len(_CapturingConnection.instances) == 1
    connection = _CapturingConnection.instances[0]
    assert connection.host == "torghut-sim.torghut.svc.cluster.local"
    assert connection.port == 8080
    assert connection.timeout == 0.1
    assert connection.method == "GET"
    assert connection.path == "/trading/paper-route-target-plan?target_limit=1"
    assert connection.headers == {
        "Accept": "application/json",
        "Connection": "close",
        "Host": "torghut-sim.torghut.svc.cluster.local:8080",
    }
    assert connection.closed is True


@pytest.mark.parametrize(
    ("status", "body", "expected_error"),
    [
        (503, b"temporarily unavailable", "paper_route_target_plan_http_status:503"),
        (200, b"not-json", "paper_route_target_plan_invalid_json:"),
        (200, b'["not", "an", "object"]', "paper_route_target_plan_invalid_payload"),
    ],
)
def test_plan_url_fetch_reports_status_json_and_payload_errors(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    body: bytes,
    expected_error: str,
) -> None:
    _CapturingConnection.instances = []
    _CapturingConnection.response = _FakeResponse(status, body)
    monkeypatch.setattr(cli, "HTTPConnection", _CapturingConnection)

    payload = cli._fetch_plan_url_payload_once(
        "http://torghut-sim.torghut.svc.cluster.local/plan",
        timeout_seconds=1,
    )

    error = str(payload["load_error"])
    assert error.startswith(expected_error)
    assert _CapturingConnection.instances[0].closed is True


def test_plan_url_fetch_reports_oversized_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _CapturingConnection.instances = []
    _CapturingConnection.response = _FakeResponse(200, b"abcdef")
    monkeypatch.setattr(cli, "HTTPConnection", _CapturingConnection)
    monkeypatch.setattr(cli, "TARGET_PLAN_RESPONSE_LIMIT_BYTES", 5)

    payload = cli._fetch_plan_url_payload_once(
        "http://torghut-sim.torghut.svc.cluster.local/plan",
        timeout_seconds=1,
    )

    assert payload == {"load_error": "paper_route_target_plan_response_too_large"}
    assert _CapturingConnection.instances[0].closed is True


def test_plan_url_fetch_reports_request_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _RaisingConnection.instances = []
    monkeypatch.setattr(cli, "HTTPConnection", _RaisingConnection)

    payload = cli._fetch_plan_url_payload_once(
        "http://torghut-sim.torghut.svc.cluster.local/plan",
        timeout_seconds=1,
    )

    assert str(payload["load_error"]).startswith(
        "paper_route_target_plan_fetch_failed:network down"
    )
    assert _RaisingConnection.instances[0].closed is True


def test_plan_url_fetch_retries_and_records_attempt_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    sleeps: list[float] = []

    def fake_fetch_once(url: str, *, timeout_seconds: float) -> dict[str, Any]:
        nonlocal attempts
        attempts += 1
        assert url == "http://torghut-sim.torghut.svc.cluster.local/plan"
        assert timeout_seconds == 3
        if attempts == 1:
            return {"load_error": "temporary"}
        return {"targets": [_hpairs_target()]}

    monkeypatch.setattr(cli, "_fetch_plan_url_payload_once", fake_fetch_once)
    monkeypatch.setattr(cli.time, "sleep", lambda seconds: sleeps.append(seconds))

    payload = cli._fetch_plan_url_payload(
        "http://torghut-sim.torghut.svc.cluster.local/plan",
        timeout_seconds=3,
        attempts=2,
        retry_backoff_seconds=0.01,
    )

    assert payload["fetch_attempts"] == 2
    assert payload["targets"][0]["hypothesis_id"] == "H-PAIRS-01"
    assert sleeps == [0.01]


def test_plan_url_fetch_records_failed_attempt_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        cli,
        "_fetch_plan_url_payload_once",
        lambda *_, **__: {"load_error": "still-down"},
    )
    monkeypatch.setattr(cli.time, "sleep", lambda _: None)

    payload = cli._fetch_plan_url_payload(
        "http://torghut-sim.torghut.svc.cluster.local/plan",
        timeout_seconds=3,
        attempts=2,
        retry_backoff_seconds=0,
    )

    assert payload == {
        "load_error": "still-down",
        "fetch_attempts": 2,
    }


def test_plan_url_payload_without_materializable_plan_is_reported(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        cli, "_fetch_plan_url_payload", lambda *_, **__: {"targets": []}
    )

    exit_code, payload = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--max-notional",
            "25",
        ],
        capsys,
    )

    assert exit_code == 2
    assert (
        "paper_route_materialization_plan_load_failed:paper_route_target_plan_missing"
        in payload["blockers"]
    )
    assert payload["plan_source"] == {"kind": "unavailable"}


def test_paper_route_target_plan_database_open_failure_is_reported(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(tmp_path, _plan(_hpairs_target()))
    monkeypatch.setenv(
        "DB_DSN",
        f"sqlite+pysqlite:///{tmp_path / 'missing' / 'torghut.sqlite3'}",
    )

    exit_code, payload = _run_cli(
        ["--plan-json", str(plan_path), "--max-notional", "25"],
        capsys,
    )

    assert exit_code == 2
    assert any(
        blocker.startswith("paper_route_materialization_database_failed:")
        for blocker in payload["blockers"]
    )
