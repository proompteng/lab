"""Extracted Torghut API route and support functions."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api import common as api_common
from app.api.common import (
    BUILD_VERSION,
    ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS,
    logger,
    retryable_tca_recompute_error,
)
from app.config import settings
from app.db import SessionLocal, get_session
from app.trading.feature_quality import (
    FeatureQualityThresholds,
    evaluate_feature_batch_quality,
)
from app.trading.hypotheses import load_jangar_dependency_quorum
from app.trading.models import SignalEnvelope
from app.trading.revenue_repair import build_revenue_repair_digest
from app.trading.scheduler import TradingScheduler
from app.trading.tca import refresh_execution_tca_metrics
from app.trading.zero_notional_repair_executor import run_zero_notional_repair

from .application import get_app
from .readiness_helpers import (
    evaluate_database_contract,
    evaluate_trading_health_payload,
)
from .trading_status import trading_status

router = APIRouter()


def _load_jangar_dependency_quorum_payload() -> dict[str, object]:
    """Fetch cached Jangar dependency carry for revenue-repair reentry only."""

    dependency_quorum = load_jangar_dependency_quorum()
    return dependency_quorum.as_payload()


def _load_jangar_verify_trust_foreclosure_board(
    dependency_quorum_payload: Mapping[str, object] | None = None,
) -> dict[str, object] | None:
    """Fetch cached Jangar verify-trust board for legacy revenue-repair callers."""

    payload = dependency_quorum_payload or _load_jangar_dependency_quorum_payload()
    board = payload.get("verify_trust_foreclosure_board")
    if not isinstance(board, Mapping):
        return None
    return dict(cast(Mapping[str, object], board))


@router.get("/trading/revenue-repair")
def trading_revenue_repair() -> dict[str, object]:
    """Return business-state and repair-priority evidence for revenue readiness."""

    readyz_payload, _status_code = evaluate_trading_health_payload(
        include_database_contract=True,
        allow_stale_dependency_cache=True,
    )
    status_payload = trading_status()
    dependency_quorum_payload = _load_jangar_dependency_quorum_payload()
    verify_trust_foreclosure_board = _load_jangar_verify_trust_foreclosure_board(
        dependency_quorum_payload
    )
    if dependency_quorum_payload:
        status_payload = {
            **status_payload,
            "dependency_quorum": dependency_quorum_payload,
            "controller_ingestion_settlement": dependency_quorum_payload.get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": verify_trust_foreclosure_board
            or dependency_quorum_payload.get("verify_trust_foreclosure_board"),
            "repair_slot_escrow": dependency_quorum_payload.get("repair_slot_escrow"),
            "stage_debt_repair_admission": dependency_quorum_payload.get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": dependency_quorum_payload.get(
                "foreclosure_carry_rollout_witness"
            ),
        }
    elif verify_trust_foreclosure_board is not None:
        status_payload = {
            **status_payload,
            "verify_trust_foreclosure_board": verify_trust_foreclosure_board,
        }
    return cast(
        dict[str, object],
        jsonable_encoder(
            build_revenue_repair_digest(
                readyz_payload=readyz_payload,
                status_payload=status_payload,
            )
        ),
    )


@router.post("/trading/profit-freshness/zero-notional-repair")
def trading_profit_freshness_zero_notional_repair(
    execute: bool = Query(default=False),
    action: str | None = Query(
        default=None,
        description="Optional zero-notional action to select from queued repair lots.",
    ),
    tca_limit: int = Query(default=250, ge=1, le=5000),
    drift_limit: int = Query(default=500, ge=1, le=5000),
    feature_limit: int = Query(default=500, ge=1, le=5000),
    repair_lot_dispatch_ticket: dict[str, Any] | None = Body(
        default=None,
        description=(
            "Jangar repair_lot_dispatch_ticket authorizing runner-required "
            "zero-notional repair execution."
        ),
    ),
) -> dict[str, object]:
    """Plan or run an allowlisted zero-notional repair from the freshness frontier."""

    status_payload = trading_status()
    frontier = cast(
        Mapping[str, Any],
        status_payload.get("profit_freshness_frontier") or {},
    )

    def run_tca_recompute(_repair: Mapping[str, Any]) -> Mapping[str, object]:
        retry_reasons: list[str] = []
        result: Mapping[str, object] = {}
        for attempt in range(1, ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS + 1):
            try:
                with SessionLocal() as session:
                    result = refresh_execution_tca_metrics(
                        session,
                        account_label=settings.trading_account_label,
                        limit=tca_limit,
                        dry_run=False,
                    )
                    session.commit()
            except OperationalError as exc:
                if (
                    attempt < ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS
                    and retryable_tca_recompute_error(exc)
                ):
                    retry_reason = f"route_tca_recompute_retryable:{type(exc).__name__}"
                    retry_reasons.append(retry_reason)
                    logger.warning(
                        "Zero-notional route/TCA repair retrying after retryable database error attempt=%s max_attempts=%s",
                        attempt,
                        ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS,
                        exc_info=True,
                        extra={
                            "zero_notional_tca_recompute_attempt": attempt,
                            "zero_notional_tca_recompute_max_attempts": (
                                ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS
                            ),
                            "zero_notional_tca_recompute_retry_reason": retry_reason,
                        },
                    )
                    time.sleep(min(0.25 * attempt, 1.0))
                    continue
                logger.exception("Zero-notional route/TCA repair failed")
                return {
                    "execution_state": "runner_failed",
                    "command_exit_code": 1,
                    "blocked_reasons": [
                        f"route_tca_recompute_failed:{type(exc).__name__}",
                        *retry_reasons,
                    ],
                    "after_refs": [],
                    "retry_attempts": len(retry_reasons),
                }
            except Exception as exc:  # pragma: no cover - fail-closed receipt path
                logger.exception("Zero-notional route/TCA repair failed")
                return {
                    "execution_state": "runner_failed",
                    "command_exit_code": 1,
                    "blocked_reasons": [
                        f"route_tca_recompute_failed:{type(exc).__name__}",
                        *retry_reasons,
                    ],
                    "after_refs": [],
                    "retry_attempts": len(retry_reasons),
                }
            break
        else:  # pragma: no cover - defensive; loop always returns or breaks.
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 1,
                "blocked_reasons": [
                    "route_tca_recompute_failed:retry_attempts_exhausted",
                    *retry_reasons,
                ],
                "after_refs": [],
                "retry_attempts": len(retry_reasons),
            }
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["execution_tca_metrics"],
            "result": result,
            "retry_attempts": len(retry_reasons),
            "retry_reasons": retry_reasons,
        }

    def run_drift_check_replay(repair: Mapping[str, Any]) -> Mapping[str, object]:
        current_app = get_app()
        scheduler: TradingScheduler | None = getattr(
            current_app.state, "trading_scheduler", None
        )
        pipeline = getattr(scheduler, "_pipeline", None) if scheduler else None
        ingestor = getattr(pipeline, "ingestor", None)
        fetch_with_reason = getattr(ingestor, "fetch_signals_with_reason", None)
        run_simple_drift_check = getattr(pipeline, "_run_simple_drift_check", None)
        if not callable(fetch_with_reason) or not callable(run_simple_drift_check):
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 78,
                "blocked_reasons": ["drift_check_runner_unavailable"],
                "after_refs": [],
            }

        assert scheduler is not None
        now = datetime.now(timezone.utc)
        lookback_minutes = max(
            1, int(settings.trading_autonomy_signal_lookback_minutes)
        )
        symbol_set = {
            str(symbol).strip().upper()
            for symbol in cast(Sequence[object], repair.get("symbol_set") or [])
            if str(symbol).strip()
        }

        def select_signals(batch: Any) -> list[Any]:
            return [
                signal
                for signal in cast(Sequence[Any], getattr(batch, "signals", []))
                if not symbol_set
                or str(getattr(signal, "symbol", "")).strip().upper() in symbol_set
            ]

        def replay_window_from_latest_signal() -> tuple[Any | None, list[Any]]:
            latest_status_fn = getattr(ingestor, "latest_signal_status", None)
            if not callable(latest_status_fn):
                return None, []
            latest_status = latest_status_fn()
            if not isinstance(latest_status, Mapping):
                return None, []
            latest_status_mapping = cast(Mapping[str, object], latest_status)
            latest_signal_at = latest_status_mapping.get("latest_signal_at")
            if not isinstance(latest_signal_at, datetime):
                return None, []
            if latest_signal_at.tzinfo is None:
                latest_signal_at = latest_signal_at.replace(tzinfo=timezone.utc)
            else:
                latest_signal_at = latest_signal_at.astimezone(timezone.utc)
            fallback_batch = fetch_with_reason(
                start=latest_signal_at - timedelta(minutes=lookback_minutes),
                end=latest_signal_at,
                limit=drift_limit,
            )
            return fallback_batch, select_signals(fallback_batch)

        try:
            batch = fetch_with_reason(
                start=now - timedelta(minutes=lookback_minutes),
                end=now,
                limit=drift_limit,
            )
            signals = select_signals(batch)
            replay_window = "current"
            if not signals:
                fallback_batch, fallback_signals = replay_window_from_latest_signal()
                if fallback_signals:
                    batch = fallback_batch
                    signals = fallback_signals
                    replay_window = "latest_signal"
            if not signals:
                no_signal_reason = str(
                    getattr(batch, "no_signal_reason", None) or "no_signals"
                )
                return {
                    "execution_state": "runner_blocked",
                    "command_exit_code": 78,
                    "blocked_reasons": [f"drift_check_no_signals:{no_signal_reason}"],
                    "after_refs": [],
                    "result": {
                        "query_start": getattr(batch, "query_start", None),
                        "query_end": getattr(batch, "query_end", None),
                        "symbol_set": sorted(symbol_set),
                        "replay_window": replay_window,
                    },
                }
            run_simple_drift_check(signals)
        except Exception as exc:  # pragma: no cover - fail-closed receipt path
            logger.exception("Zero-notional drift-check repair failed")
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 1,
                "blocked_reasons": [f"drift_check_replay_failed:{type(exc).__name__}"],
                "after_refs": [],
            }

        drift_path = str(
            getattr(scheduler.state, "drift_last_detection_path", "") or ""
        )
        after_refs = ["drift_detection_checks"]
        if drift_path:
            after_refs.append(drift_path)
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": after_refs,
            "result": {
                "signals_evaluated": len(signals),
                "symbol_set": sorted(symbol_set),
                "replay_window": replay_window,
                "query_start": getattr(batch, "query_start", None),
                "query_end": getattr(batch, "query_end", None),
                "drift_status": getattr(scheduler.state, "drift_status", None),
                "drift_active_reason_codes": list(
                    getattr(scheduler.state, "drift_active_reason_codes", [])
                ),
            },
        }

    def run_feature_coverage_replay(repair: Mapping[str, Any]) -> Mapping[str, object]:
        current_app = get_app()
        scheduler: TradingScheduler | None = getattr(
            current_app.state, "trading_scheduler", None
        )
        pipeline = getattr(scheduler, "_pipeline", None) if scheduler else None
        ingestor = getattr(pipeline, "ingestor", None)
        fetch_with_reason = getattr(ingestor, "fetch_signals_with_reason", None)
        if not callable(fetch_with_reason) or scheduler is None:
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 78,
                "blocked_reasons": ["feature_coverage_runner_unavailable"],
                "after_refs": [],
            }

        now = datetime.now(timezone.utc)
        lookback_minutes = max(1, int(settings.trading_signal_lookback_minutes))
        symbol_set = {
            str(symbol).strip().upper()
            for symbol in cast(Sequence[object], repair.get("symbol_set") or [])
            if str(symbol).strip()
        }

        def select_signals(batch: Any) -> list[Any]:
            return [
                signal
                for signal in cast(Sequence[Any], getattr(batch, "signals", []))
                if not symbol_set
                or str(getattr(signal, "symbol", "")).strip().upper() in symbol_set
            ]

        def replay_window_from_latest_signal() -> tuple[Any | None, list[Any]]:
            latest_status_fn = getattr(ingestor, "latest_signal_status", None)
            if not callable(latest_status_fn):
                return None, []
            latest_status = latest_status_fn()
            if not isinstance(latest_status, Mapping):
                return None, []
            latest_status_mapping = cast(Mapping[str, object], latest_status)
            latest_signal_at = latest_status_mapping.get("latest_signal_at")
            if not isinstance(latest_signal_at, datetime):
                return None, []
            if latest_signal_at.tzinfo is None:
                latest_signal_at = latest_signal_at.replace(tzinfo=timezone.utc)
            else:
                latest_signal_at = latest_signal_at.astimezone(timezone.utc)
            fallback_batch = fetch_with_reason(
                start=latest_signal_at - timedelta(minutes=lookback_minutes),
                end=latest_signal_at,
                limit=feature_limit,
            )
            return fallback_batch, select_signals(fallback_batch)

        try:
            batch = fetch_with_reason(
                start=now - timedelta(minutes=lookback_minutes),
                end=now,
                limit=feature_limit,
            )
            signals = select_signals(batch)
            replay_window = "current"
            if not signals:
                fallback_batch, fallback_signals = replay_window_from_latest_signal()
                if fallback_signals:
                    batch = fallback_batch
                    signals = fallback_signals
                    replay_window = "latest_signal"
            if not signals:
                no_signal_reason = str(
                    getattr(batch, "no_signal_reason", None) or "no_signals"
                )
                return {
                    "execution_state": "runner_blocked",
                    "command_exit_code": 78,
                    "blocked_reasons": [
                        f"feature_coverage_no_signals:{no_signal_reason}"
                    ],
                    "after_refs": [],
                    "result": {
                        "query_start": getattr(batch, "query_start", None),
                        "query_end": getattr(batch, "query_end", None),
                        "symbol_set": sorted(symbol_set),
                        "replay_window": replay_window,
                    },
                }

            quality_report = evaluate_feature_batch_quality(
                cast(list[SignalEnvelope], signals),
                thresholds=FeatureQualityThresholds(
                    max_required_null_rate=settings.trading_feature_max_required_null_rate,
                    max_staleness_ms=settings.trading_feature_max_staleness_ms,
                    max_duplicate_ratio=settings.trading_feature_max_duplicate_ratio,
                ),
            )
            metrics = scheduler.state.metrics
            metrics.feature_batch_rows_total = max(
                int(getattr(metrics, "feature_batch_rows_total", 0) or 0),
                quality_report.rows_total,
            )
            metrics.feature_null_rate = dict(quality_report.null_rate_by_field)
            metrics.feature_staleness_ms_p95 = quality_report.staleness_ms_p95
            metrics.feature_duplicate_ratio = quality_report.duplicate_ratio
            metrics.feature_schema_mismatch_total += (
                quality_report.schema_mismatch_total
            )
            if not quality_report.accepted:
                metrics.feature_quality_rejections_total += 1
                metrics.record_feature_quality_rejection(quality_report.reasons)
        except Exception as exc:  # pragma: no cover - fail-closed receipt path
            logger.exception("Zero-notional feature-coverage repair failed")
            return {
                "execution_state": "runner_failed",
                "command_exit_code": 1,
                "blocked_reasons": [
                    f"feature_coverage_replay_failed:{type(exc).__name__}"
                ],
                "after_refs": [],
            }

        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["feature_coverage_rows"],
            "result": {
                "signals_evaluated": len(signals),
                "rows_total": quality_report.rows_total,
                "accepted": quality_report.accepted,
                "reason_codes": list(quality_report.reasons),
                "symbol_set": sorted(symbol_set),
                "replay_window": replay_window,
                "query_start": getattr(batch, "query_start", None),
                "query_end": getattr(batch, "query_end", None),
                "feature_batch_rows_total": metrics.feature_batch_rows_total,
            },
        }

    receipt = run_zero_notional_repair(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=cast(str | None, status_payload.get("active_revision")),
        source_commit=api_common.BUILD_COMMIT,
        profit_freshness_frontier=frontier,
        execute=execute,
        preferred_action=action,
        repair_lot_dispatch_ticket=repair_lot_dispatch_ticket,
        freshness_carry_ledger=cast(
            Mapping[str, Any],
            status_payload.get("freshness_carry_ledger") or {},
        ),
        runners={
            "recompute_route_tca_and_fill_quality": run_tca_recompute,
            "rerun_drift_checks_for_blocked_hypotheses": run_drift_check_replay,
            "rebuild_required_feature_rows": run_feature_coverage_replay,
        },
    )
    return cast(dict[str, object], jsonable_encoder(receipt))


@router.get("/")
def root() -> dict[str, str]:
    """Surface service identity and build metadata."""

    return {
        "service": "torghut",
        "status": "ok",
        "version": BUILD_VERSION,
        "commit": api_common.BUILD_COMMIT,
    }


@router.get("/db-check")
def db_check(session: Session = Depends(get_session)) -> dict[str, object]:
    """Verify database connectivity and Alembic schema head alignment."""

    try:
        database_contract = evaluate_database_contract(session)
        schema_status = {
            "schema_current": bool(database_contract.get("schema_current")),
            "current_heads": database_contract.get("schema_current_heads"),
            "expected_heads": database_contract.get("expected_heads"),
            "schema_head_signature": database_contract.get("schema_head_signature"),
            "schema_graph_signature": database_contract.get("schema_graph_signature"),
            "schema_graph_roots": database_contract.get("schema_graph_roots", []),
            "schema_graph_branch_count": database_contract.get(
                "schema_graph_branch_count",
            ),
            "schema_graph_branch_tolerance": database_contract.get(
                "schema_graph_branch_tolerance",
            ),
            "schema_graph_allow_divergence_roots": database_contract.get(
                "schema_graph_allow_divergence_roots",
            ),
            "schema_graph_parent_forks": database_contract.get(
                "schema_graph_parent_forks",
                {},
            ),
            "schema_graph_duplicate_revisions": database_contract.get(
                "schema_graph_duplicate_revisions",
                {},
            ),
            "schema_graph_orphan_parents": database_contract.get(
                "schema_graph_orphan_parents",
                [],
            ),
            "schema_graph_lineage_ready": database_contract.get(
                "schema_graph_lineage_ready",
            ),
            "schema_graph_lineage_errors": database_contract.get(
                "schema_graph_lineage_errors",
                [],
            ),
            "schema_graph_lineage_warnings": database_contract.get(
                "schema_graph_lineage_warnings",
                [],
            ),
            "schema_missing_heads": database_contract.get("schema_missing_heads", []),
            "schema_unexpected_heads": database_contract.get(
                "schema_unexpected_heads", []
            ),
            "schema_head_count_expected": database_contract.get(
                "schema_head_count_expected",
            ),
            "schema_head_count_current": database_contract.get(
                "schema_head_count_current",
            ),
            "schema_head_delta_count": database_contract.get(
                "schema_head_delta_count",
            ),
        }
        account_scope_status = {
            "account_scope_ready": bool(database_contract.get("account_scope_ready")),
            "account_scope_errors": database_contract.get("account_scope_errors", []),
            "account_scope_warnings": database_contract.get(
                "account_scope_warnings",
                [],
            ),
        }
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if database_contract.get("error"):
        raise HTTPException(
            status_code=503,
            detail={
                "error": database_contract.get("error"),
                "schema_current": False,
                "schema_missing_heads": database_contract.get(
                    "schema_missing_heads", []
                ),
                "schema_unexpected_heads": database_contract.get(
                    "schema_unexpected_heads", []
                ),
                "schema_graph_lineage_ready": database_contract.get(
                    "schema_graph_lineage_ready",
                ),
                "schema_graph_lineage_errors": database_contract.get(
                    "schema_graph_lineage_errors",
                    [],
                ),
                "schema_graph_lineage_warnings": database_contract.get(
                    "schema_graph_lineage_warnings",
                    [],
                ),
                "checked_at": database_contract.get("checked_at"),
                "account_scope_ready": account_scope_status.get("account_scope_ready"),
                "account_scope_warnings": account_scope_status.get(
                    "account_scope_warnings",
                    [],
                ),
            },
        )

    if not bool(schema_status.get("schema_current")):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database schema mismatch",
                "checked_at": database_contract.get("checked_at"),
                "schema_missing_heads": database_contract.get(
                    "schema_missing_heads", []
                ),
                "schema_unexpected_heads": database_contract.get(
                    "schema_unexpected_heads", []
                ),
                "schema_head_count_expected": database_contract.get(
                    "schema_head_count_expected",
                ),
                "schema_head_count_current": database_contract.get(
                    "schema_head_count_current",
                ),
                "schema_head_delta_count": database_contract.get(
                    "schema_head_delta_count",
                ),
                **schema_status,
            },
        )
    if not bool(database_contract.get("schema_graph_lineage_ready", True)):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database schema lineage divergence",
                "checked_at": database_contract.get("checked_at"),
                "schema_graph_lineage_errors": database_contract.get(
                    "schema_graph_lineage_errors",
                    [],
                ),
                "schema_graph_lineage_warnings": database_contract.get(
                    "schema_graph_lineage_warnings",
                    [],
                ),
                **schema_status,
            },
        )
    if settings.trading_multi_account_enabled and not bool(
        account_scope_status.get("account_scope_ready")
    ):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "database account scope schema mismatch",
                "checked_at": database_contract.get("checked_at"),
                "schema_head_signature": database_contract.get("schema_head_signature"),
                "schema_graph_signature": database_contract.get(
                    "schema_graph_signature"
                ),
                "schema_graph_branch_count": database_contract.get(
                    "schema_graph_branch_count",
                ),
                "schema_graph_lineage_warnings": database_contract.get(
                    "schema_graph_lineage_warnings",
                    [],
                ),
                "account_scope_warnings": database_contract.get(
                    "account_scope_warnings",
                    [],
                ),
                **account_scope_status,
            },
        )
    if not settings.trading_multi_account_enabled:
        account_scope_status = dict(account_scope_status)
        account_scope_status["account_scope_ready"] = True
        account_scope_status["account_scope_errors"] = []

    return {
        "ok": True,
        "checked_at": database_contract.get("checked_at"),
        **schema_status,
        "account_scope_ready": bool(account_scope_status.get("account_scope_ready")),
        "account_scope_checks": account_scope_status,
    }


__all__ = [
    "_load_jangar_dependency_quorum_payload",
    "_load_jangar_verify_trust_foreclosure_board",
    "trading_revenue_repair",
    "trading_profit_freshness_zero_notional_repair",
    "root",
    "db_check",
]
