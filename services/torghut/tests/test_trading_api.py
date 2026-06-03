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
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

import app.main as main_module
from app.db import get_session
from app.main import (
    _ALPACA_HEALTH_STATE,
    _OPTIONS_CATALOG_FRESHNESS_CACHE,
    _TRADING_DEPENDENCY_HEALTH_CACHE,
    _build_hypothesis_runtime_payload,
    _assert_dspy_cutover_migration_guard,
    _build_live_submission_gate_payload,
    _build_route_image_proof_summary,
    _check_alpaca,
    _daily_runtime_ledger_portfolio_summary,
    _decimal_or_none,
    _fetch_paper_route_target_plan_url,
    _forecast_service_status,
    _load_external_paper_route_target_plan,
    _paper_route_target_plan_from_payload,
    _load_rejected_signal_outcome_learning_summary,
    healthz,
    _load_options_catalog_freshness_summary,
    _merge_external_paper_route_target_plan,
    _readiness_dependency_cache_key,
    _readiness_dependency_checks,
    _route_continuity_packet_for_proof_floor,
    _route_claim_symbols,
    app,
)
from app.trading.paper_route_target_plan import (
    fetch_paper_route_target_plan_url as shared_fetch_paper_route_target_plan_url,
    paper_route_target_plan_probe_symbols,
)
from app.trading.paper_route_evidence import _next_regular_equities_session_window
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
    StrategyRuntimeLedgerBucket,
    TradeDecision,
    VNextEmpiricalJobRun,
)


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


class TestTradingApi(TestCase):
    def setUp(self) -> None:
        _TRADING_DEPENDENCY_HEALTH_CACHE.clear()
        _ALPACA_HEALTH_STATE.clear()
        _OPTIONS_CATALOG_FRESHNESS_CACHE.clear()
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
        session_local_patch = patch("app.main.SessionLocal", self.session_local)
        session_local_patch.start()
        self.addCleanup(session_local_patch.stop)

        def _override_session() -> Session:
            with self.session_local() as session:
                yield session

        app.dependency_overrides[get_session] = _override_session
        self.client = TestClient(app)

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

    def test_forecast_service_status_uses_empirical_job_lineage_when_registry_empty(
        self,
    ) -> None:
        original_manifest_path = settings.trading_forecast_registry_manifest_path
        original_manifest_url = settings.trading_forecast_registry_manifest_url
        settings.trading_forecast_registry_manifest_path = None
        settings.trading_forecast_registry_manifest_url = None
        forecast_registry.reset()
        self.addCleanup(forecast_registry.reset)
        self.addCleanup(
            setattr,
            settings,
            "trading_forecast_registry_manifest_path",
            original_manifest_path,
        )
        self.addCleanup(
            setattr,
            settings,
            "trading_forecast_registry_manifest_url",
            original_manifest_url,
        )

        status = _forecast_service_status(
            {
                "ready": True,
                "status": "healthy",
                "candidate_ids": ["chip-paper-microbar-composite@execution-proof"],
                "dataset_snapshot_refs": ["torghut-chip-full-day-20260505-4c330ce9-r1"],
                "model_refs": ["rules/intraday_tsmom_v1"],
            }
        )

        self.assertEqual(status["status"], "healthy")
        self.assertEqual(status["authority"], "empirical")
        self.assertEqual(status["message"], "empirical_jobs_ready")
        self.assertEqual(status["source"], "empirical_jobs")

    def tearDown(self) -> None:
        _TRADING_DEPENDENCY_HEALTH_CACHE.clear()
        _ALPACA_HEALTH_STATE.clear()
        app.dependency_overrides.clear()
        if hasattr(app.state, "trading_scheduler"):
            delattr(app.state, "trading_scheduler")

    def test_route_claim_symbols_extracts_valid_quorum_symbols(self) -> None:
        payload = {
            "quorums": [
                "not-a-mapping",
                {"route_tca_signal": "not-a-mapping"},
                {"route_tca_signal": {"details": "not-a-mapping"}},
                {"route_tca_signal": {"details": {"symbols": "AAPL"}}},
                {
                    "route_tca_signal": {
                        "details": {"symbols": [" aapl ", "", "MSFT", "aapl"]}
                    }
                },
                {
                    "symbols": ["tsla"],
                    "route_tca_signal": {
                        "details": {
                            "details": {"symbols": [" nvda ", "AAPL"]},
                        },
                    },
                },
            ]
        }

        self.assertEqual(_route_claim_symbols({}), ())
        self.assertEqual(
            _route_claim_symbols(payload), ("AAPL", "MSFT", "NVDA", "TSLA")
        )

    def test_options_catalog_freshness_summary_includes_route_symbol_scope(
        self,
    ) -> None:
        self._enable_exact_options_catalog_route_scope()
        fake_session = _OptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=[" aapl ", "MSFT", "AAPL", ""],
        )

        self.assertEqual(payload["scope"], "route_symbols")
        self.assertEqual(payload["route_symbols"], ["AAPL", "MSFT"])
        self.assertEqual(payload["active_contracts"], 6)
        route_scope = payload["route_symbol_freshness"]
        self.assertIsInstance(route_scope, dict)
        route_scope = dict(route_scope)
        self.assertTrue(route_scope["AAPL"]["provider_updated_ts_present"])
        self.assertFalse(route_scope["MSFT"]["provider_updated_ts_present"])
        self.assertEqual(route_scope["MSFT"]["missing_close_price_count"], 1)
        self.assertEqual(
            fake_session.calls[1][1],
            {"route_symbols": ("AAPL", "MSFT")},
        )
        self.assertIn("WHERE underlying_symbol IN", fake_session.calls[1][0])
        self.assertIn("AND status = 'active'", fake_session.calls[1][0])
        self.assertEqual(
            sum(
                "FROM torghut_options_contract_catalog" in sql
                for sql, _params in fake_session.calls
            ),
            1,
        )

    def test_options_catalog_freshness_summary_uses_bounded_route_scope_by_default(
        self,
    ) -> None:
        fake_session = _FallbackOptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL", "MSFT"],
        )

        self.assertEqual(payload["scope"], "route_symbols")
        self.assertEqual(payload["route_symbols"], ["AAPL", "MSFT"])
        self.assertTrue(payload["bounded"])
        self.assertFalse(payload["coverage_exact"])
        self.assertFalse(payload["active_contracts_exact"])
        self.assertEqual(payload["active_contracts"], 1)
        self.assertIn(
            "options_catalog_freshness_exact_route_scope_disabled",
            payload["reason_codes"],
        )
        self.assertEqual(
            sum(
                "GROUP BY underlying_symbol" in sql
                for sql, _params in fake_session.calls
            ),
            0,
        )
        self.assertEqual(
            sum("LIMIT 1" in sql for sql, _params in fake_session.calls),
            2,
        )

    def test_options_catalog_freshness_summary_uses_bounded_global_scan_without_route_scope(
        self,
    ) -> None:
        fake_session = _OptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
        )

        self.assertEqual(payload["scope"], "global")
        self.assertEqual(payload["active_contracts"], 6)
        self.assertFalse(payload["active_contracts_exact"])
        self.assertFalse(payload["coverage_exact"])
        self.assertEqual(payload["query_limit"], 200)
        self.assertEqual(payload["route_symbols"], [])
        self.assertIn("WHERE status = 'active'", fake_session.calls[1][0])
        self.assertIn("LIMIT 200", fake_session.calls[1][0])
        self.assertEqual(
            sum(
                "FROM torghut_options_contract_catalog" in sql
                for sql, _params in fake_session.calls
            ),
            1,
        )

    def test_daily_runtime_ledger_portfolio_summary_timeout_is_fail_closed(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                payload = _daily_runtime_ledger_portfolio_summary(
                    session=session,
                    account_label="TORGHUT_SIM",
                    stage_scope="paper",
                    observed_at=datetime(2026, 6, 1, 12, tzinfo=timezone.utc),
                )

        self.assertTrue(payload["read_model_unavailable"])
        self.assertEqual(payload["bucket_count"], 0)
        self.assertEqual(
            payload["blockers"], ["portfolio_runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(payload["query_limit"], 200)
        self.assertEqual(rollback.call_count, 1)

    def test_daily_runtime_ledger_portfolio_summary_uses_status_timeout(
        self,
    ) -> None:
        fake_session = _PostgresRuntimeLedgerPortfolioSummarySession()

        payload = _daily_runtime_ledger_portfolio_summary(
            session=fake_session,  # type: ignore[arg-type]
            account_label="TORGHUT_SIM",
            stage_scope="paper",
            observed_at=datetime(2026, 6, 1, 12, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["bucket_count"], 0)
        self.assertEqual(fake_session.calls[0], "SET LOCAL statement_timeout = 500")
        self.assertNotIn("statement_timeout = 5000", "\n".join(fake_session.calls))

    def test_tca_summary_uses_bounded_status_timeout(self) -> None:
        fake_session = _PostgresReadinessSession()

        with patch(
            "app.main.build_tca_gate_inputs",
            return_value={"order_count": 0},
        ) as build_tca:
            payload = main_module._load_tca_summary(
                fake_session,  # type: ignore[arg-type]
                scheduler=None,
            )

        self.assertEqual(payload["order_count"], 0)
        self.assertEqual(fake_session.calls[0], "SET LOCAL statement_timeout = 750")
        build_tca.assert_called_once()

    def test_llm_evaluation_uses_bounded_status_timeout(self) -> None:
        fake_session = _PostgresReadinessSession()

        with patch(
            "app.main.build_llm_evaluation_metrics",
            return_value={"ok": True, "metrics": {"total_reviews": 0}},
        ) as build_llm:
            payload = main_module._load_llm_evaluation(
                fake_session,  # type: ignore[arg-type]
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(fake_session.calls[0], "SET LOCAL statement_timeout = 500")
        build_llm.assert_called_once()

    def test_status_read_optional_hooks_fail_safely(self) -> None:
        class FailingRollbackSession:
            def rollback(self) -> None:
                raise SQLAlchemyError("rollback failed")

        class BrokenBindSession:
            def get_bind(self) -> object:
                raise RuntimeError("bind unavailable")

        class TimeoutSession(_PostgresReadinessSession):
            def execute(
                self, statement: object, params: object | None = None
            ) -> object:
                _ = params
                self.calls.append(str(statement))
                raise SQLAlchemyError("statement timeout")

        main_module._rollback_status_read_session(  # type: ignore[arg-type]
            SimpleNamespace(),
            context="missing rollback",
        )
        main_module._rollback_status_read_session(  # type: ignore[arg-type]
            FailingRollbackSession(),
            context="failing rollback",
        )
        main_module._apply_status_read_statement_timeout(  # type: ignore[arg-type]
            SimpleNamespace(),
            milliseconds=500,
        )
        main_module._apply_status_read_statement_timeout(  # type: ignore[arg-type]
            BrokenBindSession(),
            milliseconds=500,
        )
        with self.assertRaises(SQLAlchemyError):
            main_module._apply_status_read_statement_timeout(  # type: ignore[arg-type]
                TimeoutSession(),
                milliseconds=500,
            )

    def test_tca_summary_timeout_returns_unavailable_payload(self) -> None:
        fake_session = _PostgresReadinessSession()

        with patch(
            "app.main.build_tca_gate_inputs",
            side_effect=SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            ),
        ):
            payload = main_module._load_tca_summary(
                fake_session,  # type: ignore[arg-type]
                scheduler=None,
            )

        self.assertTrue(payload["read_model_unavailable"])
        self.assertEqual(
            payload["reason_codes"], ["execution_tca_summary_query_timeout"]
        )
        self.assertEqual(fake_session.rollback_count, 1)

    def test_llm_evaluation_timeout_returns_unavailable_payload(self) -> None:
        fake_session = _PostgresReadinessSession()

        with patch(
            "app.main.build_llm_evaluation_metrics",
            side_effect=SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            ),
        ):
            payload = main_module._load_llm_evaluation(
                fake_session,  # type: ignore[arg-type]
            )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["reason_codes"], ["llm_evaluation_query_timeout"])
        self.assertEqual(fake_session.rollback_count, 1)

    def test_hypothesis_runtime_summary_timeout_is_fail_closed(self) -> None:
        with patch(
            "app.main.build_hypothesis_runtime_summary",
            side_effect=SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            ),
        ):
            payload, summary, _quorum = main_module._build_hypothesis_runtime_payload(
                TradingScheduler(),
                tca_summary={},
                market_context_status={},
                feature_readiness={},
            )

        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["reason_codes"],
            ["hypothesis_runtime_summary_query_timeout"],
        )
        self.assertEqual(payload["items"], [])

    def test_options_catalog_freshness_summary_caches_unavailable_route_scope(
        self,
    ) -> None:
        original_cache_seconds = (
            settings.trading_options_catalog_freshness_cache_seconds
        )
        settings.trading_options_catalog_freshness_cache_seconds = 30
        self.addCleanup(
            setattr,
            settings,
            "trading_options_catalog_freshness_cache_seconds",
            original_cache_seconds,
        )
        fake_session = _FailingOptionsFreshnessSession()

        first = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL"],
        )
        second = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL"],
        )

        self.assertEqual(first["status"], "unavailable")
        self.assertEqual(second["status"], "unavailable")
        self.assertEqual(first["route_symbols"], ["AAPL"])
        self.assertEqual(second["route_symbols"], ["AAPL"])
        first_cache = first.get("cache")
        second_cache = second.get("cache")
        self.assertIsInstance(first_cache, dict)
        self.assertIsInstance(second_cache, dict)
        assert isinstance(first_cache, dict)
        assert isinstance(second_cache, dict)
        self.assertEqual(first_cache["hit"], False)
        self.assertEqual(second_cache["hit"], True)
        self.assertEqual(len(fake_session.calls), 1)
        self.assertIn(
            "options_catalog_freshness_exact_route_scope_disabled",
            first["reason_codes"],
        )

    def test_options_catalog_freshness_summary_falls_back_to_bounded_on_timeout(
        self,
    ) -> None:
        self._enable_exact_options_catalog_route_scope()
        fake_session = _TimedOutAggregateOptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL", "MSFT"],
        )

        self.assertEqual(payload["status"], "current")
        self.assertEqual(payload["scope"], "route_symbols")
        self.assertEqual(payload["route_symbols"], ["AAPL", "MSFT"])
        self.assertTrue(payload["bounded"])
        self.assertFalse(payload["coverage_exact"])
        self.assertFalse(payload["active_contracts_exact"])
        self.assertEqual(payload["active_contracts"], 2)
        self.assertIn(
            "options_catalog_freshness_bounded_route_scope",
            payload["reason_codes"],
        )
        self.assertIn(
            "options_catalog_freshness_query_timeout",
            payload["reason_codes"],
        )
        self.assertEqual(
            sum("LIMIT 1" in sql for sql, _params in fake_session.calls),
            2,
        )

    def test_options_catalog_freshness_summary_reports_bounded_timeout(
        self,
    ) -> None:
        fake_session = _TimedOutBoundedOptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL", "MSFT"],
        )

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["scope"], "route_symbols")
        self.assertEqual(payload["route_symbols"], ["AAPL", "MSFT"])
        self.assertIn(
            "options_catalog_freshness_exact_route_scope_disabled",
            payload["reason_codes"],
        )
        self.assertIn(
            "options_catalog_freshness_bounded_route_scope_timeout",
            payload["reason_codes"],
        )
        self.assertIn(
            "options_catalog_freshness_bounded_route_scope_unavailable",
            payload["reason_codes"],
        )
        self.assertEqual(
            sum("LIMIT 1" in sql for sql, _params in fake_session.calls),
            1,
        )

    def test_options_catalog_freshness_summary_expires_cached_route_scope(
        self,
    ) -> None:
        self._enable_exact_options_catalog_route_scope()
        original_cache_seconds = (
            settings.trading_options_catalog_freshness_cache_seconds
        )
        settings.trading_options_catalog_freshness_cache_seconds = 1
        self.addCleanup(
            setattr,
            settings,
            "trading_options_catalog_freshness_cache_seconds",
            original_cache_seconds,
        )
        _OPTIONS_CATALOG_FRESHNESS_CACHE[(("AAPL",),)] = (
            datetime.now(timezone.utc) - timedelta(seconds=2),
            {
                "status": "unavailable",
                "scope": "route_symbols",
                "route_symbols": ["AAPL"],
                "reason": "old",
            },
        )
        fake_session = _OptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL"],
        )

        self.assertEqual(payload["status"], "current")
        self.assertEqual(payload["scope"], "route_symbols")
        self.assertEqual(payload["route_symbols"], ["AAPL"])
        self.assertEqual(
            sum(
                "FROM torghut_options_contract_catalog" in sql
                for sql, _params in fake_session.calls
            ),
            1,
        )
        cache = payload.get("cache")
        self.assertIsInstance(cache, dict)
        assert isinstance(cache, dict)
        self.assertEqual(cache["hit"], False)

    def test_options_catalog_freshness_summary_falls_back_to_bounded_route_scope(
        self,
    ) -> None:
        self._enable_exact_options_catalog_route_scope()
        fake_session = _FallbackOptionsFreshnessSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL", "MSFT"],
        )

        self.assertEqual(payload["status"], "current")
        self.assertEqual(payload["scope"], "route_symbols")
        self.assertEqual(payload["route_symbols"], ["AAPL", "MSFT"])
        self.assertTrue(payload["bounded"])
        self.assertFalse(payload["coverage_exact"])
        self.assertFalse(payload["active_contracts_exact"])
        self.assertEqual(payload["active_contracts"], 1)
        self.assertFalse(payload["provider_updated_ts_present"])
        self.assertEqual(payload["missing_provider_updated_ts_count"], 1)
        self.assertIn(
            "options_catalog_freshness_bounded_route_scope",
            payload["reason_codes"],
        )
        route_scope = payload["route_symbol_freshness"]
        self.assertIsInstance(route_scope, dict)
        route_scope = dict(route_scope)
        self.assertEqual(set(route_scope), {"AAPL"})
        self.assertFalse(route_scope["AAPL"]["provider_updated_ts_present"])
        self.assertEqual(route_scope["AAPL"]["missing_provider_updated_ts_count"], 1)
        self.assertTrue(route_scope["AAPL"]["bounded"])
        self.assertFalse(route_scope["AAPL"]["coverage_exact"])
        self.assertEqual(
            sum("LIMIT 1" in sql for sql, _params in fake_session.calls),
            2,
        )

    def test_options_catalog_freshness_summary_rolls_back_before_bounded_fallback(
        self,
    ) -> None:
        self._enable_exact_options_catalog_route_scope()
        fake_session = _FallbackOptionsFreshnessRequiresRollbackSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL"],
        )

        self.assertEqual(payload["status"], "current")
        self.assertTrue(payload["bounded"])
        self.assertEqual(payload["active_contracts"], 1)
        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(
            sum("LIMIT 1" in sql for sql, _params in fake_session.calls),
            1,
        )

    def test_options_catalog_freshness_bounded_fallback_skips_blank_symbols(
        self,
    ) -> None:
        self._enable_exact_options_catalog_route_scope()
        fake_session = _FallbackOptionsFreshnessBlankSymbolSession()

        payload = _load_options_catalog_freshness_summary(
            fake_session,  # type: ignore[arg-type]
            route_symbols=["AAPL", "MSFT"],
        )

        self.assertEqual(payload["status"], "current")
        self.assertTrue(payload["bounded"])
        self.assertEqual(payload["active_contracts"], 2)
        self.assertEqual(payload["missing_close_price_count"], 1)
        self.assertEqual(payload["zero_open_interest_count"], 1)
        route_scope = payload["route_symbol_freshness"]
        self.assertIsInstance(route_scope, dict)
        route_scope = dict(route_scope)
        self.assertEqual(set(route_scope), {"MSFT"})
        self.assertEqual(route_scope["MSFT"]["missing_close_price_count"], 1)
        self.assertEqual(route_scope["MSFT"]["zero_open_interest_count"], 1)

    def test_tigerbeetle_ledger_status_fails_closed_on_ref_count_timeout(
        self,
    ) -> None:
        original_required = settings.tigerbeetle_required
        original_reconcile_required = settings.tigerbeetle_reconcile_required
        settings.tigerbeetle_required = True
        settings.tigerbeetle_reconcile_required = True
        fake_session = _PostgresReadinessSession()
        try:
            with (
                patch(
                    "app.main._check_tigerbeetle_protocol_health",
                    return_value={"ok": True, "protocol_ok": True},
                ),
                patch(
                    "app.main.latest_tigerbeetle_reconciliation_payload",
                    return_value={
                        "ok": True,
                        "age_seconds": 1,
                        "blockers": [],
                    },
                ),
                patch(
                    "app.main.tigerbeetle_ref_counts",
                    side_effect=SQLAlchemyError(
                        "QueryCanceled: canceling statement due to statement timeout"
                    ),
                ),
            ):
                payload = main_module._build_tigerbeetle_ledger_status(
                    fake_session,  # type: ignore[arg-type]
                )
        finally:
            settings.tigerbeetle_required = original_required
            settings.tigerbeetle_reconcile_required = original_reconcile_required

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn("tigerbeetle_ref_counts_unavailable", payload["blockers"])
        self.assertIn("tigerbeetle_ref_counts_query_timeout", payload["blockers"])
        ref_counts = payload["ref_counts"]
        self.assertIsInstance(ref_counts, dict)
        assert isinstance(ref_counts, dict)
        self.assertTrue(ref_counts["ref_counts_unavailable"])
        self.assertIn(
            "tigerbeetle_ref_counts_query_timeout",
            ref_counts["reason_codes"],
        )
        self.assertGreaterEqual(fake_session.rollback_count, 1)

    def test_tigerbeetle_ledger_status_fails_closed_on_reconciliation_timeout(
        self,
    ) -> None:
        original_required = settings.tigerbeetle_required
        original_reconcile_required = settings.tigerbeetle_reconcile_required
        settings.tigerbeetle_required = True
        settings.tigerbeetle_reconcile_required = True
        fake_session = _PostgresReadinessSession()
        try:
            with (
                patch(
                    "app.main._check_tigerbeetle_protocol_health",
                    return_value={"ok": True, "protocol_ok": True},
                ),
                patch(
                    "app.main.latest_tigerbeetle_reconciliation_payload",
                    side_effect=SQLAlchemyError(
                        "QueryCanceled: canceling statement due to statement timeout"
                    ),
                ),
                patch(
                    "app.main.tigerbeetle_ref_counts",
                    return_value={
                        "account_ref_count": 1,
                        "transfer_ref_count": 1,
                        "runtime_ledger_ref_count": 1,
                        "runtime_ledger_signed_ref_count": 1,
                        "runtime_ledger_missing_signed_ref_count": 0,
                        "runtime_ledger_missing_account_ref_count": 0,
                        "source_materialization": {},
                    },
                ),
            ):
                payload = main_module._build_tigerbeetle_ledger_status(
                    fake_session,  # type: ignore[arg-type]
                )
        finally:
            settings.tigerbeetle_required = original_required
            settings.tigerbeetle_reconcile_required = original_reconcile_required

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn(
            "tigerbeetle_reconciliation_status_unavailable",
            payload["blockers"],
        )
        self.assertIn(
            "tigerbeetle_reconciliation_status_query_timeout",
            payload["blockers"],
        )
        latest_reconciliation = payload["latest_reconciliation"]
        self.assertIsInstance(latest_reconciliation, dict)
        assert isinstance(latest_reconciliation, dict)
        self.assertFalse(latest_reconciliation["ok"])
        self.assertEqual(latest_reconciliation["status"], "unavailable")
        self.assertIn(
            "tigerbeetle_reconciliation_status_query_timeout",
            latest_reconciliation["reason_codes"],
        )
        self.assertGreaterEqual(fake_session.rollback_count, 1)

    def test_decimal_or_none_handles_missing_and_unparseable_values(self) -> None:
        self.assertIsNone(_decimal_or_none(None))
        self.assertIsNone(_decimal_or_none(object()))
        self.assertEqual(_decimal_or_none("1.25"), Decimal("1.25"))

    def test_route_image_proof_summary_preserves_route_workload_status(self) -> None:
        payload = _build_route_image_proof_summary(
            build={"image_digest": "sha256:fallback", "active_revision": "build-rev"},
            dependency_quorum={
                "rollout_image_book": {
                    "image_digest": "sha256:ready",
                    "active_revision": "runtime-rev",
                    "state": "current",
                    "route_workloads_ok": False,
                    "reason_codes": ["route_adjacent_workloads_degraded"],
                }
            },
        )

        self.assertEqual(payload["image_digest"], "sha256:ready")
        self.assertEqual(payload["route_workloads_ok"], False)

    def test_healthz_handler_stays_async_for_liveness_probe(self) -> None:
        self.assertTrue(inspect.iscoroutinefunction(healthz))

        response = self.client.get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "torghut"})

    def test_trading_decisions_endpoint(self) -> None:
        response = self.client.get("/trading/decisions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")

    def test_autoresearch_epoch_endpoints(self) -> None:
        with self.session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="ok",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=["paper-1"],
                    snapshot_manifest_json={"source_count": 1},
                    runner_config_json={"replay_mode": "synthetic"},
                    summary_json={
                        "best": "portfolio-1",
                        "claim_count": 2,
                        "hypothesis_count": 1,
                        "candidate_spec_count": 1,
                        "evidence_bundle_count": 1,
                        "portfolio_candidate_count": 1,
                        "mlx_rank_bucket_lift": {"lift_net_pnl_per_day": "10"},
                        "false_positive_table": [{"candidate_spec_id": "spec-fp"}],
                        "best_false_negative_table": [{"candidate_spec_id": "spec-fn"}],
                        "promotion_readiness": {
                            "blockers": ["scheduler_v3_parity_missing"]
                        },
                    },
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="hyp-1",
                    candidate_kind="sleeve",
                    family_template_id="microbar_cross_sectional_pairs_v1",
                    payload_json={"candidate_spec_id": "spec-1"},
                    payload_hash="hash",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-1",
                    candidate_spec_id="spec-1",
                    model_id="model-1",
                    backend="numpy-fallback",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={"rank": 1},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["cand-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "target_met": True,
                        "net_pnl_per_day": "535",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                    },
                    optimizer_report_json={"selected_count": 1},
                    payload_json={
                        "portfolio_candidate_id": "portfolio-1",
                        "sleeves": [{"candidate_id": "cand-1"}],
                    },
                    status="target_met",
                )
            )
            session.commit()

        list_response = self.client.get("/trading/autoresearch/epochs")
        self.assertEqual(list_response.status_code, 200)
        list_payload = list_response.json()
        self.assertEqual(list_payload["count"], 1)
        self.assertEqual(list_payload["epochs"][0]["epoch_id"], "epoch-1")
        self.assertEqual(
            list_payload["epochs"][0]["best_portfolio_net_pnl_per_day"], "535"
        )
        self.assertEqual(list_payload["epochs"][0]["claim_count"], 2)
        self.assertEqual(
            list_payload["epochs"][0]["false_positive_table"][0]["candidate_spec_id"],
            "spec-fp",
        )
        self.assertEqual(
            list_payload["epochs"][0]["blocked_promotion_reasons"],
            ["scheduler_v3_parity_missing"],
        )

        detail_response = self.client.get("/trading/autoresearch/epochs/epoch-1")
        self.assertEqual(detail_response.status_code, 200)
        detail_payload = detail_response.json()
        self.assertEqual(detail_payload["epoch"]["epoch_id"], "epoch-1")
        self.assertEqual(
            detail_payload["candidate_specs"][0]["candidate_spec_id"], "spec-1"
        )
        self.assertEqual(detail_payload["proposal_scores"][0]["rank"], 1)
        self.assertEqual(
            detail_payload["portfolio_candidates"][0]["portfolio_candidate_id"],
            "portfolio-1",
        )
        self.assertEqual(
            detail_payload["dashboard"]["blocked_promotion_reasons"],
            ["scheduler_v3_parity_missing"],
        )
        self.assertEqual(
            detail_payload["dashboard"]["best_false_negative_table"][0][
                "candidate_spec_id"
            ],
            "spec-fn",
        )

        missing_response = self.client.get("/trading/autoresearch/epochs/missing")
        self.assertEqual(missing_response.status_code, 404)

    def test_dspy_cutover_migration_guard_assertion_raises_for_legacy_toggles(
        self,
    ) -> None:
        original_runtime_mode = settings.llm_dspy_runtime_mode
        original_fail_mode_enforcement = settings.llm_fail_mode_enforcement
        original_fail_mode = settings.llm_fail_mode
        original_abstain_fail_mode = settings.llm_abstain_fail_mode
        original_escalate_fail_mode = settings.llm_escalate_fail_mode
        original_quality_fail_mode = settings.llm_quality_fail_mode
        original_shadow_mode = settings.llm_shadow_mode
        settings.llm_dspy_runtime_mode = "active"
        settings.llm_fail_mode_enforcement = "configured"
        settings.llm_fail_mode = "veto"
        settings.llm_abstain_fail_mode = "pass_through"
        settings.llm_escalate_fail_mode = "veto"
        settings.llm_quality_fail_mode = "veto"
        settings.llm_shadow_mode = False
        try:
            with self.assertRaisesRegex(
                RuntimeError,
                "dspy_cutover_migration_guard_failed",
            ):
                _assert_dspy_cutover_migration_guard()
        finally:
            settings.llm_dspy_runtime_mode = original_runtime_mode
            settings.llm_fail_mode_enforcement = original_fail_mode_enforcement
            settings.llm_fail_mode = original_fail_mode
            settings.llm_abstain_fail_mode = original_abstain_fail_mode
            settings.llm_escalate_fail_mode = original_escalate_fail_mode
            settings.llm_quality_fail_mode = original_quality_fail_mode
            settings.llm_shadow_mode = original_shadow_mode

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_graph_signature": "graph-signature-demo",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 1,
            "schema_graph_parent_forks": {},
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_reports_schema_heads(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        response = self.client.get("/db-check")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["schema_current"])
        self.assertEqual(payload["current_heads"], payload["expected_heads"])
        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["schema_head_signature"], "7f8e4d0")
        self.assertEqual(payload["schema_missing_heads"], [])
        self.assertEqual(payload["schema_unexpected_heads"], [])
        self.assertEqual(payload["schema_head_count_expected"], 1)
        self.assertEqual(payload["schema_head_count_current"], 1)
        self.assertEqual(payload["schema_head_delta_count"], 0)
        self.assertEqual(payload["schema_graph_signature"], "graph-signature-demo")
        self.assertEqual(payload["schema_graph_roots"], ["0001_initial_torghut_schema"])
        self.assertEqual(payload["schema_graph_branch_count"], 1)
        self.assertEqual(payload["schema_graph_parent_forks"], {})
        self.assertEqual(payload["schema_graph_lineage_errors"], [])
        self.assertIn("checked_at", payload)

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-divergent",
            "schema_graph_signature": "graph-divergent",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 3,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0016_whitepaper_engineering_triggers_and_rollout",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_lineage_divergence_returns_503_when_override_disabled(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        original_tolerance = settings.trading_db_schema_graph_branch_tolerance
        original_allow = settings.trading_db_schema_graph_allow_divergence_roots
        settings.trading_db_schema_graph_branch_tolerance = 1
        settings.trading_db_schema_graph_allow_divergence_roots = False
        try:
            response = self.client.get("/db-check")
        finally:
            settings.trading_db_schema_graph_branch_tolerance = original_tolerance
            settings.trading_db_schema_graph_allow_divergence_roots = original_allow

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(
            payload["detail"]["error"], "database schema lineage divergence"
        )
        self.assertFalse(payload["detail"]["schema_graph_lineage_ready"])
        self.assertIn("schema_graph_lineage_errors", payload["detail"])
        self.assertIn("schema_graph_branch_count", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-override",
            "schema_graph_signature": "graph-override",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 2,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0017_whitepaper_semantic_indexing",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_lineage_warning_returns_200_when_override_enabled(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        original_tolerance = settings.trading_db_schema_graph_branch_tolerance
        original_allow = settings.trading_db_schema_graph_allow_divergence_roots
        settings.trading_db_schema_graph_branch_tolerance = 1
        settings.trading_db_schema_graph_allow_divergence_roots = True
        try:
            response = self.client.get("/db-check")
        finally:
            settings.trading_db_schema_graph_branch_tolerance = original_tolerance
            settings.trading_db_schema_graph_allow_divergence_roots = original_allow

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["schema_graph_lineage_ready"])
        self.assertEqual(payload["schema_graph_branch_count"], 2)
        self.assertEqual(
            payload["schema_graph_lineage_errors"],
            [],
        )
        self.assertEqual(
            payload["schema_graph_lineage_warnings"],
            [
                "migration parent forks detected: 0015_whitepaper_workflow_tables -> "
                "[0016_llm_dspy_workflow_artifacts, 0017_whitepaper_semantic_indexing]",
                "migration graph branch count 2 exceeds tolerance 1; allowed by "
                "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true",
            ],
        )

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": False,
            "current_heads": ["0010_execution_provenance_and_governance_trace"],
            "expected_heads": [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
            "schema_unexpected_heads": [
                "0010_execution_provenance_and_governance_trace"
            ],
            "schema_head_count_expected": 2,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 3,
        },
    )
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True},
    )
    def test_db_check_schema_mismatch_returns_503(
        self,
        _mock_account_scope: object,
        _mock_schema: object,
    ) -> None:
        response = self.client.get("/db-check")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["detail"]["error"], "database schema mismatch")
        self.assertFalse(payload["detail"]["schema_current"])
        self.assertEqual(
            payload["detail"]["schema_missing_heads"],
            [
                "0011_autonomy_lifecycle_and_promotion_audit",
                "0011_execution_tca_simulator_divergence",
            ],
        )
        self.assertEqual(
            payload["detail"]["schema_unexpected_heads"],
            ["0010_execution_provenance_and_governance_trace"],
        )
        self.assertEqual(payload["detail"]["schema_head_count_expected"], 2)
        self.assertEqual(payload["detail"]["schema_head_count_current"], 1)
        self.assertEqual(payload["detail"]["schema_head_delta_count"], 3)
        self.assertEqual(payload["detail"]["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload["detail"])

    def test_bounded_account_scope_invariants_uses_catalog_queries(self) -> None:
        class FakeResult:
            def __init__(self, rows: list[dict[str, object]]) -> None:
                self._rows = rows

            def mappings(self) -> "FakeResult":
                return self

            def all(self) -> list[dict[str, object]]:
                return self._rows

        class FakeSession:
            def __init__(self) -> None:
                self.statements: list[str] = []

            def execute(
                self,
                statement: object,
                _params: dict[str, object] | None = None,
            ) -> FakeResult:
                sql = str(statement)
                self.statements.append(sql)
                if "SET LOCAL statement_timeout" in sql:
                    return FakeResult([])
                if "FROM pg_catalog.pg_class" in sql and "pg_attribute" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_decisions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_cursor",
                                "column_name": "account_label",
                            },
                            {
                                "table_name": "execution_order_events",
                                "column_name": "alpaca_account_label",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql and "array_agg" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_account_order_uidx",
                                "column_names": [
                                    "alpaca_account_label",
                                    "alpaca_order_id",
                                ],
                            },
                            {
                                "table_name": "executions",
                                "index_name": "executions_account_client_uidx",
                                "column_names": [
                                    "alpaca_account_label",
                                    "client_order_id",
                                ],
                            },
                            {
                                "table_name": "trade_decisions",
                                "index_name": "trade_decisions_account_hash_uidx",
                                "column_names": [
                                    "alpaca_account_label",
                                    "decision_hash",
                                ],
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_account_uidx",
                                "column_names": ["source", "account_label"],
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_account_order_uidx",
                            },
                            {
                                "table_name": "trade_decisions",
                                "index_name": "trade_decisions_account_hash_uidx",
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_account_uidx",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_constraint" in sql:
                    return FakeResult([])
                raise AssertionError(f"unexpected SQL: {sql}")

        fake_session = FakeSession()
        payload = main_module._check_account_scope_invariants_bounded(fake_session)  # type: ignore[arg-type]

        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["account_scope_errors"], [])
        self.assertEqual(payload["account_scope_check_mode"], "bounded_catalog")
        joined_sql = "\n".join(fake_session.statements)
        self.assertIn("SET LOCAL statement_timeout", joined_sql)
        self.assertNotIn("pg_type", joined_sql)
        self.assertNotIn("information_schema.columns", joined_sql)
        self.assertNotIn("pg_catalog.pg_indexes", joined_sql)

    def test_bounded_account_scope_invariants_reports_legacy_indexes(self) -> None:
        class FakeResult:
            def __init__(self, rows: list[dict[str, object]]) -> None:
                self._rows = rows

            def mappings(self) -> "FakeResult":
                return self

            def all(self) -> list[dict[str, object]]:
                return self._rows

        class FakeSession:
            def execute(
                self,
                statement: object,
                _params: dict[str, object] | None = None,
            ) -> FakeResult:
                sql = str(statement)
                if "SET LOCAL statement_timeout" in sql:
                    return FakeResult([])
                if "FROM pg_catalog.pg_class" in sql and "pg_attribute" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_decisions",
                                "column_name": "alpaca_account_label",
                            },
                            {
                                "table_name": "trade_cursor",
                                "column_name": "account_label",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql and "array_agg" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_alpaca_order_id_key",
                                "column_names": ["alpaca_order_id"],
                            },
                            {
                                "table_name": "executions",
                                "index_name": "executions_client_order_id_key",
                                "column_names": ["client_order_id"],
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_key",
                                "column_names": ["source"],
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_index" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "index_name": "executions_alpaca_order_id_key",
                            },
                            {
                                "table_name": "trade_cursor",
                                "index_name": "trade_cursor_source_key",
                            },
                        ]
                    )
                if "FROM pg_catalog.pg_constraint" in sql:
                    return FakeResult(
                        [
                            {
                                "table_name": "executions",
                                "constraint_name": "executions_alpaca_order_id_key",
                            },
                            {
                                "table_name": "trade_cursor",
                                "constraint_name": "trade_cursor_source_key",
                            },
                        ]
                    )
                raise AssertionError(f"unexpected SQL: {sql}")

        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            payload = main_module._check_account_scope_invariants_bounded(FakeSession())  # type: ignore[arg-type]
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["account_scope_errors"], [])
        self.assertTrue(
            payload["legacy_executions_single_account_order_id_index_detected"]
        )
        self.assertTrue(
            payload["legacy_executions_single_account_client_order_id_index_detected"]
        )
        self.assertTrue(
            payload["legacy_trade_cursor_source_only_source_index_detected"]
        )
        self.assertFalse(payload["execution_has_account_scoped_unique_order_id"])
        self.assertFalse(payload["execution_has_account_scoped_unique_client_order_id"])
        self.assertFalse(
            payload["trade_decision_has_account_scoped_unique_decision_hash"]
        )
        self.assertFalse(payload["trade_cursor_has_account_scoped_source_index"])
        self.assertFalse(payload["execution_order_events_have_account_label"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_database_contract_fails_closed_on_account_scope_timeout(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = True
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                side_effect=SQLAlchemyError(
                    "canceling statement due to statement timeout"
                ),
            ):
                payload = main_module._evaluate_database_contract(object())  # type: ignore[arg-type]
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["account_scope_ready"])
        self.assertIn("statement timeout", payload["account_scope_errors"][0])
        self.assertEqual(payload["schema_current"], True)

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_database_contract_bypasses_account_scope_timeout_when_disabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                side_effect=SQLAlchemyError(
                    "canceling statement due to statement timeout"
                ),
            ):
                payload = main_module._evaluate_database_contract(object())  # type: ignore[arg-type]
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["account_scope_ready"])
        self.assertEqual(payload["account_scope_errors"], [])
        self.assertIn(
            "account scope catalog check failed but is non-blocking",
            " ".join(payload["account_scope_warnings"]),
        )

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_db_check_enforces_account_scope_when_multi_account_enabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = True
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                return_value={
                    "account_scope_ready": False,
                    "account_scope_errors": [
                        "legacy unique constraint/index detected for executions.alpaca_order_id",
                    ],
                },
            ):
                response = self.client.get("/db-check")
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(
            payload["detail"]["error"], "database account scope schema mismatch"
        )
        self.assertIn("account_scope_errors", payload["detail"])
        self.assertEqual(payload["detail"]["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload["detail"])

    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": [],
            "schema_unexpected_heads": [],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 0,
        },
    )
    def test_db_check_allows_account_scope_issues_when_multi_account_disabled(
        self,
        _mock_check: object,
    ) -> None:
        original_multi = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = False
        try:
            with patch(
                "app.main._check_account_scope_invariants_bounded",
                return_value={
                    "account_scope_ready": False,
                    "account_scope_errors": ["legacy unique constraint/index detected"],
                },
            ):
                response = self.client.get("/db-check")
        finally:
            settings.trading_multi_account_enabled = original_multi

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["account_scope_ready"], True)
        self.assertIn(
            "account_scope_warnings",
            payload["account_scope_checks"],
        )
        self.assertEqual(
            payload["account_scope_checks"]["account_scope_warnings"],
            [
                "account scope checks are bypassed when trading_multi_account_enabled is false"
            ],
        )
        self.assertEqual(payload["schema_head_signature"], "7f8e4d0")
        self.assertIn("checked_at", payload)

    def test_trading_executions_endpoint(self) -> None:
        response = self.client.get("/trading/executions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")
        self.assertEqual(payload[0]["execution_correlation_id"], "corr-1")
        self.assertEqual(payload[0]["execution_idempotency_key"], "idem-1")
        self.assertIsNotNone(payload[0]["tca"])
        self.assertEqual(payload[0]["tca"]["slippage_bps"], 100.0)

    def test_trading_tca_endpoint(self) -> None:
        response = self.client.get("/trading/tca?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["order_count"], 1)
        self.assertEqual(payload["summary"]["expected_shortfall_sample_count"], 1)
        self.assertAlmostEqual(
            float(payload["summary"]["expected_shortfall_coverage"]), 1.0
        )
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(payload["rows"][0]["symbol"], "AAPL")

    def test_trading_status_includes_tca_calibration_summary(self) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        tca_summary = payload["tca"]
        self.assertEqual(tca_summary["order_count"], 1)
        self.assertEqual(tca_summary["expected_shortfall_sample_count"], 1)
        self.assertEqual(float(tca_summary["expected_shortfall_coverage"]), 1.0)
        self.assertEqual(float(tca_summary["avg_expected_shortfall_bps_p50"]), 3.5)
        self.assertEqual(float(tca_summary["avg_expected_shortfall_bps_p95"]), 5.0)
        self.assertEqual(float(tca_summary["avg_realized_shortfall_bps"]), 1.2)
        self.assertEqual(float(tca_summary["avg_divergence_bps"]), 0.7)

    def test_trading_status_reports_latest_persisted_decision_timestamp(self) -> None:
        with self.session_local() as session:
            strategy = session.execute(select(Strategy)).scalars().first()
            assert strategy is not None
            latest_created_at = datetime.now(timezone.utc) + timedelta(minutes=5)
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="MSFT",
                    timeframe="5Min",
                    decision_json={"action": "sell", "qty": "2"},
                    rationale="latest",
                    status="planned",
                    created_at=latest_created_at,
                )
            )
            session.commit()

        response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            datetime.fromisoformat(payload["last_decision_at"]),
            latest_created_at,
        )

    def test_trading_status_does_not_fetch_jangar_dependency_for_self_governed_registry(
        self,
    ) -> None:
        call_order: list[str] = []

        def _load_llm_evaluation(_session: Session) -> dict[str, object]:
            call_order.append("llm_evaluation")
            return {"ok": True, "metrics": {"total_reviews": 1}}

        def _load_tca(_session: Session, **_kwargs: object) -> dict[str, object]:
            call_order.append("tca")
            return {}

        with (
            patch("app.trading.hypotheses.urlopen") as jangar_status_fetch,
            patch("app.main._load_llm_evaluation", side_effect=_load_llm_evaluation),
            patch("app.main._load_tca_summary", side_effect=_load_tca),
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertIn("llm_evaluation", call_order)
        self.assertIn("tca", call_order)
        jangar_status_fetch.assert_not_called()

    def test_revenue_repair_hydrates_jangar_verify_foreclosure_board(self) -> None:
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "fresh_until": "2026-05-14T16:30:00Z",
            "execution_trust_status": "degraded",
            "source_rollout_truth_state": "converged",
            "foreclosure_tickets": [
                {
                    "ticket_id": "verify-trust-foreclosure-ticket:test",
                    "state": "open",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                }
            ],
        }

        def _build_digest(
            *,
            readyz_payload: dict[str, object],
            status_payload: dict[str, object],
        ) -> dict[str, object]:
            self.assertEqual(readyz_payload["status"], "degraded")
            return {
                "schema_version": "torghut.revenue-repair-digest.v1",
                "verify_trust_foreclosure_board": status_payload.get(
                    "verify_trust_foreclosure_board"
                ),
            }

        with (
            patch(
                "app.main._evaluate_trading_health_payload",
                return_value=({"status": "degraded"}, 503),
            ),
            patch(
                "app.main.trading_status",
                return_value={
                    "mode": "live",
                    "pipeline_mode": "simple",
                    "build": {"commit": "source-sha"},
                },
            ),
            patch(
                "app.main._load_jangar_verify_trust_foreclosure_board",
                return_value=board,
            ),
            patch("app.main.build_revenue_repair_digest", side_effect=_build_digest),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["verify_trust_foreclosure_board"], board)

    def test_revenue_repair_hydrates_jangar_repair_slot_carry(self) -> None:
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "fresh_until": "2026-05-14T16:30:00Z",
        }
        settlement = {
            "schema_version": "jangar.controller-ingestion-settlement.v1",
            "settlement_id": "controller-ingestion-settlement:agents:test",
            "decision": "hold",
            "agentrun_ingestion_current": False,
        }
        repair_slot_escrow = {
            "schema_version": "jangar.repair-slot-escrow.v1",
            "escrow_id": "repair-slot-escrow:test",
            "status": "block",
            "reason_codes": ["selected_receipt_source_revenue_repair_ref_mismatch"],
        }
        rollout_witness = {
            "schema_version": "jangar.foreclosure-carry-rollout-witness.v1",
            "witness_id": "foreclosure-carry-rollout-witness:test",
        }
        dependency_quorum = {
            "decision": "block",
            "reasons": ["empirical_jobs_degraded"],
            "message": "blocked",
            "controller_ingestion_settlement": settlement,
            "verify_trust_foreclosure_board": board,
            "repair_slot_escrow": repair_slot_escrow,
            "foreclosure_carry_rollout_witness": rollout_witness,
        }

        def _build_digest(
            *,
            readyz_payload: dict[str, object],
            status_payload: dict[str, object],
        ) -> dict[str, object]:
            self.assertEqual(readyz_payload["status"], "degraded")
            self.assertEqual(status_payload["dependency_quorum"], dependency_quorum)
            self.assertEqual(
                status_payload["controller_ingestion_settlement"],
                settlement,
            )
            self.assertEqual(status_payload["repair_slot_escrow"], repair_slot_escrow)
            self.assertEqual(
                status_payload["foreclosure_carry_rollout_witness"],
                rollout_witness,
            )
            return {
                "schema_version": "torghut.revenue-repair-digest.v1",
                "repair_slot_escrow": status_payload.get("repair_slot_escrow"),
            }

        with (
            patch(
                "app.main._evaluate_trading_health_payload",
                return_value=({"status": "degraded"}, 503),
            ),
            patch(
                "app.main.trading_status",
                return_value={
                    "mode": "live",
                    "pipeline_mode": "simple",
                    "build": {"commit": "source-sha"},
                },
            ),
            patch(
                "app.main._load_jangar_dependency_quorum_payload",
                return_value=dependency_quorum,
            ),
            patch("app.main.build_revenue_repair_digest", side_effect=_build_digest),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["repair_slot_escrow"], repair_slot_escrow)

    def test_trading_consumer_evidence_avoids_recursive_jangar_status_fetch(
        self,
    ) -> None:
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-08T03:54:41.769374+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["simple_submit_disabled"],
            "proof_dimensions": [],
            "repair_ladder": [],
        }
        live_submission_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "dependency_quorum_decision": "allow",
        }

        with (
            patch("app.main.resolve_hypothesis_dependency_quorum") as dependency_fetch,
            patch("app.main.load_jangar_route_continuity_packet") as continuity_fetch,
            patch(
                "app.main._forecast_service_status",
                return_value={
                    "status": "healthy",
                    "authority": "empirical",
                    "promotion_authority_eligible_models": ["candidate-a"],
                },
            ),
            patch(
                "app.main._lean_authority_status",
                return_value={"status": "healthy", "authority": "empirical"},
            ),
            patch(
                "app.main._empirical_jobs_status",
                return_value={
                    "status": "healthy",
                    "ready": True,
                    "candidate_ids": ["candidate-a"],
                    "dataset_snapshot_refs": ["dataset-a"],
                },
            ),
            patch(
                "app.main.load_quant_evidence_status",
                return_value={"ok": True, "required": False},
            ),
            patch("app.main._load_tca_summary", return_value={}),
            patch(
                "app.main._build_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
            patch(
                "app.main.build_profitability_proof_floor_receipt",
                return_value=proof_floor,
            ),
            patch(
                "app.main._readiness_dependency_snapshot",
                return_value=(
                    {
                        "database": {
                            "ok": True,
                            "schema_current": True,
                            "schema_current_heads": ["0029_live_submission_gate"],
                        }
                    },
                    datetime(2026, 5, 8, 3, 54, 41, tzinfo=timezone.utc),
                    True,
                ),
            ) as readiness_snapshot,
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/consumer-evidence")
            summary_response = self.client.get(
                "/trading/consumer-evidence?view=summary"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(summary_response.status_code, 200)
        self.assertTrue(
            readiness_snapshot.call_args.kwargs["include_database_contract"]
        )
        self.assertTrue(
            readiness_snapshot.call_args.kwargs["allow_stale_dependency_cache"]
        )
        payload = response.json()
        self.assertEqual(
            payload["schema_version"], "torghut.consumer-evidence-status.v1"
        )
        self.assertEqual(payload["control_plane_dependency_mode"], "caller_evaluated")
        self.assertEqual(payload["dependency_quorum"]["decision"], "allow")
        self.assertEqual(payload["proof_floor"], proof_floor)
        self.assertEqual(
            payload["revenue_repair_digest_ref"], "/trading/revenue-repair"
        )
        self.assertEqual(
            payload["top_repair_queue_item"]["code"], "live_submit_gate_closed"
        )
        self.assertEqual(payload["selected_value_gate"], "capital_gate_safety")
        self.assertEqual(payload["max_notional"], "0")
        self.assertEqual(payload["accepted_routeable_candidate_count"], 0)
        self.assertEqual(payload["routeable_candidate_delta"], 0)
        self.assertNotIn("route_reacquisition_board", payload)
        summary_payload = summary_response.json()
        self.assertEqual(summary_payload["schema_version"], payload["schema_version"])
        self.assertEqual(summary_payload["view"], "summary")
        self.assertEqual(
            summary_payload["control_plane_dependency_mode"], "caller_evaluated"
        )
        self.assertEqual(summary_payload["dependency_quorum"]["decision"], "allow")
        self.assertEqual(summary_payload["proof_floor"], proof_floor)
        self.assertIn("torghut_consumer_evidence_receipt", summary_payload)
        self.assertIn("route_proven_profit_receipt", summary_payload)
        self.assertNotIn("route_reacquisition_board", summary_payload)
        self.assertNotIn("capital_reentry_cohort_ledger", summary_payload)
        self.assertNotIn("profit_carry_passport_ledger", summary_payload)
        receipt = payload["torghut_consumer_evidence_receipt"]
        self.assertEqual(
            receipt["schema_version"],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(receipt["paper_readiness_state"], "blocked")
        self.assertIn("simple_submit_disabled", receipt["reason_codes"])
        route_proven_receipt = payload["route_proven_profit_receipt"]
        self.assertEqual(
            route_proven_receipt["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(route_proven_receipt["decision"], "repair")
        self.assertEqual(route_proven_receipt["capital_state"], "zero_notional")
        self.assertEqual(
            route_proven_receipt["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(
            payload["consumer_evidence_canary"],
            route_proven_receipt["route_canary"],
        )
        self.assertEqual(
            payload["consumer_evidence_canary"]["expected_schema"],
            "torghut.consumer-evidence-status.v1",
        )
        ledger = payload["capital_reentry_cohort_ledger"]
        self.assertEqual(
            ledger["schema_version"],
            "torghut.capital-reentry-cohort-ledger.v1",
        )
        self.assertEqual(
            ledger["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(ledger["summary"]["zero_notional_cohort_count"], 5)
        profit_repair = payload["profit_repair_settlement_ledger"]
        self.assertEqual(
            profit_repair["schema_version"],
            "torghut.profit-repair-settlement-ledger.v1",
        )
        self.assertEqual(
            profit_repair["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(profit_repair["summary"]["zero_notional_lot_count"], 7)
        routeability = payload["routeability_repair_acceptance_ledger"]
        self.assertEqual(
            routeability["schema_version"],
            "torghut.routeability-repair-acceptance-ledger.v1",
        )
        self.assertEqual(routeability["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(routeability["accepted_routeable_candidate_count"], 0)
        clearinghouse = payload["route_evidence_clearinghouse_packet"]
        self.assertEqual(
            clearinghouse["schema_version"],
            "torghut.route-evidence-clearinghouse-packet.v1",
        )
        self.assertEqual(clearinghouse["accepted_routeable_candidate_count"], 0)
        self.assertEqual(clearinghouse["max_notional"], "0")
        repair_bid_settlement = payload["repair_bid_settlement_ledger"]
        self.assertEqual(
            repair_bid_settlement["schema_version"],
            "torghut.repair-bid-settlement-ledger.v1",
        )
        self.assertEqual(repair_bid_settlement["routeable_candidate_count"], 0)
        self.assertEqual(repair_bid_settlement["max_notional"], "0")
        self.assertLessEqual(
            len(repair_bid_settlement["selected_lot_ids"]),
            repair_bid_settlement["summary"]["max_selected_lots"],
        )
        executable_alpha_repair = payload["executable_alpha_repair_receipts"]
        self.assertEqual(
            executable_alpha_repair["schema_version"],
            "torghut.executable-alpha-repair-receipts.v1",
        )
        self.assertEqual(executable_alpha_repair["status"], "inactive")
        self.assertEqual(executable_alpha_repair["max_notional"], "0")
        executable_alpha_settlement = payload["executable_alpha_settlement_slots"]
        self.assertEqual(
            executable_alpha_settlement["schema_version"],
            "torghut.executable-alpha-settlement-slots-ref.v1",
        )
        self.assertEqual(executable_alpha_settlement["status"], "inactive")
        self.assertEqual(executable_alpha_settlement["max_notional"], "0")
        alpha_repair_closure = payload["alpha_repair_closure_board"]
        self.assertEqual(
            alpha_repair_closure["schema_version"],
            "torghut.alpha-repair-closure-board-ref.v1",
        )
        self.assertEqual(alpha_repair_closure["status"], "inactive")
        self.assertEqual(alpha_repair_closure["max_notional"], "0")
        self.assertNotIn("db_check_not_provided", alpha_repair_closure["reason_codes"])
        alpha_foundry = payload["alpha_evidence_foundry"]
        self.assertEqual(
            alpha_foundry["schema_version"],
            "torghut.alpha-evidence-foundry-ref.v1",
        )
        self.assertEqual(alpha_foundry["status"], "inactive")
        self.assertEqual(alpha_foundry["max_notional"], "0")
        settlement_conveyor = payload["alpha_readiness_settlement_conveyor"]
        self.assertEqual(
            settlement_conveyor["schema_version"],
            "torghut.alpha-readiness-settlement-conveyor-ref.v1",
        )
        self.assertEqual(settlement_conveyor["status"], "observing")
        self.assertEqual(settlement_conveyor["max_notional"], "0")
        alpha_dividend = payload["alpha_repair_dividend_ledger"]
        self.assertEqual(
            alpha_dividend["schema_version"],
            "torghut.alpha-repair-dividend-ledger-ref.v1",
        )
        self.assertEqual(alpha_dividend["max_notional"], "0")
        self.assertEqual(
            alpha_dividend["required_recorder_schema"],
            "jangar.material-action-custody-flight-recorder.v1",
        )
        alpha_closure_slo = payload["alpha_closure_dividend_slo"]
        self.assertEqual(
            alpha_closure_slo["schema_version"],
            "torghut.alpha-closure-dividend-slo.v1",
        )
        self.assertEqual(alpha_closure_slo["max_notional"], "0")
        self.assertEqual(alpha_closure_slo["capital_rule"], "zero_notional_repair_only")
        self.assertEqual(alpha_closure_slo["enforcement_mode"], "observe")
        controller_carry = payload["jangar_controller_ingestion_carry"]
        self.assertEqual(
            controller_carry["schema_version"],
            "torghut.jangar-controller-ingestion-carry-ref.v1",
        )
        self.assertEqual(controller_carry["carry_state"], "unavailable")
        self.assertEqual(controller_carry["max_notional"], "0")
        no_delta_auction = payload["no_delta_repair_reentry_auction"]
        self.assertEqual(
            no_delta_auction["schema_version"],
            "torghut.no-delta-repair-reentry-auction-ref.v1",
        )
        self.assertEqual(
            no_delta_auction["jangar_controller_ingestion_carry_state"],
            "unavailable",
        )
        self.assertIn(
            no_delta_auction["reentry_decision"],
            {"deny", "hold"},
        )
        self.assertEqual(no_delta_auction["max_notional"], "0")
        warrant = payload["route_warrant_exchange"]
        self.assertEqual(
            warrant["schema_version"],
            "torghut.route-warrant-exchange.v1",
        )
        self.assertEqual(warrant["accepted_routeable_candidate_count"], 0)
        self.assertEqual(warrant["max_notional"], "0")
        source_serving = payload["source_serving_repair_receipt_ledger"]
        self.assertEqual(
            source_serving["schema_version"],
            "torghut.source-serving-repair-receipt-ledger.v1",
        )
        self.assertEqual(source_serving["max_notional"], "0")
        self.assertIn(
            source_serving["source_serving_state"],
            {
                "converged",
                "digest_unknown",
                "contract_missing",
                "source_ahead",
                "unknown",
            },
        )
        self.assertEqual(
            source_serving["route_warrant_ref"],
            warrant["warrant_id"],
        )
        freshness_carry = payload["freshness_carry_ledger"]
        self.assertEqual(
            freshness_carry["schema_version"],
            "torghut.freshness-carry-ledger.v1",
        )
        self.assertEqual(freshness_carry["capital_posture"]["max_notional"], "0")
        self.assertIn("dimensions", freshness_carry)
        self.assertIn("repair_proof_slos", freshness_carry)
        self.assertEqual(
            freshness_carry["source_serving_ledger_ref"],
            source_serving["ledger_id"],
        )
        self.assertEqual(
            freshness_carry["route_warrant_ref"],
            warrant["warrant_id"],
        )
        repair_receipt_frontier = payload["repair_receipt_frontier"]
        self.assertEqual(
            repair_receipt_frontier["schema_version"],
            "torghut.repair-receipt-frontier.v1",
        )
        self.assertEqual(repair_receipt_frontier["max_notional"], "0")
        self.assertEqual(
            repair_receipt_frontier["source_serving_ledger_ref"],
            source_serving["ledger_id"],
        )
        self.assertEqual(
            repair_receipt_frontier["freshness_carry_ledger_ref"],
            freshness_carry["ledger_id"],
        )
        self.assertIn(
            repair_receipt_frontier["frontier_state"],
            {"repair_only", "paper_blocked", "paper_candidate", "live_candidate"},
        )
        repair_outcome = payload["repair_outcome_dividend_ledger"]
        self.assertEqual(
            repair_outcome["schema_version"],
            "torghut.repair-outcome-dividend-ledger.v1",
        )
        self.assertEqual(repair_outcome["max_notional"], "0")
        self.assertFalse(repair_outcome["live_submit_enabled"])
        self.assertEqual(
            repair_outcome["source_repair_bid_settlement_ledger_id"],
            repair_bid_settlement["ledger_id"],
        )
        self.assertEqual(
            repair_outcome["repair_receipt_frontier_ref"],
            repair_receipt_frontier["frontier_id"],
        )
        self.assertEqual(
            repair_outcome["summary"]["repair_receipt_binding_count"],
            len(repair_outcome["outcome_receipts"]),
        )
        self.assertEqual(
            repair_outcome["summary"]["open_escrow_count"],
            len(repair_outcome["open_escrows"]),
        )
        self.assertEqual(
            {
                receipt["repair_lot_id"]
                for receipt in repair_outcome["outcome_receipts"]
            },
            set(repair_bid_settlement["dispatchable_lot_ids"]),
        )
        self.assertTrue(
            all(
                escrow["max_notional"] == "0"
                for escrow in repair_outcome["open_escrows"]
            )
        )
        self.assertEqual(
            repair_outcome["summary"]["routeable_candidate_count"],
            0,
        )
        profit_carry = payload["profit_carry_passport_ledger"]
        self.assertEqual(
            profit_carry["schema_version"],
            "torghut.profit-carry-passport-ledger.v1",
        )
        self.assertEqual(profit_carry["max_notional"], "0")
        self.assertFalse(profit_carry["live_submit_enabled"])
        self.assertEqual(
            profit_carry["source_refs"]["repair_outcome_dividend_ledger_ref"],
            repair_outcome["ledger_id"],
        )
        self.assertEqual(
            profit_carry["action_class_decisions"]["paper_canary"], "blocked"
        )
        self.assertEqual(
            profit_carry["action_class_decisions"]["live_micro_canary"], "blocked"
        )
        self.assertTrue(
            all(
                passport["max_notional"] == "0"
                for passport in profit_carry["profit_carry_passports"]
            )
        )
        frontier = payload["profit_freshness_frontier"]
        self.assertEqual(
            frontier["schema_version"],
            "torghut.profit-freshness-frontier.v1",
        )
        self.assertEqual(frontier["capital_posture"]["paper_notional_limit"], "0")
        self.assertEqual(frontier["capital_posture"]["live_notional_limit"], "0")
        arbiter = payload["evidence_clock_arbiter"]
        self.assertEqual(
            arbiter["schema_version"],
            "torghut.evidence-clock-arbiter.v1",
        )
        self.assertEqual(arbiter["routeable_candidate_count"], 0)
        self.assertEqual(arbiter["max_notional"], "0")
        exchange = payload["routeable_profit_candidate_exchange"]
        self.assertEqual(
            exchange["schema_version"],
            "torghut.routeable-profit-candidate-exchange.v1",
        )
        self.assertEqual(exchange["summary"]["routeable_candidate_count"], 0)
        self.assertEqual(exchange["capital_safety_ref"]["max_notional"], "0")
        settlement = payload["clock_settlement_receipt"]
        self.assertEqual(
            settlement["schema_version"],
            "torghut.clock-settlement-receipt.v1",
        )
        self.assertEqual(settlement["routeable_candidate_count"], 0)
        self.assertEqual(settlement["max_notional"], "0")
        self.assertIn(
            "selected_repair_packet_ids",
            settlement["summary"],
        )
        dependency_fetch.assert_not_called()
        continuity_fetch.assert_not_called()

    def test_trading_consumer_evidence_hydrates_jangar_carry_non_recursively(
        self,
    ) -> None:
        settlement = {
            "settlement_id": "controller-ingestion-settlement:current",
            "decision": "allow",
            "controller_ingestion_current": True,
            "fresh_until": "2099-05-14T15:45:00+00:00",
        }
        board = {
            "board_id": "verify-trust-foreclosure-board:current",
            "fresh_until": "2099-05-14T15:45:00+00:00",
        }
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-08T03:54:41.769374+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["simple_submit_disabled"],
            "proof_dimensions": [],
            "repair_ladder": [],
        }
        live_submission_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "dependency_quorum_decision": "allow",
        }

        with (
            patch("app.main.resolve_hypothesis_dependency_quorum") as dependency_fetch,
            patch("app.main.load_jangar_route_continuity_packet") as continuity_fetch,
            patch(
                "app.main.load_jangar_dependency_quorum",
                return_value=JangarDependencyQuorumStatus(
                    decision="allow",
                    reasons=[],
                    message="ok",
                    controller_ingestion_settlement=settlement,
                    verify_trust_foreclosure_board=board,
                ),
            ) as jangar_fetch,
            patch(
                "app.main._forecast_service_status",
                return_value={
                    "status": "healthy",
                    "authority": "empirical",
                    "promotion_authority_eligible_models": ["candidate-a"],
                },
            ),
            patch(
                "app.main._lean_authority_status",
                return_value={"status": "healthy", "authority": "empirical"},
            ),
            patch(
                "app.main._empirical_jobs_status",
                return_value={
                    "status": "healthy",
                    "ready": True,
                    "candidate_ids": ["candidate-a"],
                    "dataset_snapshot_refs": ["dataset-a"],
                },
            ),
            patch(
                "app.main.load_quant_evidence_status",
                return_value={"ok": True, "required": False},
            ),
            patch("app.main._load_tca_summary", return_value={}),
            patch(
                "app.main._build_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
            patch(
                "app.main.build_profitability_proof_floor_receipt",
                return_value=proof_floor,
            ),
            patch(
                "app.main._readiness_dependency_snapshot",
                return_value=(
                    {
                        "database": {
                            "ok": True,
                            "schema_current": True,
                            "schema_current_heads": ["0029_live_submission_gate"],
                        }
                    },
                    datetime(2026, 5, 8, 3, 54, 41, tzinfo=timezone.utc),
                    True,
                ),
            ),
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/consumer-evidence")

        self.assertEqual(response.status_code, 200)
        jangar_fetch.assert_called_once_with(omit_torghut_consumer_evidence=True)
        dependency_fetch.assert_not_called()
        continuity_fetch.assert_not_called()
        payload = response.json()
        self.assertEqual(
            payload["control_plane_dependency_mode"],
            "jangar_status_non_recursive",
        )
        self.assertEqual(
            payload["dependency_quorum"]["controller_ingestion_settlement"],
            settlement,
        )
        self.assertEqual(
            payload["dependency_quorum"]["verify_trust_foreclosure_board"],
            board,
        )
        controller_carry = payload["jangar_controller_ingestion_carry"]
        self.assertEqual(controller_carry["carry_state"], "current")
        self.assertEqual(
            controller_carry["source_jangar_settlement_ref"],
            "controller-ingestion-settlement:current",
        )
        self.assertNotIn(
            "jangar_controller_ingestion_settlement_missing",
            controller_carry["reason_codes"],
        )
        self.assertNotIn(
            "jangar_verify_foreclosure_board_missing",
            controller_carry["reason_codes"],
        )
        self.assertEqual(controller_carry["max_notional"], "0")

    def test_route_continuity_delegates_to_jangar_when_registry_requires_it(
        self,
    ) -> None:
        expected_packet = {
            "epoch_id": "jangar-epoch",
            "state": "present",
            "decision": "allow",
            "fresh_until": "2026-05-08T21:00:00+00:00",
            "blocking_reasons": [],
            "action_class": "paper_canary",
        }

        with (
            patch(
                "app.main.hypothesis_registry_requires_dependency_capability",
                return_value=True,
            ) as requires_capability,
            patch(
                "app.main.load_jangar_route_continuity_packet",
                return_value=expected_packet,
            ) as continuity_fetch,
        ):
            packet = _route_continuity_packet_for_proof_floor(
                {"generated_at": "2026-05-08T20:00:00+00:00"}
            )

        self.assertEqual(packet, expected_packet)
        requires_capability.assert_called_once()
        continuity_fetch.assert_called_once_with(action_class="paper_canary")

    def test_trading_status_uses_isolated_db_sessions_for_late_reads(self) -> None:
        observed_sessions: list[Session] = []

        def _load_llm_evaluation(session: Session) -> dict[str, object]:
            observed_sessions.append(session)
            return {"ok": True, "metrics": {"total_reviews": 1}}

        def _load_tca(session: Session, **_kwargs: object) -> dict[str, object]:
            observed_sessions.append(session)
            return {}

        def _load_last_decision_at(session: Session) -> None:
            observed_sessions.append(session)
            return None

        def _build_live_submission_gate(
            *args: object, **kwargs: object
        ) -> dict[str, object]:
            session = kwargs["session"]
            assert isinstance(session, Session)
            observed_sessions.append(session)
            return {"allowed": True, "reason": "ready", "blocked_reasons": []}

        with (
            patch("app.main._load_llm_evaluation", side_effect=_load_llm_evaluation),
            patch("app.main._load_tca_summary", side_effect=_load_tca),
            patch(
                "app.main._load_last_decision_at", side_effect=_load_last_decision_at
            ),
            patch(
                "app.main._build_live_submission_gate_payload",
                side_effect=_build_live_submission_gate,
            ),
            patch("app.main.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(len(observed_sessions), 4)
        self.assertIsNot(observed_sessions[0], observed_sessions[1])
        self.assertIsNot(observed_sessions[1], observed_sessions[2])
        self.assertIsNot(observed_sessions[2], observed_sessions[3])

    def test_trading_status_reuses_clickhouse_signal_status_once(self) -> None:
        with patch(
            "app.main._load_clickhouse_ta_status",
            return_value={
                "state": "current",
                "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "source_ref": "clickhouse:ta_signals",
                "signal_rows": 10,
                "symbol_count": 1,
            },
        ) as load_clickhouse:
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(load_clickhouse.call_count, 1)
        payload = response.json()
        self.assertIn("status_read_budget", payload)

    def test_trading_status_fails_closed_late_reads_after_budget_exhausted(
        self,
    ) -> None:
        with (
            patch("app.main._TRADING_STATUS_READ_BUDGET_SECONDS", 0.0),
            patch(
                "app.main._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch("app.main._build_live_submission_gate_payload") as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_not_called()
        payload = response.json()
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "live_submission_gate_status_read_budget_exhausted",
        )
        self.assertTrue(payload["live_submission_gate"]["read_model_unavailable"])
        self.assertTrue(payload["status_read_budget"]["exhausted"])
        self.assertIn(
            "live_submission_gate",
            payload["status_read_budget"]["skipped_reads"],
        )
        self.assertIn(
            "options_catalog_freshness",
            payload["status_read_budget"]["skipped_reads"],
        )

    def test_trading_status_prioritizes_live_gate_before_late_reads_when_budget_is_low(
        self,
    ) -> None:
        class ManualBudget(main_module._TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()
        live_submission_gate_payload = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        def _build_live_submission_gate(
            *args: object,
            **kwargs: object,
        ) -> dict[str, object]:
            budget.current_elapsed = 9.8
            return live_submission_gate_payload

        with (
            patch("app.main._TradingStatusReadBudget", return_value=budget),
            patch(
                "app.main._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch("app.main._build_tigerbeetle_ledger_status") as tigerbeetle_status,
            patch(
                "app.main._daily_runtime_ledger_portfolio_summary"
            ) as portfolio_summary,
            patch("app.main._load_last_decision_at") as last_decision,
            patch(
                "app.main._load_rejected_signal_outcome_learning_summary"
            ) as rejected_signal_learning,
            patch(
                "app.main._build_live_submission_gate_payload",
                side_effect=_build_live_submission_gate,
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_called_once()
        tigerbeetle_status.assert_not_called()
        portfolio_summary.assert_not_called()
        last_decision.assert_not_called()
        rejected_signal_learning.assert_not_called()
        payload = response.json()
        skipped_reads = payload["status_read_budget"]["skipped_reads"]
        self.assertNotIn("live_submission_gate", skipped_reads)
        self.assertIn("tigerbeetle_ledger", skipped_reads)
        self.assertIn("runtime_ledger_portfolio_summary", skipped_reads)
        self.assertIn("last_decision", skipped_reads)
        self.assertIn("rejected_signal_outcome_learning", skipped_reads)
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "alpha_readiness_not_promotion_eligible",
        )
        self.assertFalse(payload["live_submission_gate"]["read_model_unavailable"])
        self.assertFalse(payload["status_read_budget"]["exhausted"])
        self.assertEqual(payload["status_read_budget"]["remaining_seconds"], 0.2)
        self.assertIn(
            "tigerbeetle_ledger_status_read_budget_insufficient_remaining",
            payload["tigerbeetle_ledger"]["blockers"],
        )
        self.assertTrue(
            payload["portfolio_runtime_ledger_summary"]["read_model_unavailable"]
        )

    def test_trading_status_skips_live_gate_when_gate_dependencies_consume_budget(
        self,
    ) -> None:
        class ManualBudget(main_module._TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()

        def _load_hypothesis_runtime(
            *_args: object,
            **_kwargs: object,
        ) -> tuple[
            dict[str, object],
            dict[str, object],
            main_module.JangarDependencyQuorumStatus,
        ]:
            budget.current_elapsed = 8.5
            return main_module._budget_unavailable_hypothesis_runtime_payload(
                reason="hypothesis_runtime_test_budget_marker"
            )

        with (
            patch("app.main._TradingStatusReadBudget", return_value=budget),
            patch(
                "app.main._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch(
                "app.main._load_trading_status_hypothesis_runtime",
                side_effect=_load_hypothesis_runtime,
            ),
            patch("app.main._build_live_submission_gate_payload") as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_not_called()
        payload = response.json()
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "live_submission_gate_status_read_budget_insufficient_remaining",
        )
        self.assertTrue(payload["live_submission_gate"]["read_model_unavailable"])
        self.assertFalse(payload["status_read_budget"]["exhausted"])
        self.assertEqual(payload["status_read_budget"]["remaining_seconds"], 1.5)
        self.assertIn(
            "live_submission_gate",
            payload["status_read_budget"]["skipped_reads"],
        )
        self.assertIn(
            "options_catalog_freshness",
            payload["status_read_budget"]["skipped_reads"],
        )

    def test_trading_status_skips_early_expensive_reads_when_budget_remaining_is_low(
        self,
    ) -> None:
        class ManualBudget(main_module._TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()

        def _load_tca(_session: Session, **_kwargs: object) -> dict[str, object]:
            budget.current_elapsed = 9.2
            return {}

        with (
            patch("app.main._TradingStatusReadBudget", return_value=budget),
            patch(
                "app.main._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch("app.main._load_tca_summary", side_effect=_load_tca),
            patch("app.main._build_tigerbeetle_ledger_status") as tigerbeetle_status,
            patch(
                "app.main._daily_runtime_ledger_portfolio_summary"
            ) as portfolio_summary,
            patch("app.main._build_hypothesis_runtime_payload") as hypothesis_runtime,
            patch("app.main._build_live_submission_gate_payload") as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        tigerbeetle_status.assert_not_called()
        portfolio_summary.assert_not_called()
        hypothesis_runtime.assert_not_called()
        live_gate.assert_not_called()
        payload = response.json()
        skipped_reads = payload["status_read_budget"]["skipped_reads"]
        self.assertIn("tigerbeetle_ledger", skipped_reads)
        self.assertIn("runtime_ledger_portfolio_summary", skipped_reads)
        self.assertIn("hypothesis_runtime", skipped_reads)
        self.assertIn("live_submission_gate", skipped_reads)
        self.assertIn(
            "tigerbeetle_ledger_status_read_budget_insufficient_remaining",
            payload["tigerbeetle_ledger"]["blockers"],
        )
        self.assertTrue(
            payload["portfolio_runtime_ledger_summary"]["read_model_unavailable"]
        )
        self.assertTrue(payload["hypotheses"]["summary"]["read_model_unavailable"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "live_submission_gate_status_read_budget_insufficient_remaining",
        )

    def test_readiness_checks_external_dependencies_before_postgres_session(
        self,
    ) -> None:
        call_order: list[str] = []
        original_trading_enabled = settings.trading_enabled
        settings.trading_enabled = True
        try:
            with (
                patch(
                    "app.main._check_clickhouse",
                    side_effect=lambda: (
                        call_order.append("clickhouse") or {"ok": True, "detail": "ok"}
                    ),
                ),
                patch(
                    "app.main._check_alpaca",
                    side_effect=lambda: (
                        call_order.append("alpaca") or {"ok": True, "detail": "ok"}
                    ),
                ),
                patch(
                    "app.main._check_postgres",
                    side_effect=lambda _session: (
                        call_order.append("postgres") or {"ok": True, "detail": "ok"}
                    ),
                ),
            ):
                with self.session_local() as session:
                    _readiness_dependency_checks(
                        session,
                        include_database_contract=False,
                    )
        finally:
            settings.trading_enabled = original_trading_enabled

        self.assertEqual(call_order, ["clickhouse", "alpaca", "postgres"])

    def test_trading_status_surfaces_simple_lane_fields(self) -> None:
        original_pipeline_mode = settings.trading_pipeline_mode
        original_trading_enabled = settings.trading_enabled
        original_trading_mode = settings.trading_mode
        original_simple_submit_enabled = settings.trading_simple_submit_enabled
        original_kill_switch_enabled = settings.trading_kill_switch_enabled

        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_kill_switch_enabled = False
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.orders_submitted_total = 7
            scheduler.state.metrics.decision_reject_reason_total = {
                "broker_submit_failed": 2,
                "capital_stage_shadow": 9,
            }
            scheduler.state.metrics.strategy_intent_suppression_total = {
                "strategy-1|exit_only_sell_without_long_position": 4,
            }
            scheduler.state.metrics.rejected_signal_events_total = 3
            scheduler.state.metrics.rejected_signal_outcome_label_pending_total = 3
            scheduler.state.metrics.rejected_signal_reason_total = {
                "missing_executable_quote": 3,
            }
            scheduler.state.last_rejected_signal_outcome_event = {
                "schema_version": "torghut.rejected-signal-outcome-event.v1",
                "source": "quote_quality_gate",
                "paper_claim_id": "rejection-event-outcome-labels",
                "symbol": "AAPL",
                "reject_reason": "missing_executable_quote",
                "outcome_label_status": "pending",
            }
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()

            self.assertEqual(payload["pipeline_mode"], "simple")
            self.assertEqual(payload["execution_lane"], "simple")
            self.assertFalse(payload["live_submission_gate"]["allowed"])
            self.assertEqual(
                payload["live_submission_gate"]["reason"],
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertTrue(
                payload["live_submission_gate"]["simple_lane"]["shared_gate_enforced"]
            )
            self.assertIn(
                "profit_window_contract",
                payload["live_submission_gate"],
            )
            self.assertEqual(payload["simple_lane_orders_submitted_total"], 7)
            self.assertEqual(
                payload["simple_lane_reject_reason_totals"],
                {"broker_submit_failed": 2},
            )
            self.assertEqual(
                payload["rejections"]["strategy_intent_suppression_total"],
                {"strategy-1|exit_only_sell_without_long_position": 4},
            )
            self.assertEqual(payload["rejections"]["rejected_signal_events_total"], 3)
            self.assertEqual(
                payload["rejections"]["rejected_signal_reason_total"],
                {"missing_executable_quote": 3},
            )
            outcome_learning = payload["rejected_signal_outcome_learning"]
            self.assertEqual(
                outcome_learning["schema_version"],
                "torghut.rejected-signal-outcome-learning.v1",
            )
            self.assertEqual(outcome_learning["state"], "pending_outcome_labels")
            self.assertEqual(outcome_learning["events_total"], 3)
            self.assertEqual(
                outcome_learning["blocking_reasons"],
                ["counterfactual_outcome_labels_pending"],
            )
            self.assertEqual(
                outcome_learning["latest_event"]["paper_claim_id"],
                "rejection-event-outcome-labels",
            )
            self.assertTrue(payload["simple_lane_status"]["enabled"])
            self.assertTrue(
                payload["simple_lane_status"]["route_symbol_filter_enabled"]
            )
            self.assertEqual(
                payload["simple_lane_status"]["allowed_reject_reasons"][0],
                "broker_precheck_failed",
            )
        finally:
            settings.trading_pipeline_mode = original_pipeline_mode
            settings.trading_enabled = original_trading_enabled
            settings.trading_mode = original_trading_mode
            settings.trading_simple_submit_enabled = original_simple_submit_enabled
            settings.trading_kill_switch_enabled = original_kill_switch_enabled

    def test_trading_status_summarizes_persisted_rejected_signal_outcomes(
        self,
    ) -> None:
        with self.session_local() as session:
            required_fields = [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ]
            session.add_all(
                [
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-1",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="paper",
                        symbol="AAPL",
                        event_ts=datetime(2026, 5, 18, 14, 31, tzinfo=timezone.utc),
                        timeframe="1Min",
                        seq="42",
                        reject_reason="missing_executable_quote",
                        spread_bps=Decimal("55.5"),
                        jump_bps=None,
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={"event_id": "reject-event-1"},
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-2",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="paper",
                        symbol="MSFT",
                        event_ts=datetime(2026, 5, 18, 14, 32, tzinfo=timezone.utc),
                        timeframe="1Min",
                        seq="43",
                        reject_reason="wide_spread",
                        outcome_label_status="labeled",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={"event_id": "reject-event-2"},
                        outcome_payload_json={"post_cost_net_pnl": "1.25"},
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-3",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="paper",
                        symbol="NVDA",
                        event_ts=datetime(2026, 5, 18, 14, 33, tzinfo=timezone.utc),
                        timeframe="1Min",
                        seq="44",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="incomplete",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={"event_id": "reject-event-3"},
                    ),
                ]
            )
            session.commit()

        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
        try:
            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            outcome_learning = response.json()["rejected_signal_outcome_learning"]
        finally:
            app.state.trading_scheduler = None

        self.assertEqual(outcome_learning["persistence_state"], "ok")
        self.assertEqual(outcome_learning["events_total"], 3)
        self.assertEqual(outcome_learning["outcome_label_pending_total"], 1)
        self.assertEqual(outcome_learning["labeled_count"], 1)
        self.assertEqual(outcome_learning["incomplete_count"], 1)
        self.assertEqual(
            outcome_learning["outcome_label_status_total"],
            {"incomplete": 1, "labeled": 1, "pending": 1},
        )
        self.assertEqual(
            outcome_learning["reason_total"],
            {"missing_executable_quote": 2, "wide_spread": 1},
        )
        self.assertEqual(outcome_learning["latest_event"]["event_id"], "reject-event-3")
        self.assertEqual(
            outcome_learning["blocking_reasons"],
            ["counterfactual_outcome_labels_pending"],
        )

    def test_rejected_signal_outcome_summary_reports_unavailable_on_db_error(
        self,
    ) -> None:
        with self.session_local() as session:
            with patch.object(
                session,
                "execute",
                side_effect=SQLAlchemyError("db unavailable"),
            ):
                summary = _load_rejected_signal_outcome_learning_summary(session)

        self.assertEqual(summary, {"persistence_state": "unavailable"})

    def test_simple_lane_shared_gate_applies_local_block_reason(self) -> None:
        original = {
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_emergency_stop_enabled": settings.trading_emergency_stop_enabled,
        }
        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = False
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_kill_switch_enabled = False
        settings.trading_emergency_stop_enabled = False
        try:
            with patch(
                "app.main.build_live_submission_gate_payload",
                return_value={
                    "allowed": True,
                    "reason": "ready",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                },
            ):
                gate = _build_live_submission_gate_payload(
                    SimpleNamespace(emergency_stop_active=False),
                    session=None,
                    hypothesis_summary={},
                )
        finally:
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_emergency_stop_enabled = original[
                "trading_emergency_stop_enabled"
            ]

        self.assertFalse(gate["allowed"])
        self.assertEqual(gate["reason"], "trading_disabled")
        self.assertEqual(gate["capital_stage"], "shadow")
        self.assertEqual(gate["capital_state"], "observe")
        self.assertEqual(gate["blocked_reasons"], ["trading_disabled"])
        self.assertEqual(
            gate["simple_lane"],
            {
                "submit_enabled": True,
                "shared_gate_enforced": True,
                "blocked_reasons": ["trading_disabled"],
            },
        )

    def test_simple_lane_paper_mode_preserves_shared_runtime_import_plan(self) -> None:
        original = {
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_mode": settings.trading_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
        }
        settings.trading_pipeline_mode = "simple"
        settings.trading_mode = "paper"
        settings.trading_simple_submit_enabled = True
        shared_gate = {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
            "promotion_eligible_total": 0,
            "paper_probation_eligible_total": 1,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "paper_probation_authorized": True,
                        "promotion_allowed": False,
                        "final_promotion_authorized": False,
                    }
                ],
            },
        }
        try:
            with patch(
                "app.main.build_live_submission_gate_payload",
                return_value=shared_gate,
            ) as shared_gate_builder:
                gate = _build_live_submission_gate_payload(
                    SimpleNamespace(emergency_stop_active=False),
                    session=None,
                    hypothesis_summary={},
                )
        finally:
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]

        shared_gate_builder.assert_called_once()
        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["reason"], "non_live_mode")
        self.assertEqual(gate["pipeline_mode"], "simple")
        self.assertEqual(
            gate["runtime_ledger_paper_probation_import_plan"]["target_count"],
            1,
        )
        self.assertEqual(
            gate["simple_lane"],
            {
                "submit_enabled": True,
                "shared_gate_enforced": True,
                "blocked_reasons": [],
            },
        )

    def test_trading_status_and_health_include_profitability_proof_floor(
        self,
    ) -> None:
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-07T22:11:12.125118+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "repair_ladder": [{"code": "repair_execution_tca"}],
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "account_label": "PA3SX7FYNUTF",
                "trading_mode": "live",
                "records": [
                    {
                        "symbol": "NVDA",
                        "state": "blocked",
                        "reason": "execution_tca_route_universe_incomplete",
                        "filled_execution_count": 12,
                        "next_repair_action": "repair_route_evidence_before_paper_probe",
                    }
                ],
                "summary": {"blocked_symbol_count": 1},
            },
        }

        with patch(
            "app.main.build_profitability_proof_floor_receipt",
            return_value=proof_floor,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["proof_floor"], proof_floor)
        status_consumer_evidence = status_response.json()[
            "torghut_consumer_evidence_receipt"
        ]
        self.assertEqual(
            status_consumer_evidence["schema_version"],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(status_consumer_evidence["paper_readiness_state"], "blocked")
        self.assertIn(
            "forecast_registry_degraded", status_consumer_evidence["reason_codes"]
        )
        status_route_receipt = status_response.json()["route_proven_profit_receipt"]
        self.assertEqual(
            status_route_receipt["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(status_route_receipt["decision"], "repair")
        self.assertEqual(
            status_route_receipt["consumer_evidence_receipt_id"],
            status_consumer_evidence["receipt_id"],
        )
        self.assertEqual(
            status_response.json()["consumer_evidence_canary"],
            status_route_receipt["route_canary"],
        )
        self.assertEqual(
            status_response.json()["route_reacquisition_book"],
            proof_floor["route_reacquisition_book"],
        )
        status_board = status_response.json()["route_reacquisition_board"]
        self.assertEqual(
            status_board["schema_version"],
            "torghut.route-reacquisition-board.v1",
        )
        self.assertEqual(status_board["state"], "repair_only")
        self.assertEqual(status_board["summary"]["zero_notional_row_count"], 1)
        self.assertEqual(status_board["rows"][0]["symbol"], "NVDA")
        self.assertEqual(status_board["rows"][0]["max_notional"], "0")
        self.assertEqual(health_response.json()["proof_floor"], proof_floor)
        self.assertEqual(
            health_response.json()["torghut_consumer_evidence_receipt"][
                "schema_version"
            ],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(
            health_response.json()["route_proven_profit_receipt"]["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(
            health_response.json()["route_reacquisition_book"],
            proof_floor["route_reacquisition_book"],
        )
        health_board = health_response.json()["route_reacquisition_board"]
        self.assertEqual(
            health_board["schema_version"],
            "torghut.route-reacquisition-board.v1",
        )
        self.assertEqual(health_board["state"], status_board["state"])
        self.assertEqual(health_board["summary"], status_board["summary"])
        self.assertEqual(health_board["rows"], status_board["rows"])
        self.assertEqual(
            health_response.json()["dependencies"]["profitability_proof_floor"][
                "detail"
            ],
            "repair_only",
        )
        status_ledger = status_response.json()["capital_reentry_cohort_ledger"]
        health_ledger = health_response.json()["capital_reentry_cohort_ledger"]
        self.assertEqual(
            status_ledger["schema_version"],
            "torghut.capital-reentry-cohort-ledger.v1",
        )
        self.assertEqual(status_ledger["aggregate_state"], "repair")
        self.assertEqual(status_ledger["summary"]["zero_notional_cohort_count"], 5)
        self.assertEqual(
            health_ledger["schema_version"], status_ledger["schema_version"]
        )
        self.assertTrue(
            str(health_ledger["consumer_evidence_receipt_id"]).startswith(
                "torghut-consumer-evidence:"
            )
        )
        status_profit_repair = status_response.json()["profit_repair_settlement_ledger"]
        health_profit_repair = health_response.json()["profit_repair_settlement_ledger"]
        self.assertEqual(
            status_profit_repair["schema_version"],
            "torghut.profit-repair-settlement-ledger.v1",
        )
        self.assertEqual(status_profit_repair["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(
            health_profit_repair["schema_version"],
            status_profit_repair["schema_version"],
        )
        status_routeability = status_response.json()[
            "routeability_repair_acceptance_ledger"
        ]
        health_routeability = health_response.json()[
            "routeability_repair_acceptance_ledger"
        ]
        self.assertEqual(
            status_routeability["schema_version"],
            "torghut.routeability-repair-acceptance-ledger.v1",
        )
        self.assertEqual(status_routeability["accepted_routeable_candidate_count"], 0)
        self.assertEqual(status_routeability["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(
            health_routeability["schema_version"],
            status_routeability["schema_version"],
        )
        status_arbiter = status_response.json()["evidence_clock_arbiter"]
        health_arbiter = health_response.json()["evidence_clock_arbiter"]
        self.assertEqual(
            status_arbiter["schema_version"],
            "torghut.evidence-clock-arbiter.v1",
        )
        self.assertEqual(status_arbiter["routeable_candidate_count"], 0)
        self.assertIn(
            "capital_gate",
            {clock["name"] for clock in status_arbiter["clocks"]},
        )
        self.assertEqual(
            health_arbiter["schema_version"], status_arbiter["schema_version"]
        )
        status_exchange = status_response.json()["routeable_profit_candidate_exchange"]
        health_exchange = health_response.json()["routeable_profit_candidate_exchange"]
        self.assertEqual(
            status_exchange["schema_version"],
            "torghut.routeable-profit-candidate-exchange.v1",
        )
        self.assertEqual(status_exchange["summary"]["routeable_candidate_count"], 0)
        self.assertEqual(
            health_exchange["schema_version"], status_exchange["schema_version"]
        )
        status_settlement = status_response.json()["clock_settlement_receipt"]
        health_settlement = health_response.json()["clock_settlement_receipt"]
        self.assertEqual(
            status_settlement["schema_version"],
            "torghut.clock-settlement-receipt.v1",
        )
        self.assertEqual(status_settlement["routeable_candidate_count"], 0)
        self.assertEqual(status_settlement["max_notional"], "0")
        self.assertEqual(
            health_settlement["schema_version"],
            status_settlement["schema_version"],
        )
        status_clearinghouse = status_response.json()[
            "route_evidence_clearinghouse_packet"
        ]
        health_clearinghouse = health_response.json()[
            "route_evidence_clearinghouse_packet"
        ]
        self.assertEqual(
            status_clearinghouse["schema_version"],
            "torghut.route-evidence-clearinghouse-packet.v1",
        )
        self.assertEqual(status_clearinghouse["accepted_routeable_candidate_count"], 0)
        self.assertEqual(status_clearinghouse["max_notional"], "0")
        self.assertEqual(
            health_clearinghouse["schema_version"],
            status_clearinghouse["schema_version"],
        )
        status_repair_bid_settlement = status_response.json()[
            "repair_bid_settlement_ledger"
        ]
        health_repair_bid_settlement = health_response.json()[
            "repair_bid_settlement_ledger"
        ]
        self.assertEqual(
            status_repair_bid_settlement["schema_version"],
            "torghut.repair-bid-settlement-ledger.v1",
        )
        self.assertEqual(status_repair_bid_settlement["routeable_candidate_count"], 0)
        self.assertEqual(status_repair_bid_settlement["max_notional"], "0")
        self.assertLessEqual(
            len(status_repair_bid_settlement["dispatchable_lot_ids"]),
            status_repair_bid_settlement["summary"]["max_dispatchable_lots"],
        )
        self.assertEqual(
            health_repair_bid_settlement["schema_version"],
            status_repair_bid_settlement["schema_version"],
        )
        status_warrant = status_response.json()["route_warrant_exchange"]
        health_warrant = health_response.json()["route_warrant_exchange"]
        self.assertEqual(
            status_warrant["schema_version"],
            "torghut.route-warrant-exchange.v1",
        )
        self.assertEqual(status_warrant["accepted_routeable_candidate_count"], 0)
        self.assertEqual(status_warrant["max_notional"], "0")
        self.assertEqual(
            health_warrant["schema_version"],
            status_warrant["schema_version"],
        )
        status_source_serving = status_response.json()[
            "source_serving_repair_receipt_ledger"
        ]
        health_source_serving = health_response.json()[
            "source_serving_repair_receipt_ledger"
        ]
        self.assertEqual(
            status_source_serving["schema_version"],
            "torghut.source-serving-repair-receipt-ledger.v1",
        )
        self.assertEqual(status_source_serving["max_notional"], "0")
        self.assertEqual(
            status_source_serving["route_warrant_ref"],
            status_warrant["warrant_id"],
        )
        self.assertEqual(
            health_source_serving["schema_version"],
            status_source_serving["schema_version"],
        )
        status_freshness_carry = status_response.json()["freshness_carry_ledger"]
        health_freshness_carry = health_response.json()["freshness_carry_ledger"]
        self.assertEqual(
            status_freshness_carry["schema_version"],
            "torghut.freshness-carry-ledger.v1",
        )
        self.assertEqual(
            status_freshness_carry["capital_posture"]["max_notional"],
            "0",
        )
        self.assertIn("dimensions", status_freshness_carry)
        self.assertIn("repair_proof_slos", status_freshness_carry)
        self.assertEqual(
            health_freshness_carry["schema_version"],
            status_freshness_carry["schema_version"],
        )
        status_repair_receipt_frontier = status_response.json()[
            "repair_receipt_frontier"
        ]
        health_repair_receipt_frontier = health_response.json()[
            "repair_receipt_frontier"
        ]
        self.assertEqual(
            status_repair_receipt_frontier["schema_version"],
            "torghut.repair-receipt-frontier.v1",
        )
        self.assertEqual(status_repair_receipt_frontier["max_notional"], "0")
        self.assertEqual(
            status_repair_receipt_frontier["source_serving_ledger_ref"],
            status_source_serving["ledger_id"],
        )
        self.assertEqual(
            health_repair_receipt_frontier["schema_version"],
            status_repair_receipt_frontier["schema_version"],
        )
        status_repair_outcome = status_response.json()["repair_outcome_dividend_ledger"]
        health_repair_outcome = health_response.json()["repair_outcome_dividend_ledger"]
        self.assertEqual(
            status_repair_outcome["schema_version"],
            "torghut.repair-outcome-dividend-ledger.v1",
        )
        self.assertEqual(status_repair_outcome["max_notional"], "0")
        self.assertFalse(status_repair_outcome["live_submit_enabled"])
        self.assertEqual(
            status_repair_outcome["source_repair_bid_settlement_ledger_id"],
            status_repair_bid_settlement["ledger_id"],
        )
        self.assertEqual(
            status_repair_outcome["repair_receipt_frontier_ref"],
            status_repair_receipt_frontier["frontier_id"],
        )
        self.assertEqual(
            health_repair_outcome["schema_version"],
            status_repair_outcome["schema_version"],
        )
        status_frontier = status_response.json()["profit_freshness_frontier"]
        health_frontier = health_response.json()["profit_freshness_frontier"]
        self.assertEqual(
            status_frontier["schema_version"],
            "torghut.profit-freshness-frontier.v1",
        )
        self.assertEqual(
            status_frontier["capital_posture"]["paper_notional_limit"],
            "0",
        )
        self.assertEqual(
            status_frontier["capital_posture"]["live_notional_limit"],
            "0",
        )
        self.assertEqual(
            health_frontier["schema_version"],
            status_frontier["schema_version"],
        )

    def test_trading_status_and_health_include_renewal_bond_profit_escrow(
        self,
    ) -> None:
        escrow = {
            "schema_version": "torghut.renewal-bond-profit-escrow.v1",
            "receipt_id": "rbpe-test",
            "escrow_verdict": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "selected_zero_notional_repairs": [
                {"code": "refresh_execution_tca_settlement"}
            ],
        }

        with patch(
            "app.main.build_renewal_bond_profit_escrow",
            return_value=escrow,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["renewal_bond_profit_escrow"], escrow)
        self.assertEqual(health_response.json()["renewal_bond_profit_escrow"], escrow)

    def test_trading_status_health_and_autonomy_include_alpha_replay_projection(
        self,
    ) -> None:
        projection = {
            "capital_replay_board": {
                "schema_version": "torghut.capital-replay-board.v1",
                "board_id": "capital-replay:test",
                "summary": {"replay_item_count": 1},
                "replay_items": [{"max_notional": "0"}],
            },
            "executable_alpha_receipts": {
                "schema_version": "torghut.executable-alpha-receipts.v1",
                "summary": {"receipts_total": 1},
                "receipts": [{"graduation_state": "candidate"}],
            },
        }

        with (
            patch(
                "app.main.build_capital_replay_projection",
                return_value=projection,
            ),
            patch(
                "app.main._build_autonomy_capital_replay_projection",
                return_value=projection,
            ),
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")
            autonomy_response = self.client.get("/trading/autonomy")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(autonomy_response.status_code, 200)
        for response in (status_response, health_response, autonomy_response):
            payload = response.json()
            self.assertEqual(
                payload["capital_replay_board"],
                projection["capital_replay_board"],
            )
            self.assertEqual(
                payload["executable_alpha_receipts"],
                projection["executable_alpha_receipts"],
            )

    def test_trading_status_and_health_include_quality_adjusted_frontier(
        self,
    ) -> None:
        frontier = {
            "schema_version": "torghut.quality-adjusted-profit-frontier.v1",
            "frontier_id": "quality-frontier:test",
            "summary": {"packet_count": 1, "capital_ready": False},
            "packets": [{"repair_class": "quant", "max_notional": "0"}],
            "paper_probe_notional_limit": "0",
        }

        with patch(
            "app.main.build_quality_adjusted_profit_frontier",
            return_value=frontier,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(
            status_response.json()["quality_adjusted_profit_frontier"],
            frontier,
        )
        self.assertEqual(
            health_response.json()["quality_adjusted_profit_frontier"],
            frontier,
        )

    def test_trading_status_and_health_include_profit_signal_quorum(self) -> None:
        quorum = {
            "schema_version": "torghut.profit-signal-quorum.v1",
            "quorum_set_id": "profit-signal-quorum-ledger:test",
            "aggregate_decision": "observe_only",
            "summary": {"quorum_count": 1, "zero_notional_quorum_count": 1},
            "quorums": [
                {
                    "quorum_id": "profit-signal-quorum:test",
                    "hypothesis_id": "H-CONT-01",
                    "decision": "observe_only",
                    "max_notional": "0",
                }
            ],
            "max_notional": "0",
        }

        with patch("app.main.build_profit_signal_quorum", return_value=quorum):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["profit_signal_quorum"], quorum)
        self.assertEqual(health_response.json()["profit_signal_quorum"], quorum)

    def test_trading_health_requires_profitability_proof_floor_in_live(self) -> None:
        original_enabled = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_empirical_required = settings.trading_empirical_jobs_health_required
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_universe_source = "static"
        settings.trading_empirical_jobs_health_required = False
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler

            with (
                patch("app.main._check_alpaca", return_value={"ok": True}),
                patch("app.main._check_clickhouse", return_value={"ok": True}),
                patch("app.main._check_postgres", return_value={"ok": True}),
                patch(
                    "app.main._check_account_scope_invariants_bounded",
                    return_value={
                        "account_scope_ready": True,
                        "account_scope_errors": [],
                    },
                ),
                patch(
                    "app.main.check_schema_current",
                    return_value={
                        "schema_current": True,
                        "current_heads": ["0011_execution_tca_simulator_divergence"],
                        "expected_heads": ["0011_execution_tca_simulator_divergence"],
                        "schema_head_signature": "7f8e4d0",
                    },
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value={
                        "allowed": True,
                        "reason": "ready",
                        "blocked_reasons": [],
                        "capital_stage": "live",
                    },
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": False, "status": "degraded"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": False,
                        "ok": True,
                        "status": "not_required",
                        "reason": "quant_health_not_configured",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value={
                        "route_state": "repair_only",
                        "capital_state": "zero_notional",
                    },
                ),
            ):
                response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            dependency = response.json()["dependencies"]["profitability_proof_floor"]
            self.assertFalse(dependency["ok"])
            self.assertEqual(dependency["detail"], "repair_only")
            self.assertTrue(dependency["required"])
        finally:
            settings.trading_enabled = original_enabled
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_empirical_jobs_health_required = (
                original_empirical_required
            )

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_ok(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["postgres"]["ok"])
            self.assertTrue(payload["dependencies"]["clickhouse"]["ok"])
            self.assertTrue(payload["dependencies"]["alpaca"]["ok"])
            self.assertIn("universe", payload["dependencies"])
            self.assertTrue(payload["dependencies"]["universe"]["ok"])
            self.assertEqual(payload["dependencies"]["universe"]["status"], "ok")
            self.assertEqual(
                payload["dependencies"]["universe"]["detail"], "jangar universe fresh"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_resolves_jangar_universe_before_reporting_ok(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_require_non_empty = settings.trading_universe_require_non_empty_jangar
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        settings.trading_universe_require_non_empty_jangar = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols={"AMD", "NVDA"},
                        status="ok",
                        reason="jangar_fetch_ok",
                        cache_age_seconds=0,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertTrue(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "ok")
            self.assertEqual(universe_dependency["symbols_count"], 2)
            self.assertEqual(scheduler.state.universe_symbols_count, 2)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_universe_require_non_empty_jangar = (
                original_require_non_empty
            )

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_resolves_static_universe_before_reporting_ok(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "static"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols={"AAPL", "NVDA"},
                        status="ok",
                        reason="static_symbols_loaded",
                        cache_age_seconds=None,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertTrue(universe_dependency["ok"])
            self.assertEqual(universe_dependency["source"], "static")
            self.assertEqual(universe_dependency["status"], "ok")
            self.assertEqual(universe_dependency["reason"], "static_symbols_loaded")
            self.assertEqual(universe_dependency["symbols_count"], 2)
            self.assertEqual(universe_dependency["detail"], "static universe loaded")
            self.assertTrue(universe_dependency["require_non_empty"])
            self.assertEqual(scheduler.state.universe_symbols_count, 2)
            self.assertFalse(scheduler.state.universe_fail_safe_blocked)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_fails_closed_when_static_universe_probe_is_empty(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "static"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols=set(),
                        status="empty",
                        reason="static_symbols_empty",
                        cache_age_seconds=None,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertFalse(universe_dependency["ok"])
            self.assertEqual(universe_dependency["source"], "static")
            self.assertEqual(universe_dependency["status"], "empty")
            self.assertEqual(universe_dependency["reason"], "static_symbols_empty")
            self.assertEqual(universe_dependency["detail"], "static universe empty")
            self.assertTrue(universe_dependency["require_non_empty"])
            self.assertEqual(scheduler.state.universe_symbols_count, 0)
            self.assertTrue(scheduler.state.universe_fail_safe_blocked)
            self.assertEqual(
                scheduler.state.universe_fail_safe_block_reason,
                "static_symbols_empty",
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_fails_closed_when_universe_probe_is_empty(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_require_non_empty = settings.trading_universe_require_non_empty_jangar
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        settings.trading_universe_require_non_empty_jangar = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "not_evaluated"
            scheduler.state.universe_symbols_count = 0
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols=set(),
                        status="empty",
                        reason="jangar_empty_response_cache_stale",
                        cache_age_seconds=None,
                    )
                ),
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            payload = response.json()
            universe_dependency = payload["dependencies"]["universe"]
            self.assertFalse(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "empty")
            self.assertEqual(universe_dependency["detail"], "jangar universe empty")
            self.assertEqual(scheduler.state.universe_symbols_count, 0)
            self.assertTrue(scheduler.state.universe_fail_safe_blocked)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_universe_require_non_empty_jangar = (
                original_require_non_empty
            )

    @patch("app.main.load_quant_evidence_status")
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_treats_quant_evidence_as_informational_outside_live_mode(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        mock_quant_evidence: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            mock_quant_evidence.return_value = {
                "required": True,
                "ok": False,
                "status": "unknown",
                "reason": "quant_health_fetch_failed",
                "blocking_reasons": ["quant_health_fetch_failed"],
                "account": "paper",
                "window": "15m",
                "source_url": "https://torghut.example/custom/proxy/quant/health?account=paper&window=15m",
            }
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["quant_evidence"]["ok"])
            self.assertEqual(
                payload["dependencies"]["quant_evidence"]["detail"],
                "not_required_in_non_live_mode",
            )
            self.assertFalse(payload["quant_evidence"]["ok"])
            self.assertEqual(
                payload["quant_evidence"]["reason"], "quant_health_fetch_failed"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch(
        "app.main._build_live_submission_gate_payload",
        return_value={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "live",
        },
    )
    @patch("app.main._empirical_jobs_status")
    @patch("app.main.load_quant_evidence_status")
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_live_external_authorities_are_informational_when_not_required(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        mock_quant_evidence: object,
        mock_empirical_jobs: object,
        _mock_submission_gate: object,
    ) -> None:
        original_enabled = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_empirical_required = settings.trading_empirical_jobs_health_required
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_universe_source = "static"
        settings.trading_empirical_jobs_health_required = False
        try:
            mock_empirical_jobs.return_value = {
                "ready": False,
                "status": "degraded",
                "authority": "blocked",
            }
            mock_quant_evidence.return_value = {
                "required": False,
                "ok": True,
                "status": "not_required",
                "reason": "quant_health_not_configured",
                "blocking_reasons": [],
                "account": "live",
                "window": "15m",
                "source_url": None,
            }
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler

            with patch(
                "app.main._build_profitability_proof_floor_payload",
                return_value={
                    "route_state": "live_micro_candidate",
                    "capital_state": "live_allowed",
                },
            ):
                response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["empirical_jobs"]["ok"])
            self.assertFalse(payload["dependencies"]["empirical_jobs"]["required"])
            self.assertTrue(payload["dependencies"]["quant_evidence"]["ok"])
            self.assertFalse(payload["dependencies"]["quant_evidence"]["required"])
            self.assertTrue(payload["dependencies"]["profitability_proof_floor"]["ok"])
        finally:
            settings.trading_enabled = original_enabled
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_empirical_jobs_health_required = (
                original_empirical_required
            )

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_reuses_dependency_checks_within_cache_ttl(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 1)
            self.assertEqual(_mock_clickhouse.call_count, 1)
            self.assertEqual(_mock_alpaca.call_count, 1)
            payload = response.json()
            self.assertEqual(
                payload["dependencies"]["readiness_cache"]["cache_used"], True
            )
            self.assertIn("checked_at", payload["dependencies"]["readiness_cache"])
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_refreshes_dependency_checks_after_cache_ttl(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)

            cache_key = _readiness_dependency_cache_key(include_database_contract=True)
            _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key]["checked_at"] = datetime.now(
                timezone.utc
            ) - timedelta(seconds=120)
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 2)
            self.assertEqual(_mock_clickhouse.call_count, 2)
            self.assertEqual(_mock_alpaca.call_count, 2)
            payload = response.json()
            self.assertEqual(
                payload["dependencies"]["readiness_cache"]["cache_used"], False
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": False, "detail": "down"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_dependency_failure(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["clickhouse"]["ok"])
            self.assertIn("universe", payload["dependencies"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
        },
    )
    def test_trading_health_flags_universe_blocking(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "error"
            scheduler.state.universe_source_reason = "jangar_fetch_failed_cache_stale"
            scheduler.state.universe_symbols_count = 0
            scheduler.state.universe_cache_age_seconds = 600
            scheduler.state.universe_fail_safe_blocked = True
            scheduler.state.universe_fail_safe_block_reason = (
                "jangar_fetch_failed_cache_stale"
            )
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            universe_dependency = payload["dependencies"]["universe"]
            self.assertFalse(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "error")
            self.assertEqual(
                universe_dependency["detail"], "jangar universe unavailable"
            )
            self.assertEqual(
                universe_dependency["reason"], "jangar_fetch_failed_cache_stale"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_trading_health_reports_static_fallback_universe_as_degraded_not_blocked(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "degraded"
            scheduler.state.universe_source_reason = (
                "jangar_fetch_failed_cache_stale_using_static_fallback"
            )
            scheduler.state.universe_symbols_count = 8
            scheduler.state.universe_cache_age_seconds = 900
            scheduler.state.universe_fail_safe_blocked = False
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            universe_dependency = payload["dependencies"]["universe"]
            self.assertTrue(universe_dependency["ok"])
            self.assertEqual(universe_dependency["status"], "degraded")
            self.assertEqual(
                universe_dependency["detail"], "jangar static fallback in use"
            )
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_readyz_returns_200_when_dependencies_are_healthy(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["postgres"]["ok"])
            self.assertTrue(payload["dependencies"]["clickhouse"]["ok"])
            self.assertTrue(payload["dependencies"]["alpaca"]["ok"])
            self.assertIn("universe", payload["dependencies"])
            self.assertTrue(payload["dependencies"]["universe"]["ok"])
            self.assertTrue(payload["dependencies"]["database"]["schema_current"])
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_signature"], "7f8e4d0"
            )
            self.assertIn("checked_at", payload["dependencies"]["database"])
            self.assertIn("readiness_cache", payload["dependencies"])
            self.assertIn("cache_used", payload["dependencies"]["readiness_cache"])
            self.assertFalse(payload["dependencies"]["readiness_cache"]["cache_stale"])
            self.assertEqual(payload["readiness_surface"], "core_dependencies_only")
            live_submission_gate = payload["live_submission_gate"]
            self.assertFalse(live_submission_gate["allowed"])
            self.assertFalse(live_submission_gate["promotion_authority"])
            self.assertFalse(live_submission_gate["final_authority_ok"])
            self.assertFalse(live_submission_gate["final_promotion_allowed"])
            self.assertEqual(
                live_submission_gate["reason"],
                "readyz_core_dependencies_only",
            )
            self.assertFalse(live_submission_gate["read_model_evaluated"])
            self.assertNotIn("alpha_repair_closure_board", payload)
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source

    def test_core_readyz_gate_records_live_blockers_without_authority(self) -> None:
        original = {
            "trading_mode": settings.trading_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
        }
        try:
            settings.trading_mode = "live"
            settings.trading_enabled = False
            settings.trading_kill_switch_enabled = True
            settings.trading_pipeline_mode = "simple"
            settings.trading_simple_submit_enabled = False

            gate = main_module._core_readiness_live_submission_gate()
        finally:
            settings.trading_mode = original["trading_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]

        self.assertFalse(gate["allowed"])
        self.assertFalse(gate["promotion_authority"])
        self.assertFalse(gate["promotion_authority_ok"])
        self.assertFalse(gate["final_authority_ok"])
        self.assertFalse(gate["final_promotion_allowed"])
        self.assertFalse(gate["final_promotion_authorized"])
        self.assertEqual(gate["reason"], "readyz_core_dependencies_only")
        self.assertEqual(
            gate["reason_codes"],
            [
                "readyz_core_dependencies_only",
                "trading_disabled",
                "kill_switch_enabled",
                "simple_submit_disabled",
            ],
        )
        self.assertFalse(gate["read_model_evaluated"])
        self.assertEqual(gate["readiness_surface"], "core_dependencies_only")

    def test_core_readyz_creates_scheduler_when_app_state_is_empty(self) -> None:
        original = {
            "trading_mode": settings.trading_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_readiness_dependency_cache_ttl_seconds": settings.trading_readiness_dependency_cache_ttl_seconds,
            "trading_readiness_dependency_cache_stale_tolerance_seconds": settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
        }
        checked_at = datetime.now(timezone.utc)
        if hasattr(app.state, "trading_scheduler"):
            del app.state.trading_scheduler
        try:
            settings.trading_mode = "paper"
            settings.trading_enabled = True
            settings.trading_readiness_dependency_cache_ttl_seconds = 8
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = 20
            with (
                patch(
                    "app.main._evaluate_scheduler_status",
                    return_value=(True, {"ok": True, "running": True}),
                ),
                patch(
                    "app.main._readiness_dependency_snapshot",
                    return_value=(
                        {
                            "postgres": {"ok": True, "detail": "ok"},
                            "clickhouse": {"ok": True, "detail": "ok"},
                            "alpaca": {"ok": True, "detail": "ok"},
                            "tigerbeetle": {"ok": True, "detail": "ok"},
                            "database": {"ok": True, "detail": "ok"},
                        },
                        checked_at,
                        False,
                    ),
                ),
                patch(
                    "app.main._evaluate_universe_dependency",
                    return_value={"ok": True, "detail": "ok"},
                ),
            ):
                payload, status_code = main_module._evaluate_core_readiness_payload(
                    include_database_contract=True,
                    allow_stale_dependency_cache=True,
                )
        finally:
            settings.trading_mode = original["trading_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_readiness_dependency_cache_ttl_seconds = original[
                "trading_readiness_dependency_cache_ttl_seconds"
            ]
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = (
                original["trading_readiness_dependency_cache_stale_tolerance_seconds"]
            )

        self.assertEqual(status_code, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertIsInstance(app.state.trading_scheduler, TradingScheduler)
        self.assertEqual(payload["readiness_surface"], "core_dependencies_only")
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertFalse(payload["live_submission_gate"]["read_model_evaluated"])
        self.assertFalse(payload["dependencies"]["readiness_cache"]["cache_stale"])

    @patch(
        "app.main._alpaca_probe_account",
        side_effect=[
            {
                "ok": True,
                "status": "broker_ok",
                "detail": "ok",
                "account": {
                    "account_number": "PA3SX7FYNUTF",
                    "status": "ACTIVE",
                },
            },
            {
                "ok": False,
                "status": "broker_slow",
                "detail": "alpaca account probe timed out after 2.00s",
            },
        ],
    )
    @patch("app.main.TorghutAlpacaClient")
    def test_check_alpaca_uses_cached_last_known_good_for_slow_probe(
        self,
        mock_client: Any,
        _mock_probe: object,
    ) -> None:
        original_key = settings.apca_api_key_id
        original_secret = settings.apca_api_secret_key
        original_ttl = settings.trading_alpaca_healthcheck_last_good_ttl_seconds
        original_retries = settings.trading_alpaca_healthcheck_retries
        try:
            settings.apca_api_key_id = "demo-key"
            settings.apca_api_secret_key = "demo-secret"
            settings.trading_alpaca_healthcheck_last_good_ttl_seconds = 120
            settings.trading_alpaca_healthcheck_retries = 1
            mock_client.return_value.endpoint_class = "live"

            first = _check_alpaca()
            second = _check_alpaca()
        finally:
            settings.apca_api_key_id = original_key
            settings.apca_api_secret_key = original_secret
            settings.trading_alpaca_healthcheck_last_good_ttl_seconds = original_ttl
            settings.trading_alpaca_healthcheck_retries = original_retries

        self.assertTrue(first["ok"])
        self.assertEqual(first["broker_status"], "broker_ok")
        self.assertFalse(first["cache_used"])
        self.assertTrue(second["ok"])
        self.assertTrue(second["cache_used"])
        self.assertEqual(second["broker_status"], "broker_slow")
        self.assertEqual(second["endpoint_class"], "live")
        self.assertEqual(second["account_label"], "PA3SX7FYNUTF")

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0017_whitepaper_semantic_indexing"],
            "expected_heads": ["0017_whitepaper_semantic_indexing"],
            "schema_head_signature": "sig-override",
            "schema_graph_signature": "graph-override",
            "schema_graph_roots": ["0001_initial_torghut_schema"],
            "schema_graph_branch_count": 2,
            "schema_graph_branch_tolerance": 1,
            "schema_graph_allow_divergence_roots": True,
            "schema_graph_parent_forks": {
                "0015_whitepaper_workflow_tables": [
                    "0016_llm_dspy_workflow_artifacts",
                    "0017_whitepaper_semantic_indexing",
                ]
            },
            "schema_graph_duplicate_revisions": {},
            "schema_graph_orphan_parents": [],
            "schema_graph_lineage_ready": True,
            "schema_graph_lineage_errors": [],
            "schema_graph_lineage_warnings": [
                "migration graph branch count 2 exceeds tolerance 1; allowed by "
                "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
            ],
            "checked_at": "2026-03-06T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
            "account_scope_warnings": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_returns_200_with_schema_lineage_warning_override(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["dependencies"]["database"]["ok"])
            self.assertTrue(
                payload["dependencies"]["database"]["schema_graph_lineage_ready"]
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_graph_lineage_warnings"],
                [
                    "migration graph branch count 2 exceeds tolerance 1; allowed by "
                    "TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS=true"
                ],
            )
            self.assertEqual(payload["dependencies"]["database"]["detail"], "ok")
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_reuses_stale_dependency_cache_within_stale_tolerance(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        original_stale_tolerance = (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        )
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        settings.trading_readiness_dependency_cache_stale_tolerance_seconds = 20
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            cache_key = _readiness_dependency_cache_key(include_database_contract=True)
            _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key]["checked_at"] = datetime.now(
                timezone.utc
            ) - timedelta(seconds=22)
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 1)
            self.assertEqual(_mock_clickhouse.call_count, 1)
            self.assertEqual(_mock_alpaca.call_count, 1)
            payload = response.json()
            cache = payload["dependencies"]["readiness_cache"]
            self.assertTrue(cache["cache_used"])
            self.assertTrue(cache["cache_stale"])
            self.assertGreater(cache["cache_age_seconds"], 8)
            self.assertLessEqual(cache["cache_age_seconds"], 28)
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = (
                original_stale_tolerance
            )
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    def test_readyz_stale_dependency_cache_keeps_authority_fail_closed(
        self,
    ) -> None:
        original_mode = settings.trading_mode
        original_enabled = settings.trading_enabled
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        original_stale_tolerance = (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        )
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        settings.trading_readiness_dependency_cache_stale_tolerance_seconds = 20
        checked_at = datetime.now(timezone.utc) - timedelta(seconds=12)
        cache_key = _readiness_dependency_cache_key(include_database_contract=True)
        _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key] = {
            "checked_at": checked_at,
            "dependencies": {
                "postgres": {"ok": False, "detail": "statement timeout"},
                "clickhouse": {"ok": True, "detail": "ok"},
                "alpaca": {"ok": True, "detail": "ok"},
                "tigerbeetle": {
                    "ok": False,
                    "blockers": ["tigerbeetle_ref_counts_query_timeout"],
                },
                "database": {"ok": True, "detail": "ok"},
            },
        }
        authoritative_gate = {
            "allowed": True,
            "reason": "promotion_authority_ok",
            "promotion_authority": True,
            "promotion_authority_ok": True,
            "final_authority_ok": True,
            "final_promotion_allowed": True,
            "final_promotion_authorized": True,
            "blocked_reasons": [],
            "reason_codes": [],
            "runtime_ledger_paper_probation_import_plan": {
                "promotion_allowed": True,
                "final_promotion_allowed": True,
                "final_promotion_authorized": True,
                "targets": [
                    {
                        "promotion_allowed": True,
                        "final_promotion_allowed": True,
                        "final_promotion_authorized": True,
                    }
                ],
            },
        }
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=authoritative_gate,
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                    },
                ),
            ):
                response = self.client.get("/readyz")
        finally:
            settings.trading_mode = original_mode
            settings.trading_enabled = original_enabled
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = (
                original_stale_tolerance
            )
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["dependencies"]["postgres"]["ok"])
        self.assertEqual(
            payload["dependencies"]["tigerbeetle"]["blockers"],
            ["tigerbeetle_ref_counts_query_timeout"],
        )
        cache = payload["dependencies"]["readiness_cache"]
        self.assertTrue(cache["cache_used"])
        self.assertTrue(cache["cache_stale"])
        live_submission_gate = payload["live_submission_gate"]
        self.assertFalse(live_submission_gate["allowed"])
        self.assertFalse(live_submission_gate["promotion_authority"])
        self.assertFalse(live_submission_gate["final_authority_ok"])
        self.assertFalse(live_submission_gate["final_promotion_allowed"])
        self.assertIn(
            "readyz_core_dependencies_only",
            live_submission_gate["reason_codes"],
        )
        self.assertFalse(live_submission_gate["read_model_evaluated"])
        self.assertEqual(
            _json_truthy_paths_for_keys(
                payload,
                {
                    "promotion_authority",
                    "promotion_authority_ok",
                    "final_authority_ok",
                    "final_promotion_allowed",
                    "final_promotion_authorized",
                },
            ),
            [],
        )

    def test_trading_health_evaluation_timeout_returns_fail_closed_quickly(
        self,
    ) -> None:
        original_timeout = main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
        main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 0.01
        with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        def _slow_health_payload(**_kwargs: object) -> tuple[dict[str, object], int]:
            time.sleep(0.2)
            return ({"status": "ok", "live_submission_gate": {"allowed": True}}, 200)

        try:
            with patch(
                "app.main._evaluate_trading_health_payload",
                side_effect=_slow_health_payload,
            ):
                started_at = time.monotonic()
                response = self.client.get("/trading/health")
                elapsed = time.monotonic() - started_at
            time.sleep(0.25)
        finally:
            main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = original_timeout
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertLess(elapsed, 0.5)
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["reason"], "trading_health_evaluation_timeout")
        self.assertIn(
            "trading_health_evaluation_timeout",
            payload["dependencies"]["health_evaluation"]["reason_codes"],
        )
        self.assertIsInstance(payload["dependencies"]["postgres"], dict)
        self.assertFalse(payload["dependencies"]["postgres"]["ok"])
        self.assertIsInstance(payload["scheduler"], dict)
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertFalse(payload["live_submission_gate"]["promotion_authority"])
        self.assertFalse(payload["live_submission_gate"]["final_authority_ok"])

    def test_trading_health_timeout_uses_cached_dependency_shape(self) -> None:
        original_timeout = main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
        main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 0.01
        health_cache_key = main_module._trading_health_surface_cache_key(
            include_database_contract=False,
            allow_stale_dependency_cache=False,
        )
        dependency_cache_key = _readiness_dependency_cache_key(False)
        checked_at = datetime.now(timezone.utc)
        _TRADING_DEPENDENCY_HEALTH_CACHE[dependency_cache_key] = {
            "checked_at": checked_at,
            "dependencies": {
                "postgres": {"ok": True, "detail": "ok"},
                "clickhouse": {"ok": True, "detail": "ok"},
                "alpaca": {"ok": True, "detail": "ok"},
                "tigerbeetle": {
                    "ok": True,
                    "blockers": ["tigerbeetle_runtime_ledger_signed_refs_missing"],
                },
            },
        }
        with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.pop(
                health_cache_key,
                None,
            )

        def _slow_health_payload(**_kwargs: object) -> tuple[dict[str, object], int]:
            time.sleep(0.2)
            return ({"status": "ok", "live_submission_gate": {"allowed": True}}, 200)

        try:
            with patch(
                "app.main._evaluate_trading_health_payload",
                side_effect=_slow_health_payload,
            ):
                response = self.client.get("/trading/health")
            time.sleep(0.25)
        finally:
            main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = original_timeout
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        dependencies = payload["dependencies"]
        self.assertEqual(payload["reason"], "trading_health_evaluation_timeout")
        self.assertTrue(dependencies["postgres"]["ok"])
        self.assertTrue(dependencies["clickhouse"]["ok"])
        self.assertEqual(
            dependencies["tigerbeetle"]["blockers"],
            ["tigerbeetle_runtime_ledger_signed_refs_missing"],
        )
        self.assertTrue(dependencies["readiness_cache"]["cache_used"])
        self.assertTrue(
            dependencies["readiness_cache"]["health_surface_timeout_fallback"]
        )
        self.assertIsInstance(payload["scheduler"], dict)
        self.assertFalse(payload["live_submission_gate"]["promotion_authority"])
        self.assertFalse(payload["live_submission_gate"]["final_authority_ok"])
        self.assertFalse(payload["live_submission_gate"]["final_promotion_allowed"])

    def test_trading_health_serves_completed_health_cache_while_refreshing(
        self,
    ) -> None:
        cache_key = main_module._trading_health_surface_cache_key(
            include_database_contract=False,
            allow_stale_dependency_cache=False,
        )
        cached_payload: dict[str, object] = {
            "status": "degraded",
            "reason": "cached_health_payload",
            "reason_codes": ["cached_health_payload"],
            "dependencies": {"postgres": {"ok": True, "detail": "ok"}},
            "live_submission_gate": {
                "allowed": False,
                "promotion_authority": False,
                "final_authority_ok": False,
                "final_promotion_allowed": False,
            },
        }
        completed_future: Future[tuple[dict[str, object], int]] = Future()
        completed_future.set_result((cached_payload, 503))
        refresh_called = Event()
        refresh_calls: list[object] = []

        def _refresh_health_payload(
            **_kwargs: object,
        ) -> tuple[dict[str, object], int]:
            refresh_calls.append(_kwargs)
            refresh_called.set()
            return (
                {
                    **cached_payload,
                    "reason": "refreshed_health_payload",
                    "reason_codes": ["refreshed_health_payload"],
                },
                503,
            )

        with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS[cache_key] = (
                completed_future
            )
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE[cache_key] = {
                "payload": cached_payload,
                "status_code": 503,
                "checked_at": datetime.now(timezone.utc),
            }

        try:
            with patch(
                "app.main._evaluate_trading_health_payload",
                side_effect=_refresh_health_payload,
            ):
                response = self.client.get("/trading/health")
                self.assertTrue(refresh_called.wait(1.0))
                self.assertEqual(len(refresh_calls), 1)
        finally:
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["reason"], "cached_health_payload")
        self.assertNotEqual(payload["reason"], "trading_health_evaluation_timeout")

    def test_trading_health_starts_fresh_eval_when_completed_future_has_no_cache(
        self,
    ) -> None:
        cache_key = main_module._trading_health_surface_cache_key(
            include_database_contract=False,
            allow_stale_dependency_cache=False,
        )
        completed_future: Future[tuple[dict[str, object], int]] = Future()
        completed_future.set_result(({"reason": "orphaned_health_payload"}, 503))
        refresh_calls: list[object] = []

        def _refresh_health_payload(
            **_kwargs: object,
        ) -> tuple[dict[str, object], int]:
            refresh_calls.append(_kwargs)
            return (
                {
                    "status": "degraded",
                    "reason": "fresh_health_payload",
                    "reason_codes": ["fresh_health_payload"],
                },
                503,
            )

        with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS[cache_key] = (
                completed_future
            )

        try:
            with patch(
                "app.main._evaluate_trading_health_payload",
                side_effect=_refresh_health_payload,
            ):
                response = self.client.get("/trading/health")
        finally:
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["reason"], "fresh_health_payload")
        self.assertEqual(len(refresh_calls), 1)

    def test_timeout_live_gate_records_live_mode_blockers(self) -> None:
        original = {
            "trading_mode": settings.trading_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
        }
        try:
            settings.trading_mode = "live"
            settings.trading_enabled = False
            settings.trading_kill_switch_enabled = True
            settings.trading_pipeline_mode = "simple"
            settings.trading_simple_submit_enabled = False

            gate = main_module._minimal_health_surface_timeout_live_submission_gate(
                reason_code="readyz_evaluation_timeout",
                detail="readyz evaluation exceeded 3.0s",
            )
        finally:
            settings.trading_mode = original["trading_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]

        self.assertFalse(gate["allowed"])
        self.assertEqual(gate["reason"], "trading_disabled")
        self.assertEqual(
            gate["blocked_reasons"],
            [
                "trading_disabled",
                "kill_switch_enabled",
                "simple_submit_disabled",
            ],
        )
        self.assertFalse(gate["promotion_authority"])
        self.assertFalse(gate["final_authority_ok"])
        self.assertFalse(gate["final_promotion_allowed"])

    def test_trading_health_timeout_uses_cached_blockers_fail_closed(self) -> None:
        original_timeout = main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
        main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 0.01
        cache_key = main_module._trading_health_surface_cache_key(
            include_database_contract=False,
            allow_stale_dependency_cache=False,
        )
        cached_payload: dict[str, object] = {
            "status": "degraded",
            "dependencies": {
                "tigerbeetle": {
                    "ok": False,
                    "blockers": [
                        "source_amount_mismatch",
                        "unlinked_execution_cost",
                    ],
                }
            },
            "options_catalog_freshness": {
                "ok": False,
                "blockers": ["options_catalog_freshness_gap"],
            },
            "live_submission_gate": {
                "allowed": True,
                "promotion_authority": True,
                "final_authority_ok": True,
                "final_promotion_allowed": True,
            },
        }
        with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE[cache_key] = {
                "payload": cached_payload,
                "status_code": 503,
                "checked_at": datetime.now(timezone.utc),
            }

        def _slow_health_payload(**_kwargs: object) -> tuple[dict[str, object], int]:
            time.sleep(0.2)
            return (cached_payload, 503)

        try:
            with patch(
                "app.main._evaluate_trading_health_payload",
                side_effect=_slow_health_payload,
            ):
                response = self.client.get("/trading/health")
            time.sleep(0.25)
        finally:
            main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = original_timeout
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["reason"], "trading_health_evaluation_timeout")
        self.assertIn(
            "source_amount_mismatch",
            payload["dependencies"]["tigerbeetle"]["blockers"],
        )
        self.assertIn(
            "unlinked_execution_cost",
            payload["dependencies"]["tigerbeetle"]["blockers"],
        )
        self.assertEqual(
            payload["options_catalog_freshness"]["blockers"],
            ["options_catalog_freshness_gap"],
        )
        live_submission_gate = payload["live_submission_gate"]
        self.assertFalse(live_submission_gate["allowed"])
        self.assertFalse(live_submission_gate["promotion_authority"])
        self.assertFalse(live_submission_gate["final_authority_ok"])
        self.assertFalse(live_submission_gate["final_promotion_allowed"])
        self.assertTrue(live_submission_gate["readiness_dependency_guard_active"])

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_trading_health_refreshes_stale_readiness_cache_without_tolerance(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_mode = settings.trading_mode
        original_cache_enabled = settings.trading_readiness_dependency_cache_enabled
        original_cache_ttl = settings.trading_readiness_dependency_cache_ttl_seconds
        original_stale_tolerance = (
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds
        )
        original_source = settings.trading_universe_source
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_readiness_dependency_cache_enabled = True
        settings.trading_readiness_dependency_cache_ttl_seconds = 8
        settings.trading_readiness_dependency_cache_stale_tolerance_seconds = 20
        settings.trading_universe_source = "jangar"
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            cache_key = _readiness_dependency_cache_key(include_database_contract=False)
            _TRADING_DEPENDENCY_HEALTH_CACHE[cache_key]["checked_at"] = datetime.now(
                timezone.utc
            ) - timedelta(seconds=30)
            response = self.client.get("/trading/health")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(_mock_postgres.call_count, 2)
            self.assertEqual(_mock_clickhouse.call_count, 2)
            self.assertEqual(_mock_alpaca.call_count, 2)
            payload = response.json()
            self.assertFalse(payload["dependencies"]["readiness_cache"]["cache_stale"])
        finally:
            settings.trading_enabled = original
            settings.trading_mode = original_mode
            settings.trading_readiness_dependency_cache_enabled = original_cache_enabled
            settings.trading_readiness_dependency_cache_ttl_seconds = original_cache_ttl
            settings.trading_readiness_dependency_cache_stale_tolerance_seconds = (
                original_stale_tolerance
            )
            settings.trading_universe_source = original_source
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_allows_startup_grace_window(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        original_grace = settings.trading_startup_readiness_grace_seconds
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        settings.trading_startup_readiness_grace_seconds = 45
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = False
            scheduler.state.startup_started_at = datetime.now(timezone.utc)
            scheduler.state.universe_source_status = "ok"
            scheduler.state.universe_source_reason = "jangar_fetch_ok"
            scheduler.state.universe_symbols_count = 2
            scheduler.state.universe_cache_age_seconds = 0
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["scheduler"]["ok"])
            self.assertIn("readiness grace", payload["scheduler"]["detail"])
            self.assertTrue(payload["scheduler"]["startup_readiness_grace_active"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source
            settings.trading_startup_readiness_grace_seconds = original_grace
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch(
        "app.main._evaluate_database_contract",
        return_value={
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
            "checked_at": "2026-03-04T00:00:00+00:00",
            "account_scope_ready": True,
            "account_scope_errors": [],
        },
    )
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    def test_readyz_rejects_after_startup_grace_expires(
        self,
        _mock_alpaca: object,
        _mock_clickhouse: object,
        _mock_postgres: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        original_grace = settings.trading_startup_readiness_grace_seconds
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        settings.trading_startup_readiness_grace_seconds = 30
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = False
            scheduler.state.startup_started_at = datetime.now(timezone.utc) - timedelta(
                seconds=61
            )
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["scheduler"]["ok"])
            self.assertIn("trading loop", payload["scheduler"]["detail"])
            self.assertFalse(payload["scheduler"]["startup_readiness_grace_active"])
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source
            settings.trading_startup_readiness_grace_seconds = original_grace
            _TRADING_DEPENDENCY_HEALTH_CACHE.clear()

    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": False, "detail": "down"})
    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    def test_readyz_returns_503_when_dependency_degraded(
        self,
        _mock_schema: object,
        _mock_account_scope: object,
        _mock_postgres: object,
        _mock_alpaca: object,
    ) -> None:
        original = settings.trading_enabled
        original_source = settings.trading_universe_source
        original_require_non_empty = settings.trading_universe_require_non_empty_jangar
        settings.trading_enabled = True
        settings.trading_universe_source = "jangar"
        settings.trading_universe_require_non_empty_jangar = True
        try:
            scheduler = TradingScheduler()
            _install_pipeline_universe_resolver(
                scheduler,
                SimpleNamespace(
                    get_resolution=lambda: SimpleNamespace(
                        symbols={"AMD", "NVDA"},
                        status="ok",
                        reason="jangar_fetch_ok",
                        cache_age_seconds=0,
                    ),
                ),
            )
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["postgres"]["ok"])
            self.assertEqual(payload["dependencies"]["postgres"]["detail"], "down")
            self.assertIn("database", payload["dependencies"])
            self.assertIn("checked_at", payload["dependencies"]["database"])
            self.assertIn("universe", payload["dependencies"])
            self.assertTrue(payload["dependencies"]["universe"]["ok"])
            self.assertEqual(payload["dependencies"]["universe"]["symbols_count"], 2)
        finally:
            settings.trading_enabled = original
            settings.trading_universe_source = original_source
            settings.trading_universe_require_non_empty_jangar = (
                original_require_non_empty
            )

    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": False,
            "current_heads": ["0010_execution_provenance_and_governance_trace"],
            "expected_heads": ["0011_autonomy_lifecycle_and_promotion_audit"],
            "schema_head_signature": "7f8e4d0",
            "schema_missing_heads": ["0011_autonomy_lifecycle_and_promotion_audit"],
            "schema_unexpected_heads": [
                "0010_execution_provenance_and_governance_trace"
            ],
            "schema_head_count_expected": 1,
            "schema_head_count_current": 1,
            "schema_head_delta_count": 2,
        },
    )
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    def test_readyz_returns_503_when_schema_contract_fails(
        self,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        _mock_schema: object,
        _mock_account_scope: object,
    ) -> None:
        original = settings.trading_enabled
        settings.trading_enabled = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["database"]["ok"])
            self.assertFalse(payload["dependencies"]["database"]["schema_current"])
            self.assertEqual(
                payload["dependencies"]["database"]["account_scope_errors"], []
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_missing_heads"],
                ["0011_autonomy_lifecycle_and_promotion_audit"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_unexpected_heads"],
                ["0010_execution_provenance_and_governance_trace"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_expected"], 1
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_current"], 1
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_delta_count"], 2
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_signature"], "7f8e4d0"
            )
            self.assertIn("checked_at", payload["dependencies"]["database"])
        finally:
            settings.trading_enabled = original

    @patch("app.main._evaluate_database_contract")
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    def test_readyz_surface_schema_head_drift_fields(
        self,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        _mock_contract: object,
    ) -> None:
        original = settings.trading_enabled
        settings.trading_enabled = True
        try:
            app.state.trading_scheduler = TradingScheduler()
            app.state.trading_scheduler.state.running = True
            app.state.trading_scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mock_contract.return_value = {
                "ok": False,
                "schema_current": False,
                "schema_current_heads": ["0012_demo_beta"],
                "expected_heads": ["0011_demo_alpha"],
                "schema_missing_heads": ["0011_demo_alpha"],
                "schema_unexpected_heads": ["0012_demo_beta"],
                "schema_head_count_expected": 1,
                "schema_head_count_current": 1,
                "schema_head_delta_count": 2,
                "schema_head_signature": "sig-20260304",
                "checked_at": "2026-03-04T00:00:00+00:00",
                "account_scope_ready": True,
                "account_scope_errors": [],
                "account_scope_warnings": [],
            }
            response = self.client.get("/readyz")

            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["database"]["ok"])
            self.assertEqual(
                payload["dependencies"]["database"]["schema_missing_heads"],
                ["0011_demo_alpha"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_unexpected_heads"],
                ["0012_demo_beta"],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_expected"],
                1,
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_count_current"],
                1,
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_delta_count"], 2
            )
        finally:
            settings.trading_enabled = original

    @patch(
        "app.main._check_account_scope_invariants_bounded",
        return_value={
            "account_scope_ready": False,
            "account_scope_errors": ["legacy unique index detected"],
        },
    )
    @patch(
        "app.main.check_schema_current",
        return_value={
            "schema_current": True,
            "current_heads": ["0011_execution_tca_simulator_divergence"],
            "expected_heads": ["0011_execution_tca_simulator_divergence"],
            "schema_head_signature": "7f8e4d0",
        },
    )
    @patch("app.main._check_alpaca", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_clickhouse", return_value={"ok": True, "detail": "ok"})
    @patch("app.main._check_postgres", return_value={"ok": True, "detail": "ok"})
    def test_readyz_returns_503_when_account_scope_contract_fails(
        self,
        _mock_postgres: object,
        _mock_clickhouse: object,
        _mock_alpaca: object,
        _mock_schema: object,
        _mock_account_scope: object,
    ) -> None:
        original = settings.trading_enabled
        original_multi = settings.trading_multi_account_enabled
        settings.trading_enabled = True
        settings.trading_multi_account_enabled = True
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler
            response = self.client.get("/readyz")
            self.assertEqual(response.status_code, 503)
            payload = response.json()
            self.assertEqual(payload["status"], "degraded")
            self.assertFalse(payload["dependencies"]["database"]["ok"])
            self.assertEqual(
                payload["dependencies"]["database"]["schema_current"], True
            )
            self.assertFalse(payload["dependencies"]["database"]["account_scope_ready"])
            self.assertIn(
                "legacy unique index detected",
                payload["dependencies"]["database"]["account_scope_errors"][0],
            )
            self.assertEqual(
                payload["dependencies"]["database"]["schema_head_signature"], "7f8e4d0"
            )
            self.assertIn("checked_at", payload["dependencies"]["database"])
        finally:
            settings.trading_enabled = original
            settings.trading_multi_account_enabled = original_multi

    def test_trading_status_includes_llm_evaluation(self) -> None:
        with patch("app.main.SessionLocal", self.session_local):
            response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("hypotheses", payload)
        self.assertIn("llm_evaluation", payload)
        self.assertIn("control_plane_contract", payload)
        self.assertIn("build", payload)
        self.assertIn("shadow_first", payload)
        self.assertIn("forecast_service", payload)
        self.assertIn("lean_authority", payload)
        self.assertIn("empirical_jobs", payload)
        self.assertIn("profit_lease_projection", payload)
        self.assertIn("renewal_bond_profit_escrow", payload)
        self.assertEqual(
            payload["profit_lease_projection"]["schema_version"],
            "torghut.profit-lease-provenance.v1",
        )
        self.assertEqual(
            payload["renewal_bond_profit_escrow"]["schema_version"],
            "torghut.renewal-bond-profit-escrow.v1",
        )
        self.assertEqual(
            payload["profit_lease_projection"]["torghut_capital"]["action_class"],
            "torghut_capital",
        )
        for retired_label in (
            "jangar_consumer",
            "jangar_action_lease",
            "jangar_quant",
            "jangar_custody",
            "jangar_routeability",
            "jangar_stage_clearance",
            "required_jangar",
        ):
            self.assertEqual(
                _json_paths_containing(payload, retired_label),
                [],
                f"retired label {retired_label} leaked into /trading/status",
            )
        evaluation = payload["llm_evaluation"]
        self.assertTrue(evaluation["ok"])
        self.assertGreaterEqual(evaluation["metrics"]["total_reviews"], 1)
        hypotheses = payload["hypotheses"]
        self.assertTrue(hypotheses["registry_loaded"])
        self.assertEqual(len(hypotheses["items"]), 5)
        self.assertEqual(hypotheses["dependency_quorum"]["decision"], "allow")
        self.assertEqual(
            hypotheses["dependency_quorum"]["reasons"],
            ["torghut_dependency_quorum_not_required"],
        )
        control_plane_contract = payload["control_plane_contract"]
        self.assertEqual(
            control_plane_contract["contract_version"], "torghut.quant-producer.v1"
        )
        self.assertIn("signal_lag_seconds", control_plane_contract)
        self.assertIn("signal_continuity_state", control_plane_contract)
        self.assertIn("signal_continuity_alert_active", control_plane_contract)
        self.assertIn("signal_continuity_promotion_block_total", control_plane_contract)
        self.assertIn("signal_expected_staleness_total", control_plane_contract)
        self.assertIn("submission_block_total", control_plane_contract)
        self.assertIn("decision_state_total", control_plane_contract)
        self.assertIn("planned_decision_age_seconds", control_plane_contract)
        self.assertIn("market_session_open", control_plane_contract)
        self.assertIn("universe_fail_safe_blocked", control_plane_contract)
        self.assertIn("domain_telemetry_event_total", control_plane_contract)
        self.assertIn("domain_telemetry_dropped_total", control_plane_contract)
        self.assertEqual(control_plane_contract["alpha_readiness_hypotheses_total"], 5)
        self.assertEqual(control_plane_contract["alpha_readiness_blocked_total"], 4)
        self.assertEqual(control_plane_contract["alpha_readiness_shadow_total"], 1)
        self.assertIn(control_plane_contract["active_capital_stage"], {"shadow", None})
        self.assertIn("critical_toggle_parity", control_plane_contract)
        self.assertIn(
            payload["shadow_first"]["critical_toggle_parity"]["status"],
            {"aligned", "diverged"},
        )
        self.assertEqual(
            payload["build"]["active_revision"],
            control_plane_contract["active_revision"],
        )
        self.assertEqual(
            control_plane_contract["alpha_readiness_dependency_quorum_decision"],
            "allow",
        )
        self.assertIn(
            payload["forecast_service"]["authority"], {"empirical", "blocked"}
        )
        self.assertIn(payload["lean_authority"]["authority"], {"empirical", "blocked"})
        self.assertIn(payload["empirical_jobs"]["authority"], {"empirical", "blocked"})

    def test_trading_status_blocks_live_submission_on_critical_toggle_parity_divergence(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_pipeline_mode = "legacy"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = False
            settings.trading_kill_switch_enabled = True

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler

            hypothesis_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            dependency_quorum = SimpleNamespace(
                decision="allow",
                as_payload=lambda: {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            )

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": hypothesis_summary[
                                "dependency_quorum"
                            ],
                            "summary": hypothesis_summary,
                            "items": [],
                        },
                        hypothesis_summary,
                        dependency_quorum,
                    ),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            gate = payload["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["reason"], "critical_toggle_parity_diverged")
            self.assertIn(
                "critical_toggle_parity_diverged",
                gate["blocked_reasons"],
            )
            self.assertEqual(gate["critical_toggle_parity"]["status"], "diverged")
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_blocks_live_submission_when_quant_latest_store_is_empty(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = True
            settings.trading_kill_switch_enabled = False

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler

            hypothesis_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            dependency_quorum = SimpleNamespace(
                decision="allow",
                as_payload=lambda: {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            )

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": hypothesis_summary[
                                "dependency_quorum"
                            ],
                            "summary": hypothesis_summary,
                            "items": [],
                        },
                        hypothesis_summary,
                        dependency_quorum,
                    ),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": False,
                        "status": "degraded",
                        "reason": "quant_latest_metrics_empty",
                        "blocking_reasons": [
                            "quant_latest_metrics_empty",
                            "quant_latest_store_alarm",
                        ],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://torghut.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                        "latest_metrics_count": 0,
                        "latest_metrics_updated_at": None,
                        "empty_latest_store_alarm": True,
                        "missing_update_alarm": False,
                        "metrics_pipeline_lag_seconds": None,
                        "stage_count": 0,
                        "max_stage_lag_seconds": 0,
                        "stages": [],
                    },
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            gate = payload["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["reason"], "quant_latest_metrics_empty")
            self.assertEqual(gate["capital_state"], "observe")
            self.assertIn("quant_latest_store_alarm", gate["blocked_reasons"])
            self.assertEqual(payload["quant_evidence"]["window"], "15m")
            self.assertFalse(payload["quant_evidence"]["ok"])
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_submission_gate_matches_status_health_and_readyz(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_mode = settings.trading_mode
        original_enabled = settings.trading_enabled
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            shared_gate = {
                "allowed": False,
                "reason": "promotion_certificate_missing",
                "blocked_reasons": [
                    "promotion_certificate_missing",
                    "hypothesis_window_evidence_missing",
                ],
                "certificate_id": None,
                "capital_stage": "shadow",
                "capital_state": "observe",
                "issued_at": None,
                "expires_at": None,
                "reason_codes": [
                    "promotion_certificate_missing",
                    "hypothesis_window_evidence_missing",
                ],
                "segment_summary": {
                    "segments": {
                        "execution": {"state": "ok", "reason_codes": []},
                        "empirical": {"state": "ok", "reason_codes": []},
                        "llm-review": {"state": "ok", "reason_codes": []},
                        "market-context": {"state": "ok", "reason_codes": []},
                        "ta-core": {"state": "ok", "reason_codes": []},
                    },
                    "evaluated_hypotheses": [],
                },
                "quant_health_ref": {
                    "account": "paper",
                    "window": "15m",
                    "status": "healthy",
                    "source_url": "http://torghut.test/quant/health",
                    "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
                },
                "market_context_ref": {"last_freshness_seconds": 30},
                "evidence_tuple": {
                    "hypothesis_id": None,
                    "candidate_id": None,
                    "strategy_id": None,
                    "account": "paper",
                    "window": "15m",
                    "capital_state": "observe",
                },
                "lineage_ref": {
                    "status": "unverified",
                    "candidate_id": None,
                    "hypothesis_id": None,
                    "dataset_snapshot_count": 0,
                    "dataset_snapshot_id": None,
                    "dataset_snapshot_ref": None,
                    "dataset_snapshot_run_id": None,
                    "strategy_hypothesis_count": 0,
                    "strategy_hypothesis_id": None,
                    "lane_id": None,
                    "strategy_family": None,
                },
                "evaluated_tuples": [],
            }

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                            "summary": {
                                "promotion_eligible_total": 1,
                                "capital_stage_totals": {"shadow": 1},
                                "dependency_quorum": {
                                    "decision": "allow",
                                    "reasons": [],
                                    "message": "ready",
                                },
                            },
                            "items": [],
                        },
                        {
                            "promotion_eligible_total": 1,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        SimpleNamespace(
                            decision="allow",
                            as_payload=lambda: {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        ),
                    ),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                        "blocking_reasons": [],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://torghut.test/quant/health",
                        "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
                    },
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=shared_gate,
                ),
            ):
                status_response = self.client.get("/trading/status")
                health_response = self.client.get("/trading/health")
                ready_response = self.client.get("/readyz")
                runtime_response = self.client.get("/trading/profitability/runtime")

            self.assertEqual(status_response.status_code, 200)
            self.assertEqual(health_response.status_code, 503)
            self.assertEqual(ready_response.status_code, 503)
            self.assertEqual(runtime_response.status_code, 200)
            self.assertEqual(
                status_response.json()["live_submission_gate"], shared_gate
            )
            self.assertEqual(
                health_response.json()["live_submission_gate"], shared_gate
            )
            self.assertEqual(
                runtime_response.json()["live_submission_gate"],
                shared_gate,
            )
            ready_gate = ready_response.json()["live_submission_gate"]
            self.assertFalse(ready_gate["allowed"])
            self.assertFalse(ready_gate["promotion_authority"])
            self.assertFalse(ready_gate["final_authority_ok"])
            self.assertFalse(ready_gate["final_promotion_allowed"])
            self.assertFalse(ready_gate["read_model_evaluated"])
            self.assertEqual(
                ready_gate["reason"],
                "readyz_core_dependencies_only",
            )
            self.assertNotIn("repair_receipt_frontier", ready_response.json())
            self.assertNotIn("repair_outcome_dividend_ledger", ready_response.json())
        finally:
            settings.trading_mode = original_mode
            settings.trading_enabled = original_enabled
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_revenue_repair_endpoint_returns_business_digest(self) -> None:
        readyz_payload: dict[str, object] = {
            "status": "degraded",
            "dependencies": {
                "profitability_proof_floor": {
                    "ok": False,
                    "detail": "repair_only",
                    "capital_state": "zero_notional",
                },
                "live_submission_gate": {
                    "ok": False,
                    "detail": "simple_submit_disabled",
                    "capital_stage": "shadow",
                },
            },
        }
        status_payload: dict[str, object] = {
            "mode": "live",
            "pipeline_mode": "simple",
            "build": {"active_revision": "torghut-00254"},
            "live_submission_gate": {
                "allowed": False,
                "reason": "simple_submit_disabled",
                "blocked_reasons": ["simple_submit_disabled"],
                "capital_stage": "shadow",
                "configured_live_promotion": False,
            },
            "proof_floor": {
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_stale",
                    "simple_submit_disabled",
                ],
                "repair_ladder": [
                    {
                        "code": "repair_execution_tca",
                        "reason": "execution_tca_stale",
                        "dimension": "execution_tca",
                        "priority": 65,
                        "expected_unblock_value": 3,
                    }
                ],
                "proof_dimensions": [
                    {
                        "dimension": "execution_tca",
                        "state": "stale",
                        "reason": "execution_tca_stale",
                        "freshness_seconds": 2_988_327,
                        "threshold_seconds": 86_400,
                        "source_ref": {
                            "order_count": 13_775,
                            "last_computed_at": "2026-04-02T20:59:45.136640+00:00",
                            "avg_abs_slippage_bps": "568.6138848199565249",
                        },
                    }
                ],
            },
            "alpha_readiness": {
                "summary": {
                    "promotion_eligible_total": 0,
                    "rollback_required_total": 3,
                    "state_totals": {"blocked": 1, "shadow": 2},
                }
            },
            "quant_evidence": {"ok": True, "status": "healthy", "reason": "ready"},
            "routeability_repair_acceptance_ledger": {
                "ledger_id": "routeability-acceptance-ledger:test",
                "aggregate_state": "blocked",
                "accepted_routeable_candidate_count": 0,
                "zero_notional_or_stale_evidence_rate": 1,
                "aggregate_blocking_reason_codes": ["proof_floor_repair_only"],
            },
            "route_evidence_clearinghouse_packet": {
                "schema_version": "torghut.route-evidence-clearinghouse-packet.v1",
                "packet_id": "route-evidence-clearinghouse:test",
                "capital_decision": "repair_only",
                "accepted_routeable_candidate_count": 0,
                "zero_notional_or_stale_evidence_rate": 1,
                "selected_repair_bids": [
                    {"value_gate": "fill_tca_or_slippage_quality"}
                ],
                "held_action_classes": ["paper_canary", "live_micro_canary"],
                "summary": {"route_claim_count": 1},
            },
            "repair_bid_settlement_ledger": {
                "schema_version": "torghut.repair-bid-settlement-ledger.v1",
                "ledger_id": "repair-bid-settlement-ledger:test",
                "account_id": "PA3SX7FYNUTF",
                "session_id": "15m",
                "trading_mode": "live",
                "capital_decision": "repair_only",
                "max_notional": "0",
                "raw_repair_bid_count": 1,
                "routeable_candidate_count": 0,
                "selected_lot_ids": ["compacted-repair-lot:test"],
                "dispatchable_lot_ids": ["compacted-repair-lot:test"],
                "active_dedupe_keys": [],
                "compacted_lots": [
                    {
                        "lot_id": "compacted-repair-lot:promotion",
                        "lot_class": "promotion_custody",
                        "target_value_gate": "routeable_candidate_count",
                        "priority": 60,
                        "expected_gate_delta": "retire_alpha_readiness_not_promotion_eligible",
                        "raw_reason_codes": ["alpha_readiness_not_promotion_eligible"],
                        "required_output_receipt": "torghut.promotion-custody-decision-receipt.v1",
                        "dedupe_key": "PA3SX7FYNUTF:15m:promotion_custody",
                        "ttl_seconds": 900,
                        "max_runtime_seconds": 1200,
                        "max_notional": "0",
                        "state": "held",
                        "dispatchable": False,
                        "hold_reason_codes": ["selection_limit_exceeded"],
                        "source_bid_ids": ["route-evidence-repair-bid:promotion"],
                    }
                ],
                "summary": {
                    "compacted_lot_count": 1,
                    "selected_lot_count": 1,
                    "dispatchable_lot_count": 1,
                },
            },
        }
        with (
            patch(
                "app.main._evaluate_trading_health_payload",
                return_value=(readyz_payload, 503),
            ),
            patch("app.main.trading_status", return_value=status_payload),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["schema_version"], "torghut.revenue-repair-digest.v1")
        self.assertEqual(
            payload["routeability_repair_acceptance_ledger_id"],
            "routeability-acceptance-ledger:test",
        )
        self.assertFalse(payload["revenue_ready"])
        self.assertEqual(payload["business_state"], "repair_only")
        self.assertEqual(payload["capital"]["capital_state"], "zero_notional")
        self.assertIn(
            "execution_tca_stale",
            {item["reason"] for item in payload["blockers"]},
        )
        self.assertEqual(payload["repair_queue"][0]["code"], "repair_alpha_readiness")
        self.assertEqual(payload["top_repair_queue_item"], payload["repair_queue"][0])
        self.assertEqual(payload["selected_value_gate"], "routeable_candidate_count")
        self.assertEqual(
            payload["required_output_receipt"],
            "torghut.executable-alpha-receipts.v1",
        )
        self.assertEqual(payload["capital_state"], "zero_notional")
        self.assertEqual(payload["capital_stage"], "shadow")
        self.assertFalse(payload["live_submission_allowed"])
        self.assertEqual(payload["max_notional"], "0")
        self.assertEqual(payload["accepted_routeable_candidate_count"], 0)
        self.assertEqual(payload["routeable_candidate_delta"], 0)
        self.assertEqual(payload["repair_bid_settlement_status"], "repair_only")
        self.assertEqual(
            payload["repair_bid_settlement_selected_lot_ids"],
            ["compacted-repair-lot:test"],
        )
        self.assertEqual(
            payload["repair_bid_settlement_dispatchable_lot_ids"],
            ["compacted-repair-lot:test"],
        )
        self.assertEqual(
            payload["repair_bid_settlement_held_lot_ids"],
            ["compacted-repair-lot:promotion"],
        )
        self.assertIn(
            "jangar_material_evidence_settlement_ref_unavailable",
            payload["field_unavailable_reason_codes"],
        )
        self.assertEqual(
            payload["expected_repair_action"],
            "clear_hypothesis_blockers_before_capital",
        )
        self.assertEqual(
            payload["evidence"]["execution_tca"]["last_computed_at"],
            "2026-04-02T20:59:45.136640+00:00",
        )
        self.assertEqual(
            payload["evidence"]["routeability_acceptance"]["ledger_id"],
            "routeability-acceptance-ledger:test",
        )
        self.assertEqual(
            payload["route_evidence_clearinghouse_packet"]["packet_id"],
            "route-evidence-clearinghouse:test",
        )
        self.assertEqual(
            payload["evidence"]["route_evidence_clearinghouse"][
                "selected_repair_bid_count"
            ],
            1,
        )
        self.assertEqual(
            payload["repair_bid_settlement_ledger"]["ledger_id"],
            "repair-bid-settlement-ledger:test",
        )
        self.assertEqual(
            payload["alpha_readiness_strike_ledger"]["schema_version"],
            "torghut.alpha-readiness-strike-ledger.v1",
        )
        self.assertEqual(
            payload["alpha_readiness_strike_ledger"]["strike_slots"][0]["lot_class"],
            "promotion_custody",
        )
        self.assertEqual(
            payload["executable_alpha_repair_receipts"]["schema_version"],
            "torghut.executable-alpha-repair-receipts.v1",
        )
        self.assertEqual(payload["executable_alpha_repair_receipts"]["status"], "held")
        self.assertIn(
            "alpha_readiness_repair_targets_missing",
            payload["executable_alpha_repair_receipts"]["reason_codes"],
        )
        settlement_slots = payload["executable_alpha_settlement_slots"]
        self.assertEqual(
            settlement_slots["schema_version"],
            "torghut.executable-alpha-settlement-slots.v1",
        )
        self.assertEqual(settlement_slots["status"], "held")
        self.assertEqual(settlement_slots["selected_slot"], None)
        self.assertEqual(settlement_slots["max_notional"], "0")
        self.assertIn(
            "selected_executable_alpha_repair_receipt_missing",
            settlement_slots["reason_codes"],
        )
        closure_board = payload["alpha_repair_closure_board"]
        self.assertEqual(
            closure_board["schema_version"],
            "torghut.alpha-repair-closure-board.v1",
        )
        self.assertEqual(closure_board["status"], "blocked")
        self.assertEqual(
            closure_board["selected_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(closure_board["max_notional"], "0")
        self.assertIn("alpha_repair_receipt_missing", closure_board["reason_codes"])
        alpha_foundry = payload["alpha_evidence_foundry"]
        self.assertEqual(
            alpha_foundry["schema_version"],
            "torghut.alpha-evidence-foundry.v1",
        )
        self.assertEqual(alpha_foundry["status"], "held")
        self.assertEqual(alpha_foundry["selected_queue_code"], "repair_alpha_readiness")
        self.assertEqual(
            alpha_foundry["selected_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(
            alpha_foundry["required_output_receipt"],
            "torghut.alpha-evidence-window-receipt.v1",
        )
        self.assertEqual(alpha_foundry["max_notional"], "0")
        self.assertIn(
            "alpha_evidence_window_receipts_missing",
            alpha_foundry["reason_codes"],
        )
        settlement_conveyor = payload["alpha_readiness_settlement_conveyor"]
        self.assertEqual(
            settlement_conveyor["schema_version"],
            "torghut.alpha-readiness-settlement-conveyor.v1",
        )
        self.assertEqual(settlement_conveyor["status"], "blocked")
        self.assertEqual(settlement_conveyor["max_notional"], "0")
        self.assertIn(
            "alpha_readiness_settlement_receipts_missing",
            settlement_conveyor["reason_codes"],
        )
        alpha_dividend = payload["alpha_repair_dividend_ledger"]
        self.assertEqual(
            alpha_dividend["schema_version"],
            "torghut.alpha-repair-dividend-ledger.v1",
        )
        self.assertEqual(alpha_dividend["dividend_state"], "blocked")
        self.assertEqual(alpha_dividend["max_notional"], "0")
        self.assertIn(
            "alpha_repair_settlement_receipt_missing",
            alpha_dividend["reason_codes"],
        )
        self.assertEqual(
            payload["evidence"]["repair_bid_settlement"]["dispatchable_lot_count"],
            1,
        )

    def test_zero_notional_repair_endpoint_returns_dry_run_receipt(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("empirical"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:test",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "empirical_proof",
                        "zero_notional_action": "renew_empirical_proof_jobs",
                        "before_refs": ["empirical:H-AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["schema_version"],
            "torghut.zero-notional-repair-execution-receipt.v1",
        )
        self.assertEqual(payload["execution_state"], "dry_run_ready")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertFalse(payload["order_submission_enabled"])
        self.assertEqual(payload["paper_notional_limit"], "0")
        self.assertEqual(payload["live_notional_limit"], "0")
        self.assertEqual(payload["before_refs"], ["empirical:H-AAPL"])
        self.assertEqual(
            payload["freshness_carry_ledger_ref"],
            "freshness-carry-ledger:test",
        )
        self.assertEqual(payload["freshness_citation_state"], "cited")
        self.assertEqual(payload["freshness_dimension_id"], "empirical")
        self.assertEqual(
            payload["freshness_repair_proof_slo_ref"],
            "freshness-repair-slo:empirical",
        )

    def test_zero_notional_repair_endpoint_accepts_dispatch_ticket_body(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("empirical"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:test",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "empirical_proof",
                        "zero_notional_action": "renew_empirical_proof_jobs",
                        "before_refs": ["empirical:H-AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        repair_lot_dispatch_ticket = {
            "schema_version": "jangar.repair-lot-dispatch-ticket.v1",
            "ticket_id": "repair-lot-dispatch-ticket:test",
            "admission_receipt_id": "repair-bid-admission-receipt:test",
            "torghut_lot_id": "profit-freshness-repair-lot:test",
            "lot_class": "empirical_replay",
            "target_value_gate": "zero_notional_or_stale_evidence_rate",
            "dedupe_key": "torghut-repair:test",
            "required_output_receipt": "torghut.empirical-proof-refresh-receipt.v1",
            "launch_allowed": True,
            "launch_reason": "current_zero_notional_compacted_lot",
            "stop_conditions": ["fresh_until_expired", "dedupe_key_became_active"],
            "max_runtime_seconds": 1200,
            "max_notional": 0,
            "expected_gate_delta": 1,
            "rollback_target": "keep Torghut max_notional=0",
        }
        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair?execute=true",
                json=repair_lot_dispatch_ticket,
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_admission_required")
        self.assertEqual(payload["command_exit_code"], 78)
        self.assertEqual(
            payload["blocked_reasons"],
            ["zero_notional_runner_admission_required"],
        )
        self.assertEqual(
            payload["repair_lot_dispatch_ticket_ref"],
            "repair-lot-dispatch-ticket:test",
        )
        self.assertEqual(payload["freshness_citation_state"], "cited")
        self.assertEqual(payload["freshness_dimension_id"], "empirical")
        self.assertTrue(payload["repair_lot_dispatch_ticket_launch_allowed"])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_can_select_queued_route_tca_action(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("tca"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:empirical",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "empirical_proof",
                        "zero_notional_action": "renew_empirical_proof_jobs",
                        "before_refs": ["empirical:stale"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
                "repair_lots": [
                    {
                        "lot_id": "profit-freshness-repair-lot:tca",
                        "candidate_id": "candidate-b",
                        "hypothesis_id": "H-NVDA",
                        "blocked_dimension": "tca_fill_quality",
                        "zero_notional_action": "recompute_route_tca_and_fill_quality",
                        "before_refs": ["execution_tca:NVDA"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "queued_zero_notional_repair",
                    }
                ],
            },
        }
        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=recompute_route_tca_and_fill_quality"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "dry_run_ready")
        self.assertEqual(
            payload["zero_notional_action"],
            "recompute_route_tca_and_fill_quality",
        )
        self.assertEqual(
            payload["preferred_zero_notional_action"],
            "recompute_route_tca_and_fill_quality",
        )
        self.assertEqual(payload["repair_lot_ref"], "profit-freshness-repair-lot:tca")
        self.assertEqual(payload["before_refs"], ["execution_tca:NVDA"])
        self.assertEqual(payload["freshness_citation_state"], "cited")
        self.assertEqual(payload["freshness_dimension_id"], "tca")
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_executes_drift_replay(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:drift",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "drift_checks",
                        "zero_notional_action": "rerun_drift_checks_for_blocked_hypotheses",
                        "before_refs": ["drift_detection:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        fetched: list[dict[str, object]] = []
        replayed: list[list[str]] = []

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            return SimpleNamespace(
                signals=[
                    SimpleNamespace(symbol="AAPL"),
                    SimpleNamespace(symbol="MSFT"),
                ],
                no_signal_reason=None,
                query_start="2026-05-13T04:00:00+00:00",
                query_end="2026-05-13T04:05:00+00:00",
            )

        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                ),
                _run_simple_drift_check=lambda signals: replayed.append(
                    [signal.symbol for signal in signals],
                ),
            ),
            state=SimpleNamespace(
                drift_last_detection_path="drift-detection/latest.json",
                drift_status="ok",
                drift_active_reason_codes=[],
            ),
        )
        app.state.trading_scheduler = scheduler

        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses"
                "&execute=true&drift_limit=25"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(
            payload["after_refs"],
            ["drift_detection_checks", "drift-detection/latest.json"],
        )
        self.assertEqual(payload["runner_result"]["result"]["signals_evaluated"], 1)
        self.assertEqual(payload["runner_result"]["result"]["symbol_set"], ["AAPL"])
        self.assertEqual(fetched[0]["limit"], 25)
        self.assertEqual(replayed, [["AAPL"]])
        self.assertFalse(payload["order_submission_enabled"])
        self.assertEqual(payload["paper_notional_limit"], "0")
        self.assertEqual(payload["live_notional_limit"], "0")

    def test_zero_notional_repair_endpoint_replays_latest_signal_window(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:drift",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "drift_checks",
                        "zero_notional_action": "rerun_drift_checks_for_blocked_hypotheses",
                        "before_refs": ["drift_detection:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        fetched: list[dict[str, object]] = []
        replayed: list[list[str]] = []
        latest_signal_at = datetime(2026, 5, 12, 20, 57, tzinfo=timezone.utc)

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            if len(fetched) == 1:
                return SimpleNamespace(
                    signals=[],
                    no_signal_reason="cursor_ahead_of_stream",
                    query_start=kwargs["start"],
                    query_end=kwargs["end"],
                )
            return SimpleNamespace(
                signals=[
                    SimpleNamespace(symbol="AAPL"),
                    SimpleNamespace(symbol="MSFT"),
                ],
                no_signal_reason=None,
                query_start=kwargs["start"],
                query_end=kwargs["end"],
            )

        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                    latest_signal_status=lambda: {"latest_signal_at": latest_signal_at},
                ),
                _run_simple_drift_check=lambda signals: replayed.append(
                    [signal.symbol for signal in signals],
                ),
            ),
            state=SimpleNamespace(
                drift_last_detection_path="drift-detection/latest.json",
                drift_status="ok",
                drift_active_reason_codes=[],
            ),
        )
        app.state.trading_scheduler = scheduler

        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses"
                "&execute=true&drift_limit=25"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(len(fetched), 2)
        self.assertEqual(fetched[1]["start"], latest_signal_at - timedelta(minutes=15))
        self.assertEqual(fetched[1]["end"], latest_signal_at)
        self.assertEqual(payload["runner_result"]["result"]["signals_evaluated"], 1)
        self.assertEqual(
            payload["runner_result"]["result"]["replay_window"],
            "latest_signal",
        )
        self.assertEqual(replayed, [["AAPL"]])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_rebuilds_feature_rows_from_latest_window(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        fetched: list[dict[str, object]] = []
        latest_signal_at = datetime(2026, 5, 12, 20, 57, tzinfo=timezone.utc)

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            if len(fetched) == 1:
                return SimpleNamespace(
                    signals=[],
                    no_signal_reason="cursor_ahead_of_stream",
                    query_start=kwargs["start"],
                    query_end=kwargs["end"],
                )
            return SimpleNamespace(
                signals=[
                    SimpleNamespace(symbol="AAPL"),
                    SimpleNamespace(symbol="MSFT"),
                ],
                no_signal_reason=None,
                query_start=kwargs["start"],
                query_end=kwargs["end"],
            )

        metrics = SimpleNamespace(
            feature_batch_rows_total=0,
            feature_null_rate={},
            feature_staleness_ms_p95=0,
            feature_duplicate_ratio=0.0,
            feature_schema_mismatch_total=0,
            feature_quality_rejections_total=0,
        )
        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                    latest_signal_status=lambda: {"latest_signal_at": latest_signal_at},
                ),
            ),
            state=SimpleNamespace(metrics=metrics),
        )
        app.state.trading_scheduler = scheduler
        quality_report = FeatureQualityReport(
            accepted=True,
            rows_total=2,
            null_rate_by_field={"macd": 0.0},
            staleness_ms_p95=200,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=[],
        )

        with (
            patch("app.main.trading_status", return_value=status_payload),
            patch(
                "app.main.evaluate_feature_batch_quality", return_value=quality_report
            ),
        ):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rebuild_required_feature_rows&execute=true&feature_limit=25"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(payload["after_refs"], ["feature_coverage_rows"])
        self.assertEqual(payload["runner_result"]["result"]["signals_evaluated"], 1)
        self.assertEqual(payload["runner_result"]["result"]["rows_total"], 2)
        self.assertEqual(
            payload["runner_result"]["result"]["replay_window"],
            "latest_signal",
        )
        self.assertEqual(metrics.feature_batch_rows_total, 2)
        self.assertEqual(len(fetched), 2)
        self.assertEqual(fetched[0]["limit"], 25)
        self.assertEqual(fetched[1]["start"], latest_signal_at - timedelta(minutes=15))
        self.assertEqual(fetched[1]["end"], latest_signal_at)
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_fails_closed_without_feature_runner(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        app.state.trading_scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(ingestor=SimpleNamespace()),
        )

        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rebuild_required_feature_rows&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_failed")
        self.assertEqual(payload["command_exit_code"], 78)
        self.assertEqual(
            payload["blocked_reasons"],
            ["feature_coverage_runner_unavailable"],
        )
        self.assertEqual(payload["after_refs"], [])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_blocks_feature_replay_without_latest_window(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }

        latest_status_variants = (
            None,
            lambda: [],
            lambda: {"latest_signal_at": "not-a-datetime"},
        )
        for latest_status in latest_status_variants:
            with self.subTest(latest_status=latest_status):
                ingestor_attrs = {
                    "fetch_signals_with_reason": lambda **kwargs: SimpleNamespace(
                        signals=[],
                        no_signal_reason="window_empty",
                        query_start=kwargs["start"],
                        query_end=kwargs["end"],
                    ),
                }
                if latest_status is not None:
                    ingestor_attrs["latest_signal_status"] = latest_status
                app.state.trading_scheduler = SimpleNamespace(
                    _pipeline=SimpleNamespace(
                        ingestor=SimpleNamespace(**ingestor_attrs),
                    ),
                    state=SimpleNamespace(metrics=SimpleNamespace()),
                )

                with patch("app.main.trading_status", return_value=status_payload):
                    response = self.client.post(
                        "/trading/profit-freshness/zero-notional-repair"
                        "?action=rebuild_required_feature_rows&execute=true"
                    )

                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["execution_state"], "runner_blocked")
                self.assertEqual(payload["command_exit_code"], 78)
                self.assertEqual(
                    payload["blocked_reasons"],
                    ["feature_coverage_no_signals:window_empty"],
                )
                self.assertEqual(payload["after_refs"], [])
                self.assertEqual(
                    payload["runner_result"]["result"]["replay_window"],
                    "current",
                )
                self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_records_feature_quality_rejection(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        rejected_reasons: list[list[str]] = []
        fetched: list[dict[str, object]] = []
        naive_latest_signal_at = datetime(2026, 5, 12, 20, 57)

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            if len(fetched) == 1:
                return SimpleNamespace(
                    signals=[],
                    no_signal_reason="cursor_ahead_of_stream",
                    query_start=kwargs["start"],
                    query_end=kwargs["end"],
                )
            return SimpleNamespace(
                signals=[SimpleNamespace(symbol="AAPL")],
                no_signal_reason=None,
                query_start=kwargs["start"],
                query_end=kwargs["end"],
            )

        metrics = SimpleNamespace(
            feature_batch_rows_total=0,
            feature_null_rate={},
            feature_staleness_ms_p95=0,
            feature_duplicate_ratio=0.0,
            feature_schema_mismatch_total=0,
            feature_quality_rejections_total=0,
            record_feature_quality_rejection=lambda reasons: rejected_reasons.append(
                list(reasons),
            ),
        )
        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                    latest_signal_status=lambda: {
                        "latest_signal_at": naive_latest_signal_at,
                    },
                ),
            ),
            state=SimpleNamespace(metrics=metrics),
        )
        app.state.trading_scheduler = scheduler
        quality_report = FeatureQualityReport(
            accepted=False,
            rows_total=1,
            null_rate_by_field={"macd": 1.0},
            staleness_ms_p95=200,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=["required_feature_null_rate_high"],
        )

        with (
            patch("app.main.trading_status", return_value=status_payload),
            patch(
                "app.main.evaluate_feature_batch_quality", return_value=quality_report
            ),
        ):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rebuild_required_feature_rows&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertFalse(payload["runner_result"]["result"]["accepted"])
        self.assertEqual(
            payload["runner_result"]["result"]["reason_codes"],
            ["required_feature_null_rate_high"],
        )
        self.assertEqual(len(fetched), 2)
        self.assertEqual(
            fetched[1]["start"],
            naive_latest_signal_at.replace(tzinfo=timezone.utc) - timedelta(minutes=15),
        )
        self.assertEqual(metrics.feature_quality_rejections_total, 1)
        self.assertEqual(rejected_reasons, [["required_feature_null_rate_high"]])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_blocks_drift_replay_without_signals(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:drift",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "drift_checks",
                        "zero_notional_action": "rerun_drift_checks_for_blocked_hypotheses",
                        "before_refs": ["drift_detection:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=lambda **_: SimpleNamespace(
                        signals=[],
                        no_signal_reason="window_empty",
                        query_start="2026-05-13T04:00:00+00:00",
                        query_end="2026-05-13T04:05:00+00:00",
                    ),
                    latest_signal_status=lambda: {"latest_signal_at": "not-a-datetime"},
                ),
                _run_simple_drift_check=lambda signals: self.fail(
                    f"unexpected drift replay: {signals}",
                ),
            ),
            state=SimpleNamespace(
                drift_last_detection_path="",
                drift_status=None,
                drift_active_reason_codes=[],
            ),
        )
        app.state.trading_scheduler = scheduler

        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_blocked")
        self.assertEqual(payload["command_exit_code"], 78)
        self.assertEqual(
            payload["blocked_reasons"],
            ["drift_check_no_signals:window_empty"],
        )
        self.assertEqual(payload["after_refs"], [])
        self.assertEqual(payload["runner_result"]["result"]["symbol_set"], ["AAPL"])
        self.assertFalse(payload["order_submission_enabled"])

        scheduler._pipeline.ingestor.latest_signal_status = lambda: None
        with patch("app.main.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses&execute=true"
            )
        self.assertEqual(response.json()["execution_state"], "runner_blocked")

    def test_trading_status_blocks_live_submission_when_lineage_tables_are_empty(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = False
            settings.trading_kill_switch_enabled = False

            scheduler = TradingScheduler()
            scheduler.state.last_market_context_freshness_seconds = 30
            app.state.trading_scheduler = scheduler

            with self.session_local() as session:
                observed_at = datetime.now(timezone.utc)
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        window_started_at=observed_at - timedelta(minutes=15),
                        window_ended_at=observed_at,
                        market_session_count=1,
                        decision_count=1,
                        trade_count=1,
                        order_count=1,
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="0.10x canary",
                    )
                )
                session.add(
                    StrategyPromotionDecision(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        promotion_target="live",
                        state="0.10x canary",
                        allowed=True,
                        reason_summary="ready",
                    )
                )
                session.commit()

            registry_item = SimpleNamespace(
                hypothesis_id="H-CONT-01",
                model_dump=lambda mode="json": {
                    "hypothesis_id": "H-CONT-01",
                    "lane_id": "lane-cand-1",
                    "strategy_family": "demo",
                    "segment_dependencies": [],
                },
            )

            with (
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "summary": {
                                "promotion_eligible_total": 1,
                                "capital_stage_totals": {"0.10x canary": 1},
                                "dependency_quorum": {
                                    "decision": "allow",
                                    "reasons": [],
                                    "message": "ready",
                                },
                            },
                            "items": [
                                {
                                    "hypothesis_id": "H-CONT-01",
                                    "promotion_eligible": True,
                                    "capital_stage": "0.10x canary",
                                    "reasons": [],
                                    "segment_dependencies": [],
                                }
                            ],
                        },
                        {
                            "promotion_eligible_total": 1,
                            "capital_stage_totals": {"0.10x canary": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        SimpleNamespace(
                            decision="allow",
                            as_payload=lambda: {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        ),
                    ),
                ),
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=SimpleNamespace(items=[registry_item]),
                ),
                patch(
                    "app.main._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                        "blocking_reasons": [],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://torghut.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                    },
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            gate = response.json()["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["capital_state"], "observe")
            self.assertIn("dataset_snapshot_missing", gate["blocked_reasons"])
            self.assertIn("strategy_hypothesis_missing", gate["blocked_reasons"])
            self.assertEqual(gate["lineage_ref"]["status"], "missing")
            self.assertEqual(gate["lineage_ref"]["dataset_snapshot_count"], 0)
            self.assertEqual(gate["lineage_ref"]["strategy_hypothesis_count"], 0)
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_hypothesis_runtime_payload_uses_certificate_evidence_merge(self) -> None:
        scheduler = TradingScheduler()
        scheduler.state.last_market_context_freshness_seconds = 30
        now = datetime.now(timezone.utc)
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]
        dependency_quorum = JangarDependencyQuorumStatus(
            decision="allow",
            reasons=[],
            message="ready",
        )

        with self.session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="status-runtime-proof",
                    candidate_id="cand-status-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=12,
                    trade_count=12,
                    order_count=12,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="status-runtime-proof",
                    candidate_id="cand-status-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

        with (
            patch("app.main.load_hypothesis_registry", return_value=registry),
            patch(
                "app.trading.submission_council.load_hypothesis_registry",
                return_value=registry,
            ),
            patch(
                "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                return_value=runtime_items,
            ),
        ):
            payload, summary, _ = _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary={},
                market_context_status={"last_freshness_seconds": 10},
                dependency_quorum=dependency_quorum,
                feature_readiness={},
            )

        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["paper_probation_eligible_total"], 1)
        self.assertEqual(payload["summary"]["promotion_eligible_total"], 0)
        self.assertEqual(payload["summary"]["paper_probation_eligible_total"], 1)
        item = payload["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertTrue(item["paper_probation_eligible"])
        self.assertEqual(item["paper_probation_target_capital_stage"], "0.10x canary")
        self.assertEqual(item["candidate_id"], "cand-status-runtime")
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["paper_probation_evidence_collection_only"])

    def test_trading_status_exposes_rejection_and_market_context_controls(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.llm_policy_veto_total = 3
            scheduler.state.metrics.llm_runtime_fallback_total = 5
            scheduler.state.metrics.llm_requests_total = 100
            scheduler.state.metrics.llm_market_context_block_total = 7
            scheduler.state.metrics.pre_llm_capacity_reject_total = 11
            scheduler.state.metrics.pre_llm_qty_below_min_total = 13
            scheduler.state.market_session_open = True
            scheduler.state.last_market_context_symbol = "AAPL"
            scheduler.state.last_market_context_checked_at = datetime(
                2026, 3, 5, 15, 30, tzinfo=timezone.utc
            )
            scheduler.state.last_market_context_freshness_seconds = 120
            scheduler.state.last_market_context_quality_score = 0.92
            scheduler.state.last_market_context_domain_states = {
                "technicals": "ok",
                "fundamentals": "stale",
                "news": "ok",
                "regime": "ok",
            }
            scheduler.state.last_market_context_risk_flags = ["fundamentals_stale"]
            scheduler.state.last_market_context_allow_llm = False
            scheduler.state.last_market_context_reason = "market_context_stale"
            scheduler.state.market_context_alert_active = True
            scheduler.state.market_context_alert_reason = "market_context_stale"
            executor = OrderExecutor()
            executor._shorting_metadata_status.update(  # noqa: SLF001
                {
                    "account_ready": False,
                    "last_refresh_at": "2026-03-05T15:30:00+00:00",
                    "last_error": "account lookup unavailable",
                }
            )
            scheduler._pipeline = type(  # noqa: SLF001
                "PipelineStub",
                (),
                {"executor": executor, "llm_review_engine": None},
            )()
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["market_context"]["fail_mode"], "shadow_only")
            self.assertFalse(payload["market_context"]["required"])
            self.assertEqual(payload["market_context"]["last_symbol"], "AAPL")
            self.assertEqual(
                payload["market_context"]["last_reason"], "market_context_stale"
            )
            self.assertTrue(payload["market_context"]["alert_active"])
            self.assertEqual(payload["rejections"]["policy_veto_total"], 3)
            self.assertEqual(payload["rejections"]["runtime_fallback_total"], 5)
            self.assertAlmostEqual(
                payload["rejections"]["runtime_fallback_ratio"], 0.05
            )
            self.assertEqual(
                payload["rejections"]["runtime_fallback_alert_ratio_threshold"], 0.01
            )
            self.assertTrue(payload["rejections"]["runtime_fallback_alert_active"])
            self.assertEqual(payload["rejections"]["market_context_block_total"], 7)
            self.assertEqual(payload["rejections"]["pre_llm_capacity_reject_total"], 11)
            self.assertEqual(payload["rejections"]["pre_llm_qty_below_min_total"], 13)
            self.assertFalse(payload["shorting_metadata"]["account_ready"])
            self.assertTrue(payload["shorting_metadata"]["alert_active"])
            self.assertEqual(
                payload["shorting_metadata"]["last_error"],
                "account lookup unavailable",
            )
            self.assertTrue(payload["alerts"]["market_context_alert_active"])
            self.assertTrue(payload["alerts"]["runtime_fallback_alert_active"])
            self.assertTrue(payload["alerts"]["shorting_metadata_alert_active"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_metrics_includes_control_plane_contract(self) -> None:
        response = self.client.get("/trading/metrics")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("control_plane_contract", payload)
        self.assertIn("build", payload)
        self.assertIn("shadow_first", payload)
        self.assertEqual(
            payload["control_plane_contract"]["contract_version"],
            "torghut.quant-producer.v1",
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_hypotheses_total"], 5
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_blocked_total"], 4
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_shadow_total"], 1
        )
        self.assertIn("critical_toggle_parity", payload["control_plane_contract"])
        self.assertIn("active_revision", payload["build"])

    def test_trading_status_and_metrics_expose_execution_advisor_counters(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.execution_advisor_usage_total = {
                "advisory_only": 2,
                "fallback": 3,
            }
            scheduler.state.metrics.execution_advisor_fallback_total = {
                "advisor_disabled": 1,
                "advisor_timeout": 2,
            }
            app.state.trading_scheduler = scheduler

            status_response = self.client.get("/trading/status")
            self.assertEqual(status_response.status_code, 200)
            status_payload = status_response.json()
            advisor = status_payload["execution_advisor"]
            self.assertIn("enabled", advisor)
            self.assertIn("live_apply_enabled", advisor)
            self.assertEqual(advisor["usage_total"]["advisory_only"], 2)
            self.assertEqual(advisor["fallback_total"]["advisor_timeout"], 2)

            with patch("app.main._load_route_provenance_summary", return_value={}):
                metrics_response = self.client.get("/metrics")
            self.assertEqual(metrics_response.status_code, 200)
            metrics_payload = metrics_response.text
            self.assertIn(
                'torghut_trading_execution_advisor_usage_total{status="advisory_only"} 2',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_execution_advisor_fallback_total{reason="advisor_disabled"} 1',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_state_total{state="blocked"} 4',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_state_total{state="shadow"} 1',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_capital_stage_total{stage="shadow"} 5',
                metrics_payload,
            )
            self.assertIn(
                "torghut_trading_alpha_readiness_hypotheses_total 5",
                metrics_payload,
            )
            self.assertIn("torghut_trading_llm_runtime_fallback_ratio", metrics_payload)
            self.assertIn(
                "torghut_trading_market_context_alert_active", metrics_payload
            )
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    @patch("app.main._load_tca_summary", side_effect=SQLAlchemyError("boom"))
    def test_trading_status_maps_unhandled_db_errors_to_503(
        self, _mock_tca: object
    ) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["detail"], "database unavailable")

    def test_trading_status_includes_signal_ingest_metadata(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_ingest_reason = "cursor_ahead_of_stream"
            scheduler.state.last_ingest_signals_total = 0
            scheduler.state.autonomy_no_signal_streak = 4
            scheduler.state.last_autonomy_recommendation_trace_id = "trace-123"
            scheduler.state.last_signal_continuity_state = (
                "expected_market_closed_staleness"
            )
            scheduler.state.last_signal_continuity_reason = "no_signals_in_window"
            scheduler.state.last_signal_continuity_actionable = False
            scheduler.state.market_session_open = False
            scheduler.state.signal_continuity_alert_active = True
            scheduler.state.signal_continuity_alert_reason = "cursor_ahead_of_stream"
            scheduler.state.signal_continuity_recovery_streak = 1
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            autonomy = payload["autonomy"]
            self.assertEqual(autonomy["last_ingest_signal_count"], 0)
            self.assertEqual(autonomy["last_ingest_reason"], "cursor_ahead_of_stream")
            self.assertEqual(autonomy["no_signal_streak"], 4)
            self.assertEqual(autonomy["last_recommendation_trace_id"], "trace-123")
            continuity = payload["signal_continuity"]
            self.assertEqual(
                continuity["last_state"], "expected_market_closed_staleness"
            )
            self.assertEqual(continuity["last_reason"], "no_signals_in_window")
            self.assertFalse(continuity["last_actionable"])
            self.assertFalse(continuity["market_session_open"])
            self.assertTrue(continuity["alert_active"])
            self.assertEqual(continuity["alert_reason"], "cursor_ahead_of_stream")
            self.assertEqual(continuity["alert_recovery_streak"], 1)
            self.assertIsNone(payload["autonomy"]["last_actuation_intent"])
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_surfaces_universe_fail_safe_state(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.universe_source_status = "unavailable"
            scheduler.state.universe_source_reason = "jangar_symbols_fetch_failed"
            scheduler.state.universe_fail_safe_blocked = True
            scheduler.state.universe_fail_safe_block_reason = (
                "jangar_symbols_fetch_failed"
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            continuity = response.json()["signal_continuity"]
            self.assertTrue(continuity["universe_fail_safe_blocked"])
            self.assertEqual(
                continuity["universe_fail_safe_block_reason"],
                "jangar_symbols_fetch_failed",
            )
            self.assertEqual(continuity["universe_status"], "unavailable")
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_includes_emergency_stop_recovery_fields(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = "signal_lag_exceeded:900"
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.emergency_stop_recovery_streak = 2
            scheduler.state.emergency_stop_resolved_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            rollback = payload["rollback"]
            self.assertIn("emergency_stop_recovery_streak", rollback)
            self.assertIn("emergency_stop_resolved_at", rollback)
            self.assertEqual(rollback["emergency_stop_recovery_streak"], 2)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_includes_last_actuation_intent(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with TemporaryDirectory() as tmpdir:
            actuation_path = Path(tmpdir) / "actuation-intent.json"
            actuation_path.write_text(json.dumps({}), encoding="utf-8")
            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_actuation_intent = str(actuation_path)
                app.state.trading_scheduler = scheduler
                response = self.client.get("/trading/status")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.json()["autonomy"]["last_actuation_intent"],
                    str(actuation_path),
                )
            finally:
                if original_scheduler is None:
                    if hasattr(app.state, "trading_scheduler"):
                        del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_includes_no_signal_streak(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.autonomy_no_signal_streak = 7
            scheduler.state.last_autonomy_reason = "cursor_ahead_of_stream"
            scheduler.state.last_autonomy_recommendation_trace_id = "autonomy-trace-1"
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/autonomy")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["no_signal_streak"], 7)
            self.assertEqual(payload["last_reason"], "cursor_ahead_of_stream")
            self.assertEqual(
                payload["last_recommendation_trace_id"], "autonomy-trace-1"
            )
            self.assertIsNone(payload["last_actuation_intent"])
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_exposes_bridge_status(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-evaluation.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-bridge-1",
                        "promotion_evidence": {
                            "simulation_calibration": {
                                "artifact_ref": "gates/simulation-calibration-report-v1.json",
                                "status": "calibrated",
                                "order_count": 12,
                                "artifact_authority": {
                                    "authoritative": True,
                                    "provenance": "paper_runtime_observed",
                                },
                            },
                            "shadow_live_deviation": {
                                "artifact_ref": "gates/shadow-live-deviation-report-v1.json",
                                "status": "within_budget",
                                "avg_abs_slippage_bps": "6",
                                "artifact_authority": {
                                    "authoritative": True,
                                    "provenance": "paper_runtime_observed",
                                },
                            },
                        },
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-bridge-1",
                            "recommendation_trace_id": "rec-trace-bridge-1",
                            "promotion_evidence_authority": {
                                "simulation_calibration": {
                                    "authoritative": True,
                                },
                                "shadow_live_deviation": {
                                    "authoritative": True,
                                },
                            },
                        },
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "All upstream dependencies are healthy.",
                        },
                        "alpha_readiness": {
                            "promotion_eligible": True,
                            "strategy_families": ["intraday_tsmom_v1"],
                            "matched_hypothesis_ids": ["intraday-tsmom"],
                            "reasons": [],
                        },
                        "vnext": {
                            "strategy_compilation": [
                                {
                                    "strategy_id": "intraday-tsmom",
                                    "compiler_source": "spec_v2",
                                    "spec_compiled": True,
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_gates = str(gate_path)
                scheduler.state.drift_status = "stable"
                app.state.trading_scheduler = scheduler

                with patch("app.main.SessionLocal", self.session_local):
                    response = self.client.get("/trading/autonomy")
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["bridge_status"]["source"], "gate_report")
                self.assertIn(
                    payload["forecast_service"]["authority"], {"empirical", "blocked"}
                )
                self.assertIn(
                    payload["lean_authority"]["authority"], {"empirical", "blocked"}
                )
                self.assertIn(
                    payload["empirical_jobs"]["authority"], {"empirical", "blocked"}
                )
                self.assertEqual(
                    payload["bridge_status"]["strategy_compilation"]["spec_compiled"],
                    1,
                )
                self.assertEqual(
                    payload["bridge_status"]["simulation_calibration"]["status"],
                    "calibrated",
                )
                self.assertEqual(
                    payload["bridge_status"]["shadow_live_deviation"]["drift_status"],
                    "stable",
                )
                self.assertEqual(
                    payload["bridge_status"]["evidence_authority"][
                        "authoritative_count"
                    ],
                    2,
                )
                self.assertEqual(
                    payload["bridge_status"]["dependency_quorum"]["decision"],
                    "allow",
                )
                self.assertTrue(
                    payload["bridge_status"]["alpha_readiness"]["promotion_eligible"]
                )
            finally:
                if original_scheduler is None:
                    del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_empirical_jobs_endpoint_exposes_latest_job_freshness(self) -> None:
        with self.session_local() as session:
            session.add(
                VNextEmpiricalJobRun(
                    run_id="run-empirical-1",
                    candidate_id="cand-empirical-1",
                    job_name="benchmark parity",
                    job_type="benchmark_parity",
                    job_run_id="job-benchmark-1",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref="s3://datasets/run-empirical-1.json",
                    artifact_refs=["s3://artifacts/benchmark.json"],
                    payload_json=_truthful_empirical_payload(
                        job_run_id="job-benchmark-1",
                        dataset_snapshot_ref="s3://datasets/run-empirical-1.json",
                    ),
                )
            )
            session.commit()

        with patch("app.main.SessionLocal", self.session_local):
            response = self.client.get("/trading/empirical-jobs")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("jobs", payload)
        self.assertEqual(
            payload["message"],
            "missing empirical jobs: foundation_router_parity, janus_event_car, janus_hgrm_reward",
        )
        self.assertEqual(payload["eligible_jobs"], ["benchmark_parity"])
        self.assertEqual(
            payload["missing_jobs"],
            ["foundation_router_parity", "janus_event_car", "janus_hgrm_reward"],
        )
        self.assertEqual(payload["jobs"]["benchmark_parity"]["authority"], "empirical")
        self.assertEqual(
            payload["jobs"]["benchmark_parity"]["job_run_id"], "job-benchmark-1"
        )

    def test_trading_completion_doc29_endpoint_exposes_traceable_gate_status(
        self,
    ) -> None:
        with self.session_local() as session:
            trace = build_completion_trace(
                doc_id="doc29",
                gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
                run_id="sim-2026-03-06-full-day",
                dataset_snapshot_ref="snapshot-1",
                candidate_id="cand-1",
                workflow_name="torghut-historical-simulation",
                analysis_run_names=[],
                artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
                db_row_refs={},
                status_snapshot={},
                result_by_gate={
                    DOC29_SIMULATION_FULL_DAY_GATE: {
                        "status": TRACE_STATUS_SATISFIED,
                        "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                        "acceptance_snapshot": {
                            "trade_decisions": 640,
                            "executions": 320,
                            "execution_tca_metrics": 320,
                            "execution_order_events": 320,
                            "coverage_ratio": 0.99,
                        },
                    }
                },
                blocked_reasons={},
                git_revision="abc123",
                image_digest="sha256:test",
            )
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            session.commit()

        with (
            patch("app.main.SessionLocal", self.session_local),
            patch("app.main.BUILD_COMMIT", "abc123"),
        ):
            response = self.client.get("/trading/completion/doc29")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["doc_id"], "doc29")
        gate = next(
            item
            for item in payload["gates"]
            if item["gate_id"] == DOC29_SIMULATION_FULL_DAY_GATE
        )
        self.assertEqual(gate["status"], "satisfied")
        self.assertEqual(gate["latest_run"], "sim-2026-03-06-full-day")

        with (
            patch("app.main.SessionLocal", self.session_local),
            patch("app.main.BUILD_COMMIT", "abc123"),
        ):
            gate_response = self.client.get(
                f"/trading/completion/doc29/{DOC29_SIMULATION_FULL_DAY_GATE}"
            )
        self.assertEqual(gate_response.status_code, 200)
        self.assertEqual(
            gate_response.json()["gate_id"], DOC29_SIMULATION_FULL_DAY_GATE
        )

    def test_trading_autonomy_evidence_continuity_endpoint_returns_state_report(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_evidence_continuity_report = {
                "checked_runs": 2,
                "failed_runs": 0,
                "ok": True,
            }
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/autonomy/evidence-continuity")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertIn("report", payload)
            self.assertEqual(payload["report"]["checked_runs"], 2)
            self.assertEqual(payload["report"]["failed_runs"], 0)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_evidence_continuity_endpoint_supports_refresh(
        self,
    ) -> None:
        response = self.client.get(
            "/trading/autonomy/evidence-continuity?refresh=true&run_limit=5"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("report", payload)
        self.assertEqual(payload["report"]["checked_runs"], 0)
        self.assertEqual(payload["report"]["failed_runs"], 0)

    def test_trading_status_reports_effective_llm_guardrails(self) -> None:
        original = {
            "llm_shadow_mode": settings.llm_shadow_mode,
            "llm_enabled": settings.llm_enabled,
            "llm_rollout_stage": settings.llm_rollout_stage,
            "trading_mode": settings.trading_mode,
            "trading_live_enabled": settings.trading_live_enabled,
            "llm_fail_mode": settings.llm_fail_mode,
            "llm_fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": settings.llm_fail_open_live_approved,
            "llm_allowed_models_raw": settings.llm_allowed_models_raw,
            "llm_evaluation_report": settings.llm_evaluation_report,
            "llm_effective_challenge_id": settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": settings.llm_shadow_completed_at,
            "llm_model_version_lock": settings.llm_model_version_lock,
        }
        settings.llm_enabled = True
        settings.llm_rollout_stage = "stage3"
        settings.llm_shadow_mode = False
        settings.trading_mode = "live"
        settings.trading_live_enabled = True
        settings.llm_fail_mode = "pass_through"
        settings.llm_fail_mode_enforcement = "configured"
        settings.llm_fail_open_live_approved = True
        settings.llm_allowed_models_raw = None
        settings.llm_evaluation_report = None
        settings.llm_effective_challenge_id = None
        settings.llm_shadow_completed_at = None
        settings.llm_model_version_lock = None

        try:
            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            llm = payload["llm"]
            self.assertEqual(llm["rollout_stage"], "stage3")
            self.assertFalse(llm["shadow_mode"])
            self.assertTrue(llm["effective_shadow_mode"])
            self.assertEqual(llm["fail_mode_enforcement"], "configured")
            self.assertIn("configured_fail_mode_enabled", llm["policy_exceptions"])
            self.assertIn("policy_resolution", llm)
            self.assertIn("policy_resolution_counters", llm)
            self.assertEqual(llm["policy_resolution"]["classification"], "compliant")
            self.assertFalse(llm["policy_resolution"]["fail_mode_exception_active"])
            self.assertFalse(llm["policy_resolution"]["fail_mode_violation_active"])
            self.assertIn("guardrails", llm)
            self.assertTrue(llm["guardrails"]["allow_requests"])
            self.assertIn("llm_evaluation_report_missing", llm["guardrails"]["reasons"])
            self.assertIn(
                "llm_model_version_lock_missing", llm["guardrails"]["reasons"]
            )
        finally:
            settings.llm_shadow_mode = original["llm_shadow_mode"]
            settings.llm_enabled = original["llm_enabled"]
            settings.llm_rollout_stage = original["llm_rollout_stage"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_live_enabled = original["trading_live_enabled"]
            settings.llm_fail_mode = original["llm_fail_mode"]
            settings.llm_fail_mode_enforcement = original["llm_fail_mode_enforcement"]
            settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
            settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            settings.llm_evaluation_report = original["llm_evaluation_report"]
            settings.llm_effective_challenge_id = original["llm_effective_challenge_id"]
            settings.llm_shadow_completed_at = original["llm_shadow_completed_at"]
            settings.llm_model_version_lock = original["llm_model_version_lock"]

    def test_trading_runtime_profitability_endpoint_happy_path(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalars().first()
            strategy = session.execute(select(Strategy)).scalars().first()
            self.assertIsNotNone(decision)
            self.assertIsNotNone(strategy)
            execution = Execution(
                trade_decision_id=decision.id if decision is not None else None,
                alpaca_order_id="order-2",
                client_order_id="client-2",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("102"),
                status="filled",
                execution_expected_adapter="lean",
                execution_actual_adapter="alpaca_fallback",
                execution_fallback_reason="lean_submit_failed",
                execution_fallback_count=2,
                raw_order={},
                created_at=datetime.now(timezone.utc),
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)
            tca = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id if decision is not None else None,
                strategy_id=strategy.id if strategy is not None else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=Decimal("102"),
                filled_qty=Decimal("2"),
                signed_qty=Decimal("2"),
                slippage_bps=Decimal("200"),
                shortfall_notional=Decimal("2"),
                realized_shortfall_bps=Decimal("150"),
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(tca)
            session.commit()

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_path = root / "gate-evaluation.json"
            rollback_path = root / "rollback-incident.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-demo",
                        "gates": [
                            {
                                "gate_id": "gate6_profitability_evidence",
                                "status": "pass",
                                "reasons": [],
                                "artifact_refs": [
                                    str(root / "profitability-evidence-v4.json")
                                ],
                            }
                        ],
                        "promotion_decision": {
                            "promotion_target": "paper",
                            "recommended_mode": "paper",
                            "promotion_allowed": True,
                            "reason_codes": [],
                            "promotion_gate_artifact": str(
                                root / "promotion-evidence-gate.json"
                            ),
                        },
                        "promotion_recommendation": {
                            "action": "promote",
                            "trace_id": "recommendation-trace-demo",
                        },
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-demo",
                            "recommendation_trace_id": "recommendation-trace-demo",
                            "profitability_benchmark_artifact": str(
                                root / "profitability-benchmark-v4.json"
                            ),
                            "profitability_evidence_artifact": str(
                                root / "profitability-evidence-v4.json"
                            ),
                            "profitability_validation_artifact": str(
                                root / "profitability-evidence-validation.json"
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )
            actuation_path = root / "actuation-intent.json"
            actuation_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.autonomy.actuation-intent.v1",
                        "run_id": "run-demo",
                        "candidate_id": "candidate-demo",
                        "gates": {
                            "recommendation_trace_id": "act-rec-trace-demo",
                            "gate_report_trace_id": "act-gate-trace-demo",
                            "promotion_allowed": True,
                        },
                        "artifact_refs": [str(root / "profitability-evidence-v4.json")],
                        "audit": {
                            "rollback_readiness_readout": {
                                "kill_switch_dry_run_passed": True,
                                "gitops_revert_dry_run_passed": True,
                                "strategy_disable_dry_run_passed": False,
                                "human_approved": False,
                                "rollback_target": "rollback-target",
                                "dry_run_completed_at": "",
                            },
                            "rollback_evidence_missing_checks": [
                                "strategy_disable_dry_run_failed"
                            ],
                        },
                    }
                ),
                encoding="utf-8",
            )
            rollback_path.write_text(
                json.dumps(
                    {
                        "reasons": ["signal_lag_exceeded:900"],
                        "verification": {"incident_evidence_complete": True},
                    }
                ),
                encoding="utf-8",
            )

            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_gates = str(gate_path)
                scheduler.state.rollback_incident_evidence_path = str(rollback_path)
                scheduler.state.rollback_incidents_total = 3
                scheduler.state.emergency_stop_active = True
                scheduler.state.emergency_stop_reason = "signal_lag_exceeded:900"
                scheduler.state.metrics.signal_continuity_promotion_block_total = 2
                scheduler.state.last_autonomy_actuation_intent = str(actuation_path)
                app.state.trading_scheduler = scheduler

                response = self.client.get("/trading/profitability/runtime")
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(
                    payload["schema_version"], "torghut.runtime-profitability.v1"
                )
                self.assertEqual(payload["window"]["lookback_hours"], 72)
                self.assertEqual(payload["window"]["decision_count"], 1)
                self.assertEqual(payload["window"]["execution_count"], 2)
                self.assertEqual(
                    payload["executions"]["fallback_reason_totals"][
                        "lean_submit_failed"
                    ],
                    1,
                )
                self.assertEqual(
                    payload["realized_pnl_summary"]["shortfall_notional_total"], "3"
                )
                self.assertEqual(
                    payload["realized_pnl_summary"]["realized_pnl_proxy_notional"],
                    "-3",
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["gate_report_trace_id"],
                    "act-gate-trace-demo",
                )
                self.assertTrue(
                    payload["gate_rollback_attribution"][
                        "gate6_profitability_evidence"
                    ]["status"]
                    == "pass"
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "artifact_path"
                    ],
                    str(actuation_path),
                )
                self.assertFalse(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "actuation_allowed"
                    ]
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "rollback_readiness"
                    ]["missing_checks"],
                    ["strategy_disable_dry_run_failed"],
                )
            finally:
                if original_scheduler is None:
                    if hasattr(app.state, "trading_scheduler"):
                        del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_runtime_profitability_endpoint_empty_window(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            with self.session_local() as session:
                old_ts = datetime.now(timezone.utc) - timedelta(days=10)
                for decision in session.execute(select(TradeDecision)).scalars().all():
                    decision.created_at = old_ts
                    decision.executed_at = old_ts
                for execution in session.execute(select(Execution)).scalars().all():
                    execution.created_at = old_ts
                    execution.last_update_at = old_ts
                for tca in session.execute(select(ExecutionTCAMetric)).scalars().all():
                    tca.computed_at = old_ts
                session.commit()

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/profitability/runtime")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["window"]["empty"])
            self.assertEqual(payload["window"]["decision_count"], 0)
            self.assertEqual(payload["window"]["execution_count"], 0)
            self.assertEqual(payload["decisions_by_symbol_strategy"], [])
            self.assertEqual(payload["executions"]["by_adapter"], [])
            self.assertEqual(payload["realized_pnl_summary"]["tca_sample_count"], 0)
            caveat_codes = {item["code"] for item in payload["caveats"]}
            self.assertIn("empty_window_no_runtime_evidence", caveat_codes)
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_paper_route_evidence_endpoint_audits_probation_targets(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        now = datetime.now(timezone.utc)
        window_start = now - timedelta(hours=2)
        window_end = now
        with self.session_local() as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="paper-route-run-1",
                candidate_id="candidate-paper-route",
                hypothesis_id="H-PAPER-ROUTE",
                observed_stage="paper",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                account_label="paper",
                runtime_strategy_name="missing-paper-route-strategy",
                strategy_family="microbar_pairs",
                fill_count=4,
                decision_count=5,
                submitted_order_count=4,
                closed_trade_count=2,
                open_position_count=0,
                filled_notional=Decimal("12500"),
                gross_strategy_pnl=Decimal("83"),
                cost_amount=Decimal("3"),
                net_strategy_pnl_after_costs=Decimal("80"),
                post_cost_expectancy_bps=Decimal("64"),
                ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                pnl_basis="realized_strategy_pnl_after_explicit_costs",
                execution_policy_hash_counts={"policy-a": 4},
                cost_model_hash_counts={"cost-a": 4},
                lineage_hash_counts={"lineage-a": 4},
                blockers_json=[],
                payload_json={
                    "source_window_start": window_start.isoformat(),
                    "source_window_end": window_end.isoformat(),
                    "source_refs": [
                        "postgres:trade_decisions",
                        "postgres:executions",
                        "postgres:execution_order_events",
                        "postgres:order_feed_source_windows",
                    ],
                    "source_row_counts": {
                        "trade_decisions": 5,
                        "executions": 4,
                        "execution_order_events": 4,
                        "order_feed_source_windows": 1,
                    },
                    "trade_decision_ids": [
                        "paper-route-decision-1",
                        "paper-route-decision-2",
                        "paper-route-decision-3",
                        "paper-route-decision-4",
                        "paper-route-decision-5",
                    ],
                    "execution_ids": [
                        "paper-route-execution-1",
                        "paper-route-execution-2",
                        "paper-route-execution-3",
                        "paper-route-execution-4",
                    ],
                    "execution_order_event_ids": [
                        "paper-route-order-event-1",
                        "paper-route-order-event-2",
                        "paper-route-order-event-3",
                        "paper-route-order-event-4",
                    ],
                    "source_window_ids": ["paper-route-source-window"],
                    "source_offsets": [
                        {
                            "topic": "alpaca.trade_updates",
                            "partition": 0,
                            "offset": 100,
                        },
                        {
                            "topic": "alpaca.trade_updates",
                            "partition": 0,
                            "offset": 101,
                        },
                        {
                            "topic": "alpaca.trade_updates",
                            "partition": 0,
                            "offset": 102,
                        },
                        {
                            "topic": "alpaca.trade_updates",
                            "partition": 0,
                            "offset": 103,
                        },
                    ],
                    "source_materialization": "execution_order_events",
                    "authority_class": "runtime_order_feed_execution_source",
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "source_decision_mode_counts": {"strategy_signal_paper": 5},
                    "cost_basis_counts": {"broker_reported": 4},
                },
            )
            metric_window = StrategyHypothesisMetricWindow(
                run_id="paper-route-run-1",
                candidate_id="candidate-paper-route",
                hypothesis_id="H-PAPER-ROUTE",
                observed_stage="paper",
                window_started_at=window_start,
                window_ended_at=window_end,
                market_session_count=2,
                decision_count=5,
                trade_count=2,
                order_count=4,
                evidence_provenance="paper_runtime_observed",
                evidence_maturity="empirically_validated",
                decision_alignment_ratio="1",
                avg_abs_slippage_bps="3",
                slippage_budget_bps="10",
                post_cost_expectancy_bps="64",
                continuity_ok=True,
                drift_ok=True,
                dependency_quorum_decision="allow",
                capital_stage="shadow",
            )
            promotion_decision = StrategyPromotionDecision(
                run_id="paper-route-run-1",
                candidate_id="candidate-paper-route",
                hypothesis_id="H-PAPER-ROUTE",
                promotion_target="paper",
                state="blocked",
                allowed=False,
                reason_summary="paper_probation_evidence_collection_only",
            )
            session.add_all([bucket, metric_window, promotion_decision])
            session.commit()

        target = {
            "hypothesis_id": "H-PAPER-ROUTE",
            "candidate_id": "candidate-paper-route",
            "observed_stage": "paper",
            "strategy_family": "microbar_pairs",
            "strategy_name": "missing-paper-route-strategy",
            "account_label": "paper",
            "source_kind": "durable_runtime_ledger_bucket",
            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
            "dataset_snapshot_ref": "dataset://paper-route",
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "runtime_ledger_bucket_ref": (
                "strategy_runtime_ledger_buckets:paper-route-run-1:"
                f"{window_start.isoformat()}:{window_end.isoformat()}"
            ),
            "paper_probation_authorized": True,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_blockers": [
                "runtime_ledger_stage_not_live",
                "paper_probation_evidence_collection_only",
            ],
            "max_notional": "0",
        }
        live_gate = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [target],
            },
        }
        proof_floor = {
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "summary": {
                    "paper_route_probe_eligible_symbols": ["AAPL"],
                    "paper_route_probe_active_symbols": [],
                },
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "25",
                    "eligible_symbol_count": 1,
                    "eligible_symbols": ["AAPL"],
                    "active_symbols": [],
                    "blocking_reasons": ["market_session_closed"],
                },
            }
        }
        try:
            if hasattr(app.state, "trading_scheduler"):
                del app.state.trading_scheduler
            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value=proof_floor,
                ),
            ):
                response = self.client.get(
                    "/trading/paper-route-evidence?lookback_hours=24&target_limit=1"
                )
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(
                payload["schema_version"], "torghut.paper-route-evidence.v1"
            )
            self.assertEqual(payload["window"]["lookback_hours"], 24)
            self.assertEqual(payload["window"]["target_limit"], 1)
            self.assertEqual(payload["summary"]["target_count"], 1)
            self.assertEqual(payload["summary"]["target_with_runtime_ledger_count"], 1)
            self.assertEqual(payload["summary"]["target_with_source_activity_count"], 0)
            audit = payload["targets"][0]
            self.assertFalse(audit["target"]["promotion_allowed"])
            self.assertFalse(audit["target"]["final_promotion_allowed"])
            self.assertTrue(audit["source_activity"]["missing"])
            self.assertEqual(audit["runtime_ledger"]["bucket_count"], 1)
            self.assertEqual(audit["runtime_ledger"]["fill_count"], 4)
            self.assertEqual(audit["runtime_ledger"]["filled_notional"], "12500")
            self.assertEqual(audit["hypothesis_windows"]["window_count"], 1)
            self.assertEqual(audit["promotion_decisions"]["decision_count"], 1)
            self.assertFalse(audit["promotion_decisions"]["latest"]["allowed"])
            self.assertEqual(payload["paper_route_probe"]["eligible_symbols"], ["AAPL"])
            next_plan = payload["next_paper_route_runtime_window_targets"]
            self.assertEqual(
                next_plan["schema_version"],
                "torghut.next-paper-route-runtime-window-targets.v1",
            )
            self.assertEqual(next_plan["target_count"], 1)
            next_target = next_plan["targets"][0]
            self.assertEqual(next_target["source_dsn_env"], "SIM_DB_DSN")
            self.assertEqual(next_target["target_dsn_env"], "SIM_DB_DSN")
            self.assertEqual(
                next_target["source_kind"], "paper_route_probe_runtime_observed"
            )
            self.assertEqual(next_target["paper_route_probe_symbols"], ["AAPL"])
            self.assertEqual(next_target["max_notional"], "0")
            self.assertFalse(next_target["promotion_allowed"])
            self.assertFalse(next_target["final_promotion_allowed"])
            blockers = set(audit["readiness"]["blockers"])
            self.assertIn("source_decisions_missing", blockers)
            self.assertIn("source_executions_missing", blockers)
            self.assertIn("source_tca_missing", blockers)
            self.assertIn("paper_probation_evidence_collection_only", blockers)
            self.assertIn("promotion_decision_not_allowed", blockers)
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_paper_route_target_plan_defers_runtime_import_audit(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
            "account_label": "TORGHUT_REPLAY",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
            "window_start": "2026-05-22T13:30:00+00:00",
            "window_end": "2026-05-22T20:00:00+00:00",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        live_gate = {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [target],
            },
        }
        try:
            if hasattr(app.state, "trading_scheduler"):
                del app.state.trading_scheduler

            def _assert_deferred_audit_mode(
                *args: object, **kwargs: object
            ) -> dict[str, object]:
                self.assertEqual(
                    kwargs["live_submission_gate"][
                        "runtime_ledger_paper_probation_import_plan"
                    ],
                    live_gate["runtime_ledger_paper_probation_import_plan"],
                )
                self.assertIsNone(kwargs["include_runtime_window_import_audit"])
                self.assertTrue(kwargs["route_reacquisition_book"])
                return {
                    "schema_version": "torghut.paper-route-target-plan.v1",
                    "target_count": 1,
                    "skipped_target_count": 0,
                    "runtime_window_import_audit_mode": "deferred_until_import_ready",
                    "runtime_window_import_plan": {
                        "target_count": 1,
                        "runtime_window_import_handoff": {
                            "target_plan_endpoint": "/trading/paper-route-target-plan"
                        },
                        "targets": [
                            {
                                "candidate_id": target["candidate_id"],
                                "paper_route_probe_symbols": ["AAPL"],
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
                            }
                        ],
                    },
                    "next_paper_route_runtime_window_targets": {
                        "purpose": "next_session_paper_route_runtime_window_evidence_collection",
                        "target_count": 1,
                        "targets": [
                            {
                                "candidate_id": target["candidate_id"],
                                "paper_route_probe_symbols": ["AAPL"],
                                "window_start": "2026-05-26T13:30:00+00:00",
                            }
                        ],
                    },
                    "purpose": "next_session_paper_route_runtime_window_evidence_collection",
                    "targets": [
                        {
                            "candidate_id": target["candidate_id"],
                            "paper_route_probe_symbols": ["AAPL"],
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "promotion_allowed": False,
                            "final_promotion_allowed": False,
                        }
                    ],
                }

            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    side_effect=AssertionError("proof floor should not run"),
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "63180",
                    },
                ),
                patch(
                    "app.main.build_paper_route_target_plan_payload",
                    side_effect=_assert_deferred_audit_mode,
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(
                payload["schema_version"], "torghut.paper-route-target-plan.v1"
            )
            self.assertNotIn("next_runtime_window_target_audits", payload)
            self.assertEqual(
                payload["runtime_window_import_audit_mode"],
                "deferred_until_import_ready",
            )
            plan = payload["runtime_window_import_plan"]
            self.assertEqual(plan["target_count"], 1)
            self.assertEqual(
                payload["next_paper_route_runtime_window_targets"]["target_count"], 1
            )
            self.assertEqual(payload["target_count"], 1)
            self.assertEqual(payload["skipped_target_count"], 0)
            self.assertEqual(
                plan["runtime_window_import_handoff"]["target_plan_endpoint"],
                "/trading/paper-route-target-plan",
            )
            self.assertEqual(plan["targets"][0]["candidate_id"], target["candidate_id"])
            self.assertEqual(plan["targets"][0]["paper_route_probe_symbols"], ["AAPL"])
            self.assertFalse(plan["targets"][0]["promotion_allowed"])
            self.assertFalse(plan["targets"][0]["final_promotion_allowed"])
            next_plan = payload["next_paper_route_runtime_window_targets"]
            next_target = next_plan["targets"][0]
            self.assertEqual(payload["purpose"], next_plan["purpose"])
            self.assertEqual(
                payload["targets"][0]["candidate_id"], target["candidate_id"]
            )
            self.assertEqual(
                payload["targets"][0]["paper_route_probe_symbols"], ["AAPL"]
            )
            self.assertEqual(
                payload["targets"][0]["window_start"], next_target["window_start"]
            )
            self.assertFalse(payload["targets"][0]["promotion_allowed"])
            self.assertFalse(payload["targets"][0]["final_promotion_allowed"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_paper_route_target_plan_uses_cached_gate_fast_path(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "window_start": "2026-05-22T13:30:00+00:00",
            "window_end": "2026-05-22T20:00:00+00:00",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        cached_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "simple_submit_disabled",
            ],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [target],
            },
        }
        fake_scheduler = SimpleNamespace(
            state=SimpleNamespace(market_session_open=False),
            _last_live_submission_gate=cached_gate,
        )
        try:
            app.state.trading_scheduler = fake_scheduler
            with (
                patch(
                    "app.main._empirical_jobs_status",
                    side_effect=AssertionError("empirical jobs should not load"),
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    side_effect=AssertionError("quant evidence should not load"),
                ),
                patch(
                    "app.main._load_tca_summary",
                    side_effect=AssertionError("TCA summary should not load"),
                ),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    side_effect=AssertionError("hypothesis payload should not load"),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    side_effect=AssertionError("live gate should use cache"),
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    side_effect=AssertionError("proof floor should not run"),
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["target_count"], 1)
            self.assertEqual(
                payload["targets"][0]["candidate_id"], "c88421d619759b2cfaa6f4d0"
            )
            self.assertEqual(
                payload["live_submission_gate"]["paper_route_target_plan_source"],
                "cached_live_submission_gate",
            )
            self.assertFalse(payload["summary"]["promotion_authority"]["allowed"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_paper_route_target_plan_uses_bounded_sim_cached_gate_fast_path(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_trading_mode = settings.trading_mode
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_mode = "live"
        settings.trading_paper_route_target_plan_url = None
        self.addCleanup(setattr, settings, "trading_mode", original_trading_mode)
        self.addCleanup(
            setattr,
            settings,
            "trading_paper_route_target_plan_url",
            original_target_plan_url,
        )
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_probation_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "max_notional": "0",
        }
        cached_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "simple_submit_disabled",
            ],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
                "targets": [target],
            },
        }
        fake_scheduler = SimpleNamespace(
            state=SimpleNamespace(market_session_open=True),
            _last_live_submission_gate=cached_gate,
        )
        try:
            app.state.trading_scheduler = fake_scheduler
            with (
                patch(
                    "app.main._empirical_jobs_status",
                    side_effect=AssertionError("empirical jobs should not load"),
                ),
                patch(
                    "app.main.load_quant_evidence_status",
                    side_effect=AssertionError("quant evidence should not load"),
                ),
                patch(
                    "app.main._load_tca_summary",
                    side_effect=AssertionError("TCA summary should not load"),
                ),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    side_effect=AssertionError("hypothesis payload should not load"),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    side_effect=AssertionError("live gate should use cache"),
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    side_effect=AssertionError("proof floor should not run"),
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["target_count"], 1)
            self.assertEqual(
                payload["live_submission_gate"]["paper_route_target_plan_source"],
                "cached_live_submission_gate",
            )
            self.assertFalse(payload["summary"]["promotion_authority"]["allowed"])
            self.assertFalse(payload["paper_route_probe"]["active"])
            self.assertIn(
                "not_paper_mode",
                payload["paper_route_probe"]["blocking_reasons"],
            )
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_paper_route_target_plan_bypasses_cached_gate_scope(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_trading_mode = settings.trading_mode
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_mode = "live"
        settings.trading_paper_route_target_plan_url = None
        self.addCleanup(setattr, settings, "trading_mode", original_trading_mode)
        self.addCleanup(
            setattr,
            settings,
            "trading_paper_route_target_plan_url",
            original_target_plan_url,
        )
        stale_target = {
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "observed_stage": "paper",
            "strategy_family": "intraday_tsmom_consistent",
            "strategy_name": "intraday-tsmom-profit-v3",
            "account_label": "TORGHUT_REPLAY",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": "config/trading/hypotheses/h-tsmom-liq.json",
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "paper_route_probe_symbols": [
                "AAPL",
                "AMZN",
                "NVDA",
                "GOOGL",
                "AVGO",
                "AMD",
                "ORCL",
                "INTC",
            ],
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        fresh_target = {
            **stale_target,
            "paper_route_probe_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
        }
        stale_plan = {
            "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
            "target_count": 1,
            "skipped_target_count": 0,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "targets": [stale_target],
        }
        cached_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": stale_plan,
        }
        live_gate = {
            **cached_gate,
            "runtime_ledger_paper_probation_import_plan": {
                **stale_plan,
                "targets": [fresh_target],
            },
        }
        proof_floor = {
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "summary": {
                    "paper_route_probe_eligible_symbols": [
                        "AAPL",
                        "AMZN",
                        "INTC",
                        "NVDA",
                    ],
                    "paper_route_probe_active_symbols": [],
                },
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "75000",
                    "eligible_symbol_count": 4,
                    "eligible_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                    "active_symbols": [],
                    "blocking_reasons": ["not_paper_mode", "market_session_closed"],
                },
            }
        }
        fake_scheduler = SimpleNamespace(
            state=SimpleNamespace(market_session_open=False),
            _last_live_submission_gate=cached_gate,
            market_context_status=lambda: {"status": "ok"},
            llm_status=lambda: {"dspy_runtime": {}},
        )
        try:
            app.state.trading_scheduler = fake_scheduler
            with (
                patch("app.main._empirical_jobs_status", return_value={}),
                patch("app.main.load_quant_evidence_status", return_value={}),
                patch("app.main._load_tca_summary", return_value={}),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {},
                        {},
                        JangarDependencyQuorumStatus(
                            decision="allow",
                            reasons=[],
                            message="ready",
                        ),
                    ),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ) as live_gate_builder,
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value=proof_floor,
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")

            self.assertEqual(response.status_code, 200)
            live_gate_builder.assert_called_once()
            payload = response.json()
            self.assertEqual(
                payload["targets"][0]["paper_route_probe_symbols"],
                ["AAPL", "AMZN", "INTC", "NVDA"],
            )
            self.assertNotIn("ORCL", payload["targets"][0]["paper_route_probe_symbols"])
            self.assertNotEqual(
                payload["live_submission_gate"].get("paper_route_target_plan_source"),
                "cached_live_submission_gate",
            )
            self.assertEqual(
                payload["paper_route_probe"]["eligible_symbols"],
                ["AAPL", "AMZN", "INTC", "NVDA"],
            )
            self.assertIn(
                "not_paper_mode",
                payload["paper_route_probe"]["blocking_reasons"],
            )
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_paper_route_target_plan_preserves_strategy_universe_symbols(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_trading_mode = settings.trading_mode
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_mode = "live"
        settings.trading_paper_route_target_plan_url = ""
        self.addCleanup(setattr, settings, "trading_mode", original_trading_mode)
        self.addCleanup(
            setattr,
            settings,
            "trading_paper_route_target_plan_url",
            original_target_plan_url,
        )
        strategy_symbols = [
            "NVDA",
            "AAPL",
            "AMZN",
            "GOOGL",
            "AVGO",
            "AMD",
            "ORCL",
            "INTC",
        ]
        target = {
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "observed_stage": "paper",
            "strategy_family": "intraday_tsmom_consistent",
            "strategy_name": "intraday-tsmom-profit-v3",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "strategy_lookup_names": [
                "intraday-tsmom-profit-v3",
                "intraday-tsmom-v2",
            ],
            "account_label": "TORGHUT_REPLAY",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": ("config/trading/hypotheses/h-tsmom-liq-01.json"),
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "paper_route_probe_next_session_max_notional": "75000",
            "paper_probation_authorized": True,
            "source_collection_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        live_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [target],
            },
        }
        stale_proof_floor_symbols = ["AAPL", "AMZN", "INTC", "NVDA"]
        proof_floor = {
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "75000",
                    "eligible_symbol_count": len(stale_proof_floor_symbols),
                    "eligible_symbols": stale_proof_floor_symbols,
                    "active_symbols": [],
                    "blocking_reasons": ["not_paper_mode", "market_session_closed"],
                },
            }
        }
        with self.session_local() as session:
            session.add(
                Strategy(
                    name="intraday-tsmom-profit-v3",
                    description="tsmom runtime strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=strategy_symbols,
                )
            )
            session.commit()
        fake_scheduler = SimpleNamespace(
            state=SimpleNamespace(market_session_open=False),
            market_context_status=lambda: {"status": "ok"},
            llm_status=lambda: {"dspy_runtime": {}},
        )
        try:
            app.state.trading_scheduler = fake_scheduler
            with (
                patch("app.main._empirical_jobs_status", return_value={}),
                patch("app.main.load_quant_evidence_status", return_value={}),
                patch("app.main._load_tca_summary", return_value={}),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {},
                        {},
                        JangarDependencyQuorumStatus(
                            decision="allow",
                            reasons=[],
                            message="ready",
                        ),
                    ),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value=proof_floor,
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(
                payload["paper_route_probe"]["eligible_symbols"], strategy_symbols
            )
            self.assertIn(
                "not_paper_mode",
                payload["paper_route_probe"]["blocking_reasons"],
            )
            target_payload = payload["targets"][0]
            self.assertEqual(
                target_payload["paper_route_probe_symbols"], strategy_symbols
            )
            self.assertEqual(
                target_payload["paper_route_probe_strategy_universe_symbols"],
                strategy_symbols,
            )
            self.assertNotIn("ORCL", stale_proof_floor_symbols)
            self.assertIn("ORCL", target_payload["paper_route_probe_symbols"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_paper_route_target_plan_uses_proof_floor_when_plan_unready(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_trading_mode = settings.trading_mode
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_mode = "live"
        settings.trading_paper_route_target_plan_url = ""
        self.addCleanup(setattr, settings, "trading_mode", original_trading_mode)
        self.addCleanup(
            setattr,
            settings,
            "trading_paper_route_target_plan_url",
            original_target_plan_url,
        )
        live_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-FALLBACK",
                        "candidate_id": "candidate-proof-floor-fallback",
                        "observed_stage": "paper",
                        "strategy_family": "fallback_family",
                        "strategy_name": "missing-proof-floor-strategy",
                        "account_label": "TORGHUT_REPLAY",
                        "source_kind": "runtime_ledger_paper_probation_candidates",
                        "source_manifest_ref": (
                            "config/trading/hypotheses/h-fallback.json"
                        ),
                        "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                        "paper_route_probe_next_session_max_notional": "75000",
                        "paper_probation_authorized": True,
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "max_notional": "0",
                    }
                ],
            },
        }
        proof_floor = {
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "75000",
                    "eligible_symbol_count": 1,
                    "eligible_symbols": ["AAPL"],
                    "active_symbols": [],
                    "blocking_reasons": ["not_paper_mode", "market_session_closed"],
                },
            }
        }
        fake_scheduler = SimpleNamespace(
            state=SimpleNamespace(market_session_open=False),
            market_context_status=lambda: {"status": "ok"},
            llm_status=lambda: {"dspy_runtime": {}},
        )
        try:
            app.state.trading_scheduler = fake_scheduler
            with (
                patch("app.main._empirical_jobs_status", return_value={}),
                patch("app.main.load_quant_evidence_status", return_value={}),
                patch("app.main._load_tca_summary", return_value={}),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=(
                        {},
                        {},
                        JangarDependencyQuorumStatus(
                            decision="allow",
                            reasons=[],
                            message="ready",
                        ),
                    ),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value=proof_floor,
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["paper_route_probe"]["eligible_symbols"], ["AAPL"])
            self.assertEqual(
                payload["targets"][0]["paper_route_probe_symbols"], ["AAPL"]
            )
            self.assertIn(
                "not_paper_mode",
                payload["paper_route_probe"]["blocking_reasons"],
            )
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_paper_route_probe_blocking_reason_helpers_ignore_invalid_shapes(
        self,
    ) -> None:
        self.assertEqual(
            main_module._paper_route_probe_blocking_reasons_from_book({}),
            [],
        )
        self.assertEqual(
            main_module._paper_route_probe_blocking_reasons_from_book(
                {"paper_route_probe": {"blocking_reasons": "not_paper_mode"}}
            ),
            [],
        )
        route_book = {
            "paper_route_probe": {
                "blocking_reasons": ["market_session_closed"],
            }
        }
        self.assertIs(
            main_module._merge_paper_route_probe_blocking_reasons(
                route_book,
                fallback_route_reacquisition_book={"paper_route_probe": {}},
            ),
            route_book,
        )

    def test_paper_route_cached_gate_requires_target_plan(self) -> None:
        self.assertFalse(main_module._paper_route_target_plan_truthy(0))
        self.assertTrue(main_module._paper_route_target_plan_truthy(1))
        self.assertFalse(main_module._paper_route_target_plan_cache_safe_for_live({}))
        self.assertIsNone(
            main_module._paper_route_cached_live_submission_gate(
                SimpleNamespace(_last_live_submission_gate=None)
            )
        )
        self.assertIsNone(
            main_module._paper_route_cached_live_submission_gate(
                SimpleNamespace(_last_live_submission_gate={"allowed": False})
            )
        )
        unsafe_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": True,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            }
        }
        self.assertIsNone(
            main_module._paper_route_cached_live_submission_gate(
                SimpleNamespace(_last_live_submission_gate=unsafe_gate),
                require_bounded_sim_targets=True,
            )
        )
        unsafe_target_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "final_promotion_authorized": "yes",
                    }
                ],
            }
        }
        self.assertIsNone(
            main_module._paper_route_cached_live_submission_gate(
                SimpleNamespace(_last_live_submission_gate=unsafe_target_gate),
                require_bounded_sim_targets=True,
            )
        )

    def test_paper_route_target_strategy_lookup_names_skip_missing_values(
        self,
    ) -> None:
        names = main_module._paper_route_target_strategy_lookup_names(
            {
                "strategy_lookup_names": [
                    " source-strategy ",
                    "source-strategy",
                    12,
                ],
                "runtime_strategy_name": "runtime-strategy",
                "strategy_name": "source-strategy",
            }
        )

        self.assertEqual(
            names,
            ["source-strategy", "12", "runtime-strategy"],
        )
        self.assertEqual(
            main_module._paper_route_target_strategy_lookup_names({}),
            [],
        )

    def test_paper_route_probe_symbols_resolve_target_strategy_universe(
        self,
    ) -> None:
        with self.session_local() as session:
            session.add_all(
                [
                    Strategy(
                        name="route-target-source",
                        description="route target source",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=[" msft ", "", "AAPL", "MSFT"],
                    ),
                    Strategy(
                        name="route-target-string-universe",
                        description="route target string universe",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols="TSLA",
                    ),
                ]
            )
            session.commit()

            self.assertEqual(
                main_module._paper_route_probe_symbols_from_target_plan_strategies(
                    session,
                    [{}],
                ),
                [],
            )
            symbols = (
                main_module._paper_route_probe_symbols_from_target_plan_strategies(
                    session,
                    [
                        {
                            "strategy_lookup_names": [
                                "route-target-source",
                                "route-target-string-universe",
                                "route-target-source",
                            ],
                            "runtime_strategy_name": "route-target-source",
                            "strategy_name": "route-target-string-universe",
                        }
                    ],
                )
            )

        self.assertEqual(symbols, ["MSFT", "AAPL"])

    def test_paper_route_probe_book_uses_strategy_universe_when_symbols_missing(
        self,
    ) -> None:
        with self.session_local() as session:
            session.add(
                Strategy(
                    name="route-book-source",
                    description="route book source",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["aapl", "MSFT"],
                )
            )
            session.commit()

            book = main_module._paper_route_probe_book_from_target_plan(
                {
                    "paper_route_target_plan_source": "cached_live_submission_gate",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "candidate-strategy-universe",
                                "strategy_lookup_names": ["route-book-source"],
                                "paper_route_probe_next_session_max_notional": "25000",
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
                            }
                        ],
                    },
                },
                simple_lane_status={"paper_route_probe_enabled": True},
                state=SimpleNamespace(market_session_open=True),
                session=session,
            )

        self.assertIsNotNone(book)
        assert book is not None
        self.assertEqual(
            book["summary"]["paper_route_probe_eligible_symbols"], ["AAPL", "MSFT"]
        )
        self.assertEqual(book["paper_route_probe"]["active_symbols"], ["AAPL", "MSFT"])
        self.assertEqual(book["paper_route_probe"]["effective_max_notional"], "25000")
        self.assertEqual(book["source_refs"]["target_plan_target_count"], 1)
        self.assertEqual(
            book["source_refs"]["target_plan_source"], "cached_live_submission_gate"
        )

    def test_trading_paper_route_target_plan_uses_empty_route_book_when_unavailable(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        cached_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "targets": [
                    {
                        "candidate_id": "candidate-empty-book",
                        "strategy_name": "route-book-missing",
                        "paper_probation_authorized": True,
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            },
        }

        def _assert_empty_route_book(
            *args: object, **kwargs: object
        ) -> dict[str, object]:
            self.assertEqual(kwargs["route_reacquisition_book"], {})
            self.assertIsNone(kwargs["include_runtime_window_import_audit"])
            return {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "target_count": 1,
                "targets": [{"candidate_id": "candidate-empty-book"}],
            }

        try:
            app.state.trading_scheduler = SimpleNamespace(
                state=SimpleNamespace(market_session_open=False),
                _last_live_submission_gate=cached_gate,
            )
            with (
                patch(
                    "app.main._paper_route_probe_book_from_target_plan",
                    return_value=None,
                ),
                patch(
                    "app.main.build_paper_route_target_plan_payload",
                    side_effect=_assert_empty_route_book,
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={"paper_route_probe_enabled": True},
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["target_count"], 1)
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_paper_route_target_plan_skips_full_proof_floor_when_target_plan_ready(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_next_session_max_notional": "75000",
            "paper_probation_authorized": True,
            "source_collection_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        live_gate = {
            "allowed": True,
            "reason": "paper_probe_ready",
            "blocked_reasons": [],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [target],
            },
        }
        try:
            if hasattr(app.state, "trading_scheduler"):
                del app.state.trading_scheduler
            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    side_effect=AssertionError("full proof floor should not run"),
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(
                payload["paper_route_probe"]["eligible_symbols"], ["AAPL", "AMZN"]
            )
            self.assertEqual(
                payload["paper_route_probe"]["next_session_max_notional"], "75000"
            )
            self.assertEqual(payload["target_count"], 1)
            self.assertEqual(
                payload["targets"][0]["paper_route_probe_symbols"], ["AAPL", "AMZN"]
            )
            self.assertFalse(payload["summary"]["promotion_authority"]["allowed"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_paper_route_evidence_uses_external_plan_when_url_configured(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_paper_route_target_plan_url = (
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
            "account_label": "TORGHUT_REPLAY",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
            "window_start": "2026-05-22T13:30:00+00:00",
            "window_end": "2026-05-22T20:00:00+00:00",
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        live_gate = {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        **target,
                        "paper_route_probe_symbols": ["AAPL", "AMZN", "INTC"],
                    }
                ],
            },
        }
        proof_floor = {
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "63180",
                    "eligible_symbol_count": 2,
                    "eligible_symbols": ["AAPL", "AMZN"],
                    "active_symbols": [],
                    "blocking_reasons": ["market_session_closed"],
                },
            }
        }
        external_plan = {
            "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
            "target_count": 1,
            "skipped_target_count": 0,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "targets": [{**target, "paper_route_probe_symbols": ["AAPL", "AMZN"]}],
        }
        try:
            if hasattr(app.state, "trading_scheduler"):
                del app.state.trading_scheduler
            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value=proof_floor,
                ),
                patch(
                    "app.main._load_external_paper_route_target_plan",
                    return_value=external_plan,
                ) as external_loader,
            ):
                response = self.client.get("/trading/paper-route-evidence")
            self.assertEqual(response.status_code, 200)
            external_loader.assert_called_once()
            payload = response.json()
            self.assertEqual(payload["summary"]["target_count"], 1)
            self.assertEqual(
                payload["live_submission_gate"][
                    "runtime_ledger_paper_probation_import_plan"
                ]["target_count"],
                1,
            )
            self.assertEqual(
                payload["live_submission_gate"]["paper_route_target_plan_source"],
                "external_target_plan_url",
            )
            self.assertEqual(
                payload["targets"][0]["target"]["candidate_id"],
                "c88421d619759b2cfaa6f4d0",
            )
            next_plan = payload["next_paper_route_runtime_window_targets"]
            self.assertEqual(next_plan["target_count"], 1)
            next_target = next_plan["targets"][0]
            self.assertEqual(next_target["hypothesis_id"], "H-PAIRS-01")
            self.assertEqual(next_target["candidate_id"], "c88421d619759b2cfaa6f4d0")
            self.assertEqual(next_target["source_dsn_env"], "SIM_DB_DSN")
            self.assertEqual(next_target["target_dsn_env"], "SIM_DB_DSN")
            self.assertEqual(
                next_target["source_kind"], "paper_route_probe_runtime_observed"
            )
            self.assertEqual(next_target["paper_route_probe_symbols"], ["AAPL", "AMZN"])
            self.assertEqual(next_target["max_notional"], "0")
            self.assertFalse(next_target["promotion_allowed"])
            self.assertFalse(next_target["final_promotion_allowed"])
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_paper_route_evidence_releases_db_session_before_external_plan_fetch(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_paper_route_target_plan_url = (
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )
        active_sessions = 0

        class TrackingSession:
            def __enter__(self) -> "TrackingSession":
                nonlocal active_sessions
                active_sessions += 1
                return self

            def __exit__(self, *args: object) -> None:
                nonlocal active_sessions
                active_sessions -= 1

        def _load_external_without_held_session() -> dict[str, object]:
            self.assertEqual(active_sessions, 0)
            return {
                "targets": [
                    {
                        "candidate_id": "fresh-authoritative",
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ]
            }

        try:
            app.state.trading_scheduler = SimpleNamespace(
                state=SimpleNamespace(market_session_open=False),
                llm_status=lambda: {"dspy_runtime": {}},
                market_context_status=lambda: {},
            )
            with (
                patch("app.main.SessionLocal", return_value=TrackingSession()),
                patch("app.main._empirical_jobs_status", return_value={}),
                patch("app.main.load_quant_evidence_status", return_value={}),
                patch("app.main._load_tca_summary", return_value={}),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=({}, {}, {}),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value={
                        "allowed": False,
                        "runtime_ledger_paper_probation_import_plan": {"targets": []},
                    },
                ),
                patch(
                    "app.main._load_external_paper_route_target_plan",
                    side_effect=_load_external_without_held_session,
                ),
                patch("app.main._build_simple_lane_status_payload", return_value={}),
                patch(
                    "app.main._paper_route_probe_book_from_target_plan",
                    return_value={},
                ),
                patch(
                    "app.main.build_paper_route_evidence_audit",
                    return_value={
                        "schema_version": "torghut.paper-route-evidence.v1",
                        "summary": {"target_count": 1},
                    },
                ),
            ):
                response = self.client.get("/trading/paper-route-evidence")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(active_sessions, 0)
            self.assertEqual(response.json()["summary"]["target_count"], 1)
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_paper_route_evidence_enables_sim_target_account_audit(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_mode = settings.trading_mode
        settings.trading_mode = "live"
        settings.trading_paper_route_target_plan_url = ""
        live_gate = {
            "allowed": False,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "candidate_id": "sim-runtime-target",
                        "account_label": "TORGHUT_SIM",
                        "target_dsn_env": "SIM_DB_DSN",
                        "source_dsn_env": "SIM_DB_DSN",
                        "observed_stage": "paper",
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            },
        }

        try:
            app.state.trading_scheduler = SimpleNamespace(
                state=SimpleNamespace(market_session_open=False),
                llm_status=lambda: {"dspy_runtime": {}},
                market_context_status=lambda: {},
            )
            with (
                patch("app.main._empirical_jobs_status", return_value={}),
                patch("app.main.load_quant_evidence_status", return_value={}),
                patch("app.main._load_tca_summary", return_value={}),
                patch(
                    "app.main._build_hypothesis_runtime_payload",
                    return_value=({}, {}, {}),
                ),
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch("app.main._build_simple_lane_status_payload", return_value={}),
                patch(
                    "app.main._paper_route_probe_book_from_target_plan",
                    return_value={},
                ),
                patch(
                    "app.main.build_paper_route_evidence_audit",
                    return_value={
                        "schema_version": "torghut.paper-route-evidence.v1",
                        "summary": {"target_count": 1},
                    },
                ) as audit_builder,
            ):
                response = self.client.get("/trading/paper-route-evidence")

            self.assertEqual(response.status_code, 200)
            self.assertTrue(
                audit_builder.call_args.kwargs["target_account_audit_available"]
            )
        finally:
            settings.trading_mode = original_mode
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_paper_route_target_plan_enables_sim_target_account_audit(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_mode = settings.trading_mode
        settings.trading_mode = "live"
        settings.trading_paper_route_target_plan_url = ""
        live_gate = {
            "allowed": False,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "candidate_id": "sim-runtime-target",
                        "account_label": "TORGHUT_SIM",
                        "target_dsn_env": "SIM_DB_DSN",
                        "source_dsn_env": "SIM_DB_DSN",
                        "observed_stage": "paper",
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            },
        }

        try:
            app.state.trading_scheduler = SimpleNamespace(
                state=SimpleNamespace(market_session_open=False),
                _last_live_submission_gate=live_gate,
            )
            with (
                patch(
                    "app.main._paper_route_cached_live_submission_gate",
                    return_value=live_gate,
                ),
                patch("app.main._build_simple_lane_status_payload", return_value={}),
                patch(
                    "app.main._paper_route_probe_book_from_target_plan",
                    return_value={},
                ),
                patch(
                    "app.main.build_paper_route_target_plan_payload",
                    return_value={
                        "schema_version": "torghut.paper-route-target-plan.v1",
                        "target_count": 1,
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "targets": [{"candidate_id": "sim-runtime-target"}],
                    },
                ) as target_plan_builder,
            ):
                response = self.client.get("/trading/paper-route-target-plan")

            self.assertEqual(response.status_code, 200)
            self.assertTrue(
                target_plan_builder.call_args.kwargs["target_account_audit_available"]
            )
        finally:
            settings.trading_mode = original_mode
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_target_account_audit_stays_disabled_for_non_sim_target(self) -> None:
        original_mode = settings.trading_mode
        try:
            settings.trading_mode = "disabled"
            self.assertFalse(
                main_module._paper_route_target_account_audit_available({})
            )

            settings.trading_mode = "live"
            self.assertFalse(
                main_module._paper_route_target_account_audit_available({})
            )

            self.assertFalse(
                main_module._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "targets": [
                                {
                                    "account_label": "PA3SX7FYNUTF",
                                    "target_dsn_env": "LIVE_DB_DSN",
                                    "source_dsn_env": "LIVE_DB_DSN",
                                    "observed_stage": "live",
                                }
                            ]
                        }
                    }
                )
            )

            self.assertFalse(
                main_module._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "targets": [
                                {
                                    "account_label": "PA3SX7FYNUTF",
                                    "target_dsn_env": "LIVE_DB_DSN",
                                    "source_dsn_env": "LIVE_DB_DSN",
                                    "observed_stage": "paper",
                                }
                            ]
                        }
                    }
                )
            )

            self.assertTrue(
                main_module._paper_route_target_account_audit_available(
                    {
                        "runtime_ledger_paper_probation_import_plan": {
                            "account_label": "TORGHUT_SIM",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_dsn_env": "SIM_DB_DSN",
                            "observed_stage": "paper",
                            "targets": [],
                        }
                    }
                )
            )
        finally:
            settings.trading_mode = original_mode

    def test_paper_route_target_plan_releases_db_session_before_external_plan_fetch(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_paper_route_target_plan_url = (
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )
        active_sessions = 0
        cached_gate = {
            "allowed": False,
            "runtime_ledger_paper_probation_import_plan": {
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [
                    {
                        "candidate_id": "cached-authoritative",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ],
            },
        }

        class TrackingSession:
            def __enter__(self) -> "TrackingSession":
                nonlocal active_sessions
                active_sessions += 1
                return self

            def __exit__(self, *args: object) -> None:
                nonlocal active_sessions
                active_sessions -= 1

        def _load_external_without_held_session() -> dict[str, object]:
            self.assertEqual(active_sessions, 0)
            return {
                "targets": [
                    {
                        "candidate_id": "fresh-authoritative",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                ]
            }

        try:
            app.state.trading_scheduler = SimpleNamespace(
                state=SimpleNamespace(market_session_open=False),
                _last_live_submission_gate=cached_gate,
            )
            with (
                patch("app.main.SessionLocal", return_value=TrackingSession()),
                patch(
                    "app.main._load_external_paper_route_target_plan",
                    side_effect=_load_external_without_held_session,
                ),
                patch("app.main._build_simple_lane_status_payload", return_value={}),
                patch(
                    "app.main._paper_route_probe_book_from_target_plan",
                    return_value={},
                ),
                patch(
                    "app.main.build_paper_route_target_plan_payload",
                    return_value={
                        "schema_version": "torghut.paper-route-target-plan.v1",
                        "target_count": 1,
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "targets": [{"candidate_id": "fresh-authoritative"}],
                    },
                ),
            ):
                response = self.client.get("/trading/paper-route-target-plan")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(active_sessions, 0)
            self.assertEqual(response.json()["target_count"], 1)
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_paper_route_evidence_resolves_target_plan_strategy_universe(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_paper_route_target_plan_url = ""
        strategy_symbols = [
            "NVDA",
            "AAPL",
            "AMZN",
            "GOOGL",
            "AVGO",
            "AMD",
            "ORCL",
            "INTC",
        ]
        target = {
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "observed_stage": "paper",
            "strategy_family": "intraday_tsmom",
            "strategy_name": "intraday-tsmom-profit-v3",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "strategy_lookup_names": [
                "intraday-tsmom-profit-v3",
                "intraday-tsmom-v2",
            ],
            "account_label": "TORGHUT_REPLAY",
            "source_kind": "runtime_ledger_paper_probation_candidates",
            "source_manifest_ref": ("config/trading/hypotheses/h-tsmom-liq-01.json"),
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "window_start": "2026-05-22T13:30:00+00:00",
            "window_end": "2026-05-22T20:00:00+00:00",
            "paper_route_probe_next_session_max_notional": "75000",
            "paper_probation_authorized": True,
            "source_collection_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        live_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [target],
            },
        }
        with self.session_local() as session:
            session.add(
                Strategy(
                    name="intraday-tsmom-profit-v3",
                    description="tsmom runtime strategy",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=strategy_symbols,
                )
            )
            session.commit()
        try:
            if hasattr(app.state, "trading_scheduler"):
                del app.state.trading_scheduler
            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_simple_lane_status_payload",
                    return_value={
                        "paper_route_probe_enabled": True,
                        "paper_route_probe_max_notional": "75000",
                    },
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    side_effect=AssertionError(
                        "target-plan strategy universe should avoid proof-floor fallback"
                    ),
                ),
            ):
                response = self.client.get("/trading/paper-route-evidence")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(
                payload["paper_route_probe"]["eligible_symbols"], strategy_symbols
            )
            next_target = payload["next_paper_route_runtime_window_targets"]["targets"][
                0
            ]
            self.assertEqual(next_target["paper_route_probe_symbols"], strategy_symbols)
            self.assertEqual(
                next_target["paper_route_probe_strategy_universe_symbols"],
                strategy_symbols,
            )
            self.assertEqual(
                next_target["paper_route_probe_missing_strategy_universe_symbols"], []
            )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_paper_route_target_plan_from_payload_prefers_next_window_targets(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "live_submission_gate": {
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-OLD",
                                "candidate_id": "stale-probation-target",
                            }
                        ],
                    }
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "c88421d619759b2cfaa6f4d0",
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "c88421d619759b2cfaa6f4d0")

    def test_paper_route_target_plan_payload_prefers_selected_top_level_targets(
        self,
    ) -> None:
        selected_tsmom_target = {
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "strategy_name": "intraday-tsmom-profit-v3",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "source_kind": "runtime_ledger_source_collection_candidate",
            "selected_by": "paper_route_observed_strategy_source_collection",
        }
        raw_contaminated_hpairs_target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_kind": "paper_route_probe_runtime_observed",
            "selected_by": "paper_route_evidence_audit",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_account_contamination_state": {
                "foreign_strategy_counts": {"intraday-tsmom-profit-v3": 26}
            },
        }

        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "source": "paper_route_target_plan_endpoint",
                "purpose": "observed_strategy_runtime_ledger_source_collection_import",
                "target_count": 1,
                "targets": [selected_tsmom_target],
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "source": "paper_route_observed_strategy_source_collection",
                    "target_count": 1,
                    "targets": [selected_tsmom_target],
                },
                "source_runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "source": "paper_route_observed_strategy_source_collection",
                    "target_count": 1,
                    "targets": [selected_tsmom_target],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": (
                        "torghut.next-paper-route-runtime-window-targets.v1"
                    ),
                    "source": "paper_route_evidence_audit",
                    "target_count": 1,
                    "targets": [raw_contaminated_hpairs_target],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "ca4e6e3c7d639e3363dc5860")
        self.assertEqual(
            plan["targets"][0]["selected_by"],
            "paper_route_observed_strategy_source_collection",
        )
        self.assertNotIn("paper_route_probe_symbols", plan["targets"][0])

    def test_paper_route_target_plan_payload_prefers_next_window_over_closed_import(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "closed-window-target",
                            "window_start": "2026-05-29T13:30:00+00:00",
                            "window_end": "2026-05-29T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "next_paper_route_runtime_window_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "next-window-target",
                            "window_start": "2026-06-01T13:30:00+00:00",
                            "window_end": "2026-06-01T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "next-window-target")
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-06-01T13:30:00+00:00"
        )

    def test_paper_route_target_plan_from_payload_prefers_clean_after_discard(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "next_clean_paper_route_runtime_window_targets_after_discard": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "next_clean_session_paper_route_runtime_window_collection_after_discard",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "clean-followup-target",
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "contaminated-closed-target",
                            "window_start": "2026-06-01T13:30:00+00:00",
                            "window_end": "2026-06-01T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "clean-followup-target")
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-06-02T13:30:00+00:00"
        )

    def test_paper_route_target_plan_from_payload_falls_back_to_source_plan(
        self,
    ) -> None:
        plan = _paper_route_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
                "source_runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-source-scope",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 0,
                    "targets": [],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "candidate-source-scope")

    def test_paper_route_target_plan_from_payload_requires_targets(self) -> None:
        self.assertEqual(
            _paper_route_target_plan_from_payload(
                {
                    "runtime_window_import_plan": {
                        "target_count": 1,
                    },
                    "runtime_ledger_paper_probation_import_plan": {
                        "targets": "not-a-target-list",
                    },
                }
            ),
            {},
        )

    def test_fetch_paper_route_target_plan_url_rejects_invalid_url(self) -> None:
        self.assertEqual(
            _fetch_paper_route_target_plan_url(
                "file:///tmp/plan.json",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_scheme:file"},
        )
        self.assertEqual(
            _fetch_paper_route_target_plan_url(
                "http:///missing-host",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_host"},
        )

    def test_fetch_paper_route_target_plan_url_validates_response(self) -> None:
        class FakeResponse:
            def __init__(self, status: int, raw: bytes) -> None:
                self.status = status
                self._raw = raw

            def read(self, size: int) -> bytes:
                self.read_size = size
                return self._raw

        def connection_class(status: int, raw: bytes) -> type[Any]:
            class FakeConnection:
                instances: list["FakeConnection"] = []

                def __init__(
                    self,
                    hostname: str,
                    port: int | None,
                    *,
                    timeout: float,
                ) -> None:
                    self.hostname = hostname
                    self.port = port
                    self.timeout = timeout
                    self.request_path: str | None = None
                    self.closed = False
                    self.instances.append(self)

                def request(
                    self,
                    method: str,
                    path: str,
                    *,
                    headers: dict[str, str],
                ) -> None:
                    self.request_method = method
                    self.request_path = path
                    self.request_headers = headers

                def getresponse(self) -> FakeResponse:
                    return FakeResponse(status, raw)

                def close(self) -> None:
                    self.closed = True

            return FakeConnection

        http_error_connection = connection_class(503, b"{}")
        with patch("app.main.HTTPConnection", http_error_connection):
            self.assertEqual(
                _fetch_paper_route_target_plan_url(
                    "http://torghut.example/plan?mode=paper",
                    timeout_seconds=0,
                ),
                {"load_error": "paper_route_target_plan_http_status:503"},
            )
        self.assertEqual(http_error_connection.instances[0].hostname, "torghut.example")
        self.assertEqual(
            http_error_connection.instances[0].request_path, "/plan?mode=paper"
        )
        self.assertEqual(
            http_error_connection.instances[0].request_headers["Host"],
            "torghut.example",
        )
        self.assertEqual(
            http_error_connection.instances[0].request_headers["Connection"], "close"
        )
        self.assertEqual(http_error_connection.instances[0].timeout, 0.1)
        self.assertTrue(http_error_connection.instances[0].closed)

        retried_error_connection = connection_class(503, b"{}")
        with (
            patch("app.main.HTTPConnection", retried_error_connection),
            patch("app.main.time.sleep") as sleep,
        ):
            failed_retry = _fetch_paper_route_target_plan_url(
                "http://torghut.example",
                timeout_seconds=1,
                attempts=2,
                retry_backoff_seconds=0,
            )
        self.assertEqual(
            failed_retry,
            {
                "load_error": "paper_route_target_plan_http_status:503",
                "fetch_attempts": 2,
            },
        )
        sleep.assert_called_once_with(0.0)
        self.assertEqual(len(retried_error_connection.instances), 2)

        class FlakyConnection:
            instances: list["FlakyConnection"] = []
            responses = [
                FakeResponse(503, b"{}"),
                FakeResponse(
                    200,
                    json.dumps(
                        {
                            "runtime_window_import_plan": {
                                "targets": [
                                    {
                                        "candidate_id": "retry-candidate",
                                        "paper_route_probe_symbols": ["AAPL"],
                                    }
                                ]
                            }
                        }
                    ).encode("utf-8"),
                ),
            ]

            def __init__(
                self,
                hostname: str,
                port: int | None,
                *,
                timeout: float,
            ) -> None:
                self.hostname = hostname
                self.port = port
                self.timeout = timeout
                self.closed = False
                self.instances.append(self)

            def request(
                self,
                method: str,
                path: str,
                *,
                headers: dict[str, str],
            ) -> None:
                self.request_method = method
                self.request_path = path
                self.request_headers = headers

            def getresponse(self) -> FakeResponse:
                return self.responses[len(self.instances) - 1]

            def close(self) -> None:
                self.closed = True

        FlakyConnection.instances = []
        with patch("app.main.HTTPConnection", FlakyConnection):
            app_retried_plan = _fetch_paper_route_target_plan_url(
                "http://torghut.example",
                timeout_seconds=1,
                attempts=2,
                retry_backoff_seconds=0,
            )
        self.assertEqual(app_retried_plan["fetch_attempts"], 2)
        self.assertEqual(
            app_retried_plan["targets"][0]["candidate_id"], "retry-candidate"
        )
        self.assertEqual(len(FlakyConnection.instances), 2)

        FlakyConnection.instances = []
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            FlakyConnection,
        ):
            retried_plan = shared_fetch_paper_route_target_plan_url(
                "http://torghut.example",
                timeout_seconds=1,
                attempts=2,
                retry_backoff_seconds=0,
            )
        self.assertEqual(retried_plan["fetch_attempts"], 2)
        self.assertEqual(
            paper_route_target_plan_probe_symbols(retried_plan),
            {"AAPL"},
        )
        self.assertEqual(len(FlakyConnection.instances), 2)
        self.assertTrue(all(item.closed for item in FlakyConnection.instances))

        for raw, expected in (
            (b"{", "paper_route_target_plan_invalid_json:"),
            (b"[]", "paper_route_target_plan_invalid_payload"),
            (
                json.dumps({"runtime_window_import_plan": {"targets": []}}).encode(
                    "utf-8"
                ),
                "paper_route_target_plan_missing",
            ),
            (b"x" * 5_000_001, "paper_route_target_plan_response_too_large"),
        ):
            fake_connection = connection_class(200, raw)
            with patch("app.main.HTTPConnection", fake_connection):
                result = _fetch_paper_route_target_plan_url(
                    "http://torghut.example",
                    timeout_seconds=1,
                )
            self.assertTrue(str(result["load_error"]).startswith(expected))

        success_connection = connection_class(
            200,
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                            }
                        ]
                    }
                }
            ).encode("utf-8"),
        )
        with patch("app.main.HTTPConnection", success_connection):
            plan = _fetch_paper_route_target_plan_url(
                "http://torghut.example",
                timeout_seconds=3,
            )
        self.assertEqual(plan["source"], "external_paper_route_target_plan")
        self.assertEqual(plan["targets"][0]["candidate_id"], "c88421d619759b2cfaa6f4d0")

    def test_shared_paper_route_target_plan_helpers_validate_response(self) -> None:
        class FakeResponse:
            def __init__(self, status: int, raw: bytes) -> None:
                self.status = status
                self._raw = raw

            def read(self, size: int) -> bytes:
                self.read_size = size
                return self._raw

        def connection_class(status: int, raw: bytes) -> type[Any]:
            class FakeConnection:
                instances: list["FakeConnection"] = []

                def __init__(
                    self,
                    hostname: str,
                    port: int | None,
                    *,
                    timeout: float,
                ) -> None:
                    self.hostname = hostname
                    self.port = port
                    self.timeout = timeout
                    self.request_path: str | None = None
                    self.closed = False
                    self.instances.append(self)

                def request(
                    self,
                    method: str,
                    path: str,
                    *,
                    headers: dict[str, str],
                ) -> None:
                    self.request_method = method
                    self.request_path = path
                    self.request_headers = headers

                def getresponse(self) -> FakeResponse:
                    return FakeResponse(status, raw)

                def close(self) -> None:
                    self.closed = True

            return FakeConnection

        self.assertEqual(
            shared_fetch_paper_route_target_plan_url(
                "file:///tmp/plan.json",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_scheme:file"},
        )
        self.assertEqual(
            shared_fetch_paper_route_target_plan_url(
                "http:///missing-host",
                timeout_seconds=1,
            ),
            {"load_error": "paper_route_target_plan_invalid_host"},
        )

        http_error_connection = connection_class(503, b"{}")
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            http_error_connection,
        ):
            self.assertEqual(
                shared_fetch_paper_route_target_plan_url(
                    "http://torghut.example/plan?mode=paper",
                    timeout_seconds=0,
                ),
                {"load_error": "paper_route_target_plan_http_status:503"},
            )
        self.assertEqual(http_error_connection.instances[0].hostname, "torghut.example")
        self.assertEqual(
            http_error_connection.instances[0].request_path, "/plan?mode=paper"
        )
        self.assertEqual(
            http_error_connection.instances[0].request_headers["Host"],
            "torghut.example",
        )
        self.assertEqual(
            http_error_connection.instances[0].request_headers["Connection"], "close"
        )
        self.assertEqual(http_error_connection.instances[0].timeout, 0.1)
        self.assertTrue(http_error_connection.instances[0].closed)

        retry_exhausted_connection = connection_class(503, b"{}")
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            retry_exhausted_connection,
        ):
            self.assertEqual(
                shared_fetch_paper_route_target_plan_url(
                    "http://torghut.example/plan?mode=paper",
                    timeout_seconds=0,
                    attempts=2,
                    retry_backoff_seconds=0,
                ),
                {
                    "load_error": "paper_route_target_plan_http_status:503",
                    "fetch_attempts": 2,
                },
            )
        self.assertEqual(len(retry_exhausted_connection.instances), 2)
        self.assertTrue(
            all(item.closed for item in retry_exhausted_connection.instances)
        )

        for raw, expected in (
            (b"{", "paper_route_target_plan_invalid_json:"),
            (b"[]", "paper_route_target_plan_invalid_payload"),
            (
                json.dumps({"runtime_window_import_plan": {"targets": []}}).encode(
                    "utf-8"
                ),
                "paper_route_target_plan_missing",
            ),
            (b"x" * 5_000_001, "paper_route_target_plan_response_too_large"),
        ):
            fake_connection = connection_class(200, raw)
            with patch(
                "app.trading.paper_route_target_plan.HTTPConnection",
                fake_connection,
            ):
                result = shared_fetch_paper_route_target_plan_url(
                    "http://torghut.example",
                    timeout_seconds=1,
                )
            self.assertTrue(str(result["load_error"]).startswith(expected))

        success_connection = connection_class(
            200,
            json.dumps(
                {
                    "runtime_window_import_plan": {
                        "targets": [
                            {
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                                "paper_route_probe_symbols": " aapl, AMZN ",
                            },
                            {
                                "candidate_id": "other",
                                "paper_route_probe_symbols": [],
                            },
                            {
                                "candidate_id": "missing-symbols",
                            },
                        ]
                    }
                }
            ).encode("utf-8"),
        )
        with patch(
            "app.trading.paper_route_target_plan.HTTPConnection",
            success_connection,
        ):
            plan = shared_fetch_paper_route_target_plan_url(
                "http://torghut.example",
                timeout_seconds=3,
            )
        self.assertEqual(plan["source"], "external_paper_route_target_plan")
        self.assertEqual(
            paper_route_target_plan_probe_symbols(plan),
            {"AAPL", "AMZN"},
        )

    def test_load_external_paper_route_target_plan_uses_configured_url(self) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_timeout = settings.trading_paper_route_target_plan_timeout_seconds
        try:
            settings.trading_paper_route_target_plan_url = "  "
            self.assertEqual(_load_external_paper_route_target_plan(), {})

            settings.trading_paper_route_target_plan_url = "http://torghut.example/plan"
            settings.trading_paper_route_target_plan_timeout_seconds = 7
            with patch(
                "app.main._fetch_paper_route_target_plan_url",
                return_value={"targets": [{"candidate_id": "candidate"}]},
            ) as fetch:
                plan = _load_external_paper_route_target_plan()
            self.assertEqual(plan["targets"][0]["candidate_id"], "candidate")
            fetch.assert_called_once_with(
                "http://torghut.example/plan",
                timeout_seconds=7,
                attempts=3,
                retry_backoff_seconds=0.25,
            )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            settings.trading_paper_route_target_plan_timeout_seconds = original_timeout

    def test_load_external_paper_route_target_plan_rejects_self_reference(self) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_cache = main_module._paper_route_target_plan_success_cache
        main_module._paper_route_target_plan_success_cache = None
        try:
            settings.trading_paper_route_target_plan_url = "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan"
            with patch("app.main.HTTPConnection") as connection:
                plan = _load_external_paper_route_target_plan()
            connection.assert_not_called()
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            main_module._paper_route_target_plan_success_cache = original_cache

        self.assertEqual(plan["load_error"], "paper_route_target_plan_self_reference")

    def test_paper_route_target_plan_self_reference_requires_host(self) -> None:
        parsed = urlsplit("/trading/paper-route-target-plan")

        self.assertFalse(
            main_module._paper_route_target_plan_url_points_to_self(parsed)
        )

    def test_paper_route_target_plan_self_reference_matches_current_service(
        self,
    ) -> None:
        parsed = urlsplit(
            "http://route-sim.proof-ns.svc.cluster.local/trading/paper-route-target-plan"
        )

        with patch.dict(
            os.environ,
            {
                "K_SERVICE": "route-sim",
                "POD_NAMESPACE": "proof-ns",
            },
        ):
            self.assertTrue(
                main_module._paper_route_target_plan_url_points_to_self(parsed)
            )

    def test_load_external_paper_route_target_plan_uses_recent_success_after_timeout(
        self,
    ) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_timeout = settings.trading_paper_route_target_plan_timeout_seconds
        original_cache = main_module._paper_route_target_plan_success_cache
        settings.trading_paper_route_target_plan_url = "http://torghut.example/plan"
        settings.trading_paper_route_target_plan_timeout_seconds = 7
        main_module._paper_route_target_plan_success_cache = None
        success_plan = {
            "source": "external_paper_route_target_plan",
            "targets": [
                {
                    "candidate_id": "candidate-stale-safe",
                    "paper_route_probe_symbols": ["AAPL", "AMZN"],
                }
            ],
        }
        try:
            with (
                patch(
                    "app.main._fetch_paper_route_target_plan_url",
                    side_effect=[
                        success_plan,
                        {
                            "load_error": (
                                "paper_route_target_plan_fetch_failed:timed out"
                            )
                        },
                    ],
                ),
                patch(
                    "app.main.time.time",
                    side_effect=[1000.0, 1005.0, 1005.0, 1005.0],
                ),
            ):
                first_plan = _load_external_paper_route_target_plan()
                second_plan = _load_external_paper_route_target_plan()
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            settings.trading_paper_route_target_plan_timeout_seconds = original_timeout
            main_module._paper_route_target_plan_success_cache = original_cache

        self.assertEqual(
            first_plan["targets"][0]["candidate_id"],
            "candidate-stale-safe",
        )
        self.assertEqual(
            second_plan["paper_route_target_plan_cache_status"], "stale_success"
        )
        self.assertEqual(
            second_plan["paper_route_target_plan_last_load_error"],
            "paper_route_target_plan_fetch_failed:timed out",
        )
        self.assertEqual(
            second_plan["targets"][0]["candidate_id"],
            "candidate-stale-safe",
        )

    def test_external_paper_route_target_plan_cache_fails_closed_when_unusable(
        self,
    ) -> None:
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        original_cache = main_module._paper_route_target_plan_success_cache
        settings.trading_paper_route_target_plan_url = "http://torghut.example/plan"
        main_module._paper_route_target_plan_success_cache = None
        try:
            with patch(
                "app.main._fetch_paper_route_target_plan_url",
                return_value={
                    "load_error": "paper_route_target_plan_fetch_failed:timed out"
                },
            ):
                plan = _load_external_paper_route_target_plan()
            self.assertEqual(
                plan["load_error"],
                "paper_route_target_plan_fetch_failed:timed out",
            )

            main_module._paper_route_target_plan_success_cache = ("sentinel", 1000.0)
            main_module._remember_external_paper_route_target_plan_success(
                {"targets": []}
            )
            self.assertEqual(
                main_module._paper_route_target_plan_success_cache,
                ("sentinel", 1000.0),
            )

            main_module._paper_route_target_plan_success_cache = None
            self.assertEqual(
                main_module._cached_external_paper_route_target_plan_success(
                    "paper_route_target_plan_fetch_failed:missing"
                ),
                {},
            )

            main_module._paper_route_target_plan_success_cache = (
                {"targets": [{"candidate_id": "expired"}]},
                1000.0,
            )
            with patch("app.main.time.time", return_value=2000.0):
                self.assertEqual(
                    main_module._cached_external_paper_route_target_plan_success(
                        "paper_route_target_plan_fetch_failed:expired"
                    ),
                    {},
                )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            main_module._paper_route_target_plan_success_cache = original_cache

    def test_merge_external_paper_route_target_plan_fails_closed(self) -> None:
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "targets": [{"candidate_id": "local"}],
            }
        }
        with patch(
            "app.main._load_external_paper_route_target_plan"
        ) as external_loader:
            self.assertEqual(
                _merge_external_paper_route_target_plan(local_gate), local_gate
            )
        external_loader.assert_not_called()

        with patch("app.main._load_external_paper_route_target_plan", return_value={}):
            self.assertEqual(_merge_external_paper_route_target_plan({}), {})

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={},
            ):
                self.assertEqual(
                    _merge_external_paper_route_target_plan(local_gate),
                    local_gate,
                )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={"targets": []},
            ):
                self.assertEqual(
                    _merge_external_paper_route_target_plan(local_gate),
                    local_gate,
                )
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        with patch(
            "app.main._load_external_paper_route_target_plan",
            return_value={"load_error": "paper_route_target_plan_missing"},
        ):
            gate = _merge_external_paper_route_target_plan({})
        self.assertEqual(
            gate["paper_route_target_plan_error"],
            "paper_route_target_plan_missing",
        )

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={"load_error": "paper_route_target_plan_missing"},
            ):
                gate = _merge_external_paper_route_target_plan(local_gate)
            plan = gate["runtime_ledger_paper_probation_import_plan"]
            self.assertEqual(
                gate["paper_route_target_plan_source"], "external_target_plan_url"
            )
            self.assertEqual(
                gate["paper_route_target_plan_error"],
                "paper_route_target_plan_missing",
            )
            self.assertEqual(plan["target_count"], 0)
            self.assertEqual(plan["skipped_target_count"], 1)
            self.assertEqual(plan["targets"], [])
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        safe_local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
                "targets": [
                    {
                        "candidate_id": "safe-local",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL"],
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                        "final_promotion_authorized": False,
                    }
                ],
            }
        }
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={"load_error": "paper_route_target_plan_timeout"},
            ):
                gate = _merge_external_paper_route_target_plan(safe_local_gate)
            plan = gate["runtime_ledger_paper_probation_import_plan"]
            self.assertEqual(
                gate["paper_route_target_plan_error"],
                "paper_route_target_plan_timeout",
            )
            self.assertEqual(
                gate["paper_route_target_plan_source"],
                "local_runtime_ledger_paper_probation_import_plan",
            )
            self.assertEqual(
                gate["paper_route_target_plan_external_source"],
                "external_target_plan_url",
            )
            self.assertEqual(plan["target_count"], 1)
            self.assertEqual(plan["targets"][0]["candidate_id"], "safe-local")
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        original_target_plan_url = settings.trading_paper_route_target_plan_url
        try:
            settings.trading_paper_route_target_plan_url = (
                "http://torghut.example/paper-route-plan"
            )
            with patch(
                "app.main._load_external_paper_route_target_plan",
                return_value={
                    "promotion_allowed": True,
                    "final_promotion_allowed": True,
                    "final_promotion_authorized": True,
                    "targets": [
                        {
                            "candidate_id": "external",
                            "paper_route_probe_symbols": ["AAPL"],
                        }
                    ],
                },
            ):
                gate = _merge_external_paper_route_target_plan(local_gate)
            plan = gate["runtime_ledger_paper_probation_import_plan"]
            self.assertEqual(
                gate["paper_route_target_plan_source"], "external_target_plan_url"
            )
            self.assertEqual(plan["target_count"], 1)
            self.assertEqual(plan["targets"][0]["candidate_id"], "external")
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url

        with patch(
            "app.main._load_external_paper_route_target_plan",
            return_value={
                "paper_route_target_plan_cache_status": "stale_success",
                "paper_route_target_plan_last_load_error": "paper_route_timeout",
                "promotion_allowed": True,
                "final_promotion_allowed": True,
                "final_promotion_authorized": True,
                "targets": [
                    {
                        "candidate_id": "external",
                        "paper_route_probe_symbols": ["AAPL"],
                    }
                ],
            },
        ):
            gate = _merge_external_paper_route_target_plan({})
        plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(
            gate["paper_route_target_plan_source"], "external_target_plan_url"
        )
        self.assertEqual(gate["paper_route_target_plan_cache_status"], "stale_success")
        self.assertEqual(gate["paper_route_target_plan_error"], "paper_route_timeout")
        self.assertFalse(plan["promotion_allowed"])
        self.assertFalse(plan["final_promotion_allowed"])
        self.assertFalse(plan["final_promotion_authorized"])
        self.assertEqual(
            plan["targets"][0]["paper_route_target_plan_source"],
            "external_target_plan_url",
        )
        self.assertEqual(
            plan["targets"][0]["paper_route_probe_scope_authority"],
            "external_target_plan",
        )

    def test_external_paper_route_target_preserves_live_symbol_envelope(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_target_plan_url = settings.trading_paper_route_target_plan_url
        settings.trading_paper_route_target_plan_url = (
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )
        target = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
            "account_label": "TORGHUT_SIM",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
            "window_start": "2026-05-26T13:30:00+00:00",
            "window_end": "2026-05-26T20:00:00+00:00",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "max_notional": "0",
        }
        live_gate = {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "promotion_eligible_total": 0,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 0,
                "skipped_target_count": 0,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "targets": [],
            },
        }
        proof_floor = {
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "63180",
                    "eligible_symbol_count": 3,
                    "eligible_symbols": ["AAPL", "AMZN", "INTC"],
                    "active_symbols": [],
                    "blocking_reasons": ["market_session_closed"],
                },
            }
        }
        external_plan = {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "target_count": 1,
            "skipped_target_count": 0,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "targets": [target],
        }
        try:
            if hasattr(app.state, "trading_scheduler"):
                del app.state.trading_scheduler
            with (
                patch(
                    "app.main._build_live_submission_gate_payload",
                    return_value=live_gate,
                ),
                patch(
                    "app.main._build_profitability_proof_floor_payload",
                    return_value=proof_floor,
                ),
                patch(
                    "app.main._load_external_paper_route_target_plan",
                    return_value=external_plan,
                ),
            ):
                response = self.client.get("/trading/paper-route-evidence")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            probe = payload["paper_route_probe"]
            self.assertEqual(probe["eligible_symbols"], ["AAPL", "AMZN"])
            self.assertEqual(probe["raw_eligible_symbols"], ["AAPL", "AMZN", "INTC"])
            self.assertEqual(probe["out_of_scope_symbols"], ["INTC"])
            self.assertEqual(probe["target_plan_source"], "external_target_plan_url")
            self.assertTrue(probe["target_plan_scope_applied"])
            self.assertEqual(probe["target_plan_scope_symbols"], ["AAPL", "AMZN"])
            next_target = payload["next_paper_route_runtime_window_targets"]["targets"][
                0
            ]
            self.assertEqual(next_target["paper_route_probe_symbols"], ["AAPL", "AMZN"])
            self.assertEqual(
                next_target["paper_route_probe_scope_authority"],
                "external_target_plan",
            )
            next_audit_target = payload["next_runtime_window_target_audits"][0][
                "target"
            ]
            self.assertEqual(
                next_audit_target["paper_route_probe_symbols"], ["AAPL", "AMZN"]
            )
            self.assertNotIn("INTC", next_target["paper_route_probe_symbols"])
            self.assertNotIn("INTC", next_audit_target["paper_route_probe_symbols"])
        finally:
            settings.trading_paper_route_target_plan_url = original_target_plan_url
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_llm_evaluation_endpoint(self) -> None:
        response = self.client.get("/trading/llm-evaluation")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        metrics = payload["metrics"]
        self.assertEqual(metrics["tokens"]["prompt"], 120)
        self.assertEqual(metrics["tokens"]["completion"], 45)
