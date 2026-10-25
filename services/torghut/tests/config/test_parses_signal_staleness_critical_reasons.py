from __future__ import annotations

from typing import Any, cast
from urllib.request import Request

from tests.config.support import (
    FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD,
    Path,
    Settings,
    ValidationError,
    _MockFlagResponse,
    _TestConfigBase,
    json,
    patch,
    yaml,
)


class TestParsesSignalStalenessCriticalReasons(_TestConfigBase):
    def test_parses_signal_staleness_critical_reasons(self) -> None:
        settings = Settings(
            TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS="cursor_ahead_of_stream, universe_source_unavailable",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_signal_staleness_alert_critical_reasons,
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )

    def test_default_signal_staleness_critical_reasons_exclude_normal_tail_states(
        self,
    ) -> None:
        settings = Settings(
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut"
        )
        self.assertEqual(
            settings.trading_signal_staleness_alert_critical_reasons,
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )
        self.assertNotIn(
            "no_signals_in_window",
            settings.trading_signal_staleness_alert_critical_reasons,
        )

    def test_parses_market_closed_expected_no_signal_reasons(self) -> None:
        settings = Settings(
            TRADING_SIGNAL_MARKET_CLOSED_EXPECTED_REASONS=(
                "no_signals_in_window, cursor_tail_stable, empty_batch_advanced"
            ),
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_signal_market_closed_expected_reasons,
            {"no_signals_in_window", "cursor_tail_stable", "empty_batch_advanced"},
        )

    def test_allocator_symbol_correlation_groups_are_normalized(self) -> None:
        settings = Settings(
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_ENABLED=False,
            TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS={
                " aapl ": " Tech ",
                "msft": "growth",
            },
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_allocator_symbol_correlation_groups,
            {"AAPL": "tech", "MSFT": "growth"},
        )

    def test_rejects_negative_allocator_strategy_budget(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS={"s1": -1},
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_parses_drift_reason_code_sets(self) -> None:
        settings = Settings(
            TRADING_DRIFT_TRIGGER_RETRAIN_REASON_CODES="a,b",
            TRADING_DRIFT_TRIGGER_RESELECTION_REASON_CODES="c,d",
            TRADING_DRIFT_ROLLBACK_REASON_CODES="x,y",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_drift_trigger_retrain_reason_codes, {"a", "b"}
        )
        self.assertEqual(
            settings.trading_drift_trigger_reselection_reason_codes, {"c", "d"}
        )
        self.assertEqual(settings.trading_drift_rollback_reason_codes, {"x", "y"})

    def test_feature_flags_override_runtime_toggles(self) -> None:
        def _mock_urlopen(
            request: Request,
            _timeout: object,
        ) -> _MockFlagResponse:
            assert request.data is not None
            payload = json.loads(request.data.decode("utf-8"))
            key = payload.get("flagKey")
            values = {
                "torghut_trading_enabled": False,
                "torghut_trading_emergency_stop_enabled": True,
                "torghut_trading_execution_prefer_limit": False,
                "torghut_trading_multi_account_enabled": True,
                "torghut_trading_crypto_enabled": True,
                "torghut_trading_crypto_live_enabled": True,
                "torghut_llm_enabled": False,
                "torghut_llm_adjustment_allowed": True,
            }
            return _MockFlagResponse({"enabled": values.get(key, False)})

        with patch("app.config.common.urlopen", side_effect=_mock_urlopen):
            settings = Settings(
                TRADING_ENABLED=True,
                TRADING_EMERGENCY_STOP_ENABLED=False,
                TRADING_EXECUTION_PREFER_LIMIT=True,
                TRADING_MULTI_ACCOUNT_ENABLED=False,
                TRADING_CRYPTO_ENABLED=False,
                TRADING_CRYPTO_LIVE_ENABLED=False,
                LLM_ENABLED=True,
                LLM_ADJUSTMENT_ALLOWED=False,
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_FEATURE_FLAGS_ENABLED=True,
                TRADING_FEATURE_FLAGS_URL="http://feature-flags.feature-flags.svc.cluster.local:8013/",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

        self.assertFalse(settings.trading_enabled)
        self.assertTrue(settings.trading_emergency_stop_enabled)
        self.assertFalse(settings.trading_execution_prefer_limit)
        self.assertTrue(settings.trading_multi_account_enabled)
        self.assertTrue(settings.trading_crypto_enabled)
        self.assertTrue(settings.trading_crypto_enabled)
        self.assertTrue(settings.trading_crypto_enabled)
        self.assertTrue(settings.trading_crypto_live_enabled)
        self.assertFalse(settings.llm_enabled)
        self.assertTrue(settings.llm_adjustment_allowed)
        self.assertEqual(
            settings.trading_feature_flags_url,
            "http://feature-flags.feature-flags.svc.cluster.local:8013",
        )

    def test_trading_mode_is_canonical_live_state(self) -> None:
        settings = Settings(
            TRADING_MODE="paper",
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_mode, "paper")

    def test_trading_active_rejects_unknown_universe_source(self) -> None:
        settings = Settings(
            TRADING_MODE="paper",
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        settings.trading_enabled = True
        settings.trading_universe_source = cast(Any, "legacy")

        with self.assertRaisesRegex(
            ValueError,
            "TRADING_UNIVERSE_SOURCE must be 'jangar' or 'static'",
        ):
            settings.model_post_init(None)

    def test_feature_flags_use_flipt_evaluate_contract(self) -> None:
        requests: list[dict[str, object]] = []

        def _mock_urlopen(
            request: Request,
            _timeout: object,
        ) -> _MockFlagResponse:
            assert request.data is not None
            requests.append(
                {
                    "url": request.full_url,
                    "payload": json.loads(request.data.decode("utf-8")),
                }
            )
            return _MockFlagResponse({"enabled": None})

        with patch("app.config.common.urlopen", side_effect=_mock_urlopen):
            Settings(
                TRADING_ENABLED=False,
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_FEATURE_FLAGS_ENABLED=True,
                TRADING_FEATURE_FLAGS_URL="http://feature-flags.feature-flags.svc.cluster.local:8013/",
                TRADING_FEATURE_FLAGS_NAMESPACE=" default ",
                TRADING_FEATURE_FLAGS_ENTITY_ID=" torghut ",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

        self.assertTrue(requests)
        for item in requests:
            payload = item["payload"]
            self.assertIsInstance(payload, dict)
            self.assertTrue(str(item["url"]).endswith("/evaluate/v1/boolean"))
            self.assertEqual(payload.get("namespaceKey"), "default")
            self.assertEqual(payload.get("entityId"), "torghut")
            self.assertEqual(payload.get("context"), {})

    def test_feature_flag_failures_fallback_to_env_values(self) -> None:
        with patch("app.config.common.urlopen", side_effect=RuntimeError("network")):
            settings = Settings(
                TRADING_ENABLED=False,
                TRADING_EMERGENCY_STOP_ENABLED=False,
                LLM_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_FEATURE_FLAGS_ENABLED=True,
                TRADING_FEATURE_FLAGS_URL="http://feature-flags.feature-flags.svc.cluster.local:8013",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

        self.assertFalse(settings.trading_enabled)
        self.assertFalse(settings.trading_emergency_stop_enabled)
        self.assertTrue(settings.llm_enabled)

    def test_feature_flag_failures_short_circuit_remaining_remote_lookups(self) -> None:
        call_count = 0

        def _mock_urlopen(_request: Request, _timeout: object) -> _MockFlagResponse:
            nonlocal call_count
            call_count += 1
            raise RuntimeError("network")

        with patch("app.config.common.urlopen", side_effect=_mock_urlopen):
            Settings(
                TRADING_ENABLED=False,
                TRADING_EMERGENCY_STOP_ENABLED=False,
                LLM_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_FEATURE_FLAGS_ENABLED=True,
                TRADING_FEATURE_FLAGS_URL="http://feature-flags.feature-flags.svc.cluster.local:8013",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

        self.assertEqual(call_count, 1)

    def test_feature_flag_invalid_payload_short_circuit_remaining_remote_lookups(
        self,
    ) -> None:
        call_count = 0

        class _Response:
            status = 200

            def __enter__(self) -> "_Response":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

            def read(self) -> bytes:
                return b'{"enabled":"yes"}'

        def _mock_urlopen(_request: Request, _timeout: object) -> _Response:
            nonlocal call_count
            call_count += 1
            return _Response()

        with patch("app.config.common.urlopen", side_effect=_mock_urlopen):
            Settings(
                TRADING_ENABLED=False,
                TRADING_EMERGENCY_STOP_ENABLED=False,
                LLM_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_FEATURE_FLAGS_ENABLED=True,
                TRADING_FEATURE_FLAGS_URL="http://feature-flags.feature-flags.svc.cluster.local:8013",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

        self.assertEqual(call_count, 1)

    def test_feature_flag_map_covers_all_boolean_runtime_gates(self) -> None:
        boolean_fields = {
            name
            for name, field in Settings.model_fields.items()
            if field.annotation is bool
        }
        control_fields = {
            "trading_feature_flags_enabled",
            "log_access_log",
            "trading_mode",
            "trading_lean_backtest_enabled",
            "trading_lean_strategy_shadow_enabled",
            "trading_lean_lane_disable_switch",
            "trading_simple_submit_enabled",
            "trading_live_submit_enabled",
            "trading_simple_order_feed_telemetry_enabled",
            "trading_options_catalog_freshness_exact_route_scope_enabled",
            "trading_scheduler_leadership_required",
            "trading_broker_mutation_recovery_enabled",
            "trading_empirical_jobs_health_required",
            "trading_jangar_quant_health_required",
            "tigerbeetle_enabled",
            "tigerbeetle_required",
            "tigerbeetle_journal_enabled",
            "tigerbeetle_reconcile_required",
            "tigerbeetle_economic_parity_required",
        }
        self.assertEqual(
            set(FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD),
            boolean_fields - control_fields,
        )

    def test_torghut_feature_flag_manifest_matches_config_mapping(self) -> None:
        repo_root = next(
            parent
            for parent in Path(__file__).resolve().parents
            if (
                parent
                / "argocd/applications/feature-flags/gitops/default/features.yaml"
            ).is_file()
        )
        manifest_path = (
            repo_root / "argocd/applications/feature-flags/gitops/default/features.yaml"
        )
        manifest_data = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        self.assertIsInstance(manifest_data, dict)
        flags = manifest_data.get("flags", [])
        self.assertIsInstance(flags, list)
        manifest_keys = {
            flag.get("key")
            for flag in flags
            if isinstance(flag, dict)
            and isinstance(flag.get("key"), str)
            and str(flag.get("key")).startswith("torghut_")
        }
        self.assertEqual(
            set(FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD.values()),
            manifest_keys,
        )

    def test_trading_accounts_registry_falls_back_to_single_account_when_disabled(
        self,
    ) -> None:
        settings = Settings(
            TRADING_MULTI_ACCOUNT_ENABLED=False,
            TRADING_ACCOUNT_LABEL="paper-a",
            TRADING_MODE="paper",
            APCA_API_KEY_ID="key-a",
            APCA_API_SECRET_KEY="secret-a",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        accounts = settings.trading_accounts
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0].label, "paper-a")
        self.assertEqual(accounts[0].api_key, "key-a")

    def test_trading_accounts_registry_parses_enabled_lanes(self) -> None:
        settings = Settings(
            TRADING_MULTI_ACCOUNT_ENABLED=True,
            TRADING_ACCOUNT_LABEL="paper-a",
            TRADING_MODE="paper",
            APCA_API_KEY_ID="fallback-key",
            APCA_API_SECRET_KEY="fallback-secret",
            TRADING_ACCOUNTS_JSON=json.dumps(
                {
                    "accounts": [
                        {
                            "label": "paper-a",
                            "enabled": True,
                            "api_key": "k1",
                            "secret_key": "s1",
                        },
                        {"label": "paper-b", "enabled": False},
                        {"label": "paper-c", "enabled": True},
                    ]
                }
            ),
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        labels = [account.label for account in settings.trading_accounts]
        self.assertEqual(labels, ["paper-a", "paper-c"])
        self.assertEqual(settings.trading_accounts[1].api_key, "fallback-key")

    def test_trading_accounts_registry_deduplicates_labels_in_order(self) -> None:
        settings = Settings(
            TRADING_MULTI_ACCOUNT_ENABLED=True,
            TRADING_ACCOUNT_LABEL="paper-a",
            TRADING_MODE="paper",
            APCA_API_KEY_ID="fallback-key",
            APCA_API_SECRET_KEY="fallback-secret",
            TRADING_ACCOUNTS_JSON=json.dumps(
                {
                    "accounts": [
                        {
                            "label": "paper-b",
                            "enabled": True,
                            "api_key": "primary-key",
                        },
                        {
                            "label": "  paper-b  ",
                            "enabled": True,
                            "api_key": "dupe-key",
                        },
                        {
                            "label": "paper-c",
                            "enabled": True,
                            "api_key": "paper-c-key",
                        },
                    ]
                }
            ),
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        accounts = settings.trading_accounts
        self.assertEqual(
            [account.label for account in accounts], ["paper-b", "paper-c"]
        )
        self.assertEqual(accounts[0].api_key, "primary-key")
