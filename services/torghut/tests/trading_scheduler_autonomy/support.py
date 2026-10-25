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
        account_activity_fail: bool = False,
        rejected_outcome_fail: bool = False,
    ) -> None:
        self.account_label = account_label
        self.run_once_fail = run_once_fail
        self.reconcile_fail = reconcile_fail
        self.reconcile_return = reconcile_return
        self.account_activity_fail = account_activity_fail
        self.rejected_outcome_fail = rejected_outcome_fail
        self.run_once_calls = 0
        self.reconcile_calls = 0
        self.account_activity_calls = 0
        self.rejected_outcome_calls = 0
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

    def ingest_broker_account_activities(self) -> None:
        self.account_activity_calls += 1
        if self.account_activity_fail:
            raise RuntimeError("account_activity_failed")

    def label_mature_rejected_signal_outcomes(self) -> None:
        self.rejected_outcome_calls += 1
        if self.rejected_outcome_fail:
            raise RuntimeError("rejected_outcome_failed")


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


class _TestTradingSchedulerAutonomyBase(TestCase):
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
                        gate_payload.get("promotion_recommendation", {}).get(
                            "eligible", True
                        )
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
                            {
                                "name": "drift-gate",
                                "status": "pass",
                                "artifact_refs": [],
                            },
                            {
                                "name": "paper-canary",
                                "status": "pass",
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


__all__: tuple[str, ...] = (
    "Any",
    "Path",
    "SignalBatch",
    "SignalEnvelope",
    "SimpleNamespace",
    "TestCase",
    "TradingAccountLane",
    "TradingScheduler",
    "TradingState",
    "_OrderFirewallStub",
    "_PipelineIterationStub",
    "_PipelineStub",
    "_SchedulerDependencies",
    "_TestTradingSchedulerAutonomyBase",
    "_signal_batch",
    "asyncio",
    "contextmanager",
    "dataclass",
    "datetime",
    "json",
    "os",
    "patch",
    "settings",
    "tempfile",
    "timedelta",
    "timezone",
)
