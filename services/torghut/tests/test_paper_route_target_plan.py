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
from app.config import settings
from app.trading.execution import (
    OrderExecutor,
    _target_plan_ref_value,
    _target_plan_source_decision_mode,
    _target_plan_source_decision_needs_refresh,
)
from app.trading.models import StrategyDecision, decision_hash
from app.trading.paper_route_target_plan import (
    _paper_route_source_decision_needs_refresh,
    _paper_route_source_materialization_blockers,
    _target_identity_keys,
    _target_plan_selection_score,
    _target_source_decision_ready,
    _truthy,
    materialize_bounded_paper_route_target_plan,
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
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


def test_target_source_decision_readiness_accepts_text_truth() -> None:
    assert _target_source_decision_ready(
        {"source_decision_readiness": {"ready": "yes"}}
    )
    assert not _target_source_decision_ready(
        {"source_decision_readiness": {"ready": "no"}}
    )


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        (
            {"source_plan_ref": "paper-route-plan:abc"},
            {("source_plan_ref", "paper-route-plan:abc")},
        ),
        (
            {
                "hypothesis_id": "H-TSMOM-LIQ-01",
                "runtime_strategy_name": "intraday-tsmom-profit-v3",
            },
            {("hypothesis_strategy", "H-TSMOM-LIQ-01:intraday-tsmom-profit-v3")},
        ),
        (
            {
                "hypothesis_id": "H-PAIRS-01",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
            },
            {("hypothesis_strategy", "H-PAIRS-01:microbar-cross-sectional-pairs-v1")},
        ),
        ({"hypothesis_id": "H-PAIRS-01"}, {("hypothesis_id", "H-PAIRS-01")}),
        (
            {"strategy_name": "microbar-cross-sectional-pairs-v1"},
            {("strategy_name", "microbar-cross-sectional-pairs-v1")},
        ),
        ({}, set()),
    ],
)
def test_target_identity_keys_fall_back_by_available_specificity(
    target: dict[str, Any],
    expected: set[tuple[str, str]],
) -> None:
    assert _target_identity_keys(target) == expected


def test_target_plan_selection_score_rejects_empty_plans() -> None:
    assert _target_plan_selection_score(
        {},
        source_rank=3,
        selected_identity_keys=set(),
    ) == (-1, 0, 0, 0, 0, -3)


def test_target_plan_payload_prefers_nested_plan_with_probe_symbols() -> None:
    payload = {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "target_count": 1,
        "targets": [
            {
                "hypothesis_id": "H-TSMOM-LIQ-01",
                "candidate_id": "ca4e6e3c7d639e3363dc5860",
                "runtime_strategy_name": "intraday-tsmom-profit-v3",
            }
        ],
        "next_paper_route_runtime_window_targets": {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "source": "paper_route_evidence_audit",
            "target_count": 1,
            "targets": [
                {
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                    "candidate_id": "ca4e6e3c7d639e3363dc5860",
                    "runtime_strategy_name": "intraday-tsmom-profit-v3",
                    "paper_route_probe_symbols": ["AAPL", "AMZN"],
                    "paper_route_probe_symbol_actions": {},
                    "source_decision_readiness": {"ready": True, "blockers": []},
                }
            ],
        },
    }

    plan = paper_route_target_plan_from_payload(payload)

    assert plan["source"] == "paper_route_evidence_audit"
    assert plan["targets"][0]["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
    assert paper_route_target_plan_probe_symbols(plan) == {"AAPL", "AMZN"}


def test_target_plan_payload_keeps_selected_target_over_unrelated_nested_plan() -> None:
    payload = {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "target_count": 1,
        "targets": [
            {
                "hypothesis_id": "H-TSMOM-LIQ-01",
                "candidate_id": "ca4e6e3c7d639e3363dc5860",
                "runtime_strategy_name": "intraday-tsmom-profit-v3",
            }
        ],
        "next_paper_route_runtime_window_targets": {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "source": "paper_route_evidence_audit",
            "target_count": 1,
            "targets": [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "paper_route_probe_symbols": ["AAPL", "AMZN"],
                    "source_decision_readiness": {"ready": True, "blockers": []},
                }
            ],
        },
    }

    plan = paper_route_target_plan_from_payload(payload)

    assert plan["schema_version"] == "torghut.paper-route-target-plan.v1"
    assert plan["targets"][0]["hypothesis_id"] == "H-TSMOM-LIQ-01"
    assert plan["targets"][0]["candidate_id"] == "ca4e6e3c7d639e3363dc5860"
    assert paper_route_target_plan_probe_symbols(plan) == set()


def test_target_plan_payload_keeps_top_level_plan_when_it_has_probe_symbols() -> None:
    payload = {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "target_count": 1,
        "targets": [
            {
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
            }
        ],
        "next_paper_route_runtime_window_targets": {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "source": "paper_route_evidence_audit",
            "targets": [
                {
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                    "candidate_id": "ca4e6e3c7d639e3363dc5860",
                    "runtime_strategy_name": "intraday-tsmom-profit-v3",
                    "paper_route_probe_symbols": ["NVDA"],
                }
            ],
        },
    }

    plan = paper_route_target_plan_from_payload(payload)

    assert plan["schema_version"] == "torghut.paper-route-target-plan.v1"
    assert plan["targets"][0]["hypothesis_id"] == "H-PAIRS-01"
    assert paper_route_target_plan_probe_symbols(plan) == {"AAPL", "AMZN"}


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
    assert result["source_decision_count"] == 2
    assert result["target_plan_source_decision_count"] == 2
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
        assert payload["hypothesis_id"] == "H-PAIRS-01"
        assert payload["candidate_id"] == "c88421d619759b2cfaa6f4d0"
        assert payload["runtime_strategy_name"] == "microbar-cross-sectional-pairs-v1"
        assert payload["account_label"] == "TORGHUT_SIM"
        assert payload["observed_stage"] == "paper"
        assert payload["bounded_collection_stage"] == "bounded_paper_collection"
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


def test_existing_hpairs_target_plan_decision_is_repaired_with_source_refs(
    db_session: Session,
) -> None:
    generated_at = datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc)
    plan = _plan(_hpairs_target())
    first = materialize_bounded_paper_route_target_plan(
        db_session,
        plan,
        generated_at=generated_at,
        bounded_notional_limit=Decimal("25"),
    )
    row = db_session.execute(
        select(TradeDecision).where(TradeDecision.symbol == "AAPL")
    ).scalar_one()
    row.decision_json = {
        "params": {
            "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            "paper_route_target_plan_source_decision": {
                "mode": "paper_route_target_plan_source_decision"
            },
        },
        "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
    }
    db_session.add(row)
    db_session.flush()

    repaired = materialize_bounded_paper_route_target_plan(
        db_session,
        plan,
        generated_at=generated_at,
        bounded_notional_limit=Decimal("25"),
    )
    repaired_row = db_session.execute(
        select(TradeDecision).where(TradeDecision.id == row.id)
    ).scalar_one()
    source_metadata = repaired_row.decision_json["params"][
        "paper_route_target_plan_source_decision"
    ]

    assert first["materialized_decision_count"] == 2
    assert repaired["existing_decision_count"] == 2
    assert repaired["repaired_decision_count"] == 1
    assert repaired["blocked_target_count"] == 0
    assert source_metadata["hypothesis_id"] == "H-PAIRS-01"
    assert source_metadata["candidate_id"] == "c88421d619759b2cfaa6f4d0"
    assert (
        source_metadata["runtime_strategy_name"] == "microbar-cross-sectional-pairs-v1"
    )
    assert source_metadata["account_label"] == "TORGHUT_SIM"
    assert source_metadata["observed_stage"] == "paper"
    assert source_metadata["bounded_collection_stage"] == "bounded_paper_collection"
    assert source_metadata["final_promotion_allowed"] is False


def test_unrepairable_existing_hpairs_target_plan_decision_is_visible_blocker(
    db_session: Session,
) -> None:
    generated_at = datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc)
    plan = _plan(_hpairs_target())
    materialize_bounded_paper_route_target_plan(
        db_session,
        plan,
        generated_at=generated_at,
        bounded_notional_limit=Decimal("25"),
    )
    row = db_session.execute(
        select(TradeDecision).where(TradeDecision.symbol == "AAPL")
    ).scalar_one()
    row.status = "executed"
    row.decision_json = {
        "params": {},
        "promotion_allowed": False,
        "final_promotion_allowed": False,
    }
    db_session.add(row)
    db_session.flush()

    result = materialize_bounded_paper_route_target_plan(
        db_session,
        plan,
        generated_at=generated_at,
        bounded_notional_limit=Decimal("25"),
    )

    assert result["blocked_target_count"] == 1
    assert result["materialized_decision_count"] == 1
    assert result["route_submission_count"] == 1
    assert "paper_route_source_decision_hypothesis_id_missing" in result["blockers"]
    assert result["blocked_targets"][0]["trade_decision_id"] == str(row.id)


def test_order_executor_refreshes_existing_bounded_target_plan_source_refs(
    db_session: Session,
) -> None:
    strategy = db_session.execute(select(Strategy)).scalar_one()
    event_ts = datetime(2026, 6, 1, 13, 36, tzinfo=timezone.utc)
    decision = StrategyDecision(
        strategy_id=str(strategy.id),
        symbol="AAPL",
        event_ts=event_ts,
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
        rationale="external paper-route target plan source decision",
        params={
            "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            "paper_route_target_plan_source_decision": {
                "mode": "paper_route_target_plan_source_decision",
                "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "bounded_collection_stage": "bounded_paper_collection",
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "live_capital_routing_enabled": False,
            },
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "live_capital_routing_enabled": False,
        },
    )
    digest = decision_hash(
        decision,
        account_label="TORGHUT_SIM" if settings.trading_multi_account_enabled else None,
    )
    existing_row = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="TORGHUT_SIM",
        symbol="AAPL",
        timeframe="1Min",
        decision_json={
            "params": {
                "source_decision_mode": (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                )
            }
        },
        rationale="stale target-plan decision without source refs",
        decision_hash=digest,
        status="planned",
        created_at=event_ts,
    )
    db_session.add(existing_row)
    db_session.commit()
    existing_id = existing_row.id

    row = OrderExecutor().ensure_decision(
        db_session,
        decision,
        strategy,
        "TORGHUT_SIM",
    )

    metadata = row.decision_json["params"]["paper_route_target_plan_source_decision"]
    assert row.id == existing_id
    assert row.rationale == "external paper-route target plan source decision"
    assert metadata["hypothesis_id"] == "H-PAIRS-01"
    assert metadata["candidate_id"] == "c88421d619759b2cfaa6f4d0"
    assert metadata["runtime_strategy_name"] == "microbar-cross-sectional-pairs-v1"
    assert metadata["account_label"] == "TORGHUT_SIM"
    assert metadata["observed_stage"] == "paper"
    assert metadata["bounded_collection_stage"] == "bounded_paper_collection"
    assert row.status == "planned"


def test_order_executor_target_plan_source_refresh_helpers_cover_missing_refs() -> None:
    new_payload = {
        "params": {
            "paper_route_target_plan_source_decision": {
                "mode": "paper_route_target_plan_source_decision",
                "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "account_label": "TORGHUT_SIM",
                "bounded_collection_stage": "bounded_paper_collection",
            },
        },
    }

    assert _target_plan_source_decision_mode({}) is None
    assert _target_plan_ref_value({}, "hypothesis_id") is None
    assert _target_plan_source_decision_needs_refresh({}, new_payload) is True
    assert (
        _target_plan_source_decision_needs_refresh(
            {
                "params": {
                    "paper_route_target_plan_source_decision": {
                        "mode": "paper_route_target_plan_source_decision",
                        "source_decision_mode": "artifact_only",
                    }
                }
            },
            new_payload,
        )
        is True
    )
    assert (
        _target_plan_source_decision_needs_refresh(
            {
                "params": {
                    "paper_route_target_plan_source_decision": {
                        "mode": "paper_route_target_plan_source_decision",
                        "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "other-candidate",
                        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                        "account_label": "TORGHUT_SIM",
                        "bounded_collection_stage": "bounded_paper_collection",
                    }
                }
            },
            new_payload,
        )
        is True
    )


def test_target_plan_source_materialization_blockers_are_fail_closed() -> None:
    identity = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": None,
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
    }
    blockers = _paper_route_source_materialization_blockers(
        {
            "params": {"final_promotion_allowed": False},
            "paper_route_target_plan": {
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "account_label": "TORGHUT_SIM",
                "bounded_collection_stage": "bounded_paper_collection",
                "source_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
            },
            "final_promotion_allowed": False,
        },
        identity=identity,
    )

    assert "paper_route_target_plan_expected_candidate_id_missing" in blockers
    assert "paper_route_source_decision_mode_missing" in blockers


def test_target_plan_source_decision_refresh_guards_status_and_account(
    db_session: Session,
) -> None:
    strategy = db_session.execute(select(Strategy)).scalar_one()
    identity = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
    }
    wrong_account = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="OTHER",
        symbol="AAPL",
        timeframe="1Min",
        decision_json={},
        rationale="wrong account",
        decision_hash="wrong-account",
        status="planned",
    )
    executed = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="TORGHUT_SIM",
        symbol="AAPL",
        timeframe="1Min",
        decision_json={},
        rationale="already executed",
        decision_hash="executed",
        status="executed",
    )

    assert (
        _paper_route_source_decision_needs_refresh(
            wrong_account,
            identity=identity,
        )
        is True
    )
    assert (
        _paper_route_source_decision_needs_refresh(
            executed,
            identity=identity,
        )
        is False
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
