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


class TestLiveConfigManifestContract(TestCase):
    def test_knative_live_env_wiring_is_settings_valid(self) -> None:
        env = _load_torghut_knative_env()
        settings = Settings(**env)

        self.assertEqual(settings.trading_mode, "live")
        self.assertEqual(settings.llm_rollout_stage, "stage1")
        self.assertEqual(settings.llm_fail_mode, "pass_through")
        self.assertEqual(settings.llm_fail_mode_enforcement, "configured")
        self.assertTrue(settings.llm_live_fail_open_requested_for_stage("stage1"))
        self.assertEqual(
            settings.llm_effective_fail_mode_for_current_rollout(), "pass_through"
        )
        self.assertEqual(
            settings.llm_effective_fail_mode(rollout_stage="stage1"), "pass_through"
        )

    def test_live_pass_through_requires_explicit_approval_gate(self) -> None:
        env = _load_torghut_knative_env()
        fail_open_env = dict(env)
        fail_open_env["LLM_ROLLOUT_STAGE"] = "stage3"
        fail_open_env["LLM_FAIL_MODE"] = "pass_through"
        fail_open_env["LLM_FAIL_MODE_ENFORCEMENT"] = "configured"
        fail_open_env["LLM_FAIL_OPEN_LIVE_APPROVED"] = "false"

        with self.assertRaises(ValidationError):
            Settings(**fail_open_env)

        fail_open_env["LLM_FAIL_OPEN_LIVE_APPROVED"] = "true"
        approved_settings = Settings(**fail_open_env)
        self.assertEqual(
            approved_settings.llm_effective_fail_mode_for_current_rollout(),
            "pass_through",
        )
