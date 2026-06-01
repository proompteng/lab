from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.runtime_ledger_proof_policy import (
    DEFAULT_RUNTIME_LEDGER_PROOF_POLICY,
    runtime_ledger_proof_policy_from_env,
)


class TestRuntimeLedgerProofPolicy(TestCase):
    def test_default_policy_matches_goal_and_risk_gates(self) -> None:
        self.assertEqual(
            DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.target_payload(),
            {
                "proof_mode": "smoke",
                "final_authority": False,
                "evidence_collection_only": True,
                "evidence_collection_ok": True,
                "canary_collection_authorized": False,
                "capital_promotion_allowed": False,
                "final_promotion_allowed": False,
                "min_runtime_ledger_net_pnl_after_costs": "500",
                "min_runtime_ledger_daily_net_pnl_after_costs": "500",
                "min_runtime_ledger_trading_days": 1,
                "max_runtime_ledger_drawdown_pct_equity": "0.08",
                "max_runtime_ledger_best_day_share": "0.25",
                "max_runtime_ledger_symbol_concentration_share": "0.5",
            },
        )
        self.assertEqual(
            DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity,
            Decimal("0.08"),
        )
        self.assertEqual(
            DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.target_payload("authority")[
                "max_runtime_ledger_drawdown_pct_equity"
            ],
            "0.03",
        )

    def test_policy_can_be_overridden_without_touching_call_sites(self) -> None:
        policy = runtime_ledger_proof_policy_from_env(
            {
                "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_NET_PNL_AFTER_COSTS": "750",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_DAILY_NET_PNL_AFTER_COSTS": "625",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_TRADING_DAYS": "3",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MODE": "probation",
                "TORGHUT_RUNTIME_LEDGER_PROOF_PROBATION_MIN_TRADING_DAYS": "6",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MAX_DRAWDOWN_PCT_EQUITY": "0.12",
                "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_DRAWDOWN_PCT_EQUITY": "0.025",
                "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_TRADING_DAYS": "10",
                "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_SYMBOL_CONCENTRATION_SHARE": "0.30",
            }
        )

        self.assertEqual(policy.min_net_pnl_after_costs, Decimal("750"))
        self.assertEqual(policy.min_daily_net_pnl_after_costs, Decimal("625"))
        self.assertEqual(policy.min_trading_days, 3)
        self.assertEqual(policy.proof_mode, "probation")
        self.assertEqual(policy.probation_min_trading_days, 6)
        self.assertEqual(policy.max_drawdown_pct_equity, Decimal("0.12"))
        self.assertEqual(policy.authority_min_trading_days, 10)
        self.assertEqual(policy.authority_max_drawdown_pct_equity, Decimal("0.025"))
        self.assertEqual(
            policy.authority_max_symbol_concentration_share,
            Decimal("0.30"),
        )
        self.assertEqual(
            policy.target_payload(),
            {
                "proof_mode": "probation",
                "final_authority": False,
                "evidence_collection_only": True,
                "evidence_collection_ok": True,
                "canary_collection_authorized": True,
                "capital_promotion_allowed": False,
                "final_promotion_allowed": False,
                "min_runtime_ledger_net_pnl_after_costs": "3750",
                "min_runtime_ledger_daily_net_pnl_after_costs": "625",
                "min_runtime_ledger_trading_days": 6,
                "max_runtime_ledger_drawdown_pct_equity": "0.12",
                "max_runtime_ledger_best_day_share": "0.25",
                "max_runtime_ledger_symbol_concentration_share": "0.5",
            },
        )
        self.assertEqual(
            policy.target_payload("authority"),
            {
                "proof_mode": "authority",
                "final_authority": True,
                "evidence_collection_only": False,
                "evidence_collection_ok": False,
                "canary_collection_authorized": False,
                "capital_promotion_allowed": False,
                "final_promotion_allowed": False,
                "min_runtime_ledger_net_pnl_after_costs": "6250",
                "min_runtime_ledger_daily_net_pnl_after_costs": "625",
                "min_runtime_ledger_trading_days": 10,
                "max_runtime_ledger_drawdown_pct_equity": "0.025",
                "max_runtime_ledger_best_day_share": "0.25",
                "max_runtime_ledger_symbol_concentration_share": "0.3",
            },
        )

    def test_invalid_policy_env_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be a decimal"):
            runtime_ledger_proof_policy_from_env(
                {
                    "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_NET_PNL_AFTER_COSTS": "nope",
                }
            )

        with self.assertRaisesRegex(ValueError, "must be non-negative"):
            runtime_ledger_proof_policy_from_env(
                {
                    "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_TRADING_DAYS": "-1",
                }
            )

        with self.assertRaisesRegex(ValueError, "must be one of"):
            runtime_ledger_proof_policy_from_env(
                {
                    "TORGHUT_RUNTIME_LEDGER_PROOF_MODE": "pretend",
                }
            )
