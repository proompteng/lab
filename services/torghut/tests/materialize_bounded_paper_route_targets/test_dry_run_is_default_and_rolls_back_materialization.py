from __future__ import annotations

from tests.materialize_bounded_paper_route_targets.support import (
    Decimal,
    Namespace,
    Path,
    Session,
    StrategyDecision,
    TradeDecision,
    _count_decisions,
    _decision_payloads,
    _hpairs_target,
    _plan,
    _run_cli,
    _safe_commit_args,
    _tsmom_target,
    _write_plan,
    cli,
    datetime,
    materialize_bounded_paper_route_target_plan,
    pytest,
    select,
    target_materialization_core,
    timezone,
)


def test_dry_run_is_default_and_rolls_back_materialization(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(tmp_path, _plan(_hpairs_target()))

    exit_code, payload = _run_cli(
        ["--plan-json", str(plan_path), "--max-notional", "25"],
        capsys,
    )

    assert exit_code == 0
    assert payload["mode"] == "dry_run"
    assert payload["dry_run"] is True
    assert payload["commit"] is False
    assert payload["materialized"] is False
    assert payload["account_label"] == "TORGHUT_SIM"
    assert payload["max_notional"] == "25"
    assert payload["promotion_allowed"] is False
    assert payload["final_promotion_allowed"] is False
    assert payload["capital_promotion_allowed"] is False
    assert payload["materialized_decision_count"] == 2
    assert payload["route_submission_count"] == 2
    assert payload["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 0


def test_commit_writes_only_for_torghut_sim_with_explicit_confirmations(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(tmp_path, _plan(_hpairs_target()))

    exit_code, payload = _run_cli(_safe_commit_args(plan_path), capsys)

    assert exit_code == 0
    assert payload["mode"] == "commit"
    assert payload["dry_run"] is False
    assert payload["materialized"] is True
    assert payload["materialized_decision_count"] == 2
    assert payload["route_submission_count"] == 2
    assert payload["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 2


def test_materializer_repairs_existing_payloads_missing_executable_strategy_id(
    in_memory_session: Session,
) -> None:
    plan = _plan(_hpairs_target())
    first = materialize_bounded_paper_route_target_plan(
        in_memory_session,
        plan,
        generated_at=datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc),
        bounded_notional_limit=Decimal("25"),
    )
    in_memory_session.commit()
    assert first["materialized_decision_count"] == 2

    rows = (
        in_memory_session.execute(
            select(TradeDecision).order_by(TradeDecision.symbol.asc())
        )
        .scalars()
        .all()
    )
    for row in rows:
        broken_payload = dict(row.decision_json)
        broken_payload.pop("strategy_id", None)
        row.decision_json = broken_payload
    in_memory_session.commit()

    repaired = materialize_bounded_paper_route_target_plan(
        in_memory_session,
        plan,
        generated_at=datetime(2026, 6, 1, 13, 40, tzinfo=timezone.utc),
        bounded_notional_limit=Decimal("25"),
    )
    in_memory_session.commit()

    assert repaired["existing_decision_count"] == 2
    assert repaired["repaired_decision_count"] == 2
    assert repaired["blockers"] == []
    repaired_rows = (
        in_memory_session.execute(
            select(TradeDecision).order_by(TradeDecision.symbol.asc())
        )
        .scalars()
        .all()
    )
    decisions = [
        StrategyDecision.model_validate(row.decision_json) for row in repaired_rows
    ]
    assert {decision.symbol: decision.strategy_id for decision in decisions} == {
        "AAPL": "microbar_cross_sectional_pairs_v1@research",
        "AMZN": "microbar_cross_sectional_pairs_v1@research",
    }


def test_commit_rejects_missing_account_and_dsn_confirmation(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(tmp_path, _plan(_hpairs_target()))

    exit_code, payload = _run_cli(
        [
            "--plan-json",
            str(plan_path),
            "--max-notional",
            "25",
            "--commit",
        ],
        capsys,
    )

    assert exit_code == 2
    assert (
        "paper_route_materialization_commit_confirm_account_label_missing"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_commit_confirm_dsn_env_missing"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_operator_confirmation_missing"
        in payload["blockers"]
    )
    assert _count_decisions(sqlite_dsn) == 0


def test_rejects_live_account_labels(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(
        tmp_path, _plan(_hpairs_target(account_label="TORGHUT_LIVE"))
    )

    exit_code, payload = _run_cli(
        [
            "--plan-json",
            str(plan_path),
            "--account-label",
            "TORGHUT_LIVE",
            "--max-notional",
            "25",
        ],
        capsys,
    )

    assert exit_code == 2
    assert (
        "paper_route_materialization_account_label_must_be_torghut_sim"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_live_account_label_rejected" in payload["blockers"]
    )
    assert (
        "paper_route_materialization_target_0_account_label_must_be_torghut_sim"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_target_0_live_account_label_rejected"
        in payload["blockers"]
    )
    assert _count_decisions(sqlite_dsn) == 0


def test_rejects_unbounded_or_missing_target_identity(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(
        tmp_path,
        _plan(
            _hpairs_target(
                candidate_id="",
                source_plan_ref="",
                source_manifest_ref="",
                target_notional="0",
            )
        ),
    )

    exit_code, payload = _run_cli(["--plan-json", str(plan_path)], capsys)

    assert exit_code == 2
    assert (
        "paper_route_materialization_bounded_max_notional_required"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_target_0_candidate_id_missing"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_target_0_target_plan_ref_missing"
        in payload["blockers"]
    )
    assert (
        "paper_route_materialization_target_0_target_notional_missing"
        in payload["blockers"]
    )
    assert _count_decisions(sqlite_dsn) == 0


def test_rejects_promotion_capital_and_final_authority_flags(
    tmp_path: Path,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = _write_plan(
        tmp_path,
        _plan(
            _hpairs_target(capital_promotion_allowed=True, final_authority_ok=True),
            promotion_allowed=True,
        ),
    )

    exit_code, payload = _run_cli(
        [
            "--plan-json",
            str(plan_path),
            "--max-notional",
            "25",
            "--promotion-allowed",
            "--final-promotion-allowed",
            "--capital-promotion-allowed",
        ],
        capsys,
    )

    blockers = set(payload["blockers"])
    assert exit_code == 2
    assert (
        "paper_route_materialization_request_promotion_allowed_must_be_false"
        in blockers
    )
    assert (
        "paper_route_materialization_request_final_promotion_allowed_must_be_false"
        in blockers
    )
    assert (
        "paper_route_materialization_request_capital_promotion_allowed_must_be_false"
        in blockers
    )
    assert (
        "paper_route_materialization_plan_promotion_allowed_must_be_false" in blockers
    )
    assert (
        "paper_route_materialization_target_0_capital_promotion_allowed_must_be_false"
        in blockers
    )
    assert (
        "paper_route_materialization_target_0_final_authority_ok_must_be_false"
        in blockers
    )
    assert _count_decisions(sqlite_dsn) == 0


def test_cli_preserves_existing_paper_route_target_plan_materialization_semantics(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    in_memory_session: Session,
    sqlite_dsn: str,
) -> None:
    plan = _plan(_hpairs_target())
    direct = materialize_bounded_paper_route_target_plan(
        in_memory_session,
        plan,
        generated_at=datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc),
        bounded_notional_limit=Decimal("25"),
    )
    plan_path = _write_plan(tmp_path, plan)

    exit_code, payload = _run_cli(_safe_commit_args(plan_path), capsys)

    assert exit_code == 0
    assert payload["materialization"]["schema_version"] == direct["schema_version"]
    assert (
        payload["materialization"]["source_decision_mode"]
        == direct["source_decision_mode"]
    )
    assert (
        payload["materialized_decision_count"] == direct["materialized_decision_count"]
    )
    assert payload["route_submission_count"] == direct["route_submission_count"]
    assert payload["candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
    assert payload["runtime_strategy_names"] == ["microbar-cross-sectional-pairs-v1"]
    assert payload["target_plan_refs"] == ["paper-route-plan:c88421d619759b2cfaa6f4d0"]
    assert payload["materialization"]["promotion_allowed"] is False
    assert payload["materialization"]["final_promotion_allowed"] is False
    assert payload["materialization"]["live_capital_routing_enabled"] is False
    decisions = [
        StrategyDecision.model_validate(item) for item in _decision_payloads(sqlite_dsn)
    ]
    assert {decision.symbol: decision.action for decision in decisions} == {
        "AAPL": "buy",
        "AMZN": "sell",
    }
    assert {decision.strategy_id for decision in decisions} == {
        "microbar_cross_sectional_pairs_v1@research"
    }


def test_paper_route_target_plan_json_and_scalar_helpers_preserve_report_encoding_edges() -> (
    None
):
    generated_at = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)

    assert cli._json_default(Decimal("12.500")) == "12.500"
    assert cli._json_default(generated_at) == generated_at.isoformat()
    assert cli._json_default(Path("target-plan.json")) == "target-plan.json"
    assert cli._safe_decimal("not-a-number") == Decimal("0")
    assert cli._confirmed_selected_plan_sources(None) == set()
    assert (
        cli._confirmed_dynamic_target_filters(
            Namespace(commit=False, allow_dynamic_target_plan=True)
        )
        == {}
    )
    assert cli._confirmed_dynamic_target_indexes([], {}) == []
    assert cli._truthy(1) is True
    assert cli._truthy(0) is False


def test_paper_route_target_plan_dynamic_target_index_filter_accepts_confirmation_alias() -> (
    None
):
    summaries = [
        {
            "target_index": 3,
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "candidate-a",
            "runtime_strategy_name": "runtime-a",
            "runtime_strategy_confirmation_names": ["alias-a"],
        },
        {
            "target_index": 4,
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "candidate-b",
            "runtime_strategy_name": "runtime-b",
            "runtime_strategy_confirmation_names": ["alias-b"],
        },
    ]

    assert cli._confirmed_dynamic_target_indexes(
        summaries,
        {
            "hypothesis_id": "H-PAIRS-01",
            "runtime_strategy_name": "alias-a",
        },
    ) == [3]


def test_paper_route_target_plan_dynamic_target_index_filter_ignores_string_alias_list() -> (
    None
):
    summaries = [
        {
            "target_index": 5,
            "hypothesis_id": "H-PAIRS-01",
            "runtime_strategy_name": "runtime-a",
            "runtime_strategy_confirmation_names": "alias-a",
        }
    ]

    assert (
        cli._confirmed_dynamic_target_indexes(
            summaries,
            {
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "alias-a",
            },
        )
        == []
    )
    assert cli._confirmed_dynamic_target_indexes(
        summaries,
        {
            "hypothesis_id": "H-PAIRS-01",
            "runtime_strategy_name": "runtime-a",
        },
    ) == [5]


def test_paper_route_target_plan_sqlalchemy_dsn_uses_installed_psycopg_driver() -> None:
    assert (
        cli._sqlalchemy_dsn("postgres://user:pass@postgres/torghut")
        == "postgresql+psycopg://user:pass@postgres/torghut"
    )
    assert (
        cli._sqlalchemy_dsn("postgresql://user:pass@postgres/torghut")
        == "postgresql+psycopg://user:pass@postgres/torghut"
    )
    assert (
        cli._sqlalchemy_dsn("postgresql+psycopg://user:pass@postgres/torghut")
        == "postgresql+psycopg://user:pass@postgres/torghut"
    )
    assert cli._sqlalchemy_dsn("sqlite+pysqlite:///:memory:") == (
        "sqlite+pysqlite:///:memory:"
    )


def test_paper_route_target_plan_target_summary_accepts_explicit_quantity_and_symbol_fallbacks() -> (
    None
):
    target = _hpairs_target(
        paper_route_probe_symbol_quantities={},
        target_quantity="3",
    )

    summaries = cli._target_summaries(_plan(target))

    assert summaries == [
        {
            "target_index": 0,
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_confirmation_names": [
                "microbar-cross-sectional-pairs-v1"
            ],
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "target_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "window_start": "2026-06-01T13:30:00+00:00",
            "window_end": "2026-06-01T20:00:00+00:00",
            "bounded_collection_stage": "paper",
            "target_notional": "20",
            "target_quantity": "3",
            "bounded_evidence_collection_authorized": True,
            "bounded_materialization_authorized": True,
            "evidence_collection_ok": True,
            "execution_capacity_state": None,
            "execution_capacity_blockers": [],
            "symbols": ["AAPL", "AMZN"],
            "symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
            "symbol_quantities": {"AAPL": "3", "AMZN": "3"},
        }
    ]


def test_paper_route_materializer_blocks_notional_target_missing_capacity_contract() -> (
    None
):
    target = _hpairs_target(
        paper_route_probe_symbol_quantities={},
        target_quantity="",
        paper_route_execution_capacity_contract={},
    )
    plan = _plan(target)
    summaries = cli._target_summaries(plan)
    args = Namespace(
        account_label="TORGHUT_SIM",
        max_notional="20",
        capital_mode="paper",
        promotion_allowed=False,
        final_promotion_allowed=False,
        final_authority_ok=False,
        capital_promotion_allowed=False,
        commit=False,
        allow_dynamic_target_plan=False,
        confirm_account_label=None,
        confirm_dsn_env=None,
        confirm_hypothesis_id=None,
        confirm_candidate_id=None,
        confirm_runtime_strategy_name=None,
        confirm_target_plan_ref=None,
        confirm_selected_plan_source=None,
        confirm_target_count_min=None,
        operator_confirmation=cli.OPERATOR_CONFIRMATION,
    )

    blockers = cli._safety_blockers(
        args=args,
        plan=plan,
        plan_source={},
        summaries=summaries,
        dsn="sqlite+pysqlite:///:memory:",
        dsn_env="SIM_DB_DSN",
    )

    assert summaries[0]["execution_capacity_blockers"] == [
        "paper_route_execution_capacity_contract_missing"
    ]
    assert (
        "paper_route_materialization_target_0_paper_route_execution_capacity_contract_missing"
        in blockers
    )


def test_paper_route_materializer_window_datetime_helpers_handle_edge_cases() -> None:
    assert cli._parse_utc_datetime(None) is None
    assert cli._parse_utc_datetime("not-a-time") is None
    assert cli._parse_utc_datetime("2026-06-01T13:30:00") == datetime(
        2026,
        6,
        1,
        13,
        30,
        tzinfo=timezone.utc,
    )

    before = datetime.now(timezone.utc)
    fallback = cli._resolve_now_utc(Namespace(now_utc="not-a-time"))
    after = datetime.now(timezone.utc)

    assert before <= fallback <= after


def test_paper_route_materializer_window_check_reports_missing_target_windows() -> None:
    check = cli._active_target_window_check(
        [{"target_index": 7, "window_start": None, "window_end": ""}],
        now=datetime(2026, 6, 1, 14, tzinfo=timezone.utc),
    )

    assert check["active"] is False
    assert check["active_count"] == 0
    assert check["inactive_count"] == 0
    assert check["missing_count"] == 1
    assert check["targets"] == [
        {
            "target_index": 7,
            "state": "missing_window",
            "window_start": None,
            "window_end": "",
        }
    ]


def test_paper_route_target_plan_invalid_payload_reports_load_blockers(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    plan_path = tmp_path / "invalid-plan.json"
    plan_path.write_text("[]", encoding="utf-8")

    exit_code, payload = _run_cli(
        ["--plan-json", str(plan_path), "--max-notional", "25"],
        capsys,
    )

    assert exit_code == 2
    blockers = set(payload["blockers"])
    assert (
        "paper_route_materialization_plan_load_failed:paper_route_target_plan_json_must_be_object"
        in blockers
    )
    assert "paper_route_materialization_target_plan_targets_missing" in blockers


def test_url_payload_prefers_nested_hpairs_materialization_plan(
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
            "http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20",
            "--max-notional",
            "25",
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["plan_source"] == {
        "kind": "url",
        "url": "http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20",
        "selected_plan": (
            "live_submission_gate.runtime_ledger_paper_probation_import_plan"
        ),
        "fetch_attempts": None,
    }
    assert report["hypothesis_ids"] == ["H-PAIRS-01"]
    assert report["candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
    assert report["materialized_decision_count"] == 2
    assert report["route_submission_count"] == 2
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 0


def test_url_payload_accepts_trading_proofs_materialization_plan(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "schema_version": "torghut.proofs.v1",
        "proofs": [
            {
                "identity": {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "account_label": "TORGHUT_SIM",
                    "source_account_label": "TORGHUT_SIM",
                    "source_kind": "runtime_window",
                    "source_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
                    "target_notional": "20",
                    "target_symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
                    "target_symbol_quantities": {"AAPL": "1", "AMZN": "1"},
                },
                "window": {
                    "start": "2026-06-01T13:30:00+00:00",
                    "end": "2026-06-01T20:00:00+00:00",
                },
                "symbols": ["AAPL", "AMZN"],
                "state": "waiting_for_session",
                "account_state": {
                    "blockers": [],
                    "clean_baseline": True,
                },
            }
        ],
        "summary": {"target_count": 1},
        "promotion_authority": {
            "allowed": False,
            "final_promotion_allowed": False,
        },
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20",
            "--max-notional",
            "25",
            "--confirm-selected-plan-source",
            "trading_proofs",
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["plan_source"] == {
        "kind": "url",
        "url": "http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20",
        "selected_plan": "trading_proofs",
        "fetch_attempts": None,
    }
    assert report["hypothesis_ids"] == ["H-PAIRS-01"]
    assert report["candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
    assert report["materialized_decision_count"] == 2
    assert report["route_submission_count"] == 2
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 0


def test_url_payload_prefers_bounded_plan_over_larger_source_collection_plan(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source_collection_hpairs = _hpairs_target(
        candidate_id="source-collection-hpairs",
        bounded_evidence_collection_authorized=False,
        evidence_collection_ok=True,
    )
    source_collection_tsmom = _tsmom_target(
        bounded_evidence_collection_authorized=False,
        evidence_collection_ok=True,
    )
    payload = {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "next_paper_route_runtime_window_targets": _plan(
            source_collection_hpairs,
            source_collection_tsmom,
        ),
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
            "http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20",
            "--max-notional",
            "25",
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["plan_source"]["selected_plan"] == (
        "live_submission_gate.runtime_ledger_paper_probation_import_plan"
    )
    assert report["candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
    assert report["hypothesis_ids"] == ["H-PAIRS-01"]
    assert report["materialized_decision_count"] == 2
    assert report["blockers"] == []
    assert _count_decisions(sqlite_dsn) == 0


def test_source_collection_only_plan_blocks_materialization_before_db_write(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(
                bounded_evidence_collection_authorized=False,
                evidence_collection_ok=True,
            ),
        ),
    }
    monkeypatch.setattr(
        target_materialization_core, "_fetch_plan_url_payload", lambda *_, **__: payload
    )

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/proofs?kind=runtime_window&window=next&limit=20",
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
            "next_paper_route_runtime_window_targets",
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
    assert report["materialized"] is False
    assert report["blocked"] is True
    assert (
        "paper_route_materialization_target_0_bounded_evidence_collection_authorized_required"
        in report["blockers"]
    )
    assert _count_decisions(sqlite_dsn) == 0
