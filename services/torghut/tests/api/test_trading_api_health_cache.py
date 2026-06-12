from __future__ import annotations

# ruff: noqa: F403,F405
from tests.api.trading_api_support import *


class TestTradingApiHealthCache(TradingApiTestCaseBase):
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

    def test_trading_health_serves_cached_payload_during_inflight_refresh(
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
        refresh_started = Event()
        release_refresh = Event()

        def _refresh_health_payload() -> tuple[dict[str, object], int]:
            refresh_started.set()
            release_refresh.wait(1.0)
            return (
                {
                    **cached_payload,
                    "reason": "refreshed_health_payload",
                    "reason_codes": ["refreshed_health_payload"],
                },
                503,
            )

        refresh_future = main_module._TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR.submit(
            _refresh_health_payload,
        )
        self.assertTrue(refresh_started.wait(1.0))
        with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()
            main_module._TRADING_HEALTH_SURFACE_EVALUATIONS[cache_key] = refresh_future
            main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE[cache_key] = {
                "payload": cached_payload,
                "status_code": 503,
                "checked_at": datetime.now(timezone.utc),
            }

        try:
            started_at = time.monotonic()
            response = self.client.get("/trading/health")
            elapsed = time.monotonic() - started_at
        finally:
            release_refresh.set()
            refresh_future.result(timeout=1.0)
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertLess(elapsed, 0.5)
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["reason"], "cached_health_payload")
        self.assertNotEqual(payload["reason"], "trading_health_evaluation_timeout")

    def test_trading_health_serves_cached_payload_when_idle_and_refreshes(
        self,
    ) -> None:
        original_timeout = main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
        main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 0.01
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
        refresh_started = Event()
        release_refresh = Event()
        refresh_calls: list[object] = []

        def _refresh_health_payload(
            **_kwargs: object,
        ) -> tuple[dict[str, object], int]:
            refresh_calls.append(_kwargs)
            refresh_started.set()
            release_refresh.wait(1.0)
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
                started_at = time.monotonic()
                response = self.client.get("/trading/health")
                elapsed = time.monotonic() - started_at
                self.assertTrue(refresh_started.wait(1.0))
                self.assertEqual(len(refresh_calls), 1)
        finally:
            release_refresh.set()
            main_module._TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = original_timeout
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                refresh_futures = list(
                    main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.values()
                )
            for refresh_future in refresh_futures:
                refresh_future.result(timeout=1.0)
            with main_module._TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                main_module._TRADING_HEALTH_SURFACE_EVALUATIONS.clear()
                main_module._TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.clear()

        self.assertLess(elapsed, 0.5)
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
        self.assertNotEqual(payload.get("reason"), "trading_health_evaluation_timeout")
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
