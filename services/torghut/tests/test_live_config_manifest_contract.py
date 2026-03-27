from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from pydantic import ValidationError
from yaml import safe_load

from app.config import Settings
from app.trading.llm.dspy_programs.runtime import DSPyReviewRuntime


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _manifest_bool(env: dict[str, object], key: str) -> bool:
    raw = env.get(key)
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() == "true"


def _load_torghut_knative_manifest() -> dict[str, object]:
    manifest_path = (
        _repo_root() / "argocd" / "applications" / "torghut" / "knative-service.yaml"
    )
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise AssertionError("knative-service.yaml did not parse to a mapping")
    return manifest


def _load_torghut_knative_env() -> dict[str, object]:
    manifest = _load_torghut_knative_manifest()
    containers = (
        manifest.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    if not containers:
        raise AssertionError(
            "knative-service.yaml missing spec.template.spec.containers"
        )

    first_container = containers[0]
    env_entries = first_container.get("env", [])
    env: dict[str, object] = {}
    for item in env_entries:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str):
            continue
        if "value" in item:
            raw_value = item["value"]
            env[name] = raw_value if isinstance(raw_value, str) else str(raw_value)
    return env


def _load_torghut_feature_flags() -> dict[str, object]:
    manifest_path = (
        _repo_root()
        / "argocd"
        / "applications"
        / "feature-flags"
        / "gitops"
        / "default"
        / "features.yaml"
    )
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
    flags = manifest.get("flags")
    if not isinstance(flags, list):
        raise AssertionError("features.yaml missing flags list")

    feature_lookup: dict[str, object] = {}
    for item in flags:
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if isinstance(key, str):
            feature_lookup[key] = item
    return feature_lookup


class TestLiveConfigManifestContract(TestCase):
    def test_knative_env_wiring_is_safe_live_defaults(self) -> None:
        env = _load_torghut_knative_env()
        settings = Settings(**env)

        self.assertEqual(settings.trading_mode, "live")
        self.assertEqual(settings.trading_pipeline_mode, "simple")
        self.assertEqual(settings.trading_universe_source, "jangar")
        self.assertEqual(env.get("TRADING_STRATEGY_SCHEDULER_ENABLED"), "true")
        self.assertFalse(settings.trading_autonomy_enabled)
        self.assertFalse(settings.trading_autonomy_allow_live_promotion)
        self.assertFalse(settings.trading_evidence_continuity_enabled)
        self.assertFalse(settings.trading_emergency_stop_enabled)
        self.assertFalse(settings.trading_feature_flags_enabled)
        self.assertFalse(settings.trading_execution_advisor_enabled)
        self.assertFalse(settings.trading_execution_advisor_live_apply_enabled)
        self.assertEqual(env.get("LLM_ENABLED"), "false")
        self.assertFalse(settings.llm_enabled)
        self.assertEqual(env.get("LLM_DSPY_RUNTIME_MODE"), "disabled")
        self.assertEqual(settings.llm_dspy_runtime_mode, "disabled")
        self.assertFalse(settings.posthog_enabled)
        self.assertTrue(settings.trading_fractional_equities_enabled)
        self.assertTrue(settings.trading_universe_static_fallback_enabled)
        self.assertIsNone(settings.trading_jangar_control_plane_status_url)
        self.assertIsNone(settings.trading_jangar_quant_health_url)
        self.assertIsNone(settings.trading_market_context_url)
        self.assertEqual(
            set(settings.trading_universe_static_fallback_symbols),
            {
                "AAPL",
                "AMAT",
                "AMD",
                "AVGO",
                "GOOG",
                "INTC",
                "META",
                "MSFT",
                "NVDA",
                "QQQ",
                "SPY",
                "TSLA",
            },
        )
        self.assertNotIn("TRADING_FEATURE_FLAGS_URL", env)
        self.assertNotIn("TRADING_FORECAST_SERVICE_URL", env)
        self.assertNotIn("TRADING_LEAN_RUNNER_URL", env)
        self.assertNotIn("TRADING_MARKET_CONTEXT_URL", env)
        self.assertNotIn("TRADING_JANGAR_CONTROL_PLANE_STATUS_URL", env)
        self.assertNotIn("JANGAR_BASE_URL", env)

    def test_live_manifest_does_not_import_autonomy_env_from(self) -> None:
        manifest = _load_torghut_knative_manifest()
        containers = (
            manifest.get("spec", {})
            .get("template", {})
            .get("spec", {})
            .get("containers", [])
        )
        self.assertTrue(containers)
        first_container = containers[0]
        env_from = first_container.get("envFrom", [])
        self.assertEqual(env_from, [])

    def test_manifest_simple_lane_profile_is_enforced(self) -> None:
        env = _load_torghut_knative_env()
        self.assertTrue(_manifest_bool(env, "TRADING_ENABLED"))
        self.assertEqual(env.get("TRADING_MODE"), "live")
        self.assertEqual(env.get("TRADING_PIPELINE_MODE"), "simple")
        self.assertEqual(env.get("TRADING_UNIVERSE_SOURCE"), "jangar")
        self.assertFalse(_manifest_bool(env, "TRADING_AUTONOMY_ENABLED"))
        self.assertFalse(
            _manifest_bool(env, "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION")
        )
        self.assertFalse(_manifest_bool(env, "TRADING_KILL_SWITCH_ENABLED"))
        self.assertFalse(_manifest_bool(env, "TRADING_EMERGENCY_STOP_ENABLED"))
        self.assertNotIn("TRADING_EXECUTION_ADAPTER_POLICY", env)

    def test_manifest_rollout_toggles_disable_execution_advisor(self) -> None:
        knative_env = _load_torghut_knative_env()
        self.assertEqual(
            knative_env.get("TRADING_EXECUTION_ADVISOR_ENABLED"), "false"
        )
        self.assertEqual(
            knative_env.get("TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED"),
            "false",
        )

    def test_feature_flags_defaults_keep_execution_advisor_disabled(self) -> None:
        flags = _load_torghut_feature_flags()

        def _require_flag_enabled_false(key: str) -> None:
            raw_flag = flags.get(key)
            self.assertIsInstance(raw_flag, dict)
            self.assertIn("enabled", raw_flag)
            self.assertIs(raw_flag.get("enabled"), False)

        _require_flag_enabled_false("torghut_trading_execution_advisor_enabled")
        _require_flag_enabled_false("torghut_trading_execution_advisor_live_apply_enabled")
        _require_flag_enabled_false("torghut_trading_db_schema_graph_allow_divergence_roots")
        _require_flag_enabled_false("torghut_llm_fail_open_live_approved")
        _require_flag_enabled_false("torghut_llm_shadow_mode")

    def test_live_pass_through_with_strict_veto_profile_is_rejected(self) -> None:
        env = _load_torghut_knative_env()
        env["TRADING_MODE"] = "live"
        fail_open_env = dict(env)
        fail_open_env["LLM_ROLLOUT_STAGE"] = "stage3"
        fail_open_env["LLM_FAIL_MODE"] = "pass_through"
        fail_open_env["LLM_FAIL_MODE_ENFORCEMENT"] = "strict_veto"
        fail_open_env["LLM_FAIL_OPEN_LIVE_APPROVED"] = "false"

        with self.assertRaises(ValidationError):
            Settings(**fail_open_env)

        fail_open_env["LLM_FAIL_MODE_ENFORCEMENT"] = "configured"
        fail_open_env["LLM_FAIL_OPEN_LIVE_APPROVED"] = "true"
        approved_settings = Settings(**fail_open_env)
        self.assertEqual(
            approved_settings.llm_effective_fail_mode_for_current_rollout(),
            "pass_through",
        )
        fail_open_env["LLM_DSPY_RUNTIME_MODE"] = "active"
        fail_open_env["LLM_SHADOW_MODE"] = "false"
        fail_open_env["LLM_DSPY_ARTIFACT_HASH"] = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        approved_settings = Settings(**fail_open_env)
        cutover_allowed, cutover_reasons = (
            approved_settings.llm_dspy_cutover_migration_guard()
        )
        self.assertFalse(cutover_allowed)
        self.assertIn("dspy_cutover_requires_strict_veto_enforcement", cutover_reasons)
