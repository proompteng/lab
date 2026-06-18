from __future__ import annotations

from app.api import health_checks as health_checks_api
from app.api import status_helpers as status_helpers_api
from app.api import vnext_helpers as vnext_helpers_api

from tests.api.trading_api_support import (
    Base,
    SQLAlchemyError,
    SimpleNamespace,
    StaticPool,
    TradingApiTestCaseBase,
    TradingScheduler,
    _ALPACA_HEALTH_STATE,
    _FailingOptionsFreshnessSession,
    _FallbackOptionsFreshnessBlankSymbolSession,
    _FallbackOptionsFreshnessRequiresRollbackSession,
    _FallbackOptionsFreshnessSession,
    _OPTIONS_CATALOG_FRESHNESS_CACHE,
    _OptionsFreshnessSession,
    _PostgresReadinessSession,
    _PostgresRuntimeLedgerPortfolioSummarySession,
    _TRADING_DEPENDENCY_HEALTH_CACHE,
    _TimedOutAggregateOptionsFreshnessSession,
    _TimedOutBoundedOptionsFreshnessSession,
    _daily_runtime_ledger_portfolio_summary,
    _forecast_service_status,
    _load_options_catalog_freshness_summary,
    _route_claim_symbols,
    app,
    create_engine,
    datetime,
    forecast_registry,
    patch,
    sessionmaker,
    settings,
    timedelta,
    timezone,
)


class TestTradingApiForecastOptions(TradingApiTestCaseBase):
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
        self._clear_trading_health_surface_cache()
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
            fake_session,
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
            fake_session,
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
            fake_session,
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
            session=fake_session,
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
            "app.api.health_checks.remember_alpaca_success.build_tca_gate_inputs",
            return_value={"order_count": 0},
        ) as build_tca:
            payload = health_checks_api._load_tca_summary(
                fake_session,
                scheduler=None,
            )

        self.assertEqual(payload["order_count"], 0)
        self.assertEqual(fake_session.calls[0], "SET LOCAL statement_timeout = 750")
        build_tca.assert_called_once()

    def test_llm_evaluation_uses_bounded_status_timeout(self) -> None:
        fake_session = _PostgresReadinessSession()

        with patch(
            "app.api.vnext_helpers.build_llm_evaluation_metrics",
            return_value={"ok": True, "metrics": {"total_reviews": 0}},
        ) as build_llm:
            payload = vnext_helpers_api._load_llm_evaluation(
                fake_session,
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

        status_helpers_api._rollback_status_read_session(
            SimpleNamespace(),
            context="missing rollback",
        )
        status_helpers_api._rollback_status_read_session(
            FailingRollbackSession(),
            context="failing rollback",
        )
        status_helpers_api._apply_status_read_statement_timeout(
            SimpleNamespace(),
            milliseconds=500,
        )
        status_helpers_api._apply_status_read_statement_timeout(
            BrokenBindSession(),
            milliseconds=500,
        )
        with self.assertRaises(SQLAlchemyError):
            status_helpers_api._apply_status_read_statement_timeout(
                TimeoutSession(),
                milliseconds=500,
            )

    def test_tca_summary_timeout_returns_unavailable_payload(self) -> None:
        fake_session = _PostgresReadinessSession()

        with patch(
            "app.api.health_checks.remember_alpaca_success.build_tca_gate_inputs",
            side_effect=SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            ),
        ):
            payload = health_checks_api._load_tca_summary(
                fake_session,
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
            "app.api.vnext_helpers.build_llm_evaluation_metrics",
            side_effect=SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            ),
        ):
            payload = vnext_helpers_api._load_llm_evaluation(
                fake_session,
            )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["reason_codes"], ["llm_evaluation_query_timeout"])
        self.assertEqual(fake_session.rollback_count, 1)

    def test_hypothesis_runtime_summary_timeout_is_fail_closed(self) -> None:
        with patch(
            "app.api.health_checks.load_options_catalog_freshness_summary.build_hypothesis_runtime_summary",
            side_effect=SQLAlchemyError(
                "QueryCanceled: canceling statement due to statement timeout"
            ),
        ):
            payload, summary, _quorum = (
                health_checks_api._build_hypothesis_runtime_payload(
                    TradingScheduler(),
                    tca_summary={},
                    market_context_status={},
                    feature_readiness={},
                )
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
            fake_session,
            route_symbols=["AAPL"],
        )
        second = _load_options_catalog_freshness_summary(
            fake_session,
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
            fake_session,
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
            fake_session,
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
            fake_session,
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
            fake_session,
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
            fake_session,
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
            fake_session,
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
                    "app.api.health_checks.shared_context.check_tigerbeetle_protocol_health",
                    return_value={"ok": True, "protocol_ok": True},
                ),
                patch(
                    "app.api.health_checks.shared_context.latest_tigerbeetle_reconciliation_payload",
                    return_value={
                        "ok": True,
                        "age_seconds": 1,
                        "blockers": [],
                    },
                ),
                patch(
                    "app.api.health_checks.shared_context.tigerbeetle_ref_counts",
                    side_effect=SQLAlchemyError(
                        "QueryCanceled: canceling statement due to statement timeout"
                    ),
                ),
            ):
                payload = health_checks_api._build_tigerbeetle_ledger_status(
                    fake_session,
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
                    "app.api.health_checks.shared_context.check_tigerbeetle_protocol_health",
                    return_value={"ok": True, "protocol_ok": True},
                ),
                patch(
                    "app.api.health_checks.shared_context.latest_tigerbeetle_reconciliation_payload",
                    side_effect=SQLAlchemyError(
                        "QueryCanceled: canceling statement due to statement timeout"
                    ),
                ),
                patch(
                    "app.api.health_checks.shared_context.tigerbeetle_ref_counts",
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
                payload = health_checks_api._build_tigerbeetle_ledger_status(
                    fake_session,
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
