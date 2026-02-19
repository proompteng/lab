from __future__ import annotations

from unittest import TestCase

from app import config
from app.trading.llm.guardrails import evaluate_llm_guardrails


class TestLLMGuardrails(TestCase):
    def test_stage0_disables_llm_requests(self) -> None:
        original = {
            "llm_enabled": config.settings.llm_enabled,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
        }
        config.settings.llm_enabled = True
        config.settings.llm_rollout_stage = "stage0_baseline"
        config.settings.llm_shadow_mode = False

        try:
            guardrails = evaluate_llm_guardrails()
            self.assertFalse(guardrails.enabled)
            self.assertFalse(guardrails.allow_requests)
            self.assertTrue(guardrails.shadow_mode)
            self.assertIn("llm_stage0_requires_disabled", guardrails.reasons)
        finally:
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]

    def test_stage1_live_forces_veto_fail_mode(self) -> None:
        original = {
            "trading_mode": config.settings.trading_mode,
            "llm_enabled": config.settings.llm_enabled,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_fail_mode": config.settings.llm_fail_mode,
        }
        config.settings.trading_mode = "live"
        config.settings.llm_enabled = True
        config.settings.llm_rollout_stage = "stage1_shadow_pilot"
        config.settings.llm_shadow_mode = False
        config.settings.llm_fail_mode = "pass_through"

        try:
            guardrails = evaluate_llm_guardrails()
            self.assertTrue(guardrails.enabled)
            self.assertTrue(guardrails.allow_requests)
            self.assertTrue(guardrails.shadow_mode)
            self.assertEqual(guardrails.fail_mode, "veto")
            self.assertIn("llm_stage1_fail_mode_mismatch", guardrails.reasons)
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]

    def test_stage3_requires_model_lock_when_not_shadow(self) -> None:
        original = {
            "llm_enabled": config.settings.llm_enabled,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
        }
        config.settings.llm_enabled = True
        config.settings.llm_rollout_stage = "stage3_controlled_live"
        config.settings.llm_shadow_mode = False
        config.settings.llm_allowed_models_raw = config.settings.llm_model
        config.settings.llm_evaluation_report = "eval-2026-02-19"
        config.settings.llm_effective_challenge_id = "mrm-2026-02-19"
        config.settings.llm_shadow_completed_at = "2026-02-19T00:00:00Z"
        config.settings.llm_model_version_lock = None

        try:
            guardrails = evaluate_llm_guardrails()
            self.assertTrue(guardrails.shadow_mode)
            self.assertIn("llm_model_version_lock_missing", guardrails.reasons)
        finally:
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
