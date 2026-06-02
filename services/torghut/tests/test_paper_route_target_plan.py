from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, Strategy, TradeDecision
from app.trading.paper_route_target_plan import (
    _truthy,
    materialize_bounded_paper_route_target_plan,
)
from app.trading.runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
)
from app.trading.scheduler.simple_pipeline import (
    _bounded_paper_route_collection_entry_metadata,
)


@pytest.fixture()
def db_session() -> Iterator[Session]:
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


def _plan(*targets: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
        "source": "paper_route_evidence_audit",
        "purpose": "next_session_paper_route_runtime_window_evidence_collection",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "targets": list(targets),
    }


def test_materialization_truthy_helper_accepts_numeric_and_text_readiness() -> None:
    assert _truthy(1) is True
    assert _truthy(0) is False
    assert _truthy("true") is True
    assert _truthy("false") is False


def test_fresh_hpairs_target_materializes_bounded_collection_source_decisions(
    db_session: Session,
) -> None:
    result = materialize_bounded_paper_route_target_plan(
        db_session,
        _plan(_hpairs_target()),
        generated_at=datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc),
        bounded_notional_limit=Decimal("25"),
    )
    rows = list(
        db_session.execute(
            select(TradeDecision).order_by(TradeDecision.symbol.asc())
        ).scalars()
    )

    assert result["materialized_decision_count"] == 2
    assert result["route_submission_count"] == 2
    assert result["blocked_target_count"] == 0
    assert result["promotion_allowed"] is False
    assert result["final_authority_ok"] is False
    assert result["final_promotion_allowed"] is False
    assert result["live_capital_routing_enabled"] is False
    assert [row.symbol for row in rows] == ["AAPL", "AMZN"]
    for row in rows:
        payload = row.decision_json
        params = payload["params"]
        assert (
            payload["source_decision_mode"]
            == BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        )
        assert payload["final_authority_ok"] is False
        assert (
            params["source_decision_mode"]
            == BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        )
        assert params["profit_proof_eligible"] is True
        assert params["promotion_allowed"] is False
        assert params["final_authority_ok"] is False
        assert params["final_promotion_allowed"] is False
        source_metadata = params["paper_route_target_plan_source_decision"]
        assert source_metadata["source_decision_readiness"]["ready"] is True
        assert source_metadata["bounded_evidence_collection_authorized"] is True
        assert source_metadata["promotion_allowed"] is False
        assert source_metadata["final_authority_ok"] is False
        assert (
            _bounded_paper_route_collection_entry_metadata(params)
            == params["paper_route_probe"]
        )


@pytest.mark.parametrize(
    ("target", "expected_blockers"),
    [
        (
            _hpairs_target(
                source_decision_readiness={
                    "ready": False,
                    "blockers": ["signal_lag_exceeded"],
                }
            ),
            {"paper_route_source_decision_not_ready", "signal_lag_exceeded"},
        ),
        (
            _hpairs_target(
                source_decision_readiness={
                    "ready": False,
                    "blockers": ["drift_checks_missing"],
                }
            ),
            {"paper_route_source_decision_not_ready", "drift_checks_missing"},
        ),
        (
            _hpairs_target(source_decision_readiness=None),
            {"paper_route_source_decision_readiness_missing"},
        ),
        (
            _hpairs_target(hypothesis_id="H-REV-01"),
            {"paper_route_target_hpairs_hypothesis_required"},
        ),
        (
            _hpairs_target(account_label="TORGHUT_LIVE"),
            {"paper_route_target_torghut_sim_account_required"},
        ),
    ],
)
def test_materialization_blocks_stale_missing_or_out_of_scope_targets(
    db_session: Session,
    target: dict[str, Any],
    expected_blockers: set[str],
) -> None:
    result = materialize_bounded_paper_route_target_plan(
        db_session,
        _plan(target),
        generated_at=datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc),
        bounded_notional_limit=Decimal("25"),
    )
    row_count = db_session.execute(
        select(func.count()).select_from(TradeDecision)
    ).scalar_one()

    assert result["materialized_decision_count"] == 0
    assert result["route_submission_count"] == 0
    assert result["blocked_target_count"] == 1
    assert expected_blockers <= set(result["blockers"])
    assert row_count == 0
    assert result["promotion_allowed"] is False
    assert result["final_authority_ok"] is False
    assert result["final_promotion_allowed"] is False
    assert result["live_capital_routing_enabled"] is False
