from __future__ import annotations

from tests.api.trading_api_support import (
    Any,
    TradingApiTestCaseBase,
    TradingScheduler,
    _TRADING_DEPENDENCY_HEALTH_CACHE,
    _check_alpaca,
    _json_truthy_paths_for_keys,
    _mark_static_universe_loaded,
    _readiness_dependency_cache_key,
    app,
    datetime,
    main_module,
    patch,
    settings,
    timedelta,
    timezone,
)


class TestTradingApiReadyzContract(TradingApiTestCaseBase):
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
        "app.api.readiness_helpers_modules.refresh_universe_state_for_readiness._check_account_scope_invariants_bounded",
        return_value={"account_scope_ready": True, "account_scope_errors": []},
    )
    @patch(
        "app.api.readiness_helpers_modules.refresh_universe_state_for_readiness.check_schema_current",
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
                    "app.api.readiness_helpers_modules.shared_context._evaluate_scheduler_status",
                    return_value=(True, {"ok": True, "running": True}),
                ),
                patch(
                    "app.api.readiness_helpers_modules.shared_context._readiness_dependency_snapshot",
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
                    "app.api.readiness_helpers_modules.evaluate_trading_health_payload._evaluate_universe_dependency",
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
        "app.api.health_checks_modules.remember_alpaca_success._alpaca_probe_account",
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
    @patch("app.api.health_checks_modules.remember_alpaca_success.TorghutAlpacaClient")
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
        "app.api.readiness_helpers_modules.refresh_universe_state_for_readiness._evaluate_database_contract",
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
        "app.api.readiness_helpers_modules.refresh_universe_state_for_readiness._evaluate_database_contract",
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
                    "app.api.readiness_helpers_modules.evaluate_trading_health_payload._build_live_submission_gate_payload",
                    return_value=authoritative_gate,
                ),
                patch(
                    "app.api.readiness_helpers_modules.evaluate_trading_health_payload._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.api.readiness_helpers_modules.evaluate_trading_health_payload.load_quant_evidence_status",
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
