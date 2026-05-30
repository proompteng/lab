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
                "min_runtime_ledger_net_pnl_after_costs": "500",
                "min_runtime_ledger_daily_net_pnl_after_costs": "500",
                "min_runtime_ledger_trading_days": 1,
            },
        )
        self.assertEqual(
            DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity,
            Decimal("0.08"),
        )

    def test_policy_can_be_overridden_without_touching_call_sites(self) -> None:
        policy = runtime_ledger_proof_policy_from_env(
            {
                "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_NET_PNL_AFTER_COSTS": "750",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_DAILY_NET_PNL_AFTER_COSTS": "625",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_TRADING_DAYS": "3",
                "TORGHUT_RUNTIME_LEDGER_PROOF_MAX_DRAWDOWN_PCT_EQUITY": "0.12",
                "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_TRADING_DAYS": "10",
            }
        )

        self.assertEqual(policy.min_net_pnl_after_costs, Decimal("750"))
        self.assertEqual(policy.min_daily_net_pnl_after_costs, Decimal("625"))
        self.assertEqual(policy.min_trading_days, 3)
        self.assertEqual(policy.max_drawdown_pct_equity, Decimal("0.12"))
        self.assertEqual(policy.authority_min_trading_days, 10)

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
