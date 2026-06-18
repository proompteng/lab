from __future__ import annotations

from tests.materialize_bounded_paper_route_targets.support import (
    HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION,
    _count_decisions,
    _hpairs_target,
    _plan,
    _run_cli,
    _tsmom_target,
    cli,
    pytest,
    target_materialization_core,
)


def test_commit_url_nested_plan_with_dynamic_confirmation_writes_targets(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "targets": [
            {
                "hypothesis_id": "H-TSMOM-LIQ-01",
                "candidate_id": "source-window-only",
                "runtime_strategy_name": "intraday-tsmom-profit-v3",
                "account_label": "TORGHUT_SIM",
                "source_manifest_ref": "config/trading/hypotheses/h-tsmom-liq-01.json",
                "observed_stage": "paper",
                "source_collection_authorized": True,
                "max_notional": "0",
            }
        ],
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(_hpairs_target())
        },
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

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
    assert report["mode"] == "commit"
    assert report["materialized"] is True
    assert report["skipped"] is False
    assert report["target_window_check"]["active"] is True
    assert report["dynamic_target_plan_confirmation"] is True
    assert (
        report["plan_source"]["selected_plan"]
        == cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE
    )
    assert report["candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
    assert report["target_plan_refs"] == ["paper-route-plan:c88421d619759b2cfaa6f4d0"]
    assert report["materialized_decision_count"] == 2
    assert report["route_submission_count"] == 2
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_commit_dynamic_plan_skips_before_active_target_window_without_writes(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(_hpairs_target())
        },
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

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

    assert exit_code == 0
    assert report["skipped"] is True
    assert report["skip_reason"] == cli.ACTIVE_TARGET_WINDOW_SKIP_REASON
    assert report["materialized"] is False
    assert report["blocked"] is False
    assert report["target_window_check"]["active"] is False
    assert report["target_window_check"]["inactive_count"] == 1
    assert report["materialized_decision_count"] == 0
    assert report["route_submission_count"] == 0
    assert _count_decisions(sqlite_dsn) == 0


def test_commit_dynamic_source_collection_plan_skips_without_target_window(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "runtime_strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                    "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                    "account_label": "TORGHUT_SIM",
                    "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "handoff": "runtime_ledger_source_collection_import",
                    "source_collection_authorized": True,
                    "target_notional": "0",
                    "target_quantity": "0",
                    "window_start": "",
                    "window_end": "",
                    "paper_route_probe_symbol_actions": {},
                    "paper_route_probe_symbol_quantities": {},
                    "bounded_evidence_collection_authorized": False,
                    "promotion_allowed": False,
                    "final_authority_ok": False,
                    "final_promotion_allowed": False,
                    "capital_promotion_allowed": False,
                }
            )
        }
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
            "--commit",
            "--allow-dynamic-target-plan",
            "--skip-unless-active-target-window",
            "--now-utc",
            "2026-06-03T19:00:00+00:00",
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
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["skipped"] is True
    assert report["skip_reason"] == cli.ACTIVE_TARGET_WINDOW_SKIP_REASON
    assert report["blocked"] is False
    assert report["materialized"] is False
    assert (
        report["plan_source"]["selected_plan"]
        == cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE
    )
    assert report["source_target_count"] == 1
    assert report["target_count"] == 0
    assert report["confirmed_dynamic_target_filter_applied"] is True
    assert report["target_window_check"]["target_count"] == 0
    assert report["source_targets"][0]["target_notional"] == "0"
    assert report["materialized_decision_count"] == 0
    assert report["route_submission_count"] == 0
    assert _count_decisions(sqlite_dsn) == 0


def test_commit_dynamic_plan_confirms_strategy_lookup_alias_before_skip(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(
                _hpairs_target(
                    runtime_strategy_name="69cf50e3-4815-47c2-b802-1efbaac09ecb",
                    strategy_name="69cf50e3-4815-47c2-b802-1efbaac09ecb",
                    strategy_lookup_names=[
                        "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                        "microbar-cross-sectional-pairs-v1",
                    ],
                    source_decision_readiness=None,
                )
            )
        },
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "25",
            "--commit",
            "--allow-dynamic-target-plan",
            "--skip-unless-active-target-window",
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

    assert exit_code == 0
    assert report["skipped"] is True
    assert report["skip_reason"] == cli.ACTIVE_TARGET_WINDOW_SKIP_REASON
    assert report["blocked"] is False
    assert report["source_target_count"] == 1
    assert report["target_count"] == 1
    assert report["runtime_strategy_names"] == ["69cf50e3-4815-47c2-b802-1efbaac09ecb"]
    assert (
        "microbar-cross-sectional-pairs-v1"
        in report["targets"][0]["runtime_strategy_confirmation_names"]
    )
    assert _count_decisions(sqlite_dsn) == 0


def test_commit_dynamic_next_window_plan_at_configured_notional_skips_before_open(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(
                target_notional="75000",
                paper_route_probe_symbol_quantities={},
                paper_route_execution_capacity_contract={
                    "schema_version": "torghut.paper-route-execution-capacity-contract.v1",
                    "state": "capacity_ready",
                    "target_notional": "75000",
                    "effective_collection_notional_cap": "75000",
                    "capacity_ratio_to_target": "1",
                    "blockers": [],
                },
            )
        ),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
            "--commit",
            "--allow-dynamic-target-plan",
            "--skip-unless-active-target-window",
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
            HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["skipped"] is True
    assert report["skip_reason"] == cli.ACTIVE_TARGET_WINDOW_SKIP_REASON
    assert report["blocked"] is False
    assert report["max_notional"] == "75000"
    assert (
        report["plan_source"]["selected_plan"]
        == "next_paper_route_runtime_window_targets"
    )
    assert report["targets"][0]["target_notional"] == "75000"
    assert report["target_window_check"]["active"] is False
    assert report["materialized_decision_count"] == 0
    assert report["route_submission_count"] == 0
    assert _count_decisions(sqlite_dsn) == 0


def test_commit_dynamic_next_window_plan_at_configured_notional_writes_when_open(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(
                target_notional="75000",
                paper_route_probe_symbol_quantities={},
                paper_route_execution_capacity_contract={
                    "schema_version": "torghut.paper-route-execution-capacity-contract.v1",
                    "state": "capacity_ready",
                    "target_notional": "75000",
                    "effective_collection_notional_cap": "75000",
                    "capacity_ratio_to_target": "1",
                    "blockers": [],
                },
            )
        ),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
            "--commit",
            "--allow-dynamic-target-plan",
            "--require-active-target-window",
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
            HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["materialized"] is True
    assert report["skipped"] is False
    assert report["blocked"] is False
    assert report["max_notional"] == "75000"
    assert (
        report["plan_source"]["selected_plan"]
        == "next_paper_route_runtime_window_targets"
    )
    assert report["materialization"]["bounded_notional_limit"] == "75000"
    assert report["materialized_decision_count"] == 2
    assert report["route_submission_count"] == 2
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_commit_dynamic_plan_prefers_materializable_next_window_over_stale_hpairs_import(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    stale_target = _hpairs_target(
        candidate_id="stale-import-target",
        source_plan_ref="paper-route-plan:stale-import-target",
        target_notional="0",
        target_quantity="0",
        window_start="2026-05-13T17:00:00+00:00",
        window_end="2026-05-13T17:30:00+00:00",
        paper_route_probe_symbol_actions={},
        paper_route_probe_symbol_quantities={},
        bounded_evidence_collection_authorized=False,
    )
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(
                stale_target,
                {**stale_target, "candidate_id": "second-stale-import-target"},
            )
        },
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(target_notional="75000")
        ),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
            "--commit",
            "--allow-dynamic-target-plan",
            "--require-active-target-window",
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
            HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["materialized"] is True
    assert report["skipped"] is False
    assert report["blocked"] is False
    assert (
        report["plan_source"]["selected_plan"]
        == "next_paper_route_runtime_window_targets"
    )
    assert report["source_target_count"] == 1
    assert report["target_count"] == 1
    assert report["target_window_check"]["active_count"] == 1
    assert report["materialized_decision_count"] == 2
    assert report["route_submission_count"] == 2
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_commit_dynamic_next_window_plan_filters_to_confirmed_hpairs_target(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "next_paper_route_runtime_window_targets": _plan(
            _tsmom_target(),
            _hpairs_target(target_notional="75000"),
        ),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
            "--commit",
            "--allow-dynamic-target-plan",
            "--require-active-target-window",
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
            HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["blocked"] is False
    assert report["materialized"] is True
    assert report["source_target_count"] == 2
    assert report["target_count"] == 1
    assert report["confirmed_dynamic_target_filter"] == {
        "hypothesis_id": "H-PAIRS-01",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
    }
    assert report["confirmed_dynamic_target_filter_applied"] is True
    assert report["target_window_check"]["active"] is True
    assert report["target_window_check"]["active_count"] == 1
    assert report["source_targets"][0]["hypothesis_id"] == "H-TSMOM-LIQ-01"
    assert report["targets"][0]["hypothesis_id"] == "H-PAIRS-01"
    assert report["targets"][0]["symbol_actions"] == {"AAPL": "buy", "AMZN": "sell"}
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_dynamic_plan_selection_prefers_sanitized_isolated_hpairs_plan() -> None:
    payload = {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": _plan(
                _tsmom_target(),
                _hpairs_target(),
            )
        },
        "next_paper_route_runtime_window_targets": _plan(_hpairs_target()),
    }

    plan, selected_plan = cli._materialization_plan_from_payload(payload)

    assert selected_plan == "next_paper_route_runtime_window_targets"
    assert [
        target["candidate_id"] for target in cli.paper_route_target_plan_targets(plan)
    ] == ["c88421d619759b2cfaa6f4d0"]


def test_dynamic_plan_selection_prefers_latest_closed_plan_before_next_window() -> None:
    payload = {
        "latest_closed_paper_route_runtime_window_targets": _plan(
            _hpairs_target(source_plan_ref="paper-route-plan:latest-closed")
        ),
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(source_plan_ref="paper-route-plan:next-window")
        ),
    }

    plan, selected_plan = cli._materialization_plan_from_payload(payload)

    assert selected_plan == "latest_closed_paper_route_runtime_window_targets"
    targets = cli.paper_route_target_plan_targets(plan)
    assert [target["candidate_id"] for target in targets] == [
        "c88421d619759b2cfaa6f4d0"
    ]
    assert targets[0]["source_plan_ref"] == "paper-route-plan:latest-closed"
    assert "latest_closed_paper_route_runtime_window_targets" in (
        cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES
    )


def test_commit_dynamic_source_allowlist_selects_active_next_window_over_closed_latest(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "latest_closed_paper_route_runtime_window_targets": _plan(
            _hpairs_target(
                source_plan_ref="paper-route-plan:latest-closed",
                window_start="2026-05-31T13:30:00+00:00",
                window_end="2026-05-31T20:00:00+00:00",
            )
        ),
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(
                target_notional="75000",
                source_plan_ref="paper-route-plan:next-window",
                window_start="2026-06-01T13:30:00+00:00",
                window_end="2026-06-01T20:00:00+00:00",
            )
        ),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
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
            "next_paper_route_runtime_window_targets",
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["plan_source"]["selected_plan"] == (
        "next_paper_route_runtime_window_targets"
    )
    assert report["target_plan_refs"] == ["paper-route-plan:next-window"]
    assert report["target_window_check"]["active"] is True
    assert report["skipped"] is False
    assert report["materialized"] is True
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_commit_dynamic_next_window_plan_blocks_when_confirmed_target_is_absent(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "next_paper_route_runtime_window_targets": _plan(_tsmom_target()),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--database-dsn-env",
            "DB_DSN",
            "--max-notional",
            "75000",
            "--commit",
            "--allow-dynamic-target-plan",
            "--require-active-target-window",
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
            HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION,
            "--confirm-target-count-min",
            "1",
            "--confirm-max-notional",
            "75000",
            "--operator-confirmation",
            cli.OPERATOR_CONFIRMATION,
        ],
        capsys,
    )

    assert exit_code == 2
    assert report["blocked"] is True
    assert report["materialized"] is False
    assert report["source_target_count"] == 1
    assert report["target_count"] == 0
    assert report["confirmed_dynamic_target_filter_applied"] is True
    assert report["source_targets"][0]["hypothesis_id"] == "H-TSMOM-LIQ-01"
    assert (
        "paper_route_materialization_target_plan_targets_missing" in report["blockers"]
    )
    assert (
        "paper_route_materialization_commit_confirm_target_count_min_missing"
        in report["blockers"]
    )
    assert _count_decisions(sqlite_dsn) == 0
