from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.live_config_manifest_contract.support import *


class TestLiveConfigManifestContractPart4(_TestLiveConfigManifestContractBase):
    def test_profit_claim_strategies_require_executable_live_proof(self) -> None:
        strategies = _load_torghut_strategy_catalog()
        proof_claim_strategies: list[dict[str, object]] = []
        for strategy in strategies:
            description = str(strategy.get("description") or "").lower()
            strategy_id = str(strategy.get("strategy_id") or "").lower()
            if (
                "strict-daily-profit" in description
                or "promoted" in description
                or strategy_id.endswith("@prod")
            ):
                proof_claim_strategies.append(strategy)
        self.assertTrue(proof_claim_strategies)

        for strategy in proof_claim_strategies:
            if not _manifest_bool(strategy, "enabled"):
                continue

            params = _params(strategy)
            evidence_ref = str(
                params.get("executable_profit_evidence_ref") or ""
            ).strip()
            min_daily_net_pnl = params.get("executable_profit_min_daily_net_pnl")
            target_net_pnl = params.get("executable_profit_target_net_pnl_per_day")
            replay_buying_power = params.get("executable_replay_account_buying_power")
            replay_max_notional = params.get("executable_replay_max_notional_per_trade")
            max_notional_per_trade = _strategy_decimal(
                strategy, "max_notional_per_trade"
            )

            self.assertTrue(
                evidence_ref,
                f"{strategy.get('name')} is live-enabled with a proof/promotion claim but no executable evidence ref",
            )
            self.assertGreaterEqual(
                Decimal(str(target_net_pnl or "0")),
                Decimal("300"),
                f"{strategy.get('name')} is live-enabled with a proof/promotion claim but no $300/day target proof",
            )
            self.assertGreaterEqual(
                Decimal(str(min_daily_net_pnl or "0")),
                Decimal("300"),
                f"{strategy.get('name')} is live-enabled with a proof/promotion claim but no every-day $300 proof",
            )
            self.assertIsNotNone(max_notional_per_trade)
            self.assertLessEqual(
                max_notional_per_trade or Decimal("0"),
                Decimal(str(replay_max_notional or "0")),
                f"{strategy.get('name')} live notional exceeds executable replay notional",
            )
            self.assertLessEqual(
                Decimal(str(replay_max_notional or "0")),
                Decimal(str(replay_buying_power or "0")),
                f"{strategy.get('name')} replay notional exceeds stated buying power",
            )

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
