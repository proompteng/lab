"""Paper-route target-plan extraction and readiness checks."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from scripts.assemble_runtime_ledger_proof_packet_modules.common import (
    DOC29_LIVE_SCALE_GATE,
    _bool,
    _int,
    _mapping,
    _sequence,
    _text,
    _text_list,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.hpairs import _extend_unique


def _check(
    checks: dict[str, dict[str, Any]],
    key: str,
    *,
    passed: bool,
    observed: object,
    expected: object,
    blockers: Sequence[str] = (),
    detail: object | None = None,
    status: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "passed": bool(passed),
        "status": status or ("passed" if passed else "failed"),
        "observed": observed,
        "expected": expected,
    }
    if blockers:
        payload["blockers"] = list(blockers)
    if detail is not None:
        payload["detail"] = detail
    checks[key] = payload


def _completion_live_scale_gate(
    completion_status: Mapping[str, Any],
) -> Mapping[str, Any]:
    for raw_gate in _sequence(completion_status.get("gates")):
        gate = _mapping(raw_gate)
        if _text(gate.get("gate_id")) == DOC29_LIVE_SCALE_GATE:
            return gate
    gates_by_id = _mapping(completion_status.get("gates_by_id"))
    return _mapping(gates_by_id.get(DOC29_LIVE_SCALE_GATE))


def _runtime_ledger_refs(gate: Mapping[str, Any], key: str) -> list[str]:
    db_refs = _mapping(gate.get("db_row_refs"))
    refs = _text_list(db_refs.get(key))
    if refs:
        return refs
    return _text_list(gate.get(key))


def _runtime_ledger_trading_day_count(summary: Mapping[str, Any]) -> int:
    for key in (
        "runtime_ledger_observed_trading_day_count",
        "runtime_ledger_trading_day_count",
        "observed_trading_day_count",
        "trading_day_count",
        "runtime_ledger_session_count",
        "session_count",
    ):
        if key in summary:
            return _int(summary.get(key))
    return 0


def _paper_route_target_plan(
    paper_route_evidence: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    evidence = paper_route_evidence or {}
    proofs_plan = _proofs_target_plan(evidence)
    if proofs_plan:
        return proofs_plan
    for key in (
        "runtime_window_import_plan",
        "latest_closed_paper_route_runtime_window_targets",
        "next_paper_route_runtime_window_targets",
    ):
        plan = _mapping(evidence.get(key))
        if _paper_route_targets(plan):
            return plan
    return _mapping(evidence.get("runtime_window_import_plan"))


def _proofs_target_plan(evidence: Mapping[str, Any]) -> Mapping[str, Any]:
    if _text(evidence.get("schema_version")) != "torghut.proofs.v1":
        return {}
    proofs = [_mapping(item) for item in _sequence(evidence.get("proofs"))]
    targets: list[dict[str, Any]] = []
    import_blockers: list[str] = []
    for proof in proofs:
        target = _proof_identity_target(proof)
        if not target:
            continue
        target_blockers = _text_list(proof.get("blockers"))
        _extend_unique(import_blockers, target_blockers)
        target.setdefault("promotion_allowed", False)
        target.setdefault("final_promotion_allowed", False)
        target.setdefault("final_promotion_authorized", False)
        target["runtime_window_import_health_gate"] = _proof_health_gate(proof)
        target["paper_route_session_import_ready"] = _text(proof.get("state")) in {
            "import_due",
            "proof_ready",
        }
        target["paper_route_session_import_blockers"] = target_blockers
        targets.append(target)
    if not targets:
        return {}
    import_ready = any(
        bool(target.get("paper_route_session_import_ready")) for target in targets
    )
    if import_ready:
        import_blockers = [
            blocker
            for blocker in import_blockers
            if blocker != "runtime_ledger_materialization_missing"
        ]
    return {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "source": "trading_proofs_endpoint",
        "purpose": "runtime_window_proof_target_materialization",
        "target_count": len(targets),
        "targets": targets,
        "session_readiness": {
            "import_ready": import_ready and not import_blockers,
            "import_blockers": import_blockers,
        },
        "runtime_window_import_handoff": {
            "import_ready": import_ready and not import_blockers,
            "import_blockers": import_blockers,
        },
        "promotion_allowed": False,
        "final_promotion_allowed": False,
    }


def _proof_identity_target(proof: Mapping[str, Any]) -> dict[str, Any]:
    identity = _mapping(proof.get("identity"))
    window = _mapping(proof.get("window"))
    symbols = [
        _text(symbol).upper()
        for symbol in _sequence(proof.get("symbols"))
        if _text(symbol)
    ]
    return {
        "hypothesis_id": identity.get("hypothesis_id"),
        "candidate_id": identity.get("candidate_id"),
        "strategy_family": identity.get("strategy_family"),
        "strategy_name": identity.get("strategy_name")
        or identity.get("runtime_strategy_name"),
        "runtime_strategy_name": identity.get("runtime_strategy_name")
        or identity.get("strategy_name"),
        "account_label": identity.get("account_label"),
        "source_account_label": identity.get("source_account_label"),
        "source_kind": identity.get("source_kind"),
        "source_plan_ref": identity.get("source_plan_ref"),
        "target_notional": identity.get("target_notional"),
        "window_start": window.get("start"),
        "window_end": window.get("end"),
        "paper_route_probe_symbols": symbols,
        "symbols": symbols,
        "paper_route_probe_symbol_actions": dict(
            _mapping(identity.get("target_symbol_actions"))
        ),
        "paper_route_probe_symbol_quantities": dict(
            _mapping(identity.get("target_symbol_quantities"))
        ),
    }


def _proof_health_gate(proof: Mapping[str, Any]) -> dict[str, Any]:
    health = _mapping(proof.get("health"))
    blockers = _text_list(health.get("blockers"))
    ready = (
        _bool(health.get("dependency_quorum_ok"))
        and _bool(health.get("continuity_ok"))
        and _bool(health.get("drift_ok"))
        and not blockers
    )
    return {
        "ready": ready,
        "dependency_quorum_decision": "allow"
        if _bool(health.get("dependency_quorum_ok"))
        else "block",
        "continuity_ok": _bool(health.get("continuity_ok")),
        "drift_ok": _bool(health.get("drift_ok")),
        "blockers": blockers,
        "promotion_blockers": blockers,
    }


def _paper_route_import_blockers(plan: Mapping[str, Any]) -> list[str]:
    session_readiness = _mapping(plan.get("session_readiness"))
    handoff = _mapping(plan.get("runtime_window_import_handoff"))
    blockers = _text_list(session_readiness.get("import_blockers"))
    _extend_unique(blockers, _text_list(handoff.get("import_blockers")))
    for raw_target in _sequence(plan.get("targets")):
        target = _mapping(raw_target)
        _extend_unique(
            blockers, _text_list(target.get("paper_route_session_import_blockers"))
        )
    return blockers


def _paper_route_targets(plan: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(item) for item in _sequence(plan.get("targets")) if _mapping(item)]


def _paper_route_runtime_window_import_audit(
    paper_route_evidence: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    evidence = paper_route_evidence or {}
    if _text(evidence.get("schema_version")) == "torghut.proofs.v1":
        return _proofs_runtime_window_import_audit(evidence)
    return _mapping(evidence.get("runtime_window_import_audit"))


def _proofs_runtime_window_import_audit(
    evidence: Mapping[str, Any],
) -> Mapping[str, Any]:
    proofs = [_mapping(item) for item in _sequence(evidence.get("proofs"))]
    target_blockers: list[dict[str, Any]] = []
    blockers: list[str] = []
    targets_with_source_activity = 0
    for proof in proofs:
        proof_blockers = _text_list(proof.get("blockers"))
        _extend_unique(blockers, proof_blockers)
        if proof_blockers:
            identity = _mapping(proof.get("identity"))
            target_blockers.append(
                {
                    "hypothesis_id": _text(identity.get("hypothesis_id")),
                    "candidate_id": _text(identity.get("candidate_id")),
                    "strategy_name": _text(
                        identity.get("runtime_strategy_name")
                        or identity.get("strategy_name")
                    ),
                    "blockers": proof_blockers,
                }
            )
        counts = _mapping(proof.get("source_counts"))
        if _int(counts.get("rejected_signal_events")) > 0 or (
            _int(counts.get("decisions")) > 0
            and _int(counts.get("executions")) > 0
            and _int(counts.get("execution_tca_metrics")) > 0
        ):
            targets_with_source_activity += 1
    state = "ready" if proofs and not blockers else "blocked"
    if any(_text(proof.get("state")) == "import_due" for proof in proofs):
        state = "import_due"
    return {
        "state": state,
        "import_ready": any(
            _text(proof.get("state")) in {"import_due", "proof_ready"}
            for proof in proofs
        ),
        "next_action": "run_runtime_ledger_materialization"
        if state == "import_due"
        else "repair_blockers",
        "blockers": blockers,
        "target_blockers": target_blockers,
        "counts": {
            "source_plan_target_count": len(proofs),
            "targets_with_source_activity": targets_with_source_activity,
        },
    }


def _paper_route_runtime_window_import_audit_counts(
    audit: Mapping[str, Any],
) -> Mapping[str, Any]:
    return _mapping(audit.get("counts"))


def _paper_route_runtime_window_import_audit_blockers(
    audit: Mapping[str, Any],
) -> list[str]:
    return _text_list(audit.get("blockers"))


def _paper_route_runtime_window_import_target_blockers(
    audit: Mapping[str, Any],
) -> list[dict[str, Any]]:
    return [
        {str(key): value for key, value in item.items()}
        for item in (_mapping(raw) for raw in _sequence(audit.get("target_blockers")))
        if item
    ]


def _paper_route_source_activity_blockers(
    audit_blockers: Sequence[str],
) -> list[str]:
    source_blocker_names = {
        "paper_route_source_activity_missing",
        "strategy_name_missing",
        "source_decisions_missing",
        "source_executions_missing",
        "source_tca_missing",
    }
    return [
        blocker
        for blocker in audit_blockers
        if blocker in source_blocker_names or blocker.startswith("source_")
    ]


def _health_gate_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() == "true"


def _runtime_window_import_health_gate_summary(
    *,
    plan: Mapping[str, Any],
    targets: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    plan_gate = _mapping(plan.get("runtime_window_import_health_gate"))
    blockers = _text_list(plan_gate.get("blockers"))
    promotion_blockers = _text_list(plan_gate.get("promotion_blockers"))
    continuity_reasons = _text_list(plan_gate.get("continuity_reasons"))
    drift_reasons = _text_list(plan_gate.get("drift_reasons"))
    target_summaries: list[dict[str, Any]] = []
    ready_count = 0
    for index, target in enumerate(targets):
        gate = _mapping(target.get("runtime_window_import_health_gate"))
        target_blockers = _text_list(
            target.get("runtime_window_import_health_gate_blockers")
        )
        _extend_unique(target_blockers, _text_list(gate.get("blockers")))
        target_promotion_blockers = _text_list(
            target.get("runtime_window_import_promotion_blockers")
        )
        _extend_unique(
            target_promotion_blockers,
            _text_list(gate.get("promotion_blockers")),
        )
        dependency_quorum_decision = _text(
            target.get("dependency_quorum_decision")
            or gate.get("dependency_quorum_decision")
        )
        continuity_ok = target.get("continuity_ok", gate.get("continuity_ok"))
        drift_ok = target.get("drift_ok", gate.get("drift_ok"))
        continuity_reason = _text(
            target.get("continuity_reason") or gate.get("continuity_reason")
        )
        drift_reason = _text(target.get("drift_reason") or gate.get("drift_reason"))
        if not gate:
            _extend_unique(
                target_blockers, ["runtime_window_import_health_gate_missing"]
            )
        if dependency_quorum_decision != "allow":
            _extend_unique(target_blockers, ["dependency_quorum_not_allow"])
        if not _health_gate_bool(continuity_ok):
            _extend_unique(target_blockers, ["continuity_not_ok"])
        if not _health_gate_bool(drift_ok) and not target_promotion_blockers:
            _extend_unique(target_promotion_blockers, ["drift_not_ok"])
        ready = not target_blockers
        if ready:
            ready_count += 1
        _extend_unique(blockers, target_blockers)
        _extend_unique(promotion_blockers, target_promotion_blockers)
        _extend_unique(continuity_reasons, [continuity_reason])
        _extend_unique(drift_reasons, [drift_reason])
        target_summaries.append(
            {
                "index": index,
                "hypothesis_id": _text(target.get("hypothesis_id")),
                "candidate_id": _text(target.get("candidate_id")),
                "dependency_quorum_decision": dependency_quorum_decision,
                "continuity_ok": _text(continuity_ok),
                "continuity_reason": continuity_reason,
                "drift_ok": _text(drift_ok),
                "drift_reason": drift_reason,
                "ready": ready,
                "blockers": target_blockers,
                "promotion_blockers": target_promotion_blockers,
            }
        )
    target_count = len(targets)
    return {
        "schema_version": "torghut.runtime-window-import-health-gate-proof-summary.v1",
        "plan_schema_version": _text(plan_gate.get("schema_version")),
        "target_count": target_count,
        "ready_target_count": ready_count,
        "blocked_target_count": max(0, target_count - ready_count),
        "ready": target_count > 0 and ready_count == target_count and not blockers,
        "blockers": blockers,
        "promotion_blockers": promotion_blockers,
        "continuity_reasons": continuity_reasons,
        "drift_reasons": drift_reasons,
        "targets": target_summaries,
    }


def _missing_target_identity_count(targets: Sequence[Mapping[str, Any]]) -> int:
    required = (
        "hypothesis_id",
        "candidate_id",
        "strategy_family",
        "strategy_name",
        "source_manifest_ref",
        "window_start",
        "window_end",
    )
    missing_count = 0
    for target in targets:
        if any(not _text(target.get(key)) for key in required):
            missing_count += 1
    return missing_count


def _runtime_window_import_payload(
    runtime_window_import: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    payload = runtime_window_import or {}
    nested = _mapping(payload.get("runtime_window_import"))
    return nested if nested else payload


def _runtime_window_import_items(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    imports = [
        _mapping(item) for item in _sequence(payload.get("imports")) if _mapping(item)
    ]
    if imports:
        return imports
    return [payload] if payload else []


def _runtime_window_import_lineage(
    *,
    raw_payload: Mapping[str, Any] | None,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    raw = _mapping(raw_payload)
    nested = _mapping(raw.get("runtime_window_import"))
    run_ids: list[str] = []
    for candidate in (
        raw.get("run_id"),
        raw.get("runtime_window_import_run_id"),
        nested.get("run_id"),
        payload.get("run_id"),
    ):
        _extend_unique(run_ids, [_text(candidate)])
    for item in _runtime_window_import_items(payload):
        _extend_unique(run_ids, [_text(item.get("run_id"))])

    empirical_promotion = _mapping(raw.get("empirical_promotion"))
    return {
        "run_id": run_ids[0] if run_ids else "",
        "run_ids": run_ids,
        "status": _text(raw.get("status") or payload.get("status")),
        "output_dir": _text(raw.get("output_dir") or payload.get("output_dir")),
        "manifest_path": _text(
            raw.get("manifest_path") or payload.get("manifest_path")
        ),
        "empirical_promotion_status": _text(empirical_promotion.get("status")),
        "wrapped_payload_present": bool(raw),
        "nested_runtime_window_import_present": bool(nested),
        "runtime_window_import_item_count": len(_runtime_window_import_items(payload)),
    }


__all__ = (
    "_check",
    "_completion_live_scale_gate",
    "_runtime_ledger_refs",
    "_runtime_ledger_trading_day_count",
    "_paper_route_target_plan",
    "_proofs_target_plan",
    "_proof_identity_target",
    "_proof_health_gate",
    "_paper_route_import_blockers",
    "_paper_route_targets",
    "_paper_route_runtime_window_import_audit",
    "_proofs_runtime_window_import_audit",
    "_paper_route_runtime_window_import_audit_counts",
    "_paper_route_runtime_window_import_audit_blockers",
    "_paper_route_runtime_window_import_target_blockers",
    "_paper_route_source_activity_blockers",
    "_health_gate_bool",
    "_runtime_window_import_health_gate_summary",
    "_missing_target_identity_count",
    "_runtime_window_import_payload",
    "_runtime_window_import_items",
    "_runtime_window_import_lineage",
)
