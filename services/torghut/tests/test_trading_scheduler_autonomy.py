from __future__ import annotations

import asyncio
import json
import os
import tempfile
from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.config import TradingAccountLane, settings
from app.trading.ingest import SignalBatch
from app.trading.models import SignalEnvelope
from app.trading.scheduler.runtime import TradingScheduler
from app.trading.scheduler.state import TradingState


@dataclass
class _PipelineStub:
    signals: list[SignalEnvelope]
    session_factory: object
    no_signal_reason: str | None = None
    no_signal_lag_seconds: float | None = None
    market_session_open: bool = True
    state: TradingState | None = None

    def __post_init__(self) -> None:
        self.ingestor = self
        self.order_firewall = _OrderFirewallStub()
        self.universe_resolver = SimpleNamespace(
            get_resolution=lambda: SimpleNamespace(
                symbols={"AAPL"},
                source="jangar",
                status="ok",
                reason="jangar_fetch_ok",
                fetched_at=None,
                cache_age_seconds=0,
            )
        )

    def fetch_signals_between(
        self, start: datetime, end: datetime
    ) -> list[SignalEnvelope]:
        return list(self.signals)

    def fetch_signals_with_reason(
        self,
        start: datetime,
        end: datetime,
        symbol: str | None = None,
        limit: int | None = None,
    ) -> SignalBatch:
        return SignalBatch(
            signals=list(self.signals),
            cursor_at=None,
            cursor_seq=None,
            cursor_symbol=None,
            query_start=start,
            query_end=end,
            signal_lag_seconds=self.no_signal_lag_seconds,
            no_signal_reason=self.no_signal_reason,
        )

    def record_no_signal_batch(self, batch: SignalBatch) -> None:
        if self.state is None:
            return

        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason
        reason = batch.no_signal_reason
        normalized_reason = (reason or "unknown").strip() or "unknown"
        self.state.market_session_open = self.market_session_open
        self.state.metrics.market_session_open = 1 if self.market_session_open else 0
        if batch.signal_lag_seconds is not None:
            self.state.metrics.signal_lag_seconds = int(batch.signal_lag_seconds)
        else:
            self.state.metrics.signal_lag_seconds = None
        self.state.metrics.record_no_signal(reason)
        streak = self.state.metrics.no_signal_reason_streak.get(normalized_reason, 0)
        streak_threshold_met = (
            normalized_reason
            in {
                "no_signals_in_window",
                "cursor_tail_stable",
                "cursor_ahead_of_stream",
                "empty_batch_advanced",
            }
            and streak >= settings.trading_signal_no_signal_streak_alert_threshold
        )
        lag_threshold_met = (
            batch.signal_lag_seconds is not None
            and batch.signal_lag_seconds
            >= settings.trading_signal_stale_lag_alert_seconds
        )
        actionable = (
            normalized_reason == "cursor_ahead_of_stream"
            or self.market_session_open
            or normalized_reason
            not in settings.trading_signal_market_closed_expected_reasons
        )
        self.state.metrics.signal_continuity_actionable = 1 if actionable else 0
        self.state.last_signal_continuity_reason = normalized_reason
        self.state.last_signal_continuity_actionable = actionable
        self.state.last_signal_continuity_state = (
            "actionable_source_fault"
            if actionable
            else "expected_market_closed_staleness"
        )
        if actionable:
            self.state.metrics.record_signal_actionable_staleness(normalized_reason)
        else:
            self.state.metrics.record_signal_expected_staleness(normalized_reason)

        if actionable and (streak_threshold_met or lag_threshold_met):
            self.state.metrics.record_signal_staleness_alert(reason)
            if not self.state.signal_continuity_alert_active:
                self.state.signal_continuity_alert_started_at = datetime.now(
                    timezone.utc
                )
            self.state.signal_continuity_alert_active = True
            self.state.signal_continuity_alert_reason = normalized_reason
            self.state.signal_continuity_alert_last_seen_at = datetime.now(timezone.utc)
            self.state.signal_continuity_recovery_streak = 0
            self.state.metrics.record_signal_continuity_alert_state(
                active=True,
                recovery_streak=0,
            )
        elif actionable and self.state.signal_continuity_alert_active:
            self.state.signal_continuity_alert_reason = normalized_reason
            self.state.signal_continuity_alert_last_seen_at = datetime.now(timezone.utc)
            self.state.signal_continuity_recovery_streak = 0
            self.state.metrics.record_signal_continuity_alert_state(
                active=True,
                recovery_streak=0,
            )


class _PipelineIterationStub:
    def __init__(
        self,
        *,
        account_label: str,
        run_once_fail: bool = False,
        reconcile_return: int = 0,
        reconcile_fail: bool = False,
    ) -> None:
        self.account_label = account_label
        self.run_once_fail = run_once_fail
        self.reconcile_fail = reconcile_fail
        self.reconcile_return = reconcile_return
        self.run_once_calls = 0
        self.reconcile_calls = 0
        self.run_once_last_error: str | None = None
        self.reconcile_last_error: str | None = None

    def run_once(self) -> None:
        self.run_once_calls += 1
        if self.run_once_fail:
            self.run_once_last_error = "run_once_failed"
            raise RuntimeError("run_once_failed")

    def reconcile(self) -> int:
        self.reconcile_calls += 1
        if self.reconcile_fail:
            self.reconcile_last_error = "reconcile_failed"
            raise RuntimeError("reconcile_failed")
        return self.reconcile_return


class _SchedulerDependencies:
    def __init__(self) -> None:
        self.call_kwargs: dict[str, Any] = {}
        self.gate_payload: dict[str, Any] = {"recommended_mode": "paper", "gates": []}
        self.actuation_intent_path: Path | None = None
        self.phase_manifest_path: Path | None = None
        self.actuation_payload: dict[str, Any] | None = None


class _OrderFirewallStub:
    def status(self) -> SimpleNamespace:
        return SimpleNamespace(kill_switch_enabled=False, reason="ok")

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        return []


def _signal_batch() -> list[SignalEnvelope]:
    return [
        SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={
                "macd": {"macd": "1", "signal": "0"},
                "rsi14": "58",
                "price": "100",
            },
        ),
    ]


class TestTradingSchedulerAutonomy(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_autonomy_approval_token": settings.trading_autonomy_approval_token,
            "trading_strategy_config_path": settings.trading_strategy_config_path,
            "trading_autonomy_gate_policy_path": settings.trading_autonomy_gate_policy_path,
            "trading_autonomy_artifact_dir": settings.trading_autonomy_artifact_dir,
            "trading_signal_no_signal_streak_alert_threshold": settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_stale_lag_alert_seconds": settings.trading_signal_stale_lag_alert_seconds,
            "trading_signal_continuity_recovery_cycles": settings.trading_signal_continuity_recovery_cycles,
            "trading_signal_staleness_alert_critical_reasons_raw": (
                settings.trading_signal_staleness_alert_critical_reasons_raw
            ),
            "trading_signal_market_closed_expected_reasons_raw": (
                settings.trading_signal_market_closed_expected_reasons_raw
            ),
            "trading_evidence_continuity_run_limit": settings.trading_evidence_continuity_run_limit,
            "trading_rollback_signal_staleness_alert_streak_limit": (
                settings.trading_rollback_signal_staleness_alert_streak_limit
            ),
            "trading_universe_source": settings.trading_universe_source,
            "trading_emergency_stop_enabled": settings.trading_emergency_stop_enabled,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_drift_governance_enabled": settings.trading_drift_governance_enabled,
            "trading_drift_live_promotion_requires_evidence": settings.trading_drift_live_promotion_requires_evidence,
            "trading_drift_live_promotion_max_evidence_age_seconds": (
                settings.trading_drift_live_promotion_max_evidence_age_seconds
            ),
            "trading_drift_rollback_on_performance": settings.trading_drift_rollback_on_performance,
            "trading_drift_rollback_reason_codes_raw": settings.trading_drift_rollback_reason_codes_raw,
            "trading_drift_max_performance_drawdown": settings.trading_drift_max_performance_drawdown,
        }

    def tearDown(self) -> None:
        settings.trading_autonomy_allow_live_promotion = self._settings_snapshot[
            "trading_autonomy_allow_live_promotion"
        ]
        settings.trading_autonomy_approval_token = self._settings_snapshot[
            "trading_autonomy_approval_token"
        ]
        settings.trading_strategy_config_path = self._settings_snapshot[
            "trading_strategy_config_path"
        ]
        settings.trading_autonomy_gate_policy_path = self._settings_snapshot[
            "trading_autonomy_gate_policy_path"
        ]
        settings.trading_autonomy_artifact_dir = self._settings_snapshot[
            "trading_autonomy_artifact_dir"
        ]
        settings.trading_signal_no_signal_streak_alert_threshold = (
            self._settings_snapshot["trading_signal_no_signal_streak_alert_threshold"]
        )
        settings.trading_signal_stale_lag_alert_seconds = self._settings_snapshot[
            "trading_signal_stale_lag_alert_seconds"
        ]
        settings.trading_signal_continuity_recovery_cycles = self._settings_snapshot[
            "trading_signal_continuity_recovery_cycles"
        ]
        settings.trading_signal_staleness_alert_critical_reasons_raw = (
            self._settings_snapshot[
                "trading_signal_staleness_alert_critical_reasons_raw"
            ]
        )
        settings.trading_signal_market_closed_expected_reasons_raw = (
            self._settings_snapshot["trading_signal_market_closed_expected_reasons_raw"]
        )
        settings.trading_evidence_continuity_run_limit = self._settings_snapshot[
            "trading_evidence_continuity_run_limit"
        ]
        settings.trading_rollback_signal_staleness_alert_streak_limit = (
            self._settings_snapshot[
                "trading_rollback_signal_staleness_alert_streak_limit"
            ]
        )
        settings.trading_universe_source = self._settings_snapshot[
            "trading_universe_source"
        ]
        settings.trading_emergency_stop_enabled = self._settings_snapshot[
            "trading_emergency_stop_enabled"
        ]
        settings.trading_autonomy_enabled = self._settings_snapshot[
            "trading_autonomy_enabled"
        ]
        settings.trading_drift_governance_enabled = self._settings_snapshot[
            "trading_drift_governance_enabled"
        ]
        settings.trading_drift_live_promotion_requires_evidence = (
            self._settings_snapshot["trading_drift_live_promotion_requires_evidence"]
        )
        settings.trading_drift_live_promotion_max_evidence_age_seconds = (
            self._settings_snapshot[
                "trading_drift_live_promotion_max_evidence_age_seconds"
            ]
        )
        settings.trading_drift_rollback_on_performance = self._settings_snapshot[
            "trading_drift_rollback_on_performance"
        ]
        settings.trading_drift_rollback_reason_codes_raw = self._settings_snapshot[
            "trading_drift_rollback_reason_codes_raw"
        ]
        settings.trading_drift_max_performance_drawdown = self._settings_snapshot[
            "trading_drift_max_performance_drawdown"
        ]

    def test_run_autonomous_cycle_uses_live_promotion_when_token_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            outcome_path = Path(tmpdir) / "drift-outcome.json"
            outcome_path.write_text(
                json.dumps(
                    {
                        "checked_at": datetime.now(timezone.utc).isoformat(),
                        "eligible_for_live_promotion": True,
                        "reasons": [],
                    }
                ),
                encoding="utf-8",
            )
            scheduler.state.drift_last_outcome_path = str(outcome_path)
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "live")
            self.assertEqual(deps.call_kwargs["approval_token"], "live-approve-token")

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_drift_evidence_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token="live-approve-token",
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_falls_back_to_paper_when_live_token_missing(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=True,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(deps.call_kwargs["promotion_target"], "paper")
            self.assertIsNone(deps.call_kwargs["approval_token"])

    def test_run_autonomous_cycle_uses_strategy_paths_from_settings(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                deps.call_kwargs["strategy_config_path"],
                Path(settings.trading_strategy_config_path),
            )
            self.assertEqual(
                deps.call_kwargs["gate_policy_path"],
                Path(settings.trading_autonomy_gate_policy_path),
            )

    def test_run_autonomous_cycle_passes_persistence_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertTrue(deps.call_kwargs["persist_results"])
            self.assertIsNotNone(deps.call_kwargs["session_factory"])
            self.assertIsNotNone(deps.call_kwargs["session_factory"])
            self.assertEqual(
                deps.call_kwargs["governance_repository"], "proompteng/lab"
            )
            self.assertEqual(deps.call_kwargs["governance_base"], "main")
            self.assertEqual(
                deps.call_kwargs["governance_change"], "autonomous-promotion"
            )
            self.assertEqual(
                deps.call_kwargs["governance_reason"],
                "Autonomous recommendation for paper target.",
            )
            self.assertTrue(
                str(deps.call_kwargs["governance_head"]).startswith(
                    "agentruns/torghut-autonomy-"
                )
            )
            run_output_dir = Path(deps.call_kwargs["output_dir"])
            self.assertEqual(
                deps.call_kwargs["governance_artifact_path"], str(run_output_dir)
            )
            self.assertTrue(
                deps.call_kwargs["governance_artifact_path"].startswith(
                    str(Path(tmpdir) / "autonomy-artifacts")
                )
            )
            self.assertIsNone(deps.call_kwargs["priority_id"])

    def test_run_autonomous_cycle_accepts_governance_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            governance_root = Path(tmpdir) / "custom-autonomy-artifacts"
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle(
                    governance_repository="acme/lab",
                    governance_base="release",
                    governance_head="manual-autonomy-head",
                    governance_artifact_root=str(governance_root),
                    priority_id="priority-123",
                )

            self.assertEqual(
                deps.call_kwargs["governance_repository"], "acme/lab"
            )
            self.assertEqual(deps.call_kwargs["governance_base"], "release")
            self.assertEqual(deps.call_kwargs["governance_head"], "manual-autonomy-head")
            self.assertEqual(deps.call_kwargs["priority_id"], "priority-123")
            run_output_dir = Path(deps.call_kwargs["output_dir"])
            self.assertTrue(str(run_output_dir).startswith(str(governance_root)))
            self.assertEqual(
                deps.call_kwargs["governance_artifact_path"], str(run_output_dir)
            )

    def test_run_autonomous_cycle_records_gate_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_gates, str(deps.gate_report_path)
            )
            self.assertEqual(scheduler.state.last_autonomy_run_id, "test-run-id")
            self.assertEqual(scheduler.state.last_autonomy_recommendation, "paper")
            self.assertEqual(
                scheduler.state.last_autonomy_actuation_intent,
                str(deps.actuation_intent_path),
            )
            self.assertIn("drift_promotion_evidence", deps.call_kwargs)

    def test_run_autonomous_cycle_tracks_promotion_and_throughput_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "promotion_recommendation": {
                    "action": "promote",
                    "eligible": True,
                    "trace_id": "rec-trace-123",
                },
                "throughput": {
                    "signal_count": 9,
                    "decision_count": 7,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                    "no_signal_window": False,
                    "no_signal_reason": None,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                    "reason_codes": [],
                },
            }
            deps.actuation_payload = {
                "schema_version": "torghut.autonomy.actuation-intent.v1",
                "run_id": "test-run-id",
                "candidate_id": "cand-test",
                "actuation_allowed": True,
                "gates": {
                    "recommendation_trace_id": "rec-trace-123",
                    "gate_report_trace_id": "gate-trace-test",
                    "recommendation_reasons": ["unit_test"],
                },
                "artifact_refs": [],
                "audit": {
                    "rollback_readiness_readout": {
                        "kill_switch_dry_run_passed": True,
                        "gitops_revert_dry_run_passed": True,
                        "strategy_disable_dry_run_passed": True,
                    }
                },
            }
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.last_autonomy_promotion_action, "promote")
            self.assertTrue(scheduler.state.last_autonomy_promotion_eligible)
            self.assertEqual(
                scheduler.state.last_autonomy_recommendation_trace_id, "rec-trace-123"
            )
            self.assertEqual(scheduler.state.metrics.autonomy_promotions_total, 1)
            self.assertEqual(scheduler.state.metrics.autonomy_last_signal_count, 9)
            self.assertEqual(scheduler.state.metrics.autonomy_last_decision_count, 7)
            self.assertEqual(scheduler.state.metrics.autonomy_last_trade_count, 3)
            self.assertEqual(
                scheduler.state.metrics.autonomy_last_fold_metrics_count, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_last_stress_metrics_count, 4
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_signal_throughput_total, 9
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_decision_throughput_total, 7
            )
            self.assertEqual(scheduler.state.metrics.autonomy_trade_throughput_total, 3)
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_allowed_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total, 0
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_recommendation_total.get("paper"), 1
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("promoted_paper"), 1
            )

    def test_run_autonomous_cycle_blocks_promotion_when_actuation_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            deps.actuation_payload = {
                "schema_version": "torghut.autonomy.actuation-intent.v1",
                "run_id": "test-run-id",
                "candidate_id": "cand-test",
                "actuation_allowed": False,
                "gates": {
                    "recommendation_trace_id": "blocked-trace",
                    "gate_report_trace_id": "gate-trace-test",
                    "recommendation_reasons": ["rollback_checks_missing"],
                    "promotion_allowed": True,
                },
                "artifact_refs": [],
                "audit": {
                    "rollback_evidence_missing_checks": [
                        "killSwitchDryRunFailed"
                    ],
                    "rollback_readiness_readout": {
                        "kill_switch_dry_run_passed": False,
                        "gitops_revert_dry_run_passed": False,
                        "strategy_disable_dry_run_passed": False,
                        "human_approved": False,
                        "rollback_target": "live",
                        "dry_run_completed_at": "",
                    },
                },
            }
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "promotion_recommendation": {
                    "action": "promote",
                    "eligible": True,
                    "trace_id": "rec-trace-blocked",
                },
                "throughput": {
                    "signal_count": 9,
                    "decision_count": 7,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                    "no_signal_window": False,
                    "no_signal_reason": None,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                    "reason_codes": [],
                },
            }
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_promotion_action, "promote"
            )
            self.assertTrue(scheduler.state.last_autonomy_promotion_eligible)
            self.assertEqual(
                scheduler.state.last_autonomy_recommendation_trace_id, "blocked-trace"
            )
            self.assertEqual(scheduler.state.metrics.autonomy_promotions_total, 1)
            self.assertEqual(scheduler.state.metrics.autonomy_promotion_allowed_total, 0)
            self.assertEqual(scheduler.state.metrics.autonomy_promotion_blocked_total, 1)
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("blocked_paper"), 1
            )

    def test_run_autonomous_cycle_records_ingest_reason_when_no_signals(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            with patch(
                "app.trading.scheduler.governance.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ) as persist_no_signal:
                with patch(
                    "app.trading.scheduler.governance.run_autonomous_lane",
                    side_effect=RuntimeError("should_not_run"),
                ):
                    scheduler._run_autonomous_cycle()

            persist_no_signal.assert_called_once()
            args = persist_no_signal.call_args.kwargs
            self.assertEqual(args["no_signal_reason"], "cursor_ahead_of_stream")
            self.assertIsNotNone(args["query_start"])
            self.assertIsNotNone(args["query_end"])

            self.assertEqual(
                scheduler.state.last_ingest_reason, "cursor_ahead_of_stream"
            )
            self.assertEqual(
                scheduler.state.last_autonomy_reason, "cursor_ahead_of_stream"
            )
            self.assertEqual(scheduler.state.last_autonomy_run_id, "no-signal-run-id")
            self.assertIn("no-signals.json", scheduler.state.last_autonomy_gates or "")
            self.assertIsNone(scheduler.state.last_autonomy_actuation_intent)
            self.assertEqual(
                scheduler.state.metrics.autonomy_promotion_blocked_total,
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_recommendation_total.get("shadow"),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.autonomy_outcome_total.get("skipped_no_signal"),
                1,
            )

    def test_run_autonomous_cycle_uses_simulation_clock_for_no_signal_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            simulation_now = datetime(2026, 3, 11, 14, 5, 40, tzinfo=timezone.utc)
            lookback = timedelta(
                minutes=max(1, int(settings.trading_autonomy_signal_lookback_minutes))
            )
            with (
                patch.object(settings, "trading_simulation_enabled", True),
                patch(
                    "app.trading.scheduler.governance.trading_now",
                    return_value=simulation_now,
                ),
                patch(
                    "app.trading.scheduler.governance.upsert_autonomy_no_signal_run",
                    return_value="no-signal-run-id",
                ) as persist_no_signal,
                patch(
                    "app.trading.scheduler.governance.run_autonomous_lane",
                    side_effect=RuntimeError("should_not_run"),
                ),
            ):
                scheduler._run_autonomous_cycle()

            args = persist_no_signal.call_args.kwargs
            self.assertEqual(args["query_end"], simulation_now)
            self.assertEqual(args["query_start"], simulation_now - lookback)
            self.assertEqual(scheduler.state.last_autonomy_run_at, simulation_now)

    def test_run_autonomous_cycle_updates_ingest_metadata_on_signal_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            stale_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
            scheduler.state.last_ingest_window_start = stale_time
            scheduler.state.last_ingest_window_end = stale_time
            scheduler.state.last_ingest_reason = "stale-no-signal"

            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertIsNone(scheduler.state.last_ingest_reason)
            assert scheduler.state.last_ingest_window_start is not None
            assert scheduler.state.last_ingest_window_end is not None
            self.assertGreater(scheduler.state.last_ingest_window_start, stale_time)
            self.assertGreater(scheduler.state.last_ingest_window_end, stale_time)
            self.assertEqual(scheduler.state.last_ingest_signals_total, 1)
            self.assertEqual(scheduler.state.autonomy_signals_total, 1)

    def test_run_autonomous_cycle_alerts_on_repeated_no_signal_reasons(self) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 2
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="cursor_ahead_of_stream",
            )
            with patch(
                "app.trading.scheduler.governance.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak,
                {"cursor_ahead_of_stream": 1},
            )
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "cursor_ahead_of_stream"
                ),
            )

            with patch(
                "app.trading.scheduler.governance.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak,
                {"cursor_ahead_of_stream": 2},
            )
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "cursor_ahead_of_stream"
                ),
                1,
            )

    def test_run_autonomous_cycle_alerts_on_signal_lag(self) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 99
        settings.trading_signal_stale_lag_alert_seconds = 30
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="empty_batch_advanced",
                no_signal_lag_seconds=61.2,
            )
            with patch(
                "app.trading.scheduler.governance.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(scheduler.state.metrics.signal_lag_seconds, 61)
            self.assertEqual(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "empty_batch_advanced"
                ),
                1,
            )
            self.assertEqual(
                scheduler.state.metrics.no_signal_reason_streak.get(
                    "empty_batch_advanced"
                ),
                1,
            )

    def test_run_autonomous_cycle_treats_market_closed_no_signal_as_expected(
        self,
    ) -> None:
        settings.trading_signal_no_signal_streak_alert_threshold = 1
        settings.trading_signal_stale_lag_alert_seconds = 30
        settings.trading_signal_market_closed_expected_reasons_raw = (
            "no_signals_in_window,cursor_tail_stable,empty_batch_advanced"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
                no_signals=True,
                no_signal_reason="empty_batch_advanced",
                no_signal_lag_seconds=120.0,
                market_session_open=False,
            )
            with patch(
                "app.trading.scheduler.governance.upsert_autonomy_no_signal_run",
                return_value="no-signal-run-id",
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_signal_continuity_state,
                "expected_market_closed_staleness",
            )
            self.assertFalse(bool(scheduler.state.last_signal_continuity_actionable))
            self.assertEqual(
                scheduler.state.metrics.signal_expected_staleness_total.get(
                    "empty_batch_advanced"
                ),
                1,
            )
            self.assertIsNone(
                scheduler.state.metrics.signal_staleness_alert_total.get(
                    "empty_batch_advanced"
                )
            )

    def test_run_autonomous_cycle_records_error_on_lane_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler.state.last_autonomy_run_id = "stale-run-id"
            scheduler.state.last_autonomy_candidate_id = "stale-candidate-id"
            scheduler.state.last_autonomy_gates = str(Path(tmpdir) / "stale-gates.json")
            scheduler.state.last_autonomy_actuation_intent = (
                str(Path(tmpdir) / "stale-actuation-intent.json")
            )
            scheduler.state.last_autonomy_patch = str(Path(tmpdir) / "stale-patch.yaml")
            scheduler.state.last_autonomy_recommendation = "paper"
            scheduler.state.last_autonomy_recommendation_trace_id = "stale-rec-trace"
            scheduler.state.last_autonomy_promotion_action = "promote"
            scheduler.state.last_autonomy_promotion_eligible = True
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=RuntimeError("lane_failed"),
            ):
                scheduler._run_autonomous_cycle()

            self.assertEqual(
                scheduler.state.last_autonomy_reason, "lane_execution_failed"
            )
            self.assertEqual(scheduler.state.last_autonomy_error, "lane_failed")
            self.assertIsNone(scheduler.state.last_autonomy_run_id)
            self.assertIsNone(scheduler.state.last_autonomy_candidate_id)
            self.assertIsNone(scheduler.state.last_autonomy_gates)
            self.assertIsNone(scheduler.state.last_autonomy_actuation_intent)
            self.assertIsNone(scheduler.state.last_autonomy_patch)
            self.assertIsNone(scheduler.state.last_autonomy_recommendation)
            self.assertIsNone(scheduler.state.last_autonomy_promotion_action)
            self.assertIsNone(scheduler.state.last_autonomy_promotion_eligible)
            self.assertIsNone(scheduler.state.last_autonomy_recommendation_trace_id)
            self.assertIsNone(scheduler.state.last_autonomy_throughput)

    def test_run_evidence_continuity_check_updates_scheduler_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_evidence_continuity_run_limit = 3
            with patch(
                "app.trading.scheduler.governance.evaluate_evidence_continuity"
            ) as mock_check:
                mock_check.return_value = SimpleNamespace(
                    checked_at=datetime(2026, 2, 19, 1, 0, tzinfo=timezone.utc),
                    checked_runs=2,
                    failed_runs=1,
                    run_ids=["run-1", "run-2"],
                    to_payload=lambda: {
                        "checked_runs": 2,
                        "failed_runs": 1,
                        "ok": False,
                    },
                )
                scheduler._run_evidence_continuity_check()

            mock_check.assert_called_once()
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_checks_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_failures_total, 1
            )
            self.assertEqual(
                scheduler.state.metrics.evidence_continuity_last_failed_runs, 1
            )
            self.assertEqual(
                scheduler.state.last_evidence_continuity_report,
                {"checked_runs": 2, "failed_runs": 1, "ok": False},
            )

    def test_safety_controls_trigger_emergency_stop_on_critical_staleness_streak(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_rollback_signal_staleness_alert_streak_limit = 2
            settings.trading_signal_staleness_alert_critical_reasons_raw = (
                "cursor_ahead_of_stream"
            )
            scheduler.state.metrics.no_signal_reason_streak = {
                "cursor_ahead_of_stream": 2
            }
            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)
            self.assertIn(
                "signal_staleness_streak_exceeded:cursor_ahead_of_stream:2",
                scheduler.state.emergency_stop_reason or "",
            )

    def test_safety_controls_trigger_emergency_stop_when_universe_unavailable(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_emergency_stop_enabled = True
            settings.trading_universe_source = "jangar"
            scheduler.state.universe_source_status = "unavailable"
            scheduler.state.universe_source_reason = "jangar_symbols_fetch_failed"

            scheduler._evaluate_safety_controls()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "universe_source_unavailable:unavailable:jangar_symbols_fetch_failed",
                scheduler.state.emergency_stop_reason or "",
            )

    def test_emergency_stop_incident_contains_hooks_and_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-123",
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-1",
                            "recommendation_trace_id": "rec-trace-1",
                        },
                    },
                ),
                encoding="utf-8",
            )
            scheduler.state.last_autonomy_gates = str(gate_path)
            scheduler.state.metrics.no_signal_reason_streak = {
                "cursor_ahead_of_stream": 3
            }
            scheduler.state.metrics.signal_staleness_alert_total = {
                "cursor_ahead_of_stream": 2
            }

            scheduler._trigger_emergency_stop(
                reasons=["signal_staleness_streak_exceeded:cursor_ahead_of_stream:3"],
                fallback_ratio=0.0,
                drawdown=None,
            )

            incident_path = Path(scheduler.state.rollback_incident_evidence_path or "")
            self.assertTrue(incident_path.exists())
            payload = json.loads(incident_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["provenance"]["gate_report_trace_id"], "gate-trace-1"
            )
            self.assertEqual(
                payload["provenance"]["recommendation_trace_id"], "rec-trace-1"
            )
            self.assertTrue(payload["rollback_hooks"]["order_submission_blocked"])
            self.assertTrue(payload["verification"]["incident_evidence_complete"])

    def test_drift_governance_triggers_rollback_on_performance_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            settings.trading_drift_rollback_on_performance = True
            settings.trading_emergency_stop_enabled = True
            settings.trading_drift_rollback_reason_codes_raw = (
                "performance_drawdown_exceeded"
            )
            settings.trading_drift_max_performance_drawdown = 0.01
            deps.gate_payload = {
                "recommended_mode": "paper",
                "gates": [],
                "metrics": {"max_drawdown": "0.25"},
            }
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                scheduler._run_autonomous_cycle()

            self.assertTrue(scheduler.state.emergency_stop_active)
            self.assertIn(
                "drift_reason_detected:performance_drawdown_exceeded",
                scheduler.state.emergency_stop_reason or "",
            )
            self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)

    def test_run_trading_iteration_continues_with_partial_lane_failure(self) -> None:
        scheduler = TradingScheduler()
        failing_lane = _PipelineIterationStub(account_label="paper-a", run_once_fail=True)
        healthy_lane = _PipelineIterationStub(account_label="paper-b")
        scheduler._pipelines = [failing_lane, healthy_lane]
        scheduler._pipeline = failing_lane

        safety_calls = {"count": 0}

        def _capture_safety() -> None:
            safety_calls["count"] += 1

        scheduler._evaluate_safety_controls = _capture_safety
        asyncio.run(scheduler._run_trading_iteration())

        self.assertEqual(failing_lane.run_once_calls, 1)
        self.assertEqual(healthy_lane.run_once_calls, 1)
        self.assertIsNone(scheduler.state.last_error)
        self.assertEqual(safety_calls["count"], 1)
        self.assertIsNotNone(scheduler.state.last_run_at)
        self.assertEqual(failing_lane.run_once_last_error, "run_once_failed")
        self.assertEqual(healthy_lane.run_once_last_error, None)

    def test_run_reconcile_iteration_continues_with_partial_lane_failure(self) -> None:
        scheduler = TradingScheduler()
        failing_lane = _PipelineIterationStub(
            account_label="paper-a",
            reconcile_fail=True,
        )
        healthy_lane = _PipelineIterationStub(
            account_label="paper-b",
            reconcile_return=2,
        )
        scheduler._pipelines = [failing_lane, healthy_lane]
        scheduler._pipeline = failing_lane

        safety_calls = {"count": 0}

        def _capture_safety() -> None:
            safety_calls["count"] += 1

        scheduler._evaluate_safety_controls = _capture_safety
        asyncio.run(scheduler._run_reconcile_iteration())

        self.assertEqual(failing_lane.reconcile_calls, 1)
        self.assertEqual(healthy_lane.reconcile_calls, 1)
        self.assertEqual(healthy_lane.reconcile_return, 2)
        self.assertIsNone(scheduler.state.last_error)
        self.assertEqual(safety_calls["count"], 1)
        self.assertIsNotNone(scheduler.state.last_reconcile_at)
        self.assertEqual(failing_lane.reconcile_last_error, "reconcile_failed")
        self.assertEqual(healthy_lane.reconcile_last_error, None)

    def test_run_autonomy_iteration_triggers_rollback_when_failure_streak_exceeds_limit(self) -> None:
        original_emergency_stop = settings.trading_emergency_stop_enabled
        original_autonomy_rollback_limit = (
            settings.trading_rollback_autonomy_failure_streak_limit
        )
        original_critical_reasons = (
            settings.trading_signal_staleness_alert_critical_reasons_raw
        )

        try:
            settings.trading_emergency_stop_enabled = True
            settings.trading_rollback_autonomy_failure_streak_limit = 1
            settings.trading_signal_staleness_alert_critical_reasons_raw = ""

            with tempfile.TemporaryDirectory() as tmpdir:
                scheduler, _deps = self._build_scheduler_with_fixtures(
                    tmpdir,
                    allow_live=False,
                    approval_token=None,
                    no_signals=True,
                    no_signal_reason=None,
                )

                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._run_autonomous_cycle",
                    side_effect=RuntimeError("autonomy-cycle-failed"),
                ):
                    asyncio.run(scheduler._run_autonomy_iteration())

                self.assertEqual(
                    scheduler.state.last_error,
                    "emergency_stop_triggered reasons=autonomy_failure_streak_exceeded:1",
                )
                self.assertEqual(scheduler.state.last_autonomy_error, "autonomy-cycle-failed")
                self.assertEqual(scheduler.state.autonomy_failure_streak, 1)
                self.assertTrue(scheduler.state.emergency_stop_active)
                self.assertIn(
                    "autonomy_failure_streak_exceeded:1",
                    scheduler.state.emergency_stop_reason or "",
                )
                self.assertIsNotNone(scheduler.state.rollback_incident_evidence_path)
                self.assertEqual(scheduler.state.rollback_incidents_total, 1)
        finally:
            settings.trading_emergency_stop_enabled = original_emergency_stop
            settings.trading_rollback_autonomy_failure_streak_limit = (
                original_autonomy_rollback_limit
            )
            settings.trading_signal_staleness_alert_critical_reasons_raw = (
                original_critical_reasons
            )

    def test_build_pipeline_for_account_scopes_order_feed_ingestor(self) -> None:
        scheduler = TradingScheduler()
        lane = TradingAccountLane(
            label="paper-x",
            api_key="k",
            secret_key="s",
            base_url="https://api.example.invalid",
            enabled=True,
        )
        pipeline = scheduler._build_pipeline_for_account(lane)

        self.assertEqual(
            pipeline.order_feed_ingestor._default_account_label,  # type: ignore[attr-defined]
            "paper-x",
        )
    def test_run_autonomous_cycle_passes_autonomy_execution_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch.dict(
                os.environ,
                {
                    "GITHUB_REPOSITORY": "acme/torghut",
                    "GITHUB_BASE_REF": "release",
                    "GITHUB_HEAD_REF": "feature/abc-123",
                    "PRIORITY_ID": "42",
                },
                clear=False,
            ):
                with patch(
                    "app.trading.scheduler.governance.run_autonomous_lane",
                    side_effect=self._fake_run_autonomous_lane(deps),
                ):
                    scheduler._run_autonomous_cycle()

            governance_inputs = deps.call_kwargs.get("governance_inputs")
            self.assertIsInstance(governance_inputs, dict)
            execution_context = governance_inputs.get("execution_context")
            self.assertIsInstance(execution_context, dict)
            self.assertEqual(execution_context.get("repository"), "acme/torghut")
            self.assertEqual(execution_context.get("base"), "release")
            self.assertEqual(execution_context.get("head"), "feature/abc-123")
            self.assertEqual(
                execution_context.get("artifactPath"),
                str(Path(deps.call_kwargs.get("output_dir")).parent),
            )
            self.assertEqual(execution_context.get("priorityId"), "42")

    def test_run_autonomous_cycle_writes_iteration_notes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(_deps),
            ):
                scheduler._run_autonomous_cycle()

            notes_path = (
                Path(scheduler.state.last_autonomy_iteration_notes_path or "")
                if scheduler.state.last_autonomy_iteration_notes_path
                else None
            )
            self.assertIsNotNone(notes_path)
            assert notes_path is not None
            self.assertTrue(notes_path.exists())
            self.assertEqual(notes_path.parent.name, "notes")
            self.assertEqual(notes_path.name, "iteration-1.md")
            self.assertEqual(
                scheduler.state.last_autonomy_iteration,
                1,
            )

            notes_payload = json.loads(notes_path.read_text(encoding="utf-8"))
            self.assertEqual(notes_payload.get("status"), "lane_completed")
            self.assertEqual(
                notes_payload.get("phase_manifest_path"),
                scheduler.state.last_autonomy_phase_manifest,
            )

    def test_append_runtime_governance_updates_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler.state.drift_last_detection_path = str(
                Path(tmpdir) / "drift-detection.json"
            )
            scheduler.state.drift_last_action_path = str(
                Path(tmpdir) / "drift-action.json"
            )
            scheduler.state.drift_last_outcome_path = str(
                Path(tmpdir) / "drift-outcome.json"
            )
            scheduler.state.rollback_incident_evidence_path = str(
                Path(tmpdir) / "rollback-evidence.json"
            )
            Path(scheduler.state.drift_last_detection_path).write_text("{}", encoding="utf-8")
            Path(scheduler.state.drift_last_action_path).write_text("{}", encoding="utf-8")
            Path(scheduler.state.drift_last_outcome_path).write_text("{}", encoding="utf-8")
            Path(scheduler.state.rollback_incident_evidence_path).write_text(
                "{}", encoding="utf-8"
            )
            scheduler.state.emergency_stop_active = True

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            preexisting_top_level_ref = str(
                Path(tmpdir) / "backtest" / "walkforward-results.json"
            )
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-1",
                "candidate_id": "cand-1",
                "phases": [
                    {"name": "gate-evaluation", "status": "pass", "artifact_refs": []},
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "rollback-proof", "status": "pass", "artifact_refs": []},
                ],
                "artifact_refs": [preexisting_top_level_ref],
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2), encoding="utf-8"
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "drift_detected",
                    "detection": {"reason_codes": ["performance_drawdown_exceeded"]},
                    "action": {
                        "action_type": "quarantine",
                        "triggered": True,
                        "reason_codes": ["performance_drawdown_exceeded"],
                    },
                    "reasons": ["evidence_anomaly"],
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
            phases = updated_manifest["phases"]
            self.assertEqual(
                [phase["name"] for phase in phases],
                [
                    "gate-evaluation",
                    "promotion-prerequisites",
                    "rollback-readiness",
                    "drift-gate",
                    "paper-canary",
                    "runtime-governance",
                    "rollback-proof",
                ],
            )
            self.assertEqual(
                phases[5]["status"],
                "fail",
                "drift detected should fail runtime governance",
            )
            self.assertEqual(
                phases[6]["status"],
                "pass",
                "rollback proof should pass when evidence is attached",
            )
            self.assertIn(
                "rollback_incident_evidence_path",
                updated_manifest["rollback_proof"],
            )
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence_path"],
                str(scheduler.state.rollback_incident_evidence_path),
            )
            self.assertIn(
                str(scheduler.state.rollback_incident_evidence_path),
                updated_manifest["artifact_refs"],
            )
            self.assertIn(preexisting_top_level_ref, updated_manifest["artifact_refs"])
            self.assertIn(
                {"from": "drift-gate", "to": "paper-canary", "status": "pass"},
                updated_manifest["phase_transitions"],
            )

    def test_append_runtime_governance_updates_manifest_fails_when_rollback_triggered_without_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-2",
                "candidate_id": "cand-2",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {"name": "runtime-governance", "status": "pass", "artifact_refs": []},
                    {"name": "rollback-proof", "status": "pass", "artifact_refs": []},
                ],
                "artifact_refs": [str(Path(tmpdir) / "backtest" / "walkforward-results.json")],
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2), encoding="utf-8"
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "stable",
                    "reasons": ["watchlist_signal"],
                    "rollback_triggered": True,
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
            phases = updated_manifest["phases"]
            self.assertEqual(
                [phase["name"] for phase in phases],
                [
                    "gate-evaluation",
                    "promotion-prerequisites",
                    "rollback-readiness",
                    "drift-gate",
                    "paper-canary",
                    "runtime-governance",
                    "rollback-proof",
                ],
            )
            self.assertEqual(phases[5]["status"], "fail")
            self.assertEqual(phases[6]["status"], "fail")
            self.assertEqual(updated_manifest["rollback_proof"]["status"], "fail")
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"],
                "",
            )
            self.assertEqual(updated_manifest["runtime_governance"]["reasons"], ["watchlist_signal"])
            self.assertEqual(updated_manifest["rollback_proof"]["reasons"], ["watchlist_signal"])
            self.assertIn(
                {"from": "runtime-governance", "to": "rollback-proof", "status": "fail"},
                updated_manifest["phase_transitions"],
            )

    def test_append_runtime_governance_adds_missing_runtime_and_rollback_phases(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-3",
                "candidate_id": "cand-3",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                ],
                "artifact_refs": [str(Path(tmpdir) / "backtest" / "walkforward-results.json")],
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2), encoding="utf-8"
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "stable",
                    "action": {"action_type": "none", "triggered": False},
                    "detection": {"reason_codes": []},
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                [phase["name"] for phase in updated_manifest["phases"]],
                [
                    "gate-evaluation",
                    "promotion-prerequisites",
                    "rollback-readiness",
                    "drift-gate",
                    "paper-canary",
                    "runtime-governance",
                    "rollback-proof",
                ],
            )
            self.assertEqual(updated_manifest["phases"][5]["status"], "pass")
            self.assertEqual(updated_manifest["phases"][6]["status"], "pass")
            self.assertEqual(updated_manifest["runtime_governance"]["governance_status"], "pass")
            self.assertEqual(updated_manifest["rollback_proof"]["rollback_incident_evidence"], "")
            phase_transition = {
                (transition.get("from"), transition.get("to")): transition.get("status")
                for transition in updated_manifest["phase_transitions"]
                if isinstance(transition, dict)
            }
            self.assertEqual(
                phase_transition.get(("runtime-governance", "rollback-proof")),
                "pass",
            )

    def test_run_autonomy_cycle_appends_runtime_governance_with_rollback_trigger_and_state_evidence_path(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            scheduler.state.rollback_incident_evidence_path = str(
                Path(tmpdir) / "state-incident.json"
            )
            Path(scheduler.state.rollback_incident_evidence_path).write_text(
                json.dumps(
                    {
                        "triggered_by": "state-fallback",
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )

            drift_payload = {
                "drift_status": "drift_detected",
                "reasons": ["fallback_ratio_regression"],
                "detection": {
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "action": {
                    "action_type": "quarantine",
                    "triggered": True,
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "rollback_triggered": True,
            }

            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._evaluate_drift_governance",
                    return_value=drift_payload,
                ):
                    scheduler._run_autonomous_cycle()

            manifest_path = deps.phase_manifest_path
            self.assertIsNotNone(manifest_path)
            assert manifest_path is not None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            phases_by_name = {
                phase["name"]: phase for phase in manifest["phases"] if isinstance(phase, dict)
            }
            self.assertEqual(phases_by_name["runtime-governance"]["status"], "fail")
            self.assertEqual(phases_by_name["rollback-proof"]["status"], "pass")
            self.assertEqual(
                manifest["rollback_proof"]["rollback_incident_evidence_path"],
                str(scheduler.state.rollback_incident_evidence_path),
            )
            self.assertIn(
                str(scheduler.state.rollback_incident_evidence_path),
                manifest["artifact_refs"],
            )
            self.assertIn(
                {"from": "runtime-governance", "to": "rollback-proof", "status": "pass"},
                manifest["phase_transitions"],
            )

    def test_run_autonomy_cycle_appends_runtime_governance_fails_on_trigger_without_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )

            drift_payload = {
                "drift_status": "drift_detected",
                "reasons": ["fallback_ratio_regression"],
                "detection": {
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "action": {
                    "action_type": "quarantine",
                    "triggered": True,
                    "reason_codes": ["fallback_ratio_regression"],
                },
                "rollback_triggered": True,
            }

            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=self._fake_run_autonomous_lane(deps),
            ):
                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._evaluate_drift_governance",
                    return_value=drift_payload,
                ):
                    scheduler._run_autonomous_cycle()

            manifest_path = deps.phase_manifest_path
            self.assertIsNotNone(manifest_path)
            assert manifest_path is not None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            phases_by_name = {
                phase["name"]: phase for phase in manifest["phases"] if isinstance(phase, dict)
            }
            self.assertEqual(phases_by_name["runtime-governance"]["status"], "fail")
            self.assertEqual(phases_by_name["rollback-proof"]["status"], "fail")
            self.assertEqual(manifest["rollback_proof"]["rollback_incident_evidence"], "")
            self.assertIn(
                {"from": "runtime-governance", "to": "rollback-proof", "status": "fail"},
                manifest["phase_transitions"],
            )

    def test_append_runtime_governance_ignores_stale_rollback_evidence_when_not_triggered(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            stale_incident_path = Path(tmpdir) / "stale-incident.json"
            stale_incident_path.write_text(
                json.dumps({"trigger": "historical-stop"}),
                encoding="utf-8",
            )
            scheduler.state.drift_last_detection_path = str(stale_incident_path)
            scheduler.state.drift_last_action_path = str(stale_incident_path)
            scheduler.state.drift_last_outcome_path = str(stale_incident_path)
            scheduler.state.rollback_incident_evidence_path = str(stale_incident_path)

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-stale",
                "candidate_id": "cand-stale",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "rollback-proof", "status": "pass", "artifact_refs": []},
                ],
                "runtime_governance": {"rollback_triggered": False},
                "rollback_proof": {"rollback_triggered": False},
                "artifact_refs": [],
                "phase_count": 7,
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2),
                encoding="utf-8",
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={"drift_status": "stable", "reasons": []},
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"],
                "",
            )
            self.assertNotIn(
                str(stale_incident_path),
                updated_manifest["rollback_proof"]["artifact_refs"],
            )
            self.assertNotIn(str(stale_incident_path), updated_manifest["artifact_refs"])
            self.assertEqual(updated_manifest["phases"][-1]["status"], "pass")
            self.assertEqual(updated_manifest["status"], "pass")

    def test_append_runtime_governance_ignores_non_triggered_payload_rollback_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            explicit_evidence_path = Path(tmpdir) / "explicit-incident.json"
            explicit_evidence_path.write_text(
                json.dumps({"rollback": "expected_if_triggered"}),
                encoding="utf-8",
            )

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-evidence-ignore",
                "candidate_id": "cand-evidence-ignore",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-proof",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                ],
                "runtime_governance": {"rollback_triggered": False},
                "rollback_proof": {
                    "rollback_triggered": False,
                    "rollback_incident_evidence": "",
                    "rollback_incident_evidence_path": "",
                },
                "artifact_refs": [],
                "phase_count": 7,
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2),
                encoding="utf-8",
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "stable",
                    "reasons": [],
                    "rollback_triggered": False,
                    "rollback_incident_evidence": str(explicit_evidence_path),
                    "action": {"action_type": "none", "triggered": False},
                    "detection": {"reason_codes": []},
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(updated_manifest["status"], "pass")
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"],
                "",
            )
            self.assertNotIn(
                str(explicit_evidence_path),
                updated_manifest["rollback_proof"]["artifact_refs"],
            )
            self.assertNotIn(
                str(explicit_evidence_path),
                updated_manifest["artifact_refs"],
            )
            self.assertEqual(updated_manifest["phases"][-1]["status"], "pass")

    def test_run_autonomy_cycle_appends_runtime_governance_with_canary_failure(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )

            def _fake_run_autonomous_lane_with_canary_failure(**kwargs: Any) -> SimpleNamespace:
                deps.call_kwargs = kwargs
                deps.call_kwargs["promotion_target"] = kwargs.get("promotion_target")
                deps.call_kwargs["approval_token"] = kwargs.get("approval_token")

                output_dir = kwargs["output_dir"]
                gate_report_path = output_dir / "gate-evaluation.json"
                gate_payload = {
                    "recommended_mode": "paper",
                    "gates": [],
                    "throughput": {
                        "signal_count": 4,
                        "decision_count": 3,
                        "trade_count": 1,
                    },
                }
                gate_report_path.write_text(
                    json.dumps(gate_payload, indent=2),
                    encoding="utf-8",
                )
                deps.gate_report_path = gate_report_path

                gates_dir = output_dir / "gates"
                gates_dir.mkdir(parents=True, exist_ok=True)
                actuation_intent_path = gates_dir / "actuation-intent.json"
                actuation_payload = {
                    "schema_version": "torghut.autonomy.actuation-intent.v1",
                    "run_id": "canary-fail",
                    "candidate_id": "cand-canary-fail",
                    "actuation_allowed": True,
                    "gates": {
                        "recommendation_trace_id": "rec-trace-canary-fail",
                        "gate_report_trace_id": "gate-trace-canary-fail",
                        "recommendation_reasons": ["unit-test"],
                    },
                }
                actuation_intent_path.write_text(
                    json.dumps(actuation_payload, indent=2),
                    encoding="utf-8",
                )
                deps.actuation_intent_path = actuation_intent_path

                rollout_dir = output_dir / "rollout"
                rollout_dir.mkdir(parents=True, exist_ok=True)
                phase_manifest_path = rollout_dir / "phase-manifest.json"
                phase_manifest_path.write_text(
                    json.dumps(
                        {
                            "schema_version": "autonomy-phase-manifest-v1",
                            "run_id": "canary-fail",
                            "candidate_id": "cand-canary-fail",
                            "phases": [
                                {
                                    "name": "gate-evaluation",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "promotion-prerequisites",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "rollback-readiness",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                                {
                                    "name": "paper-canary",
                                    "status": "fail",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "runtime-governance",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "rollback-proof",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                            ],
                            "runtime_governance": {"rollback_triggered": False},
                            "rollback_proof": {"rollback_triggered": False},
                            "artifact_refs": [str(phase_manifest_path)],
                            "phase_count": 7,
                        },
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                deps.phase_manifest_path = phase_manifest_path

                return SimpleNamespace(
                    run_id="canary-fail",
                    candidate_id="cand-canary-fail",
                    output_dir=output_dir,
                    gate_report_path=gate_report_path,
                    actuation_intent_path=actuation_intent_path,
                    paper_patch_path=None,
                    phase_manifest_path=phase_manifest_path,
                )

            drift_payload = {
                "drift_status": "stable",
                "reasons": ["drift_stable"],
                "detection": {"reason_codes": []},
                "action": {"action_type": "none", "triggered": False},
                "rollback_triggered": False,
            }

            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=_fake_run_autonomous_lane_with_canary_failure,
            ):
                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._evaluate_drift_governance",
                    return_value=drift_payload,
                ):
                    scheduler._run_autonomous_cycle()

            manifest_path = deps.phase_manifest_path
            self.assertIsNotNone(manifest_path)
            assert manifest_path is not None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["phases"][4]["status"],
                "fail",
            )
            phase_transitions_by_to = {
                (transition.get("from"), transition.get("to")): transition.get("status")
                for transition in manifest["phase_transitions"]
                if isinstance(transition, dict)
            }
            self.assertEqual(
                phase_transitions_by_to[("drift-gate", "paper-canary")],
                "fail",
            )
            self.assertEqual(
                phase_transitions_by_to[("paper-canary", "runtime-governance")],
                "pass",
            )
            self.assertEqual(manifest["status"], "fail")

    def _build_scheduler_with_fixtures(
        self,
        tmpdir: str,
        *,
        allow_live: bool,
        approval_token: str | None,
        no_signals: bool = False,
        no_signal_reason: str | None = None,
        no_signal_lag_seconds: float | None = None,
        market_session_open: bool = True,
    ) -> tuple[TradingScheduler, _SchedulerDependencies]:
        strategy_config_path = Path(tmpdir) / "strategies.yaml"
        strategy_config_path.write_text(
            json.dumps(
                {
                    "strategies": [
                        {
                            "strategy_id": "intraday-tsmom-profit-v2",
                            "strategy_type": "intraday_tsmom_v1",
                            "version": "1.1.0",
                            "enabled": True,
                            "base_timeframe": "1Min",
                        }
                    ]
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        gate_policy_path = Path(tmpdir) / "autonomy-gates-v3.json"
        gate_policy_path.write_text(
            json.dumps(
                {
                    "policy_version": "v3-gates-1",
                    "required_feature_schema_version": "3.0.0",
                    "gate1_min_decision_count": 0,
                    "gate1_min_trade_count": 0,
                    "gate1_min_net_pnl": "-1",
                    "gate1_max_negative_fold_ratio": "1",
                    "gate1_max_net_pnl_cv": "100",
                    "gate2_max_drawdown": "100000",
                    "gate2_max_turnover_ratio": "1000",
                    "gate2_max_cost_bps": "1000",
                    "gate3_max_llm_error_ratio": "1",
                    "gate5_live_enabled": True,
                    "gate5_require_approval_token": True,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        settings.trading_autonomy_allow_live_promotion = allow_live
        settings.trading_autonomy_approval_token = approval_token
        settings.trading_strategy_config_path = str(strategy_config_path)
        settings.trading_autonomy_gate_policy_path = str(gate_policy_path)
        settings.trading_autonomy_artifact_dir = str(
            Path(tmpdir) / "autonomy-artifacts"
        )
        settings.trading_universe_source = "jangar"
        settings.trading_drift_governance_enabled = True
        settings.trading_drift_live_promotion_requires_evidence = True
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 1800
        settings.trading_drift_rollback_on_performance = True

        scheduler = TradingScheduler()

        @contextmanager
        def _session_factory():
            yield None

        scheduler._pipeline = _PipelineStub(
            signals=[] if no_signals else _signal_batch(),
            session_factory=_session_factory,
            no_signal_reason=no_signal_reason,
            no_signal_lag_seconds=no_signal_lag_seconds,
            market_session_open=market_session_open,
            state=scheduler.state,
        )

        return scheduler, _SchedulerDependencies()

    @staticmethod
    def _fake_run_autonomous_lane(deps: _SchedulerDependencies):
        def _capture(
            *,
            signals_path: Path,
            strategy_config_path: Path,
            gate_policy_path: Path,
            output_dir: Path,
            **kwargs: Any,
        ) -> SimpleNamespace:
            deps.call_kwargs = kwargs
            deps.call_kwargs["strategy_config_path"] = strategy_config_path
            deps.call_kwargs["gate_policy_path"] = gate_policy_path
            deps.call_kwargs["output_dir"] = output_dir

            deps.call_kwargs.update(
                {
                    "strategy_config_path": strategy_config_path,
                    "gate_policy_path": gate_policy_path,
                    "promotion_target": kwargs.get("promotion_target"),
                    "approval_token": kwargs.get("approval_token"),
                }
            )

            gate_report_path = output_dir / "gate-evaluation.json"
            gate_payload = deps.gate_payload or {
                "recommended_mode": "paper",
                "gates": [],
                "throughput": {
                    "signal_count": 8,
                    "decision_count": 5,
                    "trade_count": 3,
                    "fold_metrics_count": 1,
                    "stress_metrics_count": 4,
                },
                "promotion_decision": {
                    "promotion_allowed": True,
                    "recommended_mode": "paper",
                },
            }
            gate_report_path.write_text(json.dumps(gate_payload), encoding="utf-8")
            deps.gate_report_path = gate_report_path
            gates_dir = output_dir / "gates"
            gates_dir.mkdir(parents=True, exist_ok=True)
            actuation_intent_path = gates_dir / "actuation-intent.json"
            actuation_payload = deps.actuation_payload or {
                "schema_version": "torghut.autonomy.actuation-intent.v1",
                "run_id": "test-run-id",
                "candidate_id": "cand-test",
                "actuation_allowed": True,
                "gates": {
                    "recommendation_trace_id": "rec-trace-test",
                    "gate_report_trace_id": "gate-trace-test",
                    "recommendation_reasons": ["unit_test"],
                    "promotion_allowed": bool(
                        gate_payload.get("promotion_recommendation", {}).get("eligible", True)
                    ),
                },
                "artifact_refs": [str(gate_report_path)],
                "audit": {
                    "rollback_evidence_missing_checks": [],
                    "rollback_readiness_readout": {
                        "kill_switch_dry_run_passed": True,
                        "gitops_revert_dry_run_passed": True,
                        "strategy_disable_dry_run_passed": True,
                        "human_approved": True,
                        "rollback_target": "test",
                        "dry_run_completed_at": "",
                    },
                },
            }
            actuation_intent_path.write_text(
                json.dumps(actuation_payload), encoding="utf-8"
            )
            deps.actuation_intent_path = actuation_intent_path
            rollout_dir = output_dir / "rollout"
            rollout_dir.mkdir(parents=True, exist_ok=True)
            phase_manifest_path = rollout_dir / "phase-manifest.json"
            phase_manifest_path.write_text(
                json.dumps(
                    {
                        "schema_version": "autonomy-phase-manifest-v1",
                        "run_id": "test-run-id",
                        "candidate_id": "cand-test",
                        "phases": [
                            {
                                "name": "gate-evaluation",
                                "status": "pass",
                                "artifact_refs": [],
                            },
                            {
                                "name": "promotion-prerequisites",
                                "status": "pass",
                                "artifact_refs": [],
                            },
                            {
                                "name": "rollback-readiness",
                                "status": "pass",
                                "artifact_refs": [],
                            },
                            {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                            {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                            {
                                "name": "runtime-governance",
                                "status": "pass",
                                "artifact_refs": [],
                            },
                            {
                                "name": "rollback-proof",
                                "status": "pass",
                                "artifact_refs": [],
                            },
                        ],
                        "runtime_governance": {"governance_status": "pass"},
                        "rollback_proof": {"rollback_triggered": False},
                        "phase_count": 7,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            deps.phase_manifest_path = phase_manifest_path

            return SimpleNamespace(
                run_id="test-run-id",
                candidate_id="cand-test",
                output_dir=output_dir,
                gate_report_path=gate_report_path,
                actuation_intent_path=actuation_intent_path,
                paper_patch_path=None,
                phase_manifest_path=phase_manifest_path,
            )

        return _capture
