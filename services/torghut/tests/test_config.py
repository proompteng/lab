from __future__ import annotations

import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from pydantic import ValidationError
import yaml

from app.config import FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD, Settings


class _MockFlagResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self._payload = json.dumps(payload).encode("utf-8")
        self.status = status

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_MockFlagResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


class TestConfig(TestCase):
    def test_rejects_static_universe_when_trading_enabled(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_static_universe_when_trading_and_autonomy_disabled(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_LIVE_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_universe_source, "static")

    def test_rejects_live_mode_without_live_enabled(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_LIVE_ENABLED=False,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_rejects_paper_mode_with_live_enabled(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="paper",
                TRADING_LIVE_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_rejects_strict_veto_with_pass_through_fail_mode(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                LLM_FAIL_MODE="pass_through",
                LLM_FAIL_MODE_ENFORCEMENT="strict_veto",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_mode_coupled_configured_with_pass_through_fail_mode(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_LIVE_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_FAIL_MODE="pass_through",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            TRADING_PARITY_POLICY="mode_coupled",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(settings.llm_effective_fail_mode(), "veto")

    def test_rejects_live_fail_open_without_explicit_approval(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_LIVE_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="jangar",
                TRADING_PARITY_POLICY="live_equivalent",
                LLM_FAIL_MODE="pass_through",
                LLM_FAIL_MODE_ENFORCEMENT="configured",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_live_fail_open_with_explicit_approval(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_LIVE_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="jangar",
            TRADING_PARITY_POLICY="live_equivalent",
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
                TRADING_LIVE_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="jangar",
                TRADING_PARITY_POLICY="mode_coupled",
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
                TRADING_LIVE_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="jangar",
                TRADING_PARITY_POLICY="live_equivalent",
                LLM_ROLLOUT_STAGE="stage1",
                LLM_FAIL_MODE="veto",
                LLM_FAIL_MODE_ENFORCEMENT="configured",
                LLM_FAIL_OPEN_LIVE_APPROVED=False,
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_stage1_mode_coupled_live_does_not_require_fail_open_approval(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_LIVE_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="jangar",
            TRADING_PARITY_POLICY="mode_coupled",
            LLM_ROLLOUT_STAGE="stage1_shadow_pilot",
            LLM_FAIL_MODE="veto",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            LLM_FAIL_OPEN_LIVE_APPROVED=False,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(settings.llm_effective_fail_mode_for_current_rollout(), "veto")

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
            TRADING_ALLOCATOR_CORRELATION_SYMBOL_GROUPS={" msft ": " MegaCap "},
            TRADING_ALLOCATOR_CORRELATION_GROUP_NOTIONAL_CAPS={" MegaCap ": 3000.0},
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_allocator_strategy_notional_caps, {"momentum": 1500.0}
        )
        self.assertEqual(
            settings.trading_allocator_symbol_notional_caps, {"AAPL": 2000.0}
        )
        self.assertEqual(
            settings.trading_allocator_correlation_symbol_groups,
            {"MSFT": "megacap"},
        )
        self.assertEqual(
            settings.trading_allocator_correlation_group_notional_caps,
            {"megacap": 3000.0},
        )

    def test_allocator_rejects_negative_strategy_budget_cap(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_UNIVERSE_SOURCE="static",
                TRADING_ENABLED=False,
                TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS={"s1": -1},
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_parses_signal_staleness_critical_reasons(self) -> None:
        settings = Settings(
            TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS="cursor_ahead_of_stream, universe_source_unavailable",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_signal_staleness_alert_critical_reasons,
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
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
        def _mock_urlopen(request, timeout):  # type: ignore[no-untyped-def]
            payload = json.loads(request.data.decode("utf-8"))
            key = payload.get("flagKey")
            values = {
                "torghut_trading_enabled": False,
                "torghut_trading_emergency_stop_enabled": True,
                "torghut_trading_execution_prefer_limit": False,
                "torghut_llm_enabled": False,
                "torghut_llm_adjustment_allowed": True,
            }
            return _MockFlagResponse({"enabled": values.get(key)})

        with patch("app.config.urlopen", side_effect=_mock_urlopen):
            settings = Settings(
                TRADING_ENABLED=True,
                TRADING_EMERGENCY_STOP_ENABLED=False,
                TRADING_EXECUTION_PREFER_LIMIT=True,
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
        self.assertFalse(settings.llm_enabled)
        self.assertTrue(settings.llm_adjustment_allowed)
        self.assertEqual(
            settings.trading_feature_flags_url,
            "http://feature-flags.feature-flags.svc.cluster.local:8013",
        )

    def test_feature_flags_use_flipt_evaluate_contract(self) -> None:
        requests: list[dict[str, object]] = []

        def _mock_urlopen(request, timeout):  # type: ignore[no-untyped-def]
            requests.append(
                {
                    "url": request.full_url,
                    "payload": json.loads(request.data.decode("utf-8")),
                }
            )
            return _MockFlagResponse({"enabled": None})

        with patch("app.config.urlopen", side_effect=_mock_urlopen):
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
        with patch("app.config.urlopen", side_effect=RuntimeError("network")):
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

    def test_feature_flag_map_covers_all_boolean_runtime_gates(self) -> None:
        boolean_fields = {
            name
            for name, field in Settings.model_fields.items()
            if field.annotation is bool
        }
        control_fields = {"trading_feature_flags_enabled"}
        self.assertEqual(
            set(FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD),
            boolean_fields - control_fields,
        )

    def test_torghut_feature_flag_manifest_matches_config_mapping(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
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
