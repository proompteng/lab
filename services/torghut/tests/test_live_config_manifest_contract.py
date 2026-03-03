from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from pydantic import ValidationError
from yaml import safe_load

from app.config import Settings


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _load_torghut_knative_env() -> dict[str, object]:
    manifest_path = (
        _repo_root() / "argocd" / "applications" / "torghut" / "knative-service.yaml"
    )
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
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


def _load_torghut_lean_runner_env() -> dict[str, object]:
    manifest_path = (
        _repo_root() / "argocd" / "applications" / "torghut" / "lean-runner-deployment.yaml"
    )
    manifest = safe_load(manifest_path.read_text(encoding="utf-8"))
    containers = (
        manifest.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    if not containers:
        raise AssertionError(
            "lean-runner-deployment.yaml missing spec.template.spec.containers"
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
        env["TRADING_FEATURE_FLAGS_ENABLED"] = "false"
        settings = Settings(**env)

        self.assertEqual(settings.trading_mode, "live")
        self.assertEqual(settings.llm_rollout_stage, "stage1")
        self.assertEqual(settings.llm_fail_mode, "pass_through")
        self.assertEqual(settings.llm_fail_mode_enforcement, "configured")
        self.assertTrue(settings.llm_live_fail_open_requested_for_stage("stage1"))
        self.assertTrue(settings.llm_fail_open_live_approved)
        self.assertEqual(
            settings.llm_effective_fail_mode_for_current_rollout(), "pass_through"
        )
        self.assertEqual(
            settings.llm_effective_fail_mode(rollout_stage="stage1"), "pass_through"
        )

    def test_manifest_rollout_toggles_disable_execution_advisor(self) -> None:
        knative_env = _load_torghut_knative_env()
        lean_runner_env = _load_torghut_lean_runner_env()
        self.assertEqual(
            knative_env.get("TRADING_EXECUTION_ADVISOR_ENABLED"), "false"
        )
        self.assertEqual(
            knative_env.get("TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED"),
            "false",
        )
        self.assertEqual(
            lean_runner_env.get("TRADING_EXECUTION_ADVISOR_ENABLED"), "false"
        )
        self.assertEqual(
            lean_runner_env.get("TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED"),
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

    def test_live_pass_through_with_strict_veto_profile_is_rejected(self) -> None:
        env = _load_torghut_knative_env()
        env["TRADING_FEATURE_FLAGS_ENABLED"] = "false"
        env["TRADING_MODE"] = "live"
        fail_open_env = dict(env)
        fail_open_env["LLM_ROLLOUT_STAGE"] = "stage1"
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
