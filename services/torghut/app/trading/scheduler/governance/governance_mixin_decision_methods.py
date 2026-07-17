"""Trading scheduler governance, autonomy, and safety workflows."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from ....config import settings
from ...autonomy import (
    prune_autonomy_run_directories,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from ...ingest import SignalBatch
from ...models import SignalEnvelope
from ..safety import (
    latch_signal_continuity_alert_state as _latch_signal_continuity_alert_state,
    record_signal_continuity_recovery_cycle as _record_signal_continuity_recovery_cycle,
)
from ..state.metric_types import AutonomyPromotionOutcomeMetrics
from .shared_context import (
    TradingSchedulerGovernanceMixinContract as _TradingSchedulerGovernanceMixinContract,
    resolve_autonomy_artifact_root as _resolve_autonomy_artifact_root,
    logger,
)


if TYPE_CHECKING:
    _TradingSchedulerGovernanceDecisionBase = _TradingSchedulerGovernanceMixinContract
else:
    _TradingSchedulerGovernanceDecisionBase = object


class TradingSchedulerGovernanceDecisionMethods(
    _TradingSchedulerGovernanceDecisionBase,
):
    def _run_autonomous_cycle(
        self,
        *,
        governance_repository: str = "proompteng/lab",
        governance_base: str = "main",
        governance_head: str | None = None,
        governance_artifact_root: str | None = None,
        priority_id: str | None = None,
    ) -> None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")

        strategy_config_path, gate_policy_path = self._resolve_autonomy_config_paths()
        artifact_root = _resolve_autonomy_artifact_root(
            Path(
                governance_artifact_root
                if governance_artifact_root
                else settings.trading_autonomy_artifact_dir
            )
        )
        autonomy_iteration = self._next_autonomy_iteration(artifact_root=artifact_root)
        notes_path = self._iteration_notes_path(
            artifact_root=artifact_root,
            iteration=autonomy_iteration,
        )
        self.state.last_autonomy_iteration = autonomy_iteration
        self.state.last_autonomy_iteration_notes_path = str(notes_path)
        now = self._governance_now()
        lookback_minutes = max(
            1, int(settings.trading_autonomy_signal_lookback_minutes)
        )
        start = now - timedelta(minutes=lookback_minutes)
        autonomy_batch = self._pipeline.ingestor.fetch_signals_with_reason(
            start=start, end=now
        )
        signals = autonomy_batch.signals
        self._record_autonomy_batch_state(
            now=now, batch=autonomy_batch, signals=signals
        )
        if not self._refresh_autonomy_universe_state():
            blocked_batch = SignalBatch(
                signals=[],
                cursor_at=None,
                cursor_seq=None,
                cursor_symbol=None,
                query_start=autonomy_batch.query_start or start,
                query_end=autonomy_batch.query_end or now,
                signal_lag_seconds=autonomy_batch.signal_lag_seconds,
                no_signal_reason="universe_source_unavailable",
            )
            self._record_autonomy_batch_state(
                now=now,
                batch=blocked_batch,
                signals=[],
            )
            self._handle_autonomy_no_signal_cycle(
                batch=blocked_batch,
                now=now,
                start=start,
                artifact_root=artifact_root,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
            )
            self._write_autonomy_iteration_notes(
                notes_path=notes_path,
                iteration=autonomy_iteration,
                now=now,
                outcome="blocked_no_signal",
                reason=blocked_batch.no_signal_reason or "no_signal",
                promotion_target="paper",
                run_output_dir=None,
                gate_manifest_path=self.state.last_autonomy_phase_manifest,
                error=self.state.last_autonomy_error,
            )
            return
        if not signals:
            self._handle_autonomy_no_signal_cycle(
                batch=autonomy_batch,
                now=now,
                start=start,
                artifact_root=artifact_root,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
            )
            self._write_autonomy_iteration_notes(
                notes_path=notes_path,
                iteration=autonomy_iteration,
                now=now,
                outcome="blocked_no_signal",
                reason=autonomy_batch.no_signal_reason or "no_signal",
                promotion_target="paper",
                run_output_dir=None,
                gate_manifest_path=self.state.last_autonomy_phase_manifest,
                error=self.state.last_autonomy_error,
            )
            return

        run_output_dir, signals_path = self._prepare_autonomy_signal_artifacts(
            artifact_root=artifact_root,
            now=now,
            signals=signals,
        )
        self._reset_autonomy_signal_state(signal_count=len(signals))
        drift_gate_evidence = self._current_drift_gate_evidence(now=now)
        promotion_target, approval_token = self._resolve_autonomy_promotion_target(
            drift_gate_evidence
        )
        result = self._execute_autonomous_lane(
            signals_path=signals_path,
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
            run_output_dir=run_output_dir,
            promotion_target=promotion_target,
            approval_token=approval_token,
            drift_gate_evidence=drift_gate_evidence,
            governance_repository=governance_repository,
            governance_base=governance_base,
            governance_head=(
                governance_head
                or f"agentruns/torghut-autonomy-{now.strftime('%Y%m%dT%H%M%S')}"
            ),
            governance_artifact_path=str(run_output_dir),
            priority_id=priority_id,
            design_doc=os.getenv("DESIGN_DOC"),
            artifact_root=artifact_root,
            execution_context=self._build_autonomy_execution_context(
                artifact_root=artifact_root,
                promotion_target=promotion_target,
                design_doc=os.getenv("DESIGN_DOC"),
            ),
        )
        if result is None:
            self._write_autonomy_iteration_notes(
                notes_path=notes_path,
                iteration=autonomy_iteration,
                now=now,
                outcome="lane_execution_failed",
                reason=self.state.last_autonomy_reason or "lane_execution_failed",
                promotion_target=promotion_target,
                run_output_dir=None,
                gate_manifest_path=self.state.last_autonomy_phase_manifest,
                error=self.state.last_autonomy_error,
            )
            return

        self._apply_autonomy_lane_result(
            result=result,
            run_output_dir=run_output_dir,
            signals=signals,
            now=now,
            requested_promotion_target=promotion_target,
        )
        self._write_autonomy_iteration_notes(
            notes_path=notes_path,
            iteration=autonomy_iteration,
            now=now,
            outcome="lane_completed",
            reason="completed",
            promotion_target=promotion_target,
            run_output_dir=run_output_dir,
            gate_manifest_path=self.state.last_autonomy_phase_manifest,
            error=self.state.last_autonomy_error,
            emergency_stop_active=self.state.emergency_stop_active,
            rollback_incident_path=self.state.rollback_incident_evidence_path,
        )

    @staticmethod
    def _resolve_autonomy_config_paths() -> tuple[Path, Path]:
        strategy_config_path = settings.trading_strategy_config_path
        gate_policy_path = settings.trading_autonomy_gate_policy_path
        if not strategy_config_path:
            raise RuntimeError("strategy_config_path_missing_for_autonomy")
        if not gate_policy_path:
            raise RuntimeError("autonomy_gate_policy_path_missing")
        return Path(strategy_config_path), Path(gate_policy_path)

    @staticmethod
    def _build_autonomy_execution_context(
        *,
        artifact_root: Path,
        promotion_target: str,
        design_doc: str | None = None,
    ) -> dict[str, str]:
        repository = (os.getenv("GITHUB_REPOSITORY") or "unknown").strip() or "unknown"
        base_ref = os.getenv("GITHUB_BASE_REF") or os.getenv("GITHUB_REF") or "unknown"
        if base_ref.startswith("refs/heads/"):
            base_ref = base_ref.removeprefix("refs/heads/")
        head_ref = (
            os.getenv("GITHUB_HEAD_REF")
            or os.getenv("GITHUB_REF_NAME")
            or ("live" if promotion_target == "live" else "unknown")
        )
        priority_id = os.getenv("PRIORITY_ID") or os.getenv("CODEX_PRIORITY_ID") or ""
        design_ref = (
            design_doc if design_doc is not None else os.getenv("DESIGN_DOC", "")
        )
        return {
            "repository": repository,
            "base": base_ref,
            "head": head_ref,
            "artifactPath": str(artifact_root),
            "priorityId": priority_id,
            "designDoc": design_ref.strip(),
        }

    def _record_autonomy_batch_state(
        self,
        *,
        now: datetime,
        batch: SignalBatch,
        signals: list[SignalEnvelope],
    ) -> None:
        self.state.last_ingest_signals_total = len(signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason
        self.state.last_autonomy_run_at = now
        self.state.autonomy_signals_total = len(signals)

    def _refresh_autonomy_universe_state(self) -> bool:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        resolution = self._pipeline.universe_resolver.get_resolution()
        self.state.universe_source_status = resolution.status
        self.state.universe_source_reason = resolution.reason
        self.state.universe_symbols_count = len(resolution.symbols)
        self.state.universe_cache_age_seconds = resolution.cache_age_seconds
        self.state.universe_fail_safe_blocked = False
        self.state.universe_fail_safe_block_reason = None
        self.state.metrics.record_universe_resolution(
            status=resolution.status,
            reason=resolution.reason,
            symbols_count=len(resolution.symbols),
            cache_age_seconds=resolution.cache_age_seconds,
        )
        if resolution.status == "degraded":
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_stale_cache"
            )
        if (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
            and not resolution.symbols
        ):
            universe_reason = resolution.reason or "unknown"
            self.state.universe_fail_safe_blocked = True
            self.state.universe_fail_safe_block_reason = universe_reason
            self.state.last_signal_continuity_state = "universe_fail_safe_block"
            self.state.last_signal_continuity_reason = "universe_source_unavailable"
            self.state.last_signal_continuity_actionable = True
            self.state.metrics.signal_continuity_actionable = 1
            self.state.metrics.record_signal_actionable_staleness(
                "universe_source_unavailable"
            )
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_unavailable"
            )
            self.state.metrics.record_universe_fail_safe_block(universe_reason)
            _latch_signal_continuity_alert_state(
                self.state, "universe_source_unavailable"
            )
            self.state.last_error = (
                f"universe_source_unavailable reason={resolution.reason}"
            )
            logger.error(
                "Blocking autonomy cycle: authoritative Jangar universe unavailable reason=%s status=%s",
                resolution.reason,
                resolution.status,
            )
            return False
        return True

    def _handle_autonomy_no_signal_cycle(
        self,
        *,
        batch: SignalBatch,
        now: datetime,
        start: datetime,
        artifact_root: Path,
        strategy_config_path: Path,
        gate_policy_path: Path,
    ) -> None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        self._pipeline.record_no_signal_batch(batch)
        self.state.autonomy_no_signal_streak += 1
        self.state.metrics.no_signal_streak = self.state.autonomy_no_signal_streak
        run_output_dir = artifact_root / now.strftime("%Y%m%dT%H%M%S")
        run_output_dir.mkdir(parents=True, exist_ok=True)
        prune_autonomy_run_directories(
            artifact_root,
            retention_runs=settings.trading_autonomy_artifact_retention_runs,
            active_run_directory=run_output_dir,
        )
        no_signal_path = run_output_dir / "no-signals.json"
        reason = batch.no_signal_reason or "no_signal"
        no_signal_payload: dict[str, Any] = {
            "status": "skipped",
            "dataset_snapshot_ref": "no_signal_window",
            "no_signal_reason": reason,
            "query_start": batch.query_start.isoformat() if batch.query_start else None,
            "query_end": batch.query_end.isoformat() if batch.query_end else None,
            "signal_lag_seconds": batch.signal_lag_seconds,
            "signal_continuity": {
                "state": self.state.last_signal_continuity_state,
                "reason": self.state.last_signal_continuity_reason,
                "actionable": self.state.last_signal_continuity_actionable,
                "alert_active": self.state.signal_continuity_alert_active,
                "alert_reason": self.state.signal_continuity_alert_reason,
            },
            "market_session_open": self.state.market_session_open,
            "promotion": {
                "requested_target": "shadow",
                "promotion_allowed": False,
                "outcome": "skipped_no_signal",
            },
            "research_run_id": None,
        }
        no_signal_path.write_text(
            json.dumps(no_signal_payload, indent=2), encoding="utf-8"
        )
        self.state.last_autonomy_run_id = None
        self.state.last_autonomy_candidate_id = None
        self.state.last_autonomy_gates = str(no_signal_path)
        self.state.last_autonomy_actuation_intent = None
        self.state.last_autonomy_phase_manifest = None
        self.state.last_autonomy_patch = None
        self.state.last_autonomy_recommendation = None
        self.state.last_autonomy_promotion_action = "hold"
        self.state.last_autonomy_promotion_eligible = False
        self.state.last_autonomy_recommendation_trace_id = None
        self.state.last_autonomy_throughput = {
            "signal_count": 0,
            "decision_count": 0,
            "trade_count": 0,
            "fold_metrics_count": 0,
            "stress_metrics_count": 0,
            "no_signal_window": True,
            "no_signal_reason": reason,
        }
        self.state.metrics.autonomy_last_signal_count = 0
        self.state.metrics.autonomy_last_decision_count = 0
        self.state.metrics.autonomy_last_trade_count = 0
        self.state.metrics.autonomy_last_fold_metrics_count = 0
        self.state.metrics.autonomy_last_stress_metrics_count = 0
        self._set_autonomy_iteration_error(None)
        self.state.last_autonomy_reason = reason
        self.state.metrics.record_autonomy_promotion_outcome(
            AutonomyPromotionOutcomeMetrics(
                signal_count=0,
                decision_count=0,
                trade_count=0,
                recommendation="shadow",
                promotion_allowed=False,
                outcome="skipped_no_signal",
            )
        )
        query_start = batch.query_start or start
        query_end = batch.query_end or now
        try:
            self.state.last_autonomy_run_id = upsert_autonomy_no_signal_run(
                session_factory=self._pipeline.session_factory,
                query_start=query_start,
                query_end=query_end,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                no_signal_reason=reason,
                now=now,
                code_version="live",
            )
            no_signal_payload["research_run_id"] = self.state.last_autonomy_run_id
            no_signal_path.write_text(
                json.dumps(no_signal_payload, indent=2), encoding="utf-8"
            )
        except Exception as exc:
            self.state.autonomy_failure_streak += 1
            self.state.last_autonomy_reason = "autonomy_no_signal_persistence_failed"
            self._set_autonomy_iteration_error(str(exc))
            logger.exception(
                "Autonomy no-signal persistence failed; ingest_reason=%s window_start=%s window_end=%s",
                reason,
                query_start,
                query_end,
            )
            return
        logger.warning(
            "Autonomy cycle skipped due to no signals; ingest_reason=%s window_start=%s window_end=%s",
            batch.no_signal_reason,
            batch.query_start,
            batch.query_end,
        )
        self._emit_autonomy_domain_telemetry(
            event_name="torghut.autonomy.cycle_failed",
            severity="warning",
            properties={
                "torghut_run_id": self.state.last_autonomy_run_id,
                "candidate_id": self.state.last_autonomy_candidate_id,
                "recommendation_trace_id": self.state.last_autonomy_recommendation_trace_id,
                "no_signal_reason": reason,
                "outcome": "skipped_no_signal",
                "signal_lag_seconds": batch.signal_lag_seconds,
                "market_session_open": self.state.market_session_open,
            },
        )
        self._evaluate_safety_controls()

    @staticmethod
    def _prepare_autonomy_signal_artifacts(
        *,
        artifact_root: Path,
        now: datetime,
        signals: list[SignalEnvelope],
    ) -> tuple[Path, Path]:
        run_output_dir = artifact_root / now.strftime("%Y%m%dT%H%M%S")
        run_output_dir.mkdir(parents=True, exist_ok=True)
        prune_autonomy_run_directories(
            artifact_root,
            retention_runs=settings.trading_autonomy_artifact_retention_runs,
            active_run_directory=run_output_dir,
        )
        signals_path = run_output_dir / "signals.json"
        signal_payloads = [signal.model_dump(mode="json") for signal in signals]
        signals_path.write_text(json.dumps(signal_payloads, indent=2), encoding="utf-8")
        return run_output_dir, signals_path

    def _next_autonomy_iteration(self, *, artifact_root: Path) -> int:
        notes_root = artifact_root / "notes"
        notes_root.mkdir(parents=True, exist_ok=True)
        max_iteration = 0
        for path in notes_root.glob("iteration-*.md"):
            suffix = path.stem.removeprefix("iteration-")
            if suffix.isdigit():
                max_iteration = max(max_iteration, int(suffix))
        return max_iteration + 1

    def _iteration_notes_path(self, *, artifact_root: Path, iteration: int) -> Path:
        return artifact_root / "notes" / f"iteration-{iteration}.md"

    def _write_autonomy_iteration_notes(
        self,
        *,
        notes_path: Path,
        iteration: int,
        now: datetime,
        outcome: str,
        reason: str,
        promotion_target: str,
        run_output_dir: Path | None,
        gate_manifest_path: str | None,
        error: str | None = None,
        emergency_stop_active: bool = False,
        rollback_incident_path: str | None = None,
    ) -> None:
        notes_payload = {
            "iteration": iteration,
            "status": outcome,
            "timestamp": now.isoformat(),
            "reason": reason,
            "promotion_target": promotion_target,
            "run_output_dir": str(run_output_dir) if run_output_dir else None,
            "phase_manifest_path": gate_manifest_path,
            "autonomy_run_id": self.state.last_autonomy_run_id,
            "autonomy_candidate_id": self.state.last_autonomy_candidate_id,
            "recommender": self.state.last_autonomy_recommendation,
            "promotion_action": self.state.last_autonomy_promotion_action,
            "promotion_eligible": self.state.last_autonomy_promotion_eligible,
            "recommendation_trace_id": self.state.last_autonomy_recommendation_trace_id,
            "error": error,
            "emergency_stop_active": emergency_stop_active,
            "rollback_incident_evidence_path": rollback_incident_path,
            "throughput": self.state.last_autonomy_throughput,
            "metrics": {
                "drift_status": self.state.drift_status,
                "security_controls_triggered": self.state.last_autonomy_reason,
            },
        }
        notes_path.parent.mkdir(parents=True, exist_ok=True)
        notes_path.write_text(json.dumps(notes_payload, indent=2), encoding="utf-8")

    def _reset_autonomy_signal_state(self, *, signal_count: int) -> None:
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        self.state.autonomy_no_signal_streak = 0
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.last_signal_continuity_state = "signals_present"
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = False
        _record_signal_continuity_recovery_cycle(
            self.state,
            required_recovery_cycles=max(
                1, int(settings.trading_signal_continuity_recovery_cycles)
            ),
        )
        self.state.autonomy_signals_total = signal_count

    def _resolve_autonomy_promotion_target(
        self, drift_gate_evidence: Mapping[str, Any]
    ) -> tuple[Literal["paper", "live"], str | None]:
        if (
            settings.trading_autonomy_allow_live_promotion
            and self.state.signal_continuity_alert_active
        ):
            self.state.metrics.signal_continuity_promotion_block_total += 1
            logger.warning(
                "Autonomy live promotion denied while continuity alert is active reason=%s; forcing paper target.",
                self.state.signal_continuity_alert_reason,
            )
            return "paper", None
        if (
            settings.trading_autonomy_allow_live_promotion
            and settings.trading_autonomy_approval_token
        ):
            if settings.trading_drift_live_promotion_requires_evidence and not bool(
                drift_gate_evidence.get("eligible_for_live_promotion", False)
            ):
                logger.warning(
                    "Autonomy live promotion denied by drift evidence gate reasons=%s; fallback to paper target.",
                    drift_gate_evidence.get("reasons"),
                )
                self.state.metrics.drift_promotion_block_total += 1
                return "paper", None
            return "live", settings.trading_autonomy_approval_token
        if (
            settings.trading_autonomy_allow_live_promotion
            and not settings.trading_autonomy_approval_token
        ):
            logger.warning(
                "Autonomy live promotion enabled but no approval token configured; fallback to paper target."
            )
        return "paper", None

    def _execute_autonomous_lane(
        self,
        *,
        signals_path: Path,
        strategy_config_path: Path,
        gate_policy_path: Path,
        run_output_dir: Path,
        promotion_target: Literal["paper", "live"],
        approval_token: str | None,
        drift_gate_evidence: Mapping[str, Any],
        governance_repository: str = "proompteng/lab",
        governance_base: str = "main",
        governance_head: str | None = None,
        governance_artifact_path: str | None = None,
        priority_id: str | None = None,
        design_doc: str | None = None,
        artifact_root: Path | None = None,
        execution_context: Mapping[str, str] | None = None,
    ) -> Any | None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        try:
            return run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=run_output_dir,
                promotion_target=promotion_target,
                code_version="live",
                approval_token=approval_token,
                drift_promotion_evidence=dict(drift_gate_evidence),
                governance_repository=governance_repository,
                governance_base=governance_base,
                governance_head=(
                    governance_head
                    or f"agentruns/torghut-autonomy-{run_output_dir.name}"
                ),
                governance_artifact_path=(
                    governance_artifact_path or str(run_output_dir)
                ).strip()
                or str(run_output_dir),
                priority_id=priority_id,
                design_doc=design_doc,
                governance_change="autonomous-promotion",
                governance_reason=(
                    f"Autonomous recommendation for {promotion_target} target."
                ),
                governance_inputs=(
                    {
                        "execution_context": dict(
                            execution_context
                            or self._build_autonomy_execution_context(
                                artifact_root=(artifact_root or run_output_dir.parent),
                                promotion_target=promotion_target,
                            )
                        ),
                        "runtime_governance": {
                            "governance_status": "pass",
                            "drift_status": "queued",
                            "artifact_refs": [],
                            "rollback_triggered": False,
                            "reasons": [
                                "autonomy_runtime_governance_pending",
                            ],
                        },
                        "rollback_proof": {
                            "rollback_triggered": False,
                            "rollback_incident_evidence_path": "",
                            "reasons": [],
                        },
                    }
                    if execution_context is not None
                    else None
                ),
                persist_results=True,
                session_factory=self._pipeline.session_factory,
                alpha_train_prices_path=(
                    Path(settings.trading_autonomy_alpha_train_prices_path)
                    if settings.trading_autonomy_alpha_train_prices_path
                    else None
                ),
                alpha_test_prices_path=(
                    Path(settings.trading_autonomy_alpha_test_prices_path)
                    if settings.trading_autonomy_alpha_test_prices_path
                    else None
                ),
                alpha_gate_policy_path=(
                    Path(settings.trading_autonomy_alpha_gate_policy_path)
                    if settings.trading_autonomy_alpha_gate_policy_path
                    else None
                ),
            )
        except Exception as exc:
            self.state.autonomy_failure_streak += 1
            self.state.last_autonomy_phase_manifest = None
            self._set_autonomy_iteration_error(str(exc))
            self.state.last_autonomy_reason = "lane_execution_failed"
            self._clear_autonomy_result_state()
            self._emit_autonomy_domain_telemetry(
                event_name="torghut.autonomy.cycle_failed",
                severity="error",
                properties={
                    "torghut_run_id": None,
                    "candidate_id": None,
                    "recommendation_trace_id": None,
                    "outcome": "lane_execution_failed",
                    "error": str(exc),
                    "promotion_target": promotion_target,
                },
            )
            logger.exception("Autonomous lane execution failed: %s", exc)
            self._evaluate_safety_controls()
            return None

    def _clear_autonomy_result_state(self) -> None:
        self.state.last_autonomy_run_id = None
        self.state.last_autonomy_candidate_id = None
        self.state.last_autonomy_gates = None
        self.state.last_autonomy_actuation_intent = None
        self.state.last_autonomy_phase_manifest = None
        self.state.last_autonomy_patch = None
        self.state.last_autonomy_recommendation = None
        self.state.last_autonomy_promotion_action = None
        self.state.last_autonomy_promotion_eligible = None
        self.state.last_autonomy_recommendation_trace_id = None
        self.state.last_autonomy_throughput = None
