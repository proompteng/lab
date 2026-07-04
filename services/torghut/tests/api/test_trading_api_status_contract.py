from __future__ import annotations

from tests.api.trading_api_support import TradingApiTestCaseBase, patch


class TestTradingApiStatusContract(TradingApiTestCaseBase):
    def test_trading_status_surfaces_budget_and_safety_contract_keys(self) -> None:
        live_submission_gate = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        with patch(
            "app.api.trading_status._build_live_submission_gate_payload",
            return_value=live_submission_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(
            {
                "status_read_budget",
                "live_submission_gate",
                "submission_authority",
                "proof_floor",
                "tigerbeetle_ledger",
                "portfolio_runtime_ledger_summary",
                "hypotheses",
            }.issubset(payload),
        )
        self.assertIn("skipped_reads", payload["status_read_budget"])
        live_submission_gate = payload["live_submission_gate"]
        self.assertIn("allowed", live_submission_gate)
        self.assertIn("read_model_unavailable", live_submission_gate)
        self.assertIn("promotion_authority", live_submission_gate)
        self.assertIn("final_authority_ok", live_submission_gate)
