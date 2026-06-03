from __future__ import annotations

import json
from argparse import Namespace
from collections.abc import Iterator
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, Strategy, TradeDecision
from app.trading.paper_route_target_plan import (
    materialize_bounded_paper_route_target_plan,
)
from scripts import materialize_bounded_paper_route_targets as cli

HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION = ",".join(
    cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES
)


def _hpairs_target(**overrides: object) -> dict[str, Any]:
    target: dict[str, Any] = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "strategy_name": "microbar-cross-sectional-pairs-v1",
        "account_label": "TORGHUT_SIM",
        "source_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
        "target_notional": "20",
        "bounded_collection_stage": "paper",
        "evidence_collection_stage": "paper",
        "window_start": "2026-06-01T13:30:00+00:00",
        "window_end": "2026-06-01T20:00:00+00:00",
        "paper_route_probe_symbol_actions": {
            "AAPL": "buy",
            "AMZN": "sell",
        },
        "paper_route_probe_symbol_quantities": {
            "AAPL": "1",
            "AMZN": "1",
        },
        "paper_route_clean_window_state": "clean_window_collection_ready",
        "paper_route_clean_window_baseline_state": {
            "state": "clean",
            "blockers": [],
        },
        "paper_route_clean_window_baseline_blockers": [],
        "source_decision_readiness": {
            "schema_version": "torghut.paper-route-source-decision-readiness.v1",
            "ready": True,
            "blockers": [],
            "strategy_lookup_names": ["microbar-cross-sectional-pairs-v1"],
            "matched_strategy": {
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "enabled": True,
                "base_timeframe": "1Min",
                "universe_symbols": ["AAPL", "AMZN"],
                "max_notional_per_trade": "25",
            },
            "raw_probe_symbols": ["AAPL", "AMZN"],
            "scoped_probe_symbols": ["AAPL", "AMZN"],
        },
        "evidence_collection_ok": True,
        "bounded_evidence_collection_authorized": True,
        "capital_promotion_allowed": False,
        "promotion_allowed": False,
        "final_authority_ok": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "live_capital_routing_enabled": False,
    }
    target.update(overrides)
    return target


def _plan(*targets: dict[str, Any], **overrides: object) -> dict[str, Any]:
    plan: dict[str, Any] = {
        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
        "source": "paper_route_evidence_audit",
        "purpose": "next_session_paper_route_runtime_window_evidence_collection",
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "capital_promotion_allowed": False,
        "targets": list(targets),
    }
    plan.update(overrides)
    return plan


@pytest.fixture()
def sqlite_dsn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    dsn = f"sqlite+pysqlite:///{tmp_path / 'torghut.sqlite3'}"
    engine = create_engine(dsn, future=True)
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with session_local() as session:
        session.add(
            Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="H-PAIRS bounded target plan fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("25"),
            )
        )
        session.commit()
    monkeypatch.setenv("DB_DSN", dsn)
    yield dsn
    engine.dispose()


@pytest.fixture()
def in_memory_session() -> Iterator[Session]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with session_local() as session:
        session.add(
            Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="H-PAIRS bounded target plan fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("25"),
            )
        )
        session.commit()
        yield session
    engine.dispose()


def _write_plan(tmp_path: Path, payload: dict[str, Any]) -> Path:
    plan_path = tmp_path / "target-plan.json"
    plan_path.write_text(json.dumps(payload), encoding="utf-8")
    return plan_path


def _count_decisions(dsn: str) -> int:
    engine = create_engine(dsn, future=True)
    try:
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            return int(
                session.execute(
                    select(func.count()).select_from(TradeDecision)
                ).scalar_one()
            )
    finally:
        engine.dispose()


def _run_cli(
    argv: list[str], capsys: pytest.CaptureFixture[str]
) -> tuple[int, dict[str, Any]]:
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert isinstance(payload, dict)
    return exit_code, payload


def _safe_commit_args(plan_path: Path) -> list[str]:
    return [
        "--plan-json",
        str(plan_path),
        "--max-notional",
        "25",
        "--commit",
        "--confirm-account-label",
        "TORGHUT_SIM",
        "--confirm-dsn-env",
        "DB_DSN",
        "--confirm-hypothesis-id",
        "H-PAIRS-01",
        "--confirm-candidate-id",
        "c88421d619759b2cfaa6f4d0",
        "--confirm-runtime-strategy-name",
        "microbar-cross-sectional-pairs-v1",
        "--confirm-target-plan-ref",
        "paper-route-plan:c88421d619759b2cfaa6f4d0",
        "--confirm-max-notional",
        "25",
        "--operator-confirmation",
        cli.OPERATOR_CONFIRMATION,
    ]


class _FakeResponse:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body

    def read(self, limit: int = -1) -> bytes:
        if limit < 0:
            return self._body
        return self._body[:limit]


class _CapturingConnection:
    response = _FakeResponse(200, b"{}")
    instances: list["_CapturingConnection"] = []

    def __init__(
        self,
        host: str,
        port: int | None = None,
        *,
        timeout: float | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.method: str | None = None
        self.path: str | None = None
        self.headers: dict[str, str] | None = None
        self.closed = False
        self.__class__.instances.append(self)

    def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
        self.method = method
        self.path = path
        self.headers = headers

    def getresponse(self) -> _FakeResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


class _RaisingConnection(_CapturingConnection):
    def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
        super().request(method, path, headers=headers)
        raise OSError("network down")


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


def test_paper_route_target_plan_json_and_scalar_helpers_preserve_report_encoding_edges() -> (
    None
):
    generated_at = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)

    assert cli._json_default(Decimal("12.500")) == "12.500"
    assert cli._json_default(generated_at) == generated_at.isoformat()
    assert cli._json_default(Path("target-plan.json")) == "target-plan.json"
    assert cli._safe_decimal("not-a-number") == Decimal("0")
    assert cli._confirmed_selected_plan_sources(None) == set()
    assert cli._truthy(1) is True
    assert cli._truthy(0) is False


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
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "target_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "window_start": "2026-06-01T13:30:00+00:00",
            "window_end": "2026-06-01T20:00:00+00:00",
            "bounded_collection_stage": "paper",
            "target_notional": "20",
            "target_quantity": "3",
            "symbols": ["AAPL", "AMZN"],
            "symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
            "symbol_quantities": {"AAPL": "3", "AMZN": "3"},
        }
    ]


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
    monkeypatch.setattr(cli, "_fetch_plan_url_payload", lambda *_, **__: payload)

    exit_code, report = _run_cli(
        [
            "--plan-url",
            "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
            "--max-notional",
            "25",
        ],
        capsys,
    )

    assert exit_code == 0
    assert report["plan_source"] == {
        "kind": "url",
        "url": "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan",
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


def test_commit_dynamic_next_window_plan_at_configured_notional_skips_before_open(
    monkeypatch: pytest.MonkeyPatch,
    sqlite_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = {
        "next_paper_route_runtime_window_targets": _plan(
            _hpairs_target(target_notional="75000")
        ),
    }
    monkeypatch.setattr(cli, "_fetch_plan_url_payload", lambda *_, **__: payload)

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
            _hpairs_target(target_notional="75000")
        ),
    }
    monkeypatch.setattr(cli, "_fetch_plan_url_payload", lambda *_, **__: payload)

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


def test_paper_route_target_plan_rejects_exceeded_notional_missing_quantity_and_missing_actions(
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
    assert "paper_route_materialization_target_0_target_quantity_missing" in blockers
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
