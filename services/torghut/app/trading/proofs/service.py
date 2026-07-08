"""Canonical proof payload assembly."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Strategy
from .account_state import load_account_state
from .health import build_health_payload
from .ledger import load_runtime_ledger
from .schemas import (
    DEFAULT_PROOFS_LIMIT,
    MAX_PROOFS_LIMIT,
    PROOFS_SCHEMA_VERSION,
    ProofKind,
    ProofPayload,
    ProofState,
    ProofWindowSelector,
    ProofsPayload,
)
from .source_activity import (
    load_source_activity_counts,
    source_activity_blockers,
    source_activity_satisfied,
)
from .targets import (
    ProofTarget,
    isoformat,
    latest_closed_regular_equities_session_window,
    next_regular_equities_session_window,
    proof_target_strategy_lookup_names_from_payloads,
    select_proof_targets,
)


def build_proofs_payload(
    session: Session,
    *,
    live_submission_gate: Mapping[str, object],
    target_selection_live_submission_gate: Mapping[str, object] | None = None,
    route_reacquisition_book: Mapping[str, object],
    generated_at: datetime | None = None,
    kind: ProofKind = "runtime_window",
    limit: int = DEFAULT_PROOFS_LIMIT,
    window: ProofWindowSelector = "auto",
    full_audit: bool = False,
    target_account_audit_available: bool = True,
) -> ProofsPayload:
    resolved_generated_at = generated_at or datetime.now(timezone.utc)
    bounded_limit = max(1, min(int(limit or DEFAULT_PROOFS_LIMIT), MAX_PROOFS_LIMIT))
    target_gate = target_selection_live_submission_gate or live_submission_gate
    strategy_universe_by_name = _load_strategy_universe_by_name(
        session,
        live_submission_gate=target_gate,
        route_reacquisition_book=route_reacquisition_book,
    )
    targets = select_proof_targets(
        live_submission_gate=target_gate,
        route_reacquisition_book=route_reacquisition_book,
        limit=bounded_limit,
        window=window,
        generated_at=resolved_generated_at,
        strategy_universe_by_name=strategy_universe_by_name,
    )
    proofs = [
        _build_proof(
            session,
            target,
            generated_at=resolved_generated_at,
            full_audit=full_audit,
            target_account_audit_available=target_account_audit_available,
            live_submission_gate=target_gate,
        )
        for target in targets
    ]
    state_counts = Counter(proof["state"] for proof in proofs)
    blocker_counts: Counter[str] = Counter()
    for proof in proofs:
        blocker_counts.update(proof["blockers"])
    gate_payload = _live_submission_gate_payload(live_submission_gate)
    gate_freshness = _live_submission_gate_freshness(gate_payload)
    return {
        "schema_version": PROOFS_SCHEMA_VERSION,
        "generated_at": isoformat(resolved_generated_at),
        "kind": kind,
        "window": _window_summary(
            window=window,
            generated_at=resolved_generated_at,
            proofs=proofs,
        ),
        "live_submission_gate": gate_payload,
        "proofs": proofs,
        "summary": {
            "target_count": len(targets),
            "proof_count": len(proofs),
            "state_counts": dict(sorted(state_counts.items())),
            "blocker_counts": dict(sorted(blocker_counts.items())),
            "ready_count": state_counts.get("proof_ready", 0),
            "import_due_count": state_counts.get("import_due", 0),
            "blocked_count": state_counts.get("blocked", 0),
            "live_submission_allowed": bool(gate_payload.get("allowed")),
            "live_submission_reason": _text_or_none(gate_payload.get("reason")),
            "accepted_source_state": _text_or_none(
                gate_freshness.get("accepted_source_state")
            ),
            "accepted_lag_seconds": _float_or_none(
                gate_freshness.get("accepted_lag_seconds")
            ),
        },
        "promotion_authority": {
            "allowed": False,
            "final_promotion_allowed": False,
            "reason": "proof_collection_only",
            "blockers": ["live_runtime_ledger_authority_required"],
        },
    }


def _live_submission_gate_payload(
    live_submission_gate: Mapping[str, object],
) -> dict[str, object]:
    proof_only_keys = {
        "runtime_ledger_paper_probation_import_plan",
        "paper_route_target_plan",
        "paper_route_target_plan_fallback",
        "paper_route_target_plan_loaded_at",
        "configured_paper_collection_target_plan",
    }
    return {
        str(key): value
        for key, value in live_submission_gate.items()
        if str(key).strip() and str(key) not in proof_only_keys
    }


def _live_submission_gate_freshness(
    live_submission_gate: Mapping[str, object],
) -> Mapping[str, object]:
    freshness = live_submission_gate.get("clickhouse_ta_freshness")
    if isinstance(freshness, Mapping):
        return cast(Mapping[str, object], freshness)
    return {}


def _text_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _float_or_none(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    if not isinstance(value, str):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _load_strategy_universe_by_name(
    session: Session,
    *,
    live_submission_gate: Mapping[str, object],
    route_reacquisition_book: Mapping[str, object],
) -> dict[str, object]:
    names = proof_target_strategy_lookup_names_from_payloads(
        live_submission_gate=live_submission_gate,
        route_reacquisition_book=route_reacquisition_book,
    )
    if not names:
        return {}
    rows = session.execute(
        select(Strategy.name, Strategy.universe_symbols).where(Strategy.name.in_(names))
    ).all()
    return {
        str(name): universe_symbols
        for name, universe_symbols in rows
        if str(name or "").strip()
    }


def _build_proof(
    session: Session,
    target: ProofTarget,
    *,
    generated_at: datetime,
    full_audit: bool,
    target_account_audit_available: bool,
    live_submission_gate: Mapping[str, object],
) -> ProofPayload:
    window_closed = generated_at >= target.window_end
    source_counts = load_source_activity_counts(session, target)
    ledger = load_runtime_ledger(session, target)
    account_state = load_account_state(session, target, window_closed=window_closed)
    health = build_health_payload(
        live_submission_gate=live_submission_gate,
        target=target,
    )
    blockers: list[str] = []
    blockers.extend(health["blockers"])
    if not target_account_audit_available:
        blockers.append("target_account_audit_unavailable")
    if full_audit or window_closed:
        blockers.extend(account_state["blockers"])
    source_blockers = source_activity_blockers(
        source_counts, window_closed=window_closed
    )
    blockers.extend(source_blockers)
    if window_closed and source_activity_satisfied(source_counts):
        blockers.extend(ledger["blockers"])
    blockers = list(dict.fromkeys(blockers))
    state = _proof_state(
        generated_at=generated_at,
        target=target,
        window_closed=window_closed,
        source_ok=source_activity_satisfied(source_counts),
        ledger_materialized=ledger["materialized"],
        blockers=blockers,
    )
    return {
        "proof_id": _proof_id(target),
        "identity": {
            "hypothesis_id": target.hypothesis_id,
            "candidate_id": target.candidate_id,
            "strategy_family": target.strategy_family,
            "strategy_name": target.strategy_name,
            "runtime_strategy_name": target.runtime_strategy_name,
            "account_label": target.account_label,
            "source_account_label": target.source_account_label,
            "source_kind": target.source_kind,
            "source_plan_ref": target.source_plan_ref,
            "target_notional": target.target_notional,
            "target_symbol_actions": target.symbol_actions,
            "target_symbol_quantities": target.symbol_quantities,
            "source_decision_mode": target.source_decision_mode,
        },
        "window": {
            "selector": "latest_closed" if window_closed else "next",
            "start": isoformat(target.window_start),
            "end": isoformat(target.window_end),
            "closed": window_closed,
        },
        "symbols": list(target.symbols),
        "source_counts": source_counts,
        "runtime_ledger": ledger,
        "account_state": account_state,
        "health": health,
        "post_cost_pnl_basis": ledger["pnl_basis"],
        "post_cost_pnl_value": ledger["net_strategy_pnl_after_costs"],
        "state": state,
        "blockers": blockers,
        "next_action": _next_action(state, blockers),
    }


def _proof_state(
    *,
    generated_at: datetime,
    target: ProofTarget,
    window_closed: bool,
    source_ok: bool,
    ledger_materialized: bool,
    blockers: list[str],
) -> ProofState:
    if generated_at < target.window_start:
        return "waiting_for_session"
    if not window_closed:
        return "collecting"
    hard_blockers = [
        blocker
        for blocker in blockers
        if blocker != "runtime_ledger_materialization_missing"
    ]
    if hard_blockers:
        return "blocked"
    if not source_ok:
        return "blocked"
    if not ledger_materialized:
        return "import_due"
    return "proof_ready"


def _next_action(state: ProofState, blockers: list[str]) -> str:
    if state == "waiting_for_session":
        return "wait_for_session_open"
    if state == "collecting":
        return "collect_source_activity"
    if state == "import_due":
        return "run_runtime_ledger_materialization"
    if state == "proof_ready":
        return "attach_to_runtime_ledger_proof_packet"
    if "account_not_flat_after_window" in blockers:
        return "flatten_account_and_capture_close_snapshot"
    if "clean_baseline_snapshot_missing" in blockers:
        return "capture_clean_baseline_snapshot"
    if "execution_tca_missing" in blockers:
        return "recompute_execution_tca"
    if "runtime_ledger_materialization_missing" in blockers:
        return "run_runtime_ledger_materialization"
    return "repair_blockers"


def _proof_id(target: ProofTarget) -> str:
    parts = [
        target.hypothesis_id or "missing-hypothesis",
        target.candidate_id or "missing-candidate",
        target.runtime_strategy_name or target.strategy_name or "missing-strategy",
        isoformat(target.window_start),
        isoformat(target.window_end),
    ]
    return "|".join(parts)


def _window_summary(
    *,
    window: ProofWindowSelector,
    generated_at: datetime,
    proofs: list[ProofPayload],
) -> dict[str, object]:
    if proofs:
        starts = sorted(str(proof["window"]["start"]) for proof in proofs)
        ends = sorted(str(proof["window"]["end"]) for proof in proofs)
        return {
            "selector": window,
            "start": starts[0],
            "end": ends[-1],
            "closed": all(bool(proof["window"]["closed"]) for proof in proofs),
        }
    if window == "latest_closed":
        start, end = latest_closed_regular_equities_session_window(generated_at)
    else:
        start, end = next_regular_equities_session_window(generated_at)
    return {
        "selector": window,
        "start": isoformat(start),
        "end": isoformat(end),
        "closed": generated_at >= end,
    }
