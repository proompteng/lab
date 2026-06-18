from __future__ import annotations

from tests.api.trading_api_support import (
    SimpleNamespace,
    TradingApiTestCaseBase,
    TradingScheduler,
    _TRADING_DEPENDENCY_HEALTH_CACHE,
    _install_pipeline_universe_resolver,
    _mark_static_universe_loaded,
    _readiness_dependency_cache_key,
    app,
    datetime,
    patch,
    settings,
    timedelta,
    timezone,
)


class TestTradingApiHealthDependency(TradingApiTestCaseBase):
    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.readiness_helpers.evaluate_trading_health_payload.load_quant_evidence_status"
    )
    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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
        "app.api.readiness_helpers.status_dependencies.build_api_live_submission_gate_payload",
        return_value={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "capital_stage": "live",
        },
    )
    @patch("app.api.readiness_helpers.status_dependencies.empirical_jobs_status")
    @patch(
        "app.api.readiness_helpers.evaluate_trading_health_payload.load_quant_evidence_status"
    )
    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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
                "app.api.readiness_helpers.status_dependencies.build_profitability_proof_floor_payload",
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
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._evaluate_database_contract",
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
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
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
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._evaluate_database_contract",
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
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": False, "detail": "down"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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

    @patch(
        "app.api.health_checks.build_tigerbeetle_ledger_status",
        new=lambda _session: {"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_alpaca_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_clickhouse_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.health_checks.check_postgres_dependency",
        return_value={"ok": True, "detail": "ok"},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
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
