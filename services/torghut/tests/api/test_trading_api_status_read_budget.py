from __future__ import annotations

from tests.api.trading_api_support import (
    Session,
    TradingApiTestCaseBase,
    datetime,
    patch,
    timezone,
)
from app.trading.hypotheses import JangarDependencyQuorumStatus
from app.api.status_helpers import (
    TradingStatusReadBudget,
    budget_unavailable_hypothesis_runtime_payload,
)


class TestTradingApiStatusReadBudget(TradingApiTestCaseBase):
    def test_trading_status_uses_isolated_db_sessions_for_late_reads(self) -> None:
        observed_sessions: list[Session] = []

        def _load_llm_evaluation(session: Session) -> dict[str, object]:
            observed_sessions.append(session)
            return {"ok": True, "metrics": {"total_reviews": 1}}

        def _load_tca(session: Session, **_kwargs: object) -> dict[str, object]:
            observed_sessions.append(session)
            return {}

        def _load_last_decision_at(session: Session) -> None:
            observed_sessions.append(session)
            return None

        def _build_live_submission_gate(
            *args: object, **kwargs: object
        ) -> dict[str, object]:
            session = kwargs["session"]
            assert isinstance(session, Session)
            observed_sessions.append(session)
            return {"allowed": True, "reason": "ready", "blocked_reasons": []}

        with (
            patch(
                "app.api.status_helpers._load_llm_evaluation",
                side_effect=_load_llm_evaluation,
            ),
            patch("app.api.status_helpers._load_tca_summary", side_effect=_load_tca),
            patch(
                "app.api.trading_status._load_last_decision_at",
                side_effect=_load_last_decision_at,
            ),
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                side_effect=_build_live_submission_gate,
            ),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(len(observed_sessions), 4)
        self.assertIsNot(observed_sessions[0], observed_sessions[1])
        self.assertIsNot(observed_sessions[1], observed_sessions[2])
        self.assertIsNot(observed_sessions[2], observed_sessions[3])

    def test_trading_status_reuses_clickhouse_signal_status_once(self) -> None:
        with patch(
            "app.api.trading_status._load_clickhouse_ta_status",
            return_value={
                "state": "current",
                "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "source_ref": "clickhouse:ta_signals",
                "signal_rows": 10,
                "symbol_count": 1,
            },
        ) as load_clickhouse:
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(load_clickhouse.call_count, 1)
        payload = response.json()
        self.assertIn("status_read_budget", payload)

    def test_trading_status_builds_live_gate_before_clickhouse_ta_read(
        self,
    ) -> None:
        class ManualBudget(TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()
        call_order: list[str] = []
        live_submission_gate_payload = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        def _load_clickhouse_ta_status(*_args: object) -> dict[str, object]:
            call_order.append("clickhouse_ta_status")
            budget.current_elapsed = 9.8
            return {
                "state": "current",
                "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "source_ref": "clickhouse:ta_signals",
            }

        def _build_live_submission_gate(
            *args: object,
            **kwargs: object,
        ) -> dict[str, object]:
            call_order.append("live_submission_gate")
            clickhouse_ta_status = kwargs["clickhouse_ta_status"]
            self.assertEqual(clickhouse_ta_status["state"], "deferred")
            self.assertIn(
                "clickhouse_ta_status_deferred_until_after_live_submission_gate",
                clickhouse_ta_status["reason_codes"],
            )
            return live_submission_gate_payload

        with (
            patch(
                "app.api.trading_status._TradingStatusReadBudget", return_value=budget
            ),
            patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                side_effect=_load_clickhouse_ta_status,
            ),
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                side_effect=_build_live_submission_gate,
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_called_once()
        self.assertEqual(call_order, ["live_submission_gate", "clickhouse_ta_status"])
        payload = response.json()
        self.assertNotIn(
            "live_submission_gate",
            payload["status_read_budget"]["skipped_reads"],
        )
        self.assertFalse(payload["live_submission_gate"]["read_model_unavailable"])

    def test_trading_status_fails_closed_late_reads_after_budget_exhausted(
        self,
    ) -> None:
        with (
            patch("app.api.status_helpers.TRADING_STATUS_READ_BUDGET_SECONDS", 0.0),
            patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch(
                "app.api.trading_status._build_live_submission_gate_payload"
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_not_called()
        payload = response.json()
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "live_submission_gate_status_read_budget_exhausted",
        )
        self.assertTrue(payload["live_submission_gate"]["read_model_unavailable"])
        self.assertTrue(payload["status_read_budget"]["exhausted"])
        self.assertIn(
            "live_submission_gate",
            payload["status_read_budget"]["skipped_reads"],
        )
        self.assertIn(
            "options_catalog_freshness",
            payload["status_read_budget"]["skipped_reads"],
        )

    def test_trading_status_prioritizes_live_gate_before_late_reads_when_budget_is_low(
        self,
    ) -> None:
        class ManualBudget(TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()
        live_submission_gate_payload = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        def _build_live_submission_gate(
            *args: object,
            **kwargs: object,
        ) -> dict[str, object]:
            budget.current_elapsed = 9.8
            return live_submission_gate_payload

        with (
            patch(
                "app.api.trading_status._TradingStatusReadBudget", return_value=budget
            ),
            patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch(
                "app.api.status_helpers._build_tigerbeetle_ledger_status"
            ) as tigerbeetle_status,
            patch(
                "app.api.status_helpers._daily_runtime_ledger_portfolio_summary"
            ) as portfolio_summary,
            patch("app.api.trading_status._load_last_decision_at") as last_decision,
            patch(
                "app.api.trading_status._load_rejected_signal_outcome_learning_summary"
            ) as rejected_signal_learning,
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                side_effect=_build_live_submission_gate,
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_called_once()
        tigerbeetle_status.assert_not_called()
        portfolio_summary.assert_not_called()
        last_decision.assert_not_called()
        rejected_signal_learning.assert_not_called()
        payload = response.json()
        skipped_reads = payload["status_read_budget"]["skipped_reads"]
        self.assertNotIn("live_submission_gate", skipped_reads)
        self.assertIn("tigerbeetle_ledger", skipped_reads)
        self.assertIn("runtime_ledger_portfolio_summary", skipped_reads)
        self.assertIn("last_decision", skipped_reads)
        self.assertIn("rejected_signal_outcome_learning", skipped_reads)
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "alpha_readiness_not_promotion_eligible",
        )
        self.assertFalse(payload["live_submission_gate"]["read_model_unavailable"])
        self.assertFalse(payload["status_read_budget"]["exhausted"])
        self.assertEqual(payload["status_read_budget"]["remaining_seconds"], 0.2)
        self.assertIn(
            "tigerbeetle_ledger_status_read_budget_insufficient_remaining",
            payload["tigerbeetle_ledger"]["blockers"],
        )
        self.assertTrue(
            payload["portfolio_runtime_ledger_summary"]["read_model_unavailable"]
        )

    def test_trading_status_skips_expensive_reads_after_activation_expiry(
        self,
    ) -> None:
        live_submission_gate_payload = {
            "allowed": False,
            "reason": "live_submit_disabled",
            "blocked_reasons": ["live_submit_disabled"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        with (
            patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch(
                "app.api.trading_status._load_trading_status_llm_evaluation",
            ) as load_llm,
            patch(
                "app.api.trading_status._load_trading_status_tca_summary",
            ) as load_tca,
            patch(
                "app.api.trading_status._load_trading_status_hypothesis_runtime",
            ) as load_hypothesis,
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                return_value=live_submission_gate_payload,
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_called_once()
        load_llm.assert_not_called()
        load_tca.assert_not_called()
        load_hypothesis.assert_not_called()
        payload = response.json()
        skipped_reads = payload["status_read_budget"]["skipped_reads"]
        self.assertIn("llm_evaluation", skipped_reads)
        self.assertIn("tca_summary", skipped_reads)
        self.assertIn("hypothesis_runtime", skipped_reads)
        self.assertEqual(
            payload["llm_evaluation"]["error"],
            "llm_evaluation_live_submit_disabled",
        )
        self.assertIn(
            "tca_summary_live_submit_disabled",
            payload["tca"]["reason_codes"],
        )
        self.assertIn(
            "hypothesis_runtime_live_submit_disabled",
            payload["hypotheses"]["summary"]["reason_codes"],
        )

    def test_trading_status_skips_live_gate_when_gate_dependencies_consume_budget(
        self,
    ) -> None:
        class ManualBudget(TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()
        live_submission_gate_payload = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        def _load_hypothesis_runtime(
            *_args: object,
            **_kwargs: object,
        ) -> tuple[
            dict[str, object],
            dict[str, object],
            JangarDependencyQuorumStatus,
        ]:
            budget.current_elapsed = 8.5
            return budget_unavailable_hypothesis_runtime_payload(
                reason="hypothesis_runtime_test_budget_marker"
            )

        with (
            patch(
                "app.api.trading_status._TradingStatusReadBudget", return_value=budget
            ),
            patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch(
                "app.api.trading_status._load_trading_status_hypothesis_runtime",
                side_effect=_load_hypothesis_runtime,
            ),
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                return_value=live_submission_gate_payload,
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        live_gate.assert_called_once()
        gate_hypothesis = live_gate.call_args.kwargs["hypothesis_summary"]
        self.assertIn(
            "hypothesis_runtime_deferred_until_after_live_submission_gate",
            gate_hypothesis["summary"]["reason_codes"],
        )
        payload = response.json()
        self.assertFalse(payload["live_submission_gate"]["allowed"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "alpha_readiness_not_promotion_eligible",
        )
        self.assertFalse(payload["live_submission_gate"]["read_model_unavailable"])
        self.assertFalse(payload["status_read_budget"]["exhausted"])
        self.assertEqual(payload["status_read_budget"]["remaining_seconds"], 1.5)
        self.assertNotIn(
            "live_submission_gate",
            payload["status_read_budget"]["skipped_reads"],
        )
        self.assertIn(
            "tigerbeetle_ledger",
            payload["status_read_budget"]["skipped_reads"],
        )
        self.assertIn(
            "options_catalog_freshness",
            payload["status_read_budget"]["skipped_reads"],
        )

    def test_trading_status_skips_early_expensive_reads_when_budget_remaining_is_low(
        self,
    ) -> None:
        class ManualBudget(TradingStatusReadBudget):
            def __init__(self) -> None:
                super().__init__(max_seconds=10.0)
                self.current_elapsed = 1.0

            def elapsed_seconds(self) -> float:
                return self.current_elapsed

        budget = ManualBudget()
        live_submission_gate_payload = {
            "allowed": False,
            "reason": "alpha_readiness_not_promotion_eligible",
            "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
            "read_model_unavailable": False,
            "promotion_authority": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
        }

        def _load_tca(_session: Session, **_kwargs: object) -> dict[str, object]:
            budget.current_elapsed = 9.2
            return {}

        with (
            patch(
                "app.api.trading_status._TradingStatusReadBudget", return_value=budget
            ),
            patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "latest_signal_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                    "source_ref": "clickhouse:ta_signals",
                },
            ),
            patch("app.api.status_helpers._load_tca_summary", side_effect=_load_tca),
            patch(
                "app.api.status_helpers._build_tigerbeetle_ledger_status"
            ) as tigerbeetle_status,
            patch(
                "app.api.status_helpers._daily_runtime_ledger_portfolio_summary"
            ) as portfolio_summary,
            patch(
                "app.api.status_helpers._build_hypothesis_runtime_payload"
            ) as hypothesis_runtime,
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                return_value=live_submission_gate_payload,
            ) as live_gate,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        tigerbeetle_status.assert_not_called()
        portfolio_summary.assert_not_called()
        hypothesis_runtime.assert_not_called()
        live_gate.assert_called_once()
        payload = response.json()
        skipped_reads = payload["status_read_budget"]["skipped_reads"]
        self.assertIn("tigerbeetle_ledger", skipped_reads)
        self.assertIn("runtime_ledger_portfolio_summary", skipped_reads)
        self.assertIn("hypothesis_runtime", skipped_reads)
        self.assertNotIn("live_submission_gate", skipped_reads)
        self.assertIn(
            "tigerbeetle_ledger_status_read_budget_insufficient_remaining",
            payload["tigerbeetle_ledger"]["blockers"],
        )
        self.assertTrue(
            payload["portfolio_runtime_ledger_summary"]["read_model_unavailable"]
        )
        self.assertTrue(payload["hypotheses"]["summary"]["read_model_unavailable"])
        self.assertEqual(
            payload["live_submission_gate"]["reason"],
            "alpha_readiness_not_promotion_eligible",
        )
