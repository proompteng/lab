from __future__ import annotations


import json
import inspect
import os
import time
from collections.abc import Iterator
from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

from app import bootstrap as app_bootstrap
from app.api import health_checks as health_checks_api
from app.api import health_cache_state, proof_contracts
from app.api import maintenance as maintenance_api
from app.api import proof_floor_payloads as proof_floor_payloads_api
from app.api import proofs as proofs_api
from app.api import status_helpers as status_helpers_api
from app.api import trading_misc as trading_misc_api
from app.api.readiness_helpers import readiness_surface as readiness_surface_helpers
from app.db import get_session
from app.main import app
from app.trading.paper_route_target_plan import (
    fetch_paper_route_target_plan_url as shared_fetch_paper_route_target_plan_url,
    paper_route_target_plan_probe_symbols,
)
from app.trading.proofs.targets import (
    next_regular_equities_session_window as _next_regular_equities_session_window,
)
from app.trading.forecast_runtime import forecast_registry
from app.trading.scheduler import TradingScheduler
from app.trading.feature_quality import FeatureQualityReport
from app.trading.completion import (
    DOC29_SIMULATION_FULL_DAY_GATE,
    TRACE_STATUS_SATISFIED,
    build_completion_trace,
    persist_completion_trace,
)
from app.trading.execution import OrderExecutor
from app.config import settings
from app.trading.hypotheses import JangarDependencyQuorumStatus
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    Execution,
    ExecutionTCAMetric,
    LLMDecisionReview,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TradeDecision,
    VNextEmpiricalJobRun,
)

_ALPACA_HEALTH_STATE = health_cache_state.ALPACA_HEALTH_STATE
_OPTIONS_CATALOG_FRESHNESS_CACHE = health_cache_state.OPTIONS_CATALOG_FRESHNESS_CACHE
_TRADING_DEPENDENCY_HEALTH_CACHE = health_cache_state.TRADING_DEPENDENCY_HEALTH_CACHE
_assert_dspy_cutover_migration_guard = app_bootstrap.assert_dspy_cutover_migration_guard
_build_hypothesis_runtime_payload = health_checks_api.build_hypothesis_runtime_payload
_build_live_submission_gate_payload = (
    health_checks_api.build_api_live_submission_gate_payload
)
_build_route_image_proof_summary = (
    proof_floor_payloads_api.build_route_image_proof_summary
)
_check_alpaca = health_checks_api.check_alpaca_dependency
_daily_runtime_ledger_portfolio_summary = (
    trading_misc_api.daily_runtime_ledger_portfolio_summary
)
_decimal_or_none = health_checks_api.decimal_or_none
_fetch_paper_route_target_plan_url = proofs_api._fetch_paper_route_target_plan_url
_forecast_service_status = health_checks_api.forecast_service_status
_load_external_paper_route_target_plan = (
    proofs_api._load_external_paper_route_target_plan
)
_load_options_catalog_freshness_summary = (
    health_checks_api.load_options_catalog_freshness_summary
)
_load_rejected_signal_outcome_learning_summary = (
    proof_floor_payloads_api.load_rejected_signal_outcome_learning_summary
)
_merge_external_paper_route_target_plan = (
    proofs_api._merge_external_paper_route_target_plan
)
_paper_route_target_plan_from_payload = proofs_api._paper_route_target_plan_from_payload
_readiness_dependency_cache_key = (
    readiness_surface_helpers.readiness_dependency_cache_key
)
_readiness_dependency_checks = readiness_surface_helpers.readiness_dependency_checks
_retryable_tca_recompute_error = proof_contracts.retryable_tca_recompute_error
_route_claim_symbols = health_checks_api.route_claim_symbols
_route_continuity_packet_for_proof_floor = (
    proof_floor_payloads_api.route_continuity_packet_for_proof_floor
)
healthz = app_bootstrap.healthz


def _truthful_empirical_payload(
    *,
    job_run_id: str,
    dataset_snapshot_ref: str,
) -> dict[str, object]:
    return {
        "promotion_authority_eligible": True,
        "artifact_authority": {
            "provenance": "historical_market_replay",
            "maturity": "empirically_validated",
            "authoritative": True,
            "placeholder": False,
        },
        "lineage": {
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "job_run_id": job_run_id,
            "runtime_version_refs": ["services/torghut@sha256:abc"],
            "model_refs": ["models/candidate@sha256:def"],
        },
    }


def _install_pipeline_universe_resolver(
    scheduler: TradingScheduler,
    resolver: object,
) -> None:
    setattr(scheduler, "_pipeline", SimpleNamespace(universe_resolver=resolver))


def _paper_route_pre_session_snapshot_as_of(generated_at: datetime) -> datetime:
    window_start, _ = _next_regular_equities_session_window(generated_at)
    return window_start - timedelta(minutes=15)


def _freshness_carry_ledger_for_test(dimension_id: str) -> dict[str, object]:
    output_receipt_by_dimension = {
        "empirical": "torghut.empirical-proof-refresh-receipt.v1",
        "tca": "torghut.execution-tca-refresh-receipt.v1",
    }
    value_gate_by_dimension = {
        "empirical": "post_cost_daily_net_pnl",
        "tca": "fill_tca_or_slippage_quality",
    }
    return {
        "schema_version": "torghut.freshness-carry-ledger.v1",
        "ledger_id": "freshness-carry-ledger:test",
        "dimensions": [
            {
                "dimension_id": dimension_id,
                "state": "stale",
                "proof_authority": "app_health",
                "stale_reason_codes": [f"{dimension_id}_stale"],
            }
        ],
        "repair_proof_slos": [
            {
                "repair_id": f"freshness-repair-slo:{dimension_id}",
                "target_dimension_id": dimension_id,
                "target_value_gate": value_gate_by_dimension[dimension_id],
                "required_output_receipts": [output_receipt_by_dimension[dimension_id]],
                "dispatchable": True,
                "hold_reason_codes": [],
            }
        ],
    }


def _mark_static_universe_loaded(scheduler: TradingScheduler) -> None:
    scheduler.state.universe_source_status = "ok"
    scheduler.state.universe_source_reason = "static_symbols_loaded"
    scheduler.state.universe_symbols_count = 2
    scheduler.state.universe_cache_age_seconds = 0


def _json_paths_containing(value: object, needle: str, path: str = "") -> list[str]:
    needle = needle.lower()
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_path = f"{path}.{key}" if path else str(key)
            if needle in str(key).lower():
                paths.append(key_path)
            paths.extend(_json_paths_containing(child, needle, key_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(_json_paths_containing(child, needle, f"{path}[{index}]"))
    elif needle in str(value).lower():
        paths.append(path)
    return paths


def _json_truthy_paths_for_keys(
    value: object,
    keys: set[str],
    path: str = "",
) -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_path = f"{path}.{key}" if path else str(key)
            if key in keys and child is True:
                paths.append(key_path)
            paths.extend(_json_truthy_paths_for_keys(child, keys, key_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(_json_truthy_paths_for_keys(child, keys, f"{path}[{index}]"))
    return paths


class _MappingRows:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def one(self) -> dict[str, object]:
        return self._rows[0]

    def first(self) -> dict[str, object] | None:
        return self._rows[0] if self._rows else None

    def __iter__(self) -> Iterator[dict[str, object]]:
        return iter(self._rows)


class _ExecuteResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def mappings(self) -> _MappingRows:
        return _MappingRows(self._rows)


class _ScalarExecuteResult:
    def __init__(self, rows: list[object]) -> None:
        self._rows = rows

    def scalars(self) -> Iterator[object]:
        return iter(self._rows)


class _OptionsFreshnessSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        statement_text = str(statement)
        self.calls.append((statement_text, params))
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        if "GROUP BY underlying_symbol" in statement_text:
            return _ExecuteResult(
                [
                    {
                        "underlying_symbol": "AAPL",
                        "active_contracts": 4,
                        "newest_last_seen_ts": datetime(
                            2026, 5, 12, tzinfo=timezone.utc
                        ),
                        "missing_provider_updated_ts_count": 0,
                        "newest_provider_updated_ts": datetime(
                            2026, 5, 12, tzinfo=timezone.utc
                        ),
                        "missing_close_price_count": 0,
                        "zero_open_interest_count": 0,
                    },
                    {
                        "underlying_symbol": "MSFT",
                        "active_contracts": 2,
                        "newest_last_seen_ts": datetime(
                            2026, 5, 12, tzinfo=timezone.utc
                        ),
                        "missing_provider_updated_ts_count": 2,
                        "newest_provider_updated_ts": None,
                        "missing_close_price_count": 1,
                        "zero_open_interest_count": 1,
                    },
                ]
            )
        return _ExecuteResult(
            [
                {
                    "underlying_symbol": f"SYM{idx}",
                    "last_seen_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "provider_updated_ts": (
                        datetime(2026, 5, 12, tzinfo=timezone.utc) if idx < 4 else None
                    ),
                    "close_price": Decimal("1") if idx != 5 else None,
                    "open_interest": Decimal("10") if idx != 4 else Decimal("0"),
                }
                for idx in range(6)
            ]
        )


class _FailingOptionsFreshnessSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        self.calls.append((str(statement), params))
        raise SQLAlchemyError("statement timeout")


class _TimedOutAggregateOptionsFreshnessSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        statement_text = str(statement)
        self.calls.append((statement_text, params))
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        if "GROUP BY underlying_symbol" in statement_text:
            raise SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            )
        if "LIMIT 1" in statement_text:
            return _ExecuteResult(
                [
                    {
                        "underlying_symbol": "AAPL",
                        "last_seen_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                        "provider_updated_ts": datetime(
                            2026, 5, 12, tzinfo=timezone.utc
                        ),
                        "close_price": Decimal("182.10"),
                        "open_interest": Decimal("100"),
                    }
                ]
            )
        return _ExecuteResult([])


class _FallbackOptionsFreshnessSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        statement_text = str(statement)
        self.calls.append((statement_text, params))
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        if "GROUP BY underlying_symbol" in statement_text:
            raise SQLAlchemyError("catalog aggregate unavailable")
        if "LIMIT 1" in statement_text:
            symbol = None
            if isinstance(params, dict):
                symbol = params.get("route_symbol")
            rows = {
                "AAPL": {
                    "underlying_symbol": "AAPL",
                    "last_seen_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "provider_updated_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "close_price": Decimal("182.10"),
                    "open_interest": Decimal("100"),
                }
            }
            row = rows.get(str(symbol or "").upper())
            return _ExecuteResult([row] if row is not None else [])
        return _ExecuteResult([])


class _FallbackOptionsFreshnessRequiresRollbackSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []
        self.rollback_count = 0
        self._transaction_failed = False

    def rollback(self) -> None:
        self.rollback_count += 1
        self._transaction_failed = False

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        statement_text = str(statement)
        self.calls.append((statement_text, params))
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        if "GROUP BY underlying_symbol" in statement_text:
            self._transaction_failed = True
            raise SQLAlchemyError("catalog aggregate unavailable")
        if "LIMIT 1" in statement_text:
            if self._transaction_failed:
                raise SQLAlchemyError("current transaction is aborted")
            symbol = None
            if isinstance(params, dict):
                symbol = params.get("route_symbol")
            if str(symbol or "").upper() != "AAPL":
                return _ExecuteResult([])
            return _ExecuteResult(
                [
                    {
                        "underlying_symbol": "AAPL",
                        "last_seen_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                        "provider_updated_ts": datetime(
                            2026, 5, 12, tzinfo=timezone.utc
                        ),
                        "close_price": Decimal("182.10"),
                        "open_interest": Decimal("100"),
                    }
                ]
            )
        return _ExecuteResult([])


class _FallbackOptionsFreshnessBlankSymbolSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        statement_text = str(statement)
        self.calls.append((statement_text, params))
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        if "GROUP BY underlying_symbol" in statement_text:
            raise SQLAlchemyError("catalog aggregate unavailable")
        if "LIMIT 1" in statement_text:
            symbol = None
            if isinstance(params, dict):
                symbol = params.get("route_symbol")
            rows = {
                "AAPL": {
                    "underlying_symbol": " ",
                    "last_seen_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "provider_updated_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "close_price": Decimal("182.10"),
                    "open_interest": Decimal("100"),
                },
                "MSFT": {
                    "underlying_symbol": "MSFT",
                    "last_seen_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "provider_updated_ts": datetime(2026, 5, 12, tzinfo=timezone.utc),
                    "close_price": None,
                    "open_interest": None,
                },
            }
            row = rows.get(str(symbol or "").upper())
            return _ExecuteResult([row] if row is not None else [])
        return _ExecuteResult([])


class _TimedOutBoundedOptionsFreshnessSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object | None]] = []

    def execute(
        self, statement: object, params: object | None = None
    ) -> _ExecuteResult:
        statement_text = str(statement)
        self.calls.append((statement_text, params))
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        if "LIMIT 1" in statement_text:
            raise SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            )
        return _ExecuteResult([])


class _PostgresReadinessSession:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.rollback_count = 0

    def get_bind(self) -> object:
        return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

    def execute(self, statement: object, params: object | None = None) -> object:
        _ = params
        self.calls.append(str(statement))
        return _ExecuteResult([])

    def rollback(self) -> None:
        self.rollback_count += 1


class _PostgresRuntimeLedgerPortfolioSummarySession:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_bind(self) -> object:
        return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

    def execute(self, statement: object, params: object | None = None) -> object:
        _ = params
        statement_text = str(statement)
        self.calls.append(statement_text)
        if statement_text.startswith("SET LOCAL"):
            return _ExecuteResult([])
        return _ScalarExecuteResult([])


class TradingApiTestCaseBase(TestCase):
    def setUp(self) -> None:
        previous_command_token = settings.torghut_command_api_token
        settings.torghut_command_api_token = "test-command-token"
        self.addCleanup(
            setattr,
            settings,
            "torghut_command_api_token",
            previous_command_token,
        )
        self._clear_trading_health_surface_cache()
        _TRADING_DEPENDENCY_HEALTH_CACHE.clear()
        _ALPACA_HEALTH_STATE.clear()
        _OPTIONS_CATALOG_FRESHNESS_CACHE.clear()
        if hasattr(app.state, "trading_scheduler"):
            del app.state.trading_scheduler
        self.addCleanup(self._clear_trading_scheduler_state)
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        for session_local_target in (
            "app.bootstrap.SessionLocal",
            "app.api.health_checks.shared_context.SessionLocal",
            "app.api.health_checks.load_options_catalog_freshness_summary.SessionLocal",
            "app.api.health_checks.remember_alpaca_success.SessionLocal",
            "app.api.maintenance.SessionLocal",
            "app.api.proofs.SessionLocal",
            "app.api.readiness_helpers.evaluate_trading_health_payload.SessionLocal",
            "app.api.readiness_helpers.refresh_universe_state_for_readiness.SessionLocal",
            "app.api.readiness_helpers.readiness_surface.SessionLocal",
            "app.api.trading_status.SessionLocal",
            "app.api.status_helpers.SessionLocal",
            "app.api.trading_misc.consumer_evidence_payload.SessionLocal",
            "app.api.vnext_helpers.SessionLocal",
        ):
            session_local_patch = patch(session_local_target, self.session_local)
            session_local_patch.start()
            self.addCleanup(session_local_patch.stop)

        def _override_session() -> Session:
            with self.session_local() as session:
                yield session

        app.dependency_overrides[get_session] = _override_session
        self.client = TestClient(
            app,
            headers={"Authorization": "Bearer test-command-token"},
        )

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()

            session.refresh(strategy)

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "buy", "qty": "1", "params": {"price": "100"}},
                rationale="demo",
                status="planned",
                created_at=datetime.now(timezone.utc),
            )
            session.add(decision)
            session.commit()

            session.refresh(decision)

            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-1",
                client_order_id="client-1",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                avg_fill_price=None,
                execution_correlation_id="corr-1",
                execution_idempotency_key="idem-1",
                status="accepted",
                raw_order={},
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)

            tca = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id,
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=Decimal("101"),
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                slippage_bps=Decimal("100"),
                shortfall_notional=Decimal("1"),
                expected_shortfall_bps_p50=Decimal("3.5"),
                expected_shortfall_bps_p95=Decimal("5.0"),
                realized_shortfall_bps=Decimal("1.2"),
                divergence_bps=Decimal("0.7"),
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
            )
            session.add(tca)
            session.commit()

            review = LLMDecisionReview(
                trade_decision_id=decision.id,
                model="demo",
                prompt_version="v1",
                input_json={"decision": "demo"},
                response_json={"verdict": "approve"},
                verdict="approve",
                confidence=Decimal("0.7"),
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale="ok",
                risk_flags=["demo_flag"],
                tokens_prompt=120,
                tokens_completion=45,
                created_at=datetime.now(timezone.utc),
            )
            session.add(review)
            session.commit()

            now = datetime.now(timezone.utc)
            session.add(
                PositionSnapshot(
                    alpaca_account_label="TORGHUT_SIM",
                    as_of=_paper_route_pre_session_snapshot_as_of(now),
                    equity=Decimal("100000"),
                    cash=Decimal("100000"),
                    buying_power=Decimal("200000"),
                    positions=[],
                )
            )
            session.commit()

    def _clear_trading_scheduler_state(self) -> None:
        if hasattr(app.state, "trading_scheduler"):
            del app.state.trading_scheduler

    def _clear_trading_health_surface_cache(self) -> None:
        with health_cache_state.TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            refresh_futures = list(
                health_cache_state.TRADING_HEALTH_SURFACE_EVALUATIONS.values()
            )
            health_cache_state.TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            health_cache_state.TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()
        for refresh_future in refresh_futures:
            refresh_future.cancel()

    def _enable_exact_options_catalog_route_scope(self) -> None:
        original_exact_scope = (
            settings.trading_options_catalog_freshness_exact_route_scope_enabled
        )
        settings.trading_options_catalog_freshness_exact_route_scope_enabled = True
        self.addCleanup(
            setattr,
            settings,
            "trading_options_catalog_freshness_exact_route_scope_enabled",
            original_exact_scope,
        )


__all__: tuple[str, ...] = (
    "Any",
    "AutoresearchCandidateSpec",
    "AutoresearchEpoch",
    "AutoresearchPortfolioCandidate",
    "AutoresearchProposalScore",
    "Base",
    "DOC29_SIMULATION_FULL_DAY_GATE",
    "Decimal",
    "Event",
    "Execution",
    "ExecutionTCAMetric",
    "FeatureQualityReport",
    "Future",
    "Iterator",
    "JangarDependencyQuorumStatus",
    "LLMDecisionReview",
    "OperationalError",
    "OrderExecutor",
    "Path",
    "PositionSnapshot",
    "RejectedSignalOutcomeEvent",
    "SQLAlchemyError",
    "Session",
    "SimpleNamespace",
    "StaticPool",
    "Strategy",
    "StrategyHypothesisMetricWindow",
    "StrategyPromotionDecision",
    "TRACE_STATUS_SATISFIED",
    "TemporaryDirectory",
    "TestCase",
    "TestClient",
    "TradeDecision",
    "TradingApiTestCaseBase",
    "TradingScheduler",
    "VNextEmpiricalJobRun",
    "_ALPACA_HEALTH_STATE",
    "_ExecuteResult",
    "_FailingOptionsFreshnessSession",
    "_FallbackOptionsFreshnessBlankSymbolSession",
    "_FallbackOptionsFreshnessRequiresRollbackSession",
    "_FallbackOptionsFreshnessSession",
    "_MappingRows",
    "_OPTIONS_CATALOG_FRESHNESS_CACHE",
    "_OptionsFreshnessSession",
    "_PostgresReadinessSession",
    "_PostgresRuntimeLedgerPortfolioSummarySession",
    "_ScalarExecuteResult",
    "_TRADING_DEPENDENCY_HEALTH_CACHE",
    "_TimedOutAggregateOptionsFreshnessSession",
    "_TimedOutBoundedOptionsFreshnessSession",
    "_assert_dspy_cutover_migration_guard",
    "_build_hypothesis_runtime_payload",
    "_build_live_submission_gate_payload",
    "_build_route_image_proof_summary",
    "_check_alpaca",
    "_daily_runtime_ledger_portfolio_summary",
    "_decimal_or_none",
    "_fetch_paper_route_target_plan_url",
    "_forecast_service_status",
    "_freshness_carry_ledger_for_test",
    "_install_pipeline_universe_resolver",
    "_json_paths_containing",
    "_json_truthy_paths_for_keys",
    "_load_external_paper_route_target_plan",
    "_load_options_catalog_freshness_summary",
    "_load_rejected_signal_outcome_learning_summary",
    "_mark_static_universe_loaded",
    "_merge_external_paper_route_target_plan",
    "_next_regular_equities_session_window",
    "_paper_route_pre_session_snapshot_as_of",
    "_paper_route_target_plan_from_payload",
    "_readiness_dependency_cache_key",
    "_readiness_dependency_checks",
    "_retryable_tca_recompute_error",
    "_route_claim_symbols",
    "_route_continuity_packet_for_proof_floor",
    "_truthful_empirical_payload",
    "app",
    "app_bootstrap",
    "build_completion_trace",
    "create_engine",
    "datetime",
    "forecast_registry",
    "get_session",
    "health_cache_state",
    "health_checks_api",
    "healthz",
    "inspect",
    "json",
    "maintenance_api",
    "os",
    "paper_route_target_plan_probe_symbols",
    "patch",
    "persist_completion_trace",
    "proof_floor_payloads_api",
    "proofs_api",
    "select",
    "sessionmaker",
    "settings",
    "shared_fetch_paper_route_target_plan_url",
    "status_helpers_api",
    "time",
    "timedelta",
    "timezone",
    "trading_misc_api",
    "urlsplit",
)
