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
from app.trading.models import StrategyDecision
from app.trading.paper_route_target_plan import (
    materialize_bounded_paper_route_target_plan,
)
from scripts import materialize_bounded_paper_route_targets as cli
from scripts.paper_route_target_materialization import (
    target_materialization_core,
)

HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION = ",".join(
    cli.DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES
)


def _hpairs_target(**overrides: object) -> dict[str, Any]:
    target: dict[str, Any] = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "strategy_id": "microbar_cross_sectional_pairs_v1@research",
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


def _tsmom_target(**overrides: object) -> dict[str, Any]:
    target: dict[str, Any] = {
        "hypothesis_id": "H-TSMOM-LIQ-01",
        "candidate_id": "ca4e6e3c7d639e3363dc5860",
        "runtime_strategy_name": "intraday-tsmom-profit-v3",
        "strategy_name": "intraday-tsmom-profit-v3",
        "account_label": "TORGHUT_SIM",
        "source_plan_ref": "paper-route-plan:ca4e6e3c7d639e3363dc5860",
        "source_manifest_ref": "config/trading/hypotheses/h-tsmom-liq-01.json",
        "target_notional": "75000",
        "target_quantity": "8",
        "bounded_collection_stage": "paper",
        "evidence_collection_stage": "paper",
        "window_start": "2026-06-01T13:30:00+00:00",
        "window_end": "2026-06-01T20:00:00+00:00",
        "paper_route_probe_symbol_actions": {},
        "paper_route_probe_symbol_quantities": {
            "AAPL": "1",
            "AMD": "1",
            "AMZN": "1",
            "AVGO": "1",
            "GOOGL": "1",
            "INTC": "1",
            "NVDA": "1",
            "ORCL": "1",
        },
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


def _decision_payloads(dsn: str) -> list[dict[str, Any]]:
    engine = create_engine(dsn, future=True)
    try:
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            rows = (
                session.execute(
                    select(TradeDecision).order_by(
                        TradeDecision.created_at.asc(),
                        TradeDecision.symbol.asc(),
                    )
                )
                .scalars()
                .all()
            )
            return [dict(row.decision_json) for row in rows]
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


__all__ = (
    "HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION",
    "sqlite_dsn",
    "in_memory_session",
)

__all__: tuple[str, ...] = (
    "Any",
    "Base",
    "Decimal",
    "HPAIRS_DYNAMIC_SELECTED_PLAN_SOURCE_CONFIRMATION",
    "Iterator",
    "Namespace",
    "Path",
    "Session",
    "StaticPool",
    "Strategy",
    "StrategyDecision",
    "TradeDecision",
    "_CapturingConnection",
    "_FakeResponse",
    "_RaisingConnection",
    "_count_decisions",
    "_decision_payloads",
    "_hpairs_target",
    "_plan",
    "_run_cli",
    "_safe_commit_args",
    "_tsmom_target",
    "_write_plan",
    "cli",
    "create_engine",
    "datetime",
    "func",
    "in_memory_session",
    "json",
    "materialize_bounded_paper_route_target_plan",
    "pytest",
    "select",
    "sessionmaker",
    "sqlite_dsn",
    "target_materialization_core",
    "timezone",
)
