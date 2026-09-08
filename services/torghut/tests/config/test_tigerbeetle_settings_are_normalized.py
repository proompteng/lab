from __future__ import annotations

from tests.config.support import (
    DSPyReviewRuntime,
    Settings,
    ValidationError,
    _TestConfigBase,
    os,
    patch,
)


class TestTigerbeetleSettingsAreNormalized(_TestConfigBase):
    def test_tigerbeetle_settings_are_normalized(self) -> None:
        settings = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_REQUIRED=True,
            TORGHUT_TIGERBEETLE_CLUSTER_ID=2001,
            TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES=" tb-0:3000, tb-1:3000 ",
            TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS=1.5,
            TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS=7.5,
            TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
            TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED=True,
            TORGHUT_TIGERBEETLE_ECONOMIC_PARITY_REQUIRED=True,
        )

        self.assertTrue(settings.tigerbeetle_enabled)
        self.assertTrue(settings.tigerbeetle_required)
        self.assertEqual(settings.tigerbeetle_cluster_id, 2001)
        self.assertEqual(settings.tigerbeetle_replica_addresses, "tb-0:3000,tb-1:3000")
        self.assertEqual(settings.tigerbeetle_health_timeout_seconds, 1.5)
        self.assertEqual(settings.tigerbeetle_rpc_timeout_seconds, 7.5)
        self.assertTrue(settings.tigerbeetle_journal_enabled)
        self.assertTrue(settings.tigerbeetle_reconcile_required)
        self.assertTrue(settings.tigerbeetle_economic_parity_required)

    def test_tigerbeetle_settings_reject_enabled_empty_addresses(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TORGHUT_TIGERBEETLE_ENABLED=True,
                TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES=" , ",
            )

    def test_tigerbeetle_settings_reject_invalid_cluster_id(self) -> None:
        with self.assertRaisesRegex(
            ValidationError, "TORGHUT_TIGERBEETLE_CLUSTER_ID must be > 0"
        ):
            Settings(TORGHUT_TIGERBEETLE_CLUSTER_ID=0)

    def test_economic_parity_requirement_requires_tigerbeetle_enabled(self) -> None:
        with self.assertRaisesRegex(
            ValidationError,
            "TORGHUT_TIGERBEETLE_ENABLED is required when economic parity is required",
        ):
            Settings(TORGHUT_TIGERBEETLE_ECONOMIC_PARITY_REQUIRED=True)

    def test_tigerbeetle_settings_reject_invalid_health_timeout(self) -> None:
        with self.assertRaisesRegex(
            ValidationError,
            "TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS must be > 0",
        ):
            Settings(TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS=0)

    def test_tigerbeetle_settings_reject_invalid_rpc_timeout(self) -> None:
        with self.assertRaisesRegex(
            ValidationError,
            "TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS must be > 0",
        ):
            Settings(TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS=0)

    def test_allows_static_universe_when_trading_enabled(self) -> None:
        settings = Settings(
            TRADING_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_universe_source, "static")

    def test_allows_static_universe_when_simple_pipeline_is_live(self) -> None:
        settings = Settings(
            TRADING_ENABLED=True,
            TRADING_MODE="live",
            TRADING_PIPELINE_MODE="simple",
            TRADING_SIMPLE_SUBMIT_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_pipeline_mode, "simple")
        self.assertEqual(settings.trading_universe_source, "static")

    def test_allows_static_universe_when_trading_and_autonomy_disabled(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_MODE="paper",
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_universe_source, "static")

    def test_trading_mode_accepts_live(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_mode, "live")

    def test_live_submission_requires_emergency_stop_controls(self) -> None:
        with self.assertRaisesRegex(
            ValidationError,
            "TRADING_EMERGENCY_STOP_ENABLED must be true",
        ):
            Settings(
                TRADING_ENABLED=True,
                TRADING_MODE="live",
                TRADING_SIMPLE_SUBMIT_ENABLED=True,
                TRADING_LIVE_SUBMIT_ENABLED=True,
                TRADING_EMERGENCY_STOP_ENABLED=False,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_trading_mode_accepts_paper(self) -> None:
        settings = Settings(
            TRADING_MODE="paper",
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_mode, "paper")

    def test_deprecated_trading_config_aliases_are_not_settings_fields(self) -> None:
        deprecated_fields = {
            "trading_live_enabled",
            "trading_ws_crypto_enabled",
            "trading_universe_crypto_enabled",
            "trading_allocator_correlation_group_notional_caps",
        }
        deprecated_aliases = {
            "TRADING_LIVE_ENABLED",
            "TRADING_WS_CRYPTO_ENABLED",
            "TRADING_UNIVERSE_CRYPTO_ENABLED",
            "TRADING_ALLOCATOR_CORRELATION_GROUP_NOTIONAL_CAPS",
        }

        self.assertTrue(deprecated_fields.isdisjoint(Settings.model_fields))
        aliases = {str(field.alias) for field in Settings.model_fields.values()}
        self.assertTrue(deprecated_aliases.isdisjoint(aliases))

    def test_rejects_strict_veto_with_pass_through_fail_mode(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                LLM_FAIL_MODE="pass_through",
                LLM_FAIL_MODE_ENFORCEMENT="strict_veto",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_hypothesis_registry_and_jangar_quorum_settings_are_normalized(
        self,
    ) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_MODE="paper",
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_HYPOTHESIS_REGISTRY_PATH=" config/trading/hypotheses ",
            TRADING_JANGAR_CONTROL_PLANE_STATUS_URL=" https://jangar.example/status ",
            TRADING_JANGAR_QUANT_HEALTH_URL=" https://jangar.example/api/torghut/trading/control-plane/quant/health ",
            TRADING_JANGAR_QUANT_WINDOW="15m",
            TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS=2.5,
            TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS=30,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(
            settings.trading_hypothesis_registry_path,
            "config/trading/hypotheses",
        )
        self.assertEqual(
            settings.trading_jangar_control_plane_status_url,
            "https://jangar.example/status",
        )
        self.assertEqual(
            settings.trading_jangar_quant_health_url,
            "https://jangar.example/api/torghut/trading/control-plane/quant/health",
        )
        self.assertEqual(settings.trading_jangar_quant_window, "15m")
        self.assertEqual(settings.trading_jangar_control_plane_timeout_seconds, 2.5)
        self.assertEqual(settings.trading_jangar_control_plane_cache_ttl_seconds, 30)

    def test_forecast_registry_settings_are_normalized(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_MODE="paper",
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_FORECAST_REGISTRY_MANIFEST_PATH=" config/forecast/registry.json ",
            TRADING_FORECAST_REGISTRY_MANIFEST_URL=" https://registry.example/forecast.json ",
            TRADING_FORECAST_SERVICE_ALLOWED_MODEL_FAMILIES=" chronos , moment , financial_tsfm ",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(
            settings.trading_forecast_registry_manifest_path,
            "config/forecast/registry.json",
        )
        self.assertEqual(
            settings.trading_forecast_registry_manifest_url,
            "https://registry.example/forecast.json",
        )
        self.assertEqual(
            settings.trading_forecast_service_allowed_model_families,
            {"chronos", "moment", "financial_tsfm"},
        )

    def test_allows_configured_live_pass_through_with_explicit_approval(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_FAIL_MODE="pass_through",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            LLM_FAIL_OPEN_LIVE_APPROVED=True,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(settings.llm_effective_fail_mode(), "pass_through")

    def test_rejects_live_fail_open_without_explicit_approval(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_UNIVERSE_SOURCE="jangar",
                LLM_FAIL_MODE="pass_through",
                LLM_FAIL_MODE_ENFORCEMENT="configured",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_live_fail_open_with_explicit_approval(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_FAIL_MODE="pass_through",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            LLM_FAIL_OPEN_LIVE_APPROVED=True,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(
            settings.llm_effective_fail_mode_for_current_rollout(), "pass_through"
        )

    def test_rejects_stage2_live_fail_open_without_explicit_approval(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_UNIVERSE_SOURCE="jangar",
                LLM_ROLLOUT_STAGE="stage2",
                LLM_FAIL_MODE="veto",
                LLM_FAIL_MODE_ENFORCEMENT="configured",
                LLM_FAIL_OPEN_LIVE_APPROVED=False,
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_rejects_stage1_live_fail_open_without_explicit_approval(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_UNIVERSE_SOURCE="jangar",
                LLM_ROLLOUT_STAGE="stage1",
                LLM_FAIL_MODE="veto",
                LLM_FAIL_MODE_ENFORCEMENT="configured",
                LLM_FAIL_OPEN_LIVE_APPROVED=False,
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_stage1_live_fail_open_with_explicit_approval_is_allowed(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_ROLLOUT_STAGE="stage1_shadow_pilot",
            LLM_FAIL_MODE="veto",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            LLM_FAIL_OPEN_LIVE_APPROVED=True,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(
            settings.llm_effective_fail_mode_for_current_rollout(), "pass_through"
        )

    def test_rejects_dspy_active_mode_without_artifact_hash(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                LLM_DSPY_RUNTIME_MODE="active",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_dspy_shadow_mode_with_artifact_hash(self) -> None:
        settings = Settings(
            LLM_DSPY_RUNTIME_MODE="shadow",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.llm_dspy_runtime_mode, "shadow")
        self.assertEqual(settings.llm_dspy_artifact_hash, "a" * 64)

    def test_live_dspy_runtime_gate_blocks_invalid_hash(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="z" * 64,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_artifact_hash_not_hex", reasons)

    def test_live_dspy_runtime_gate_blocks_bootstrap_artifact_hash(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH=DSPyReviewRuntime.bootstrap_artifact_hash(),
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_bootstrap_artifact_forbidden", reasons)

    def test_allows_live_dspy_runtime_block_pass_through_without_fail_open_approval(
        self,
    ) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            LLM_DSPY_LIVE_RUNTIME_BLOCK_FAIL_MODE="pass_through_reduced_size",
            LLM_FAIL_OPEN_LIVE_APPROVED=False,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.llm_dspy_live_runtime_block_fail_mode,
            "pass_through_reduced_size",
        )

    def test_live_dspy_runtime_gate_blocks_without_jangar_base_url(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_jangar_base_url_missing", reasons)

    def test_live_dspy_runtime_gate_blocks_invalid_jangar_base_url(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="jangar.example",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_jangar_base_url_invalid", reasons)

    def test_live_dspy_runtime_gate_rejects_empty_hostname_jangar_base_url(
        self,
    ) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="http://:80/openai/v1",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_jangar_base_url_invalid", reasons)

    def test_live_dspy_runtime_gate_blocks_jangar_path_with_query_or_fragment(
        self,
    ) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="https://jangar.example/openai/v1/chat/completions?x=1",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_jangar_base_url_invalid", reasons)

        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="https://jangar.example/openai/v1/chat/completions#frag",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_jangar_base_url_invalid", reasons)

    def test_live_dspy_runtime_gate_allows_openai_compatible_jangar_base_url(
        self,
    ) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="https://jangar.example/openai/v1",
            LLM_ALLOWED_MODELS="gpt-5.6-sol",
            LLM_MODEL="gpt-5.6-sol",
            LLM_ROLLOUT_STAGE="stage3",
            LLM_EVALUATION_REPORT="ok",
            LLM_EFFECTIVE_CHALLENGE_ID="challenge-1",
            LLM_SHADOW_COMPLETED_AT="2026-03-01T00:00:00Z",
            LLM_MODEL_VERSION_LOCK="gpt-5.6-sol@v1",
            LLM_ABSTAIN_FAIL_MODE="veto",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertTrue(allowed)
        self.assertNotIn("dspy_jangar_base_url_invalid", reasons)

        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="https://jangar.example/openai/v1/chat/completions",
            LLM_ALLOWED_MODELS="gpt-5.6-sol",
            LLM_MODEL="gpt-5.6-sol",
            LLM_ROLLOUT_STAGE="stage3",
            LLM_EVALUATION_REPORT="ok",
            LLM_EFFECTIVE_CHALLENGE_ID="challenge-1",
            LLM_SHADOW_COMPLETED_AT="2026-03-01T00:00:00Z",
            LLM_MODEL_VERSION_LOCK="gpt-5.6-sol@v1",
            LLM_ABSTAIN_FAIL_MODE="veto",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertTrue(allowed)
        self.assertNotIn("dspy_jangar_base_url_invalid", reasons)

    def test_live_dspy_runtime_gate_blocks_legacy_fail_open_cutover_toggles(
        self,
    ) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            JANGAR_BASE_URL="https://jangar.example/openai/v1",
            LLM_ALLOWED_MODELS="gpt-5.6-sol",
            LLM_MODEL="gpt-5.6-sol",
            LLM_ROLLOUT_STAGE="stage3",
            LLM_EVALUATION_REPORT="ok",
            LLM_EFFECTIVE_CHALLENGE_ID="challenge-1",
            LLM_SHADOW_COMPLETED_AT="2026-03-01T00:00:00Z",
            LLM_MODEL_VERSION_LOCK="gpt-5.6-sol@v1",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            LLM_FAIL_OPEN_LIVE_APPROVED=True,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        allowed, reasons = settings.llm_dspy_live_runtime_gate()
        self.assertFalse(allowed)
        self.assertIn("dspy_cutover_requires_strict_veto_enforcement", reasons)
        self.assertIn(
            "dspy_cutover_policy_exception_configured_fail_mode_enabled",
            reasons,
        )

    def test_dspy_cutover_migration_guard_passes_with_strict_controls(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_DSPY_RUNTIME_MODE="active",
            LLM_DSPY_ARTIFACT_HASH="a" * 64,
            LLM_FAIL_MODE_ENFORCEMENT="strict_veto",
            LLM_FAIL_MODE="veto",
            LLM_ABSTAIN_FAIL_MODE="veto",
            LLM_ESCALATE_FAIL_MODE="veto",
            LLM_QUALITY_FAIL_MODE="veto",
            LLM_SHADOW_MODE=False,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        allowed, reasons = settings.llm_dspy_cutover_migration_guard()

        self.assertTrue(allowed)
        self.assertEqual(reasons, ())

    def test_strategy_runtime_defaults_move_to_scheduler_v3(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_strategy_runtime_mode, "scheduler_v3")

    def test_allocator_regime_maps_are_normalized(self) -> None:
        settings = Settings(
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_ENABLED=False,
            TRADING_ALLOCATOR_ENABLED=True,
            TRADING_ALLOCATOR_REGIME_BUDGET_MULTIPLIERS={
                "vol=high|trend=flat|liq=liquid": 0.5
            },
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertTrue(settings.trading_allocator_enabled)
        self.assertIn(
            "vol=high|trend=flat|liq=liquid",
            settings.trading_allocator_regime_budget_multipliers,
        )

    def test_allocator_budget_maps_are_normalized(self) -> None:
        settings = Settings(
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_ENABLED=False,
            TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS={" momentum ": 1500.0},
            TRADING_ALLOCATOR_SYMBOL_NOTIONAL_CAPS={" aapl ": 2000.0},
            TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS={" msft ": " MegaCap "},
            TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS={" MegaCap ": 3000.0},
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_allocator_strategy_notional_caps, {"momentum": 1500.0}
        )
        self.assertEqual(
            settings.trading_allocator_symbol_notional_caps, {"AAPL": 2000.0}
        )
        self.assertEqual(
            settings.trading_allocator_symbol_correlation_groups,
            {"MSFT": "megacap"},
        )
        self.assertEqual(
            settings.trading_allocator_correlation_group_caps,
            {"megacap": 3000.0},
        )

    def test_allocator_surface_uses_canonical_field_names(self) -> None:
        model_fields = set(Settings.model_fields.keys())
        self.assertIn(
            "trading_allocator_symbol_correlation_groups",
            model_fields,
        )
        self.assertIn(
            "trading_allocator_correlation_group_caps",
            model_fields,
        )
        self.assertIn(
            "trading_allocator_strategy_notional_caps",
            model_fields,
        )
        self.assertIn(
            "trading_allocator_symbol_notional_caps",
            model_fields,
        )

    def test_allocator_canonical_environment_populates_fields(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS": '{"MSFT": "megacap"}',
                "TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS": '{"MEGACAP":3000}',
                "TRADING_ENABLED": "false",
                "TRADING_UNIVERSE_SOURCE": "static",
                "DB_DSN": "postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            },
            clear=False,
        ):
            settings = Settings()
            self.assertEqual(
                settings.trading_allocator_symbol_correlation_groups,
                {"MSFT": "megacap"},
            )
            self.assertEqual(
                settings.trading_allocator_correlation_group_caps,
                {"megacap": 3000.0},
            )

    def test_runtime_uncertainty_degrade_regime_maps_are_normalized(self) -> None:
        settings = Settings(
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_ENABLED=False,
            TRADING_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIERS_BY_REGIME={
                " RiskOff ": 0.25
            },
            TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE_BY_REGIME={
                " RiskOff ": 0.02
            },
            TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME={
                " RiskOff ": 180
            },
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
            {"riskoff": 0.25},
        )
        self.assertEqual(
            settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime,
            {"riskoff": 0.02},
        )
        self.assertEqual(
            settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime,
            {"riskoff": 180},
        )

    def test_runtime_uncertainty_degrade_regime_maps_reject_invalid_values(
        self,
    ) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIERS_BY_REGIME={
                    "riskoff": 1.2
                },
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE_BY_REGIME={
                    "riskoff": -0.1
                },
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME={
                    "riskoff": 120.5,
                },
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_runtime_regime_confidence_thresholds_by_entropy_band_are_normalized(
        self,
    ) -> None:
        settings = Settings(
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_ENABLED=False,
            TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND={
                " High ": [0.80, 0.60],
                " low ": [0.66, 0.46],
            },
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_runtime_regime_confidence_thresholds_by_entropy_band,
            {"high": (0.80, 0.60), "low": (0.66, 0.46)},
        )

    def test_runtime_regime_confidence_thresholds_by_entropy_band_reject_invalid_values(
        self,
    ) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND={
                    "low": [1.05, 0.45],
                },
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND={
                    "low": [0.55, 0.65],
                },
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allocator_rejects_negative_strategy_budget_cap(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS={"s1": -1},
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_simulation_settings_are_normalized(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_SIMULATION_ENABLED=True,
            TRADING_SIMULATION_RUN_ID="  sim-2026-02-27-01  ",
            TRADING_SIMULATION_DATASET_ID="  dataset-a  ",
            TRADING_ORDER_FEED_BOOTSTRAP_SERVERS="  kafka-feed:9092  ",
            TRADING_ORDER_FEED_SECURITY_PROTOCOL="  SASL_PLAINTEXT  ",
            TRADING_ORDER_FEED_SASL_MECHANISM="  SCRAM-SHA-512  ",
            TRADING_ORDER_FEED_SASL_USERNAME="  user  ",
            TRADING_ORDER_FEED_SASL_PASSWORD="  secret  ",
            TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS="  kafka:9092  ",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_simulation_run_id, "sim-2026-02-27-01")
        self.assertEqual(settings.trading_simulation_dataset_id, "dataset-a")
        self.assertEqual(
            settings.trading_simulation_order_updates_bootstrap_servers,
            "kafka:9092",
        )
        self.assertEqual(
            settings.trading_order_feed_kafka_security_kwargs,
            {
                "security_protocol": "SASL_PLAINTEXT",
                "sasl_mechanism": "SCRAM-SHA-512",
                "sasl_plain_username": "user",
                "sasl_plain_password": "secret",
            },
        )

    def test_simple_pipeline_settings_are_supported(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_PIPELINE_MODE="simple",
            TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY=0.2,
            TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY=0.8,
            TRADING_SIMPLE_BUYING_POWER_RESERVE_BPS=50.0,
            TRADING_SIMPLE_SUBMIT_ENABLED=True,
            TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED=True,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(settings.trading_pipeline_mode, "simple")
        self.assertEqual(settings.trading_simple_max_order_pct_equity, 0.2)
        self.assertEqual(settings.trading_simple_max_gross_exposure_pct_equity, 0.8)
        self.assertEqual(settings.trading_simple_buying_power_reserve_bps, 50.0)
        self.assertTrue(settings.trading_simple_submit_enabled)
        self.assertTrue(settings.trading_simple_order_feed_telemetry_enabled)

        defaults = Settings(
            TRADING_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(defaults.trading_simple_max_order_pct_equity, 0.5)
        self.assertEqual(defaults.trading_simple_max_gross_exposure_pct_equity, 1.0)
        self.assertEqual(defaults.trading_simple_max_net_exposure_pct_equity, 0.5)
        self.assertEqual(defaults.trading_simple_max_symbol_pct_equity, 0.5)
        self.assertEqual(defaults.trading_simple_buying_power_reserve_bps, 1000.0)
