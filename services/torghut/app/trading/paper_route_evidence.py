"""Paper-route evidence audit helpers.

This module keeps paper-probation observability separate from promotion
authority. It explains why a target is still evidence collection only instead
of mutating any live submission gate.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Execution,
    ExecutionTCAMetric,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from .runtime_ledger import POST_COST_PNL_BASIS


PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION = "torghut.paper-route-evidence.v1"
DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS = 72
DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT = 20


def _as_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[str, Any], value).items()}


def _as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _as_mapping_items(value: object) -> list[dict[str, Any]]:
    return [
        _as_mapping(cast(object, item))
        for item in _as_sequence(value)
        if isinstance(item, Mapping)
    ]


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _safe_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal(int(value))
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value).strip())
        except (InvalidOperation, ValueError):
            return Decimal("0")
    return Decimal("0")


def _decimal_text(value: object) -> str:
    amount = _safe_decimal(value)
    text = format(amount, "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = _safe_text(value)
        if text is None:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _paper_route_probe_summary(
    route_reacquisition_book: Mapping[str, Any],
) -> dict[str, object]:
    summary = _as_mapping(route_reacquisition_book.get("summary"))
    probe = _as_mapping(route_reacquisition_book.get("paper_route_probe"))
    eligible_symbols = [
        str(item).strip()
        for item in _as_sequence(
            probe.get("eligible_symbols")
            or summary.get("paper_route_probe_eligible_symbols")
        )
        if str(item).strip()
    ]
    active_symbols = [
        str(item).strip()
        for item in _as_sequence(
            probe.get("active_symbols")
            or summary.get("paper_route_probe_active_symbols")
        )
        if str(item).strip()
    ]
    blocking_reasons = [
        str(item).strip()
        for item in _as_sequence(probe.get("blocking_reasons"))
        if str(item).strip()
    ]
    return {
        "schema_version": _safe_text(route_reacquisition_book.get("schema_version"))
        or "missing",
        "state": _safe_text(route_reacquisition_book.get("state")) or "unknown",
        "configured_enabled": bool(probe.get("configured_enabled")),
        "active": bool(probe.get("active")),
        "effective_max_notional": _safe_text(probe.get("effective_max_notional"))
        or "0",
        "next_session_max_notional": _safe_text(probe.get("next_session_max_notional"))
        or "0",
        "eligible_symbol_count": _safe_int(
            probe.get("eligible_symbol_count") or len(eligible_symbols)
        ),
        "eligible_symbols": eligible_symbols,
        "active_symbols": active_symbols,
        "blocking_reasons": blocking_reasons,
    }


def _target_identity(target: Mapping[str, Any]) -> dict[str, object]:
    return {
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
        "strategy_family": _safe_text(target.get("strategy_family")),
        "strategy_name": _safe_text(target.get("strategy_name")),
        "account_label": _safe_text(target.get("account_label")),
        "source_kind": _safe_text(target.get("source_kind")),
        "source_dsn_env": _safe_text(target.get("source_dsn_env")),
        "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
        "dataset_snapshot_ref": _safe_text(target.get("dataset_snapshot_ref")),
        "window_start": _safe_text(target.get("window_start")),
        "window_end": _safe_text(target.get("window_end")),
        "runtime_ledger_bucket_ref": _safe_text(
            target.get("runtime_ledger_bucket_ref")
        ),
        "paper_probation_authorized": bool(target.get("paper_probation_authorized")),
        "paper_probation_authorization_scope": _safe_text(
            target.get("paper_probation_authorization_scope")
        ),
        "promotion_allowed": bool(target.get("promotion_allowed")),
        "final_promotion_allowed": bool(
            target.get("final_promotion_allowed")
            or target.get("final_promotion_authorized")
        ),
        "max_notional": _safe_text(target.get("max_notional")) or "0",
        "final_promotion_blockers": [
            str(item).strip()
            for item in _as_sequence(target.get("final_promotion_blockers"))
            if str(item).strip()
        ],
        "candidate_blockers": [
            str(item).strip()
            for item in _as_sequence(target.get("candidate_blockers"))
            if str(item).strip()
        ],
        "runtime_ledger_target_metadata_blockers": [
            str(item).strip()
            for item in _as_sequence(
                target.get("runtime_ledger_target_metadata_blockers")
            )
            if str(item).strip()
        ],
    }


def _target_window(
    target: Mapping[str, Any],
    *,
    generated_at: datetime,
    lookback_hours: int,
) -> tuple[datetime, datetime]:
    fallback_end = generated_at
    fallback_start = fallback_end - timedelta(hours=max(1, lookback_hours))
    window_start = _parse_datetime(target.get("window_start")) or fallback_start
    window_end = _parse_datetime(target.get("window_end")) or fallback_end
    if window_end < window_start:
        return fallback_start, fallback_end
    return window_start, window_end


def _strategy_source_activity(
    session: Session,
    *,
    strategy_name: str | None,
    window_start: datetime,
) -> dict[str, object]:
    if strategy_name is None:
        return {
            "strategy_name": None,
            "decision_count": 0,
            "execution_count": 0,
            "filled_execution_count": 0,
            "tca_sample_count": 0,
            "last_decision_at": None,
            "last_execution_at": None,
            "last_tca_at": None,
            "missing": True,
            "missing_reasons": ["strategy_name_missing"],
        }

    decision_rows = list(
        session.execute(
            select(TradeDecision)
            .join(Strategy, TradeDecision.strategy_id == Strategy.id)
            .where(Strategy.name == strategy_name)
            .where(TradeDecision.created_at >= window_start)
            .order_by(TradeDecision.created_at.desc())
            .limit(500)
        ).scalars()
    )
    decision_ids = [row.id for row in decision_rows]
    execution_rows: list[Execution] = []
    if decision_ids:
        execution_rows = list(
            session.execute(
                select(Execution)
                .where(Execution.trade_decision_id.in_(decision_ids))
                .order_by(Execution.created_at.desc())
                .limit(500)
            ).scalars()
        )
    tca_rows = list(
        session.execute(
            select(ExecutionTCAMetric)
            .join(Strategy, ExecutionTCAMetric.strategy_id == Strategy.id)
            .where(Strategy.name == strategy_name)
            .where(ExecutionTCAMetric.computed_at >= window_start)
            .order_by(ExecutionTCAMetric.computed_at.desc())
            .limit(500)
        ).scalars()
    )
    decision_count = len(decision_rows)
    execution_count = len(execution_rows)
    tca_sample_count = len(tca_rows)
    filled_execution_count = sum(
        int(_safe_decimal(row.filled_qty) > 0) for row in execution_rows
    )
    missing_reasons: list[str] = []
    if decision_count <= 0:
        missing_reasons.append("source_decisions_missing")
    if execution_count <= 0:
        missing_reasons.append("source_executions_missing")
    if tca_sample_count <= 0:
        missing_reasons.append("source_tca_missing")
    return {
        "strategy_name": strategy_name,
        "decision_count": decision_count,
        "execution_count": execution_count,
        "filled_execution_count": filled_execution_count,
        "tca_sample_count": tca_sample_count,
        "last_decision_at": _isoformat(
            decision_rows[0].created_at if decision_rows else None
        ),
        "last_execution_at": _isoformat(
            execution_rows[0].created_at if execution_rows else None
        ),
        "last_tca_at": _isoformat(tca_rows[0].computed_at if tca_rows else None),
        "missing": bool(missing_reasons),
        "missing_reasons": missing_reasons,
    }


def _target_filters(
    stmt: Any,
    model: Any,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
) -> Any:
    if hypothesis_id is None:
        return stmt.where(model.hypothesis_id == "__missing_paper_route_hypothesis__")
    stmt = stmt.where(model.hypothesis_id == hypothesis_id)
    if candidate_id is not None:
        stmt = stmt.where(model.candidate_id == candidate_id)
    return stmt


def _positive_hash_count(value: object) -> bool:
    counts = _as_mapping(value)
    return bool(counts) and any(_safe_int(count) > 0 for count in counts.values())


def _runtime_ledger_bucket_evidence_grade(row: StrategyRuntimeLedgerBucket) -> bool:
    blockers = [
        str(item).strip()
        for item in _as_sequence(row.blockers_json)
        if str(item).strip()
    ]
    return (
        row.pnl_basis == POST_COST_PNL_BASIS
        and _safe_int(row.fill_count) > 0
        and _safe_int(row.submitted_order_count) > 0
        and _safe_int(row.closed_trade_count) > 0
        and _safe_int(row.open_position_count) == 0
        and _safe_decimal(row.filled_notional) > 0
        and _positive_hash_count(row.execution_policy_hash_counts)
        and _positive_hash_count(row.cost_model_hash_counts)
        and _positive_hash_count(row.lineage_hash_counts)
        and not blockers
    )


def _runtime_ledger_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    stmt = select(StrategyRuntimeLedgerBucket).order_by(
        StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
        StrategyRuntimeLedgerBucket.created_at.desc(),
    )
    stmt = _target_filters(
        stmt,
        StrategyRuntimeLedgerBucket,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    stmt = stmt.where(StrategyRuntimeLedgerBucket.bucket_started_at <= window_end)
    stmt = stmt.where(StrategyRuntimeLedgerBucket.bucket_ended_at >= window_start)
    rows = list(session.execute(stmt.limit(50)).scalars())
    filled_notional = sum((row.filled_notional for row in rows), Decimal("0"))
    net_pnl = sum((row.net_strategy_pnl_after_costs for row in rows), Decimal("0"))
    return {
        "bucket_count": len(rows),
        "evidence_grade_bucket_count": sum(
            int(_runtime_ledger_bucket_evidence_grade(row)) for row in rows
        ),
        "fill_count": sum(max(0, _safe_int(row.fill_count)) for row in rows),
        "decision_count": sum(max(0, _safe_int(row.decision_count)) for row in rows),
        "submitted_order_count": sum(
            max(0, _safe_int(row.submitted_order_count)) for row in rows
        ),
        "closed_trade_count": sum(
            max(0, _safe_int(row.closed_trade_count)) for row in rows
        ),
        "open_position_count": sum(
            max(0, _safe_int(row.open_position_count)) for row in rows
        ),
        "filled_notional": _decimal_text(filled_notional),
        "net_strategy_pnl_after_costs": _decimal_text(net_pnl),
        "post_cost_expectancy_bps": _decimal_text(
            (net_pnl / filled_notional * Decimal("10000"))
            if filled_notional > 0
            else Decimal("0")
        ),
        "latest_bucket_ended_at": _isoformat(rows[0].bucket_ended_at if rows else None),
        "db_row_refs": [str(row.id) for row in rows],
        "blockers": sorted(
            {
                str(item).strip()
                for row in rows
                for item in _as_sequence(row.blockers_json)
                if str(item).strip()
            }
        ),
    }


def _hypothesis_window_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    stmt = select(StrategyHypothesisMetricWindow).order_by(
        StrategyHypothesisMetricWindow.window_ended_at.desc().nullslast(),
        StrategyHypothesisMetricWindow.created_at.desc(),
    )
    stmt = _target_filters(
        stmt,
        StrategyHypothesisMetricWindow,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    stmt = stmt.where(StrategyHypothesisMetricWindow.window_started_at <= window_end)
    stmt = stmt.where(StrategyHypothesisMetricWindow.window_ended_at >= window_start)
    rows = list(session.execute(stmt.limit(50)).scalars())
    provenance_counts: dict[str, int] = {}
    maturity_counts: dict[str, int] = {}
    for row in rows:
        provenance = row.evidence_provenance or "missing"
        maturity = row.evidence_maturity or "missing"
        provenance_counts[provenance] = provenance_counts.get(provenance, 0) + 1
        maturity_counts[maturity] = maturity_counts.get(maturity, 0) + 1
    return {
        "window_count": len(rows),
        "decision_count": sum(max(0, _safe_int(row.decision_count)) for row in rows),
        "trade_count": sum(max(0, _safe_int(row.trade_count)) for row in rows),
        "order_count": sum(max(0, _safe_int(row.order_count)) for row in rows),
        "market_session_count": sum(
            max(0, _safe_int(row.market_session_count)) for row in rows
        ),
        "latest_window_ended_at": _isoformat(rows[0].window_ended_at if rows else None),
        "evidence_provenance_counts": provenance_counts,
        "evidence_maturity_counts": maturity_counts,
        "db_row_refs": [str(row.id) for row in rows],
    }


def _promotion_decision_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
) -> dict[str, object]:
    stmt = select(StrategyPromotionDecision).order_by(
        StrategyPromotionDecision.created_at.desc()
    )
    stmt = _target_filters(
        stmt,
        StrategyPromotionDecision,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    rows = list(session.execute(stmt.limit(20)).scalars())
    latest = rows[0] if rows else None
    return {
        "decision_count": len(rows),
        "allowed_count": sum(int(bool(row.allowed)) for row in rows),
        "latest": None
        if latest is None
        else {
            "id": str(latest.id),
            "run_id": latest.run_id,
            "promotion_target": latest.promotion_target,
            "state": latest.state,
            "allowed": bool(latest.allowed),
            "reason_summary": latest.reason_summary,
            "created_at": _isoformat(latest.created_at),
        },
        "db_row_refs": [str(row.id) for row in rows],
    }


def _readiness_blockers(
    *,
    target: Mapping[str, object],
    probe: Mapping[str, object],
    source_activity: Mapping[str, object],
    runtime_ledger: Mapping[str, object],
    hypothesis_windows: Mapping[str, object],
    promotion_decisions: Mapping[str, object],
) -> list[str]:
    blockers = {
        str(item).strip()
        for key in (
            "final_promotion_blockers",
            "candidate_blockers",
            "runtime_ledger_target_metadata_blockers",
        )
        for item in _as_sequence(target.get(key))
        if str(item).strip()
    }
    if not bool(target.get("promotion_allowed")):
        blockers.add("paper_probation_evidence_collection_only")
    if not bool(probe.get("configured_enabled")):
        blockers.add("paper_route_probe_disabled")
    if _safe_int(probe.get("eligible_symbol_count")) <= 0:
        blockers.add("paper_route_probe_candidate_missing")
    probe_blockers = [
        str(item).strip()
        for item in _as_sequence(probe.get("blocking_reasons"))
        if str(item).strip() and str(item).strip() != "market_session_closed"
    ]
    blockers.update(probe_blockers)
    blockers.update(
        str(item).strip()
        for item in _as_sequence(source_activity.get("missing_reasons"))
        if str(item).strip()
    )
    if _safe_int(runtime_ledger.get("bucket_count")) <= 0:
        blockers.add("runtime_ledger_bucket_missing")
    if _safe_int(runtime_ledger.get("evidence_grade_bucket_count")) <= 0:
        blockers.add("runtime_ledger_evidence_grade_bucket_missing")
    if _safe_int(hypothesis_windows.get("window_count")) <= 0:
        blockers.add("hypothesis_window_missing")
    if _safe_int(promotion_decisions.get("decision_count")) <= 0:
        blockers.add("promotion_decision_missing")
    else:
        latest = _as_mapping(promotion_decisions.get("latest"))
        if not bool(latest.get("allowed")):
            blockers.add("promotion_decision_not_allowed")
    return sorted(blockers)


def _target_audit(
    session: Session,
    *,
    raw_target: Mapping[str, Any],
    probe: Mapping[str, object],
    generated_at: datetime,
    lookback_hours: int,
) -> dict[str, object]:
    target = _target_identity(raw_target)
    window_start, window_end = _target_window(
        target,
        generated_at=generated_at,
        lookback_hours=lookback_hours,
    )
    hypothesis_id = cast(str | None, target.get("hypothesis_id"))
    candidate_id = cast(str | None, target.get("candidate_id"))
    source_activity = _strategy_source_activity(
        session,
        strategy_name=cast(str | None, target.get("strategy_name")),
        window_start=window_start,
    )
    runtime_ledger = _runtime_ledger_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
        window_start=window_start,
        window_end=window_end,
    )
    hypothesis_windows = _hypothesis_window_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
        window_start=window_start,
        window_end=window_end,
    )
    promotion_decisions = _promotion_decision_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    blockers = _readiness_blockers(
        target=target,
        probe=probe,
        source_activity=source_activity,
        runtime_ledger=runtime_ledger,
        hypothesis_windows=hypothesis_windows,
        promotion_decisions=promotion_decisions,
    )
    return {
        "target": target,
        "window": {
            "start": _isoformat(window_start),
            "end": _isoformat(window_end),
        },
        "source_activity": source_activity,
        "runtime_ledger": runtime_ledger,
        "hypothesis_windows": hypothesis_windows,
        "promotion_decisions": promotion_decisions,
        "readiness": {
            "state": "evidence_collection_blocked"
            if blockers
            else "paper_evidence_collecting",
            "promotion_allowed": bool(target.get("promotion_allowed")),
            "final_promotion_allowed": bool(target.get("final_promotion_allowed")),
            "blockers": blockers,
        },
    }


def build_paper_route_evidence_audit(
    session: Session,
    *,
    live_submission_gate: Mapping[str, Any],
    route_reacquisition_book: Mapping[str, Any],
    generated_at: datetime | None = None,
    lookback_hours: int = DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    target_limit: int = DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
) -> dict[str, object]:
    """Build a target-by-target audit for paper-route evidence collection."""

    resolved_generated_at = generated_at or datetime.now(timezone.utc)
    plan = _as_mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    targets = _as_mapping_items(plan.get("targets"))[: max(0, target_limit)]
    probe = _paper_route_probe_summary(route_reacquisition_book)
    target_audits = [
        _target_audit(
            session,
            raw_target=target,
            probe=probe,
            generated_at=resolved_generated_at,
            lookback_hours=lookback_hours,
        )
        for target in targets
    ]
    summary_blockers = sorted(
        {
            str(blocker)
            for audit in target_audits
            for blocker in _as_sequence(
                _as_mapping(audit.get("readiness")).get("blockers")
            )
        }
    )
    if not targets:
        summary_blockers.append("paper_probation_import_plan_missing")
    return {
        "schema_version": PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION,
        "generated_at": _isoformat(resolved_generated_at),
        "window": {
            "lookback_hours": lookback_hours,
            "target_limit": target_limit,
        },
        "live_submission_gate": {
            "allowed": bool(live_submission_gate.get("allowed")),
            "reason": _safe_text(live_submission_gate.get("reason")),
            "blocked_reasons": [
                str(item).strip()
                for item in _as_sequence(live_submission_gate.get("blocked_reasons"))
                if str(item).strip()
            ],
            "promotion_eligible_total": _safe_int(
                live_submission_gate.get("promotion_eligible_total")
            ),
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": _safe_text(plan.get("schema_version")),
                "target_count": _safe_int(plan.get("target_count") or len(targets)),
                "skipped_target_count": _safe_int(plan.get("skipped_target_count")),
                "promotion_allowed": bool(plan.get("promotion_allowed")),
                "final_promotion_allowed": bool(
                    plan.get("final_promotion_allowed")
                    or plan.get("final_promotion_authorized")
                ),
            },
        },
        "paper_route_probe": probe,
        "summary": {
            "target_count": len(targets),
            "target_with_source_activity_count": sum(
                int(not bool(_as_mapping(audit.get("source_activity")).get("missing")))
                for audit in target_audits
            ),
            "target_with_runtime_ledger_count": sum(
                int(
                    _safe_int(
                        _as_mapping(audit.get("runtime_ledger")).get("bucket_count")
                    )
                    > 0
                )
                for audit in target_audits
            ),
            "target_with_promotion_decision_count": sum(
                int(
                    _safe_int(
                        _as_mapping(audit.get("promotion_decisions")).get(
                            "decision_count"
                        )
                    )
                    > 0
                )
                for audit in target_audits
            ),
            "promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "promotion_allowed"
                        )
                    )
                )
                for audit in target_audits
            ),
            "final_promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "final_promotion_allowed"
                        )
                    )
                )
                for audit in target_audits
            ),
            "blockers": summary_blockers,
        },
        "targets": target_audits,
    }


__all__ = [
    "DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION",
    "build_paper_route_evidence_audit",
]
