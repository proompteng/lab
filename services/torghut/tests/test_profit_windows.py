from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest import TestCase

from app.trading.profit_windows import build_profit_window_contract


class TestProfitWindowContracts(TestCase):
    def _window_by_hypothesis(
        self,
        contract: dict[str, object],
        hypothesis_id: str,
    ) -> dict[str, Any]:
        for window in contract["windows"]:
            assert isinstance(window, dict)
            if window.get("hypothesis_id") == hypothesis_id:
                return window
        self.fail(f"missing profit window for {hypothesis_id}")

    def _escrow_by_type(
        self,
        contract: dict[str, object],
        escrow_type: str,
    ) -> dict[str, Any]:
        for escrow in contract["escrows"]:
            assert isinstance(escrow, dict)
            if escrow.get("type") == escrow_type:
                return escrow
        self.fail(f"missing escrow {escrow_type}")

    def test_contract_marks_clickhouse_freshness_expired_in_replay_session(
        self,
    ) -> None:
        contract = build_profit_window_contract(
            runtime_items=[
                {
                    "hypothesis_id": "hyp-expired",
                    "lane_id": "lane-expired",
                    "capital_stage": "canary",
                    "dependency_capabilities": {
                        "required": ["market_context_freshness"],
                    },
                }
            ],
            quant_evidence={
                "ok": False,
                "blocking_reasons": ["quant_latest_metrics_empty"],
                "source_url": "http://jangar.test/quant/health",
            },
            empirical_jobs_status={
                "ready": True,
                "dataset_snapshot_refs": ["snap-1"],
            },
            market_context_ref={"last_domain_states": {}, "last_as_of": "fresh"},
            segment_summary={"market-context": {"reason_codes": []}},
            lineage_ref={"status": "ready", "dataset_snapshot_ref": "snap-1"},
            replay=True,
            now=datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc),
        )

        window = self._window_by_hypothesis(contract, "hyp-expired")
        clickhouse_escrow = self._escrow_by_type(contract, "clickhouse_freshness")

        self.assertEqual(contract["window_session_class"], "replay")
        self.assertEqual(window["decision"], "expired")
        self.assertEqual(window["capital_state"], "shadow")
        self.assertEqual(clickhouse_escrow["status"], "expired")

    def test_contract_marks_missing_empirical_jobs_underfunded(self) -> None:
        contract = build_profit_window_contract(
            runtime_items=[
                {
                    "hypothesis_id": "hyp-missing-empirical",
                    "lane_id": "lane-missing-empirical",
                    "capital_stage": "live",
                }
            ],
            quant_evidence={"ok": True, "blocking_reasons": []},
            empirical_jobs_status=None,
            market_context_ref={"last_domain_states": {}, "last_as_of": "fresh"},
            segment_summary={"market-context": {"reason_codes": []}},
            lineage_ref={"status": "ready", "dataset_snapshot_ref": "snap-1"},
            now=datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc),
        )

        window = self._window_by_hypothesis(contract, "hyp-missing-empirical")
        empirical_escrow = self._escrow_by_type(contract, "empirical_jobs")

        self.assertEqual(window["decision"], "underfunded")
        self.assertEqual(empirical_escrow["status"], "underfunded")
        self.assertIn("empirical_jobs_status_missing", empirical_escrow["reason_codes"])

    def test_contract_surfaces_partial_funding_for_optional_market_context(
        self,
    ) -> None:
        contract = build_profit_window_contract(
            runtime_items=[
                {
                    "hypothesis_id": "hyp-partial",
                    "lane_id": "lane-partial",
                    "capital_stage": "live",
                    "required_dependency_capabilities": "market_context_freshness",
                }
            ],
            quant_evidence={"ok": True, "blocking_reasons": []},
            empirical_jobs_status={
                "ready": True,
                "dataset_snapshot_refs": ["snap-1"],
            },
            market_context_ref={
                "alert_active": True,
                "alert_reason": "market_context_alert_active",
                "last_domain_states": {"macro": "stale"},
                "last_checked_at": "2026-05-05T12:00:00Z",
            },
            segment_summary={"market-context": {"reason_codes": ["macro_stale"]}},
            lineage_ref={"status": "ready", "dataset_snapshot_ref": "snap-1"},
            now=datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc),
        )

        window = self._window_by_hypothesis(contract, "hyp-partial")
        market_context_escrow = self._escrow_by_type(contract, "market_context")

        self.assertEqual(window["decision"], "partially_funded")
        self.assertEqual(window["capital_state"], "shadow")
        self.assertFalse(market_context_escrow["required"])
        self.assertEqual(market_context_escrow["status"], "expired")

    def test_contract_maps_funded_live_and_canary_capital_states(self) -> None:
        contract = build_profit_window_contract(
            runtime_items=[
                {
                    "hypothesis_id": "hyp-live",
                    "lane_id": "lane-live",
                    "capital_stage": "live-production",
                },
                {
                    "hypothesis_id": "hyp-canary",
                    "lane_id": "lane-canary",
                    "capital_stage": "canary-5",
                },
            ],
            quant_evidence={"ok": True, "blocking_reasons": []},
            empirical_jobs_status={
                "ready": True,
                "dataset_snapshot_refs": ["snap-1"],
            },
            market_context_ref={"last_domain_states": {}, "last_as_of": "fresh"},
            segment_summary={"market-context": {"reason_codes": []}},
            lineage_ref={"status": "ready", "dataset_snapshot_ref": "snap-1"},
            market_session_open=True,
            now=datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc),
        )

        live_window = self._window_by_hypothesis(contract, "hyp-live")
        canary_window = self._window_by_hypothesis(contract, "hyp-canary")

        self.assertEqual(contract["window_session_class"], "market_open")
        self.assertEqual(live_window["decision"], "funded")
        self.assertEqual(live_window["capital_state"], "live")
        self.assertEqual(canary_window["decision"], "funded")
        self.assertEqual(canary_window["capital_state"], "canary")
