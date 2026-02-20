from __future__ import annotations

from unittest import TestCase

from app import config
from app.trading.llm.guardrails import evaluate_llm_guardrails


class TestLlmGuardrails(TestCase):
    def test_live_equivalent_policy_keeps_paper_and_live_fail_mode_aligned(
        self,
    ) -> None:
        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_parity_policy": config.settings.trading_parity_policy,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
        }
        config.settings.trading_parity_policy = "live_equivalent"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_allowed_models_raw = config.settings.llm_model

        try:
            config.settings.trading_mode = "paper"
            paper_guardrails = evaluate_llm_guardrails()
            config.settings.trading_mode = "live"
            live_guardrails = evaluate_llm_guardrails()
            self.assertEqual(paper_guardrails.effective_fail_mode, "veto")
            self.assertEqual(live_guardrails.effective_fail_mode, "veto")
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_parity_policy = original["trading_parity_policy"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]

    def test_mode_coupled_policy_keeps_live_only_override_as_explicit_exception(
        self,
    ) -> None:
        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_parity_policy": config.settings.trading_parity_policy,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
        }
        config.settings.trading_parity_policy = "mode_coupled"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_allowed_models_raw = config.settings.llm_model

        try:
            config.settings.trading_mode = "paper"
            paper_guardrails = evaluate_llm_guardrails()
            config.settings.trading_mode = "live"
            live_guardrails = evaluate_llm_guardrails()
            self.assertEqual(paper_guardrails.effective_fail_mode, "pass_through")
            self.assertEqual(live_guardrails.effective_fail_mode, "veto")
            self.assertIn(
                "mode_coupled_behavior_enabled", config.settings.llm_policy_exceptions
            )
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_parity_policy = original["trading_parity_policy"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]

    def test_stage1_shadow_pilot_forces_shadow_and_fail_mode(self) -> None:
        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_parity_policy": config.settings.trading_parity_policy,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
        }
        config.settings.trading_parity_policy = "mode_coupled"
        config.settings.llm_rollout_stage = "stage1"
        config.settings.llm_shadow_mode = False
        config.settings.llm_adjustment_allowed = True
        config.settings.llm_adjustment_approved = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_allowed_models_raw = config.settings.llm_model

        try:
            config.settings.trading_mode = "paper"
            paper_guardrails = evaluate_llm_guardrails()
            self.assertTrue(paper_guardrails.shadow_mode)
            self.assertFalse(paper_guardrails.adjustment_allowed)
            self.assertEqual(paper_guardrails.effective_fail_mode, "pass_through")

            config.settings.trading_mode = "live"
            live_guardrails = evaluate_llm_guardrails()
            self.assertTrue(live_guardrails.shadow_mode)
            self.assertFalse(live_guardrails.adjustment_allowed)
            self.assertEqual(live_guardrails.effective_fail_mode, "veto")
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_parity_policy = original["trading_parity_policy"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]

    def test_stage2_requires_governance_evidence_and_model_lock(self) -> None:
        original = {
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
        }
        config.settings.llm_rollout_stage = "stage2"
        config.settings.llm_shadow_mode = False
        config.settings.llm_allowed_models_raw = config.settings.llm_model
        config.settings.llm_evaluation_report = None
        config.settings.llm_effective_challenge_id = None
        config.settings.llm_shadow_completed_at = None
        config.settings.llm_model_version_lock = None

        try:
            guardrails = evaluate_llm_guardrails()
            self.assertTrue(guardrails.shadow_mode)
            self.assertFalse(guardrails.governance_evidence_complete)
            self.assertIn("llm_evaluation_report_missing", guardrails.reasons)
            self.assertIn("llm_effective_challenge_missing", guardrails.reasons)
            self.assertIn("llm_shadow_completion_missing", guardrails.reasons)
            self.assertIn("llm_model_version_lock_missing", guardrails.reasons)
        finally:
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

    def test_stage3_requires_explicit_model_version_lock(self) -> None:
        original = {
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
        }
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_shadow_mode = False
        config.settings.llm_allowed_models_raw = config.settings.llm_model
        config.settings.llm_evaluation_report = "eval-2026-02-12"
        config.settings.llm_effective_challenge_id = "challenge-2026-02-12"
        config.settings.llm_shadow_completed_at = "2026-02-12T06:45:00Z"
        config.settings.llm_model_version_lock = None

        try:
            missing_lock = evaluate_llm_guardrails()
            self.assertTrue(missing_lock.shadow_mode)
            self.assertIn("llm_model_version_lock_missing", missing_lock.reasons)

            config.settings.llm_model_version_lock = config.settings.llm_model
            with_lock = evaluate_llm_guardrails()
            self.assertNotIn("llm_model_version_lock_missing", with_lock.reasons)
        finally:
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

    def test_stage2_model_lock_mismatch_forces_shadow(self) -> None:
        original = {
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
        }
        config.settings.llm_rollout_stage = "stage2"
        config.settings.llm_shadow_mode = False
        config.settings.llm_allowed_models_raw = config.settings.llm_model
        config.settings.llm_evaluation_report = "eval-2026-02-12"
        config.settings.llm_effective_challenge_id = "challenge-2026-02-12"
        config.settings.llm_shadow_completed_at = "2026-02-12T06:45:00Z"
        config.settings.llm_model_version_lock = "other-model@sha256:deadbeef"

        try:
            guardrails = evaluate_llm_guardrails()
            self.assertTrue(guardrails.shadow_mode)
            self.assertFalse(guardrails.governance_evidence_complete)
            self.assertIn("llm_model_version_lock_mismatch", guardrails.reasons)
        finally:
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

    def test_stage_aliases_preserve_stage_gating_and_fail_mode_behavior(self) -> None:
        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_parity_policy": config.settings.trading_parity_policy,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
        }
        config.settings.trading_parity_policy = "mode_coupled"
        config.settings.llm_shadow_mode = False
        config.settings.llm_adjustment_allowed = True
        config.settings.llm_adjustment_approved = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_allowed_models_raw = config.settings.llm_model

        try:
            config.settings.llm_rollout_stage = "stage1_shadow_pilot"
            config.settings.trading_mode = "paper"
            stage1_paper = evaluate_llm_guardrails()
            self.assertTrue(stage1_paper.shadow_mode)
            self.assertFalse(stage1_paper.adjustment_allowed)
            self.assertEqual(stage1_paper.effective_fail_mode, "pass_through")

            config.settings.trading_mode = "live"
            stage1_live = evaluate_llm_guardrails()
            self.assertTrue(stage1_live.shadow_mode)
            self.assertFalse(stage1_live.adjustment_allowed)
            self.assertEqual(stage1_live.effective_fail_mode, "veto")

            config.settings.llm_rollout_stage = "stage2_paper_advisory"
            config.settings.llm_evaluation_report = "eval-2026-02-12"
            config.settings.llm_effective_challenge_id = "challenge-2026-02-12"
            config.settings.llm_shadow_completed_at = "2026-02-12T06:45:00Z"
            config.settings.llm_model_version_lock = config.settings.llm_model

            config.settings.trading_mode = "paper"
            stage2_paper = evaluate_llm_guardrails()
            self.assertFalse(stage2_paper.shadow_mode)
            self.assertEqual(stage2_paper.effective_fail_mode, "pass_through")
            self.assertTrue(stage2_paper.governance_evidence_complete)

            config.settings.trading_mode = "live"
            stage2_live = evaluate_llm_guardrails()
            self.assertFalse(stage2_live.shadow_mode)
            self.assertEqual(stage2_live.effective_fail_mode, "pass_through")
            self.assertTrue(stage2_live.governance_evidence_complete)
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_parity_policy = original["trading_parity_policy"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]

    def test_prompt_allowlist_and_token_budget_block_requests(self) -> None:
        original = {
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_allowed_prompt_versions_raw": config.settings.llm_allowed_prompt_versions_raw,
            "llm_prompt_version": config.settings.llm_prompt_version,
            "llm_max_tokens": config.settings.llm_max_tokens,
            "llm_token_budget_max": config.settings.llm_token_budget_max,
        }
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_shadow_mode = False
        config.settings.llm_allowed_models_raw = config.settings.llm_model
        config.settings.llm_allowed_prompt_versions_raw = "v2"
        config.settings.llm_prompt_version = "v1"
        config.settings.llm_max_tokens = 1600
        config.settings.llm_token_budget_max = 1200

        try:
            guardrails = evaluate_llm_guardrails()
            self.assertFalse(guardrails.allow_requests)
            self.assertTrue(guardrails.shadow_mode)
            self.assertIn("llm_prompt_version_not_allowlisted", guardrails.reasons)
            self.assertIn("llm_token_budget_exceeded", guardrails.reasons)
        finally:
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_allowed_prompt_versions_raw = original[
                "llm_allowed_prompt_versions_raw"
            ]
            config.settings.llm_prompt_version = original["llm_prompt_version"]
            config.settings.llm_max_tokens = original["llm_max_tokens"]
            config.settings.llm_token_budget_max = original["llm_token_budget_max"]
