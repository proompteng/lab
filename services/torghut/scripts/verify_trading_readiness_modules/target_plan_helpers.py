# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
"""Focused helpers for paper-route target plan readiness summaries."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    DOC29_LIVE_SCALE_GATE,
    InvalidOperation,
    NEXT_PAPER_ROUTE_TARGET_PLAN_SCHEMA_VERSION,
    Path,
    REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS,
    ROUTE_REACQUISITION_BOARD_SCHEMA_VERSION,
    ROUTE_REACQUISITION_BOOK_SCHEMA_VERSION,
    RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
    SCHEMA_VERSION,
    TIGERBEETLE_PARITY_STATUS_PASS,
    TIGERBEETLE_RUNTIME_LEDGER_PARITY_SCHEMA_VERSION,
    _MISSING_QUANT_REASONS,
    _QUOTE_FILLABILITY_REASON_TOKENS,
    _QUOTE_FILLABILITY_REPAIR_ACTIONS,
    _RUNTIME_LEDGER_TRADING_DAY_KEYS,
    _add_check,
    _append_unique_text,
    _bool,
    _decimal,
    _decimal_positive,
    _dimension_by_name,
    _dimension_is_required,
    _expected_floor_states,
    _health_gate_bool,
    _int,
    _load_json_object,
    _load_optional_json_object,
    _load_status_url,
    _mapping,
    _market_session_open,
    _paper_route_probe_summary,
    _paper_route_quote_fillability_summary,
    _quote_fillability_reason,
    _quote_fillability_repair_action,
    _sequence,
    _text,
    _text_list,
    argparse,
    cast,
    datetime,
    json,
    timezone,
    urlopen,
)

_TARGET_IDENTITY_FIELDS = (
    "hypothesis_id",
    "candidate_id",
    "strategy_family",
    "strategy_name",
    "account_label",
    "source_dsn_env",
    "source_kind",
    "window_start",
    "window_end",
)

_PROOF_IDENTITY_FIELDS = (
    "hypothesis_id",
    "candidate_id",
    "strategy_name",
    "account_label",
    "source_kind",
)


@dataclass(frozen=True)
class _TargetHealthEvaluation:
    dependency_quorum_decision: str
    continuity_ok: str
    continuity_reason: str
    drift_ok: str
    drift_reason: str
    blockers: list[str]
    promotion_blockers: list[str]
    ready: bool


@dataclass(frozen=True)
class _TargetAccountEvaluation:
    state: str
    blockers: list[str]


@dataclass(frozen=True)
class _TargetPlanTargetEvaluation:
    summary: dict[str, Any]
    missing_identity: bool
    probe_contract_ready: bool
    promotion_blocked: bool
    health_ready: bool
    health_blockers: list[str]
    health_promotion_blockers: list[str]
    continuity_reason: str
    drift_reason: str
    account_blockers: list[str]


@dataclass(frozen=True)
class _SkippedTargetEvaluation:
    summary: dict[str, Any]
    account_blockers: list[str]


@dataclass
class _TargetPlanRollup:
    target_summaries: list[dict[str, Any]] = field(default_factory=list)
    skipped_target_summaries: list[dict[str, Any]] = field(default_factory=list)
    account_clean_blockers: list[str] = field(default_factory=list)
    missing_identity_count: int = 0
    probe_contract_count: int = 0
    promotion_blocked_count: int = 0
    health_gate_ready_count: int = 0
    health_gate_blockers: list[str] = field(default_factory=list)
    health_gate_promotion_blockers: list[str] = field(default_factory=list)
    health_gate_continuity_reasons: list[str] = field(default_factory=list)
    health_gate_drift_reasons: list[str] = field(default_factory=list)

    def add_target(self, evaluation: _TargetPlanTargetEvaluation) -> None:
        self.target_summaries.append(evaluation.summary)
        self.missing_identity_count += int(evaluation.missing_identity)
        self.probe_contract_count += int(evaluation.probe_contract_ready)
        self.promotion_blocked_count += int(evaluation.promotion_blocked)
        self.health_gate_ready_count += int(evaluation.health_ready)
        self.add_account_blockers(evaluation.account_blockers)
        self.add_health_evidence(evaluation)

    def add_skipped(self, evaluation: _SkippedTargetEvaluation) -> None:
        self.skipped_target_summaries.append(evaluation.summary)
        self.add_account_blockers(evaluation.account_blockers)

    def add_account_blockers(self, blockers: Sequence[object]) -> None:
        for blocker in blockers:
            _append_unique_text(self.account_clean_blockers, blocker)

    def add_health_evidence(self, evaluation: _TargetPlanTargetEvaluation) -> None:
        for blocker in evaluation.health_blockers:
            _append_unique_text(self.health_gate_blockers, blocker)
        for blocker in evaluation.health_promotion_blockers:
            _append_unique_text(self.health_gate_promotion_blockers, blocker)
        _append_unique_text(
            self.health_gate_continuity_reasons, evaluation.continuity_reason
        )
        _append_unique_text(self.health_gate_drift_reasons, evaluation.drift_reason)


@dataclass(frozen=True)
class _ProofEvaluation:
    summary: dict[str, Any]
    account_blockers: list[str]
    health_blockers: list[str]
    health_promotion_blockers: list[str]
    import_blockers: list[str]
    missing_identity: bool
    health_ready: bool
    import_ready: bool
    probe_contract_ready: bool


@dataclass
class _ProofRollup:
    target_summaries: list[dict[str, Any]] = field(default_factory=list)
    account_blockers: list[str] = field(default_factory=list)
    health_blockers: list[str] = field(default_factory=list)
    health_promotion_blockers: list[str] = field(default_factory=list)
    import_blockers: list[str] = field(default_factory=list)
    health_ready_count: int = 0
    import_ready_count: int = 0
    probe_contract_count: int = 0
    missing_identity_count: int = 0

    def add(self, evaluation: _ProofEvaluation) -> None:
        self.target_summaries.append(evaluation.summary)
        self.health_ready_count += int(evaluation.health_ready)
        self.import_ready_count += int(evaluation.import_ready)
        self.probe_contract_count += int(evaluation.probe_contract_ready)
        self.missing_identity_count += int(evaluation.missing_identity)
        _extend_unique_text(self.account_blockers, evaluation.account_blockers)
        _extend_unique_text(self.health_blockers, evaluation.health_blockers)
        _extend_unique_text(
            self.health_promotion_blockers, evaluation.health_promotion_blockers
        )
        _extend_unique_text(self.import_blockers, evaluation.import_blockers)


@dataclass(frozen=True)
class _ProofPacketTargetContract:
    min_trading_days: int
    min_net_pnl: Decimal | None
    min_daily_net_pnl: Decimal | None
    source_proof_required: bool
    non_empty_source_refs_required: bool
    ok: bool


def _extend_unique_text(target: list[str], values: Sequence[object]) -> None:
    for value in values:
        _append_unique_text(target, value)


def _sorted_unique(values: Sequence[str]) -> list[str]:
    return sorted(set(values))


def _required_flags_summary(handoff: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    required_flags = {
        _text(flag) for flag in _sequence(handoff.get("required_flags")) if _text(flag)
    }
    missing_required_flags = [
        flag
        for flag in REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS
        if flag not in required_flags
    ]
    return sorted(required_flags), missing_required_flags


def _import_blockers(
    handoff: Mapping[str, Any],
    session_readiness: Mapping[str, Any],
) -> list[str]:
    return [
        _text(reason)
        for reason in (
            _sequence(handoff.get("import_blockers"))
            or _sequence(session_readiness.get("import_blockers"))
        )
        if _text(reason)
    ]


def _initial_account_blockers(
    plan: Mapping[str, Any],
    runtime_window_diagnostics: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    account_pre_session_readiness = _mapping(plan.get("account_pre_session_readiness"))
    _extend_unique_text(
        blockers, _sequence(account_pre_session_readiness.get("blockers"))
    )
    for key in ("account_state_blockers", "account_contamination_blockers"):
        _extend_unique_text(blockers, _sequence(runtime_window_diagnostics.get(key)))
    return blockers


def _target_missing_identity(target: Mapping[str, Any]) -> list[str]:
    return [field for field in _TARGET_IDENTITY_FIELDS if not _text(target.get(field))]


def _target_probe_symbols(target: Mapping[str, Any]) -> list[str]:
    return [
        _text(symbol)
        for symbol in _sequence(target.get("paper_route_probe_symbols"))
        if _text(symbol)
    ]


def _target_promotion_blocked(target: Mapping[str, Any]) -> bool:
    return (
        not _bool(target.get("promotion_allowed"))
        and not _bool(target.get("final_promotion_authorized"))
        and not _bool(target.get("final_promotion_allowed"))
        and (_decimal(target.get("max_notional")) or Decimal("0")) == 0
    )


def _target_health_evaluation(target: Mapping[str, Any]) -> _TargetHealthEvaluation:
    health_gate = _mapping(target.get("runtime_window_import_health_gate"))
    blockers = _text_list(target.get("runtime_window_import_health_gate_blockers"))
    promotion_blockers = _text_list(
        target.get("runtime_window_import_promotion_blockers")
    )
    _extend_unique_text(blockers, _sequence(health_gate.get("blockers")))
    _extend_unique_text(
        promotion_blockers, _sequence(health_gate.get("promotion_blockers"))
    )
    dependency_decision = _text(
        target.get("dependency_quorum_decision")
        or health_gate.get("dependency_quorum_decision")
    )
    continuity_ok = target.get("continuity_ok", health_gate.get("continuity_ok"))
    drift_ok = target.get("drift_ok", health_gate.get("drift_ok"))
    if not health_gate:
        _append_unique_text(blockers, "runtime_window_import_health_gate_missing")
    if dependency_decision != "allow":
        _append_unique_text(blockers, "dependency_quorum_not_allow")
    if not _health_gate_bool(continuity_ok):
        _append_unique_text(blockers, "continuity_not_ok")
    if not _health_gate_bool(drift_ok) and not promotion_blockers:
        _append_unique_text(promotion_blockers, "drift_not_ok")
    blockers = _sorted_unique(blockers)
    promotion_blockers = _sorted_unique(promotion_blockers)
    return _TargetHealthEvaluation(
        dependency_quorum_decision=dependency_decision,
        continuity_ok=_text(continuity_ok),
        continuity_reason=_text(
            target.get("continuity_reason") or health_gate.get("continuity_reason")
        ),
        drift_ok=_text(drift_ok),
        drift_reason=_text(
            target.get("drift_reason") or health_gate.get("drift_reason")
        ),
        blockers=blockers,
        promotion_blockers=promotion_blockers,
        ready=not blockers,
    )


def _target_account_evaluation(target: Mapping[str, Any]) -> _TargetAccountEvaluation:
    account_state = _mapping(target.get("paper_route_account_pre_session_state"))
    blockers = _text_list(target.get("paper_route_account_pre_session_blockers"))
    _extend_unique_text(blockers, _sequence(account_state.get("blockers")))
    return _TargetAccountEvaluation(
        state=_text(account_state.get("state")),
        blockers=_sorted_unique(blockers),
    )


def _target_evaluation(target: Mapping[str, Any]) -> _TargetPlanTargetEvaluation:
    missing_identity = _target_missing_identity(target)
    probe_symbols = _target_probe_symbols(target)
    promotion_blocked = _target_promotion_blocked(target)
    health = _target_health_evaluation(target)
    account = _target_account_evaluation(target)
    return _TargetPlanTargetEvaluation(
        summary={
            "hypothesis_id": _text(target.get("hypothesis_id")),
            "candidate_id": _text(target.get("candidate_id")),
            "strategy_name": _text(target.get("strategy_name")),
            "account_label": _text(target.get("account_label")),
            "source_dsn_env": _text(target.get("source_dsn_env")),
            "source_kind": _text(target.get("source_kind")),
            "window_start": _text(target.get("window_start")),
            "window_end": _text(target.get("window_end")),
            "paper_route_probe_symbols": probe_symbols,
            "paper_route_probe_next_session_max_notional": _text(
                target.get("paper_route_probe_next_session_max_notional")
            ),
            "promotion_blocked": promotion_blocked,
            "dependency_quorum_decision": health.dependency_quorum_decision,
            "continuity_ok": health.continuity_ok,
            "continuity_reason": health.continuity_reason,
            "drift_ok": health.drift_ok,
            "drift_reason": health.drift_reason,
            "runtime_window_import_health_gate_blockers": health.blockers,
            "runtime_window_import_promotion_blockers": health.promotion_blockers,
            "paper_route_account_pre_session_state": account.state,
            "paper_route_account_pre_session_blockers": account.blockers,
            "missing_identity_fields": missing_identity,
        },
        missing_identity=bool(missing_identity),
        probe_contract_ready=bool(
            probe_symbols
            and _decimal_positive(
                target.get("paper_route_probe_next_session_max_notional")
            )
        ),
        promotion_blocked=promotion_blocked,
        health_ready=health.ready,
        health_blockers=health.blockers,
        health_promotion_blockers=health.promotion_blockers,
        continuity_reason=health.continuity_reason,
        drift_reason=health.drift_reason,
        account_blockers=account.blockers,
    )


def _skipped_target_evaluation(
    skipped_target: Mapping[str, Any],
) -> _SkippedTargetEvaluation:
    skipped_blockers = _text_list(skipped_target.get("missing_or_blocking_fields"))
    _extend_unique_text(
        skipped_blockers,
        _sequence(skipped_target.get("paper_route_account_pre_session_blockers")),
    )
    skipped_account_state = _mapping(
        skipped_target.get("paper_route_account_pre_session_state")
    )
    _extend_unique_text(
        skipped_blockers, _sequence(skipped_account_state.get("blockers"))
    )
    account_blockers = (
        skipped_blockers
        if _text(skipped_target.get("reason"))
        == "paper_route_account_pre_session_not_clean"
        else []
    )
    return _SkippedTargetEvaluation(
        summary={
            "hypothesis_id": _text(skipped_target.get("hypothesis_id")),
            "candidate_id": _text(skipped_target.get("candidate_id")),
            "reason": _text(skipped_target.get("reason")),
            "blockers": _sorted_unique(skipped_blockers),
            "paper_route_account_pre_session_state": _text(
                skipped_account_state.get("state")
            ),
        },
        account_blockers=account_blockers,
    )


def _target_plan_rollup(
    plan: Mapping[str, Any], targets: Sequence[Mapping[str, Any]]
) -> _TargetPlanRollup:
    runtime_window_audit = _mapping(plan.get("runtime_window_import_audit"))
    diagnostics = _mapping(runtime_window_audit.get("diagnostics"))
    rollup = _TargetPlanRollup(
        account_clean_blockers=_initial_account_blockers(plan, diagnostics)
    )
    for target in targets:
        rollup.add_target(_target_evaluation(target))
    for raw_skipped_target in _sequence(plan.get("skipped_targets")):
        rollup.add_skipped(_skipped_target_evaluation(_mapping(raw_skipped_target)))
    return rollup


def _target_plan_payload(
    *,
    plan: Mapping[str, Any],
    targets: Sequence[Mapping[str, Any]],
    session_readiness: Mapping[str, Any],
    import_ready: bool,
    import_blockers: Sequence[str],
    required_flags: Sequence[str],
    missing_required_flags: Sequence[str],
    quote_fillability: Mapping[str, Any],
    rollup: _TargetPlanRollup,
) -> dict[str, Any]:
    return {
        "present": bool(plan),
        "schema_version": _text(plan.get("schema_version")),
        "target_count": _int(plan.get("target_count"), default=len(targets)),
        "actual_target_count": len(targets),
        "skipped_target_count": _int(plan.get("skipped_target_count")),
        "session_window": _mapping(plan.get("session_window")),
        "session_readiness_state": _text(session_readiness.get("state")),
        "import_ready": import_ready,
        "import_blockers": list(import_blockers),
        "required_flags": list(required_flags),
        "missing_required_flags": list(missing_required_flags),
        "targets": rollup.target_summaries,
        "skipped_targets": rollup.skipped_target_summaries,
        "missing_identity_count": rollup.missing_identity_count,
        "probe_contract_count": rollup.probe_contract_count,
        "promotion_blocked_count": rollup.promotion_blocked_count,
        "account_clean": not rollup.account_clean_blockers,
        "account_clean_blockers": sorted(rollup.account_clean_blockers),
        "quote_fillability": dict(quote_fillability),
        "runtime_window_import_health_gate": _target_plan_health_gate_payload(
            targets, rollup
        ),
    }


def _target_plan_health_gate_payload(
    targets: Sequence[Mapping[str, Any]],
    rollup: _TargetPlanRollup,
) -> dict[str, Any]:
    target_count = len(targets)
    return {
        "ready": bool(targets)
        and rollup.health_gate_ready_count == target_count
        and not rollup.health_gate_blockers,
        "target_count": target_count,
        "ready_target_count": rollup.health_gate_ready_count,
        "blocked_target_count": max(0, target_count - rollup.health_gate_ready_count),
        "blockers": rollup.health_gate_blockers,
        "promotion_blockers": rollup.health_gate_promotion_blockers,
        "continuity_reasons": rollup.health_gate_continuity_reasons,
        "drift_reasons": rollup.health_gate_drift_reasons,
    }


def _legacy_paper_route_target_plan_summary(
    evidence: Mapping[str, Any],
) -> dict[str, Any]:
    plan = _mapping(evidence.get("next_paper_route_runtime_window_targets"))
    targets = [_mapping(target) for target in _sequence(plan.get("targets"))]
    handoff = _mapping(plan.get("runtime_window_import_handoff"))
    session_readiness = _mapping(plan.get("session_readiness"))
    required_flags, missing_required_flags = _required_flags_summary(handoff)
    import_ready = _bool(handoff.get("import_ready")) or _bool(
        session_readiness.get("import_ready")
    )
    quote_fillability = _paper_route_quote_fillability_summary(
        evidence=evidence, targets=targets
    )
    return _target_plan_payload(
        plan=plan,
        targets=targets,
        session_readiness=session_readiness,
        import_ready=import_ready,
        import_blockers=_import_blockers(handoff, session_readiness),
        required_flags=required_flags,
        missing_required_flags=missing_required_flags,
        quote_fillability=quote_fillability,
        rollup=_target_plan_rollup(
            {
                **dict(plan),
                "runtime_window_import_audit": evidence.get(
                    "runtime_window_import_audit"
                ),
            },
            targets,
        ),
    )


def _proof_missing_identity(
    identity: Mapping[str, Any], window: Mapping[str, Any]
) -> list[str]:
    missing = [
        field
        for field in _PROOF_IDENTITY_FIELDS
        if not _text(
            identity.get(field)
            or (
                identity.get("runtime_strategy_name")
                if field == "strategy_name"
                else ""
            )
        )
    ]
    if not _text(window.get("start")) or not _text(window.get("end")):
        missing.append("window")
    return missing


def _proof_import_blockers(proof_blockers: Sequence[str]) -> list[str]:
    return [
        blocker
        for blocker in proof_blockers
        if blocker != "runtime_ledger_materialization_missing"
    ]


def _proof_health_ready(health: Mapping[str, Any]) -> bool:
    return (
        _bool(health.get("dependency_quorum_ok"))
        and _bool(health.get("continuity_ok"))
        and _bool(health.get("drift_ok"))
        and not _text_list(health.get("blockers"))
    )


def _proof_target_summary(
    *,
    identity: Mapping[str, Any],
    window: Mapping[str, Any],
    account_state: Mapping[str, Any],
    health: Mapping[str, Any],
    symbols: Sequence[str],
    target_notional: str,
    missing_identity: Sequence[str],
) -> dict[str, Any]:
    health_blockers = _text_list(health.get("blockers"))
    return {
        "hypothesis_id": _text(identity.get("hypothesis_id")),
        "candidate_id": _text(identity.get("candidate_id")),
        "strategy_name": _text(
            identity.get("runtime_strategy_name") or identity.get("strategy_name")
        ),
        "account_label": _text(identity.get("account_label")),
        "source_kind": _text(identity.get("source_kind")),
        "window_start": _text(window.get("start")),
        "window_end": _text(window.get("end")),
        "paper_route_probe_symbols": list(symbols),
        "paper_route_probe_next_session_max_notional": target_notional,
        "promotion_blocked": True,
        "dependency_quorum_decision": "allow"
        if _bool(health.get("dependency_quorum_ok"))
        else "block",
        "continuity_ok": _text(health.get("continuity_ok")),
        "drift_ok": _text(health.get("drift_ok")),
        "runtime_window_import_health_gate_blockers": health_blockers,
        "runtime_window_import_promotion_blockers": health_blockers,
        "paper_route_account_pre_session_blockers": _text_list(
            account_state.get("blockers")
        ),
        "missing_identity_fields": list(missing_identity),
    }


def _proof_evaluation(proof: Mapping[str, Any]) -> _ProofEvaluation:
    identity = _mapping(proof.get("identity"))
    window = _mapping(proof.get("window"))
    account_state = _mapping(proof.get("account_state"))
    health = _mapping(proof.get("health"))
    symbols = [
        _text(symbol) for symbol in _sequence(proof.get("symbols")) if _text(symbol)
    ]
    target_notional = _text(identity.get("target_notional"), "0")
    proof_blockers = _text_list(proof.get("blockers"))
    missing_identity = _proof_missing_identity(identity, window)
    return _ProofEvaluation(
        summary=_proof_target_summary(
            identity=identity,
            window=window,
            account_state=account_state,
            health=health,
            symbols=symbols,
            target_notional=target_notional,
            missing_identity=missing_identity,
        ),
        account_blockers=_text_list(account_state.get("blockers")),
        health_blockers=_text_list(health.get("blockers")),
        health_promotion_blockers=_text_list(health.get("blockers")),
        import_blockers=_proof_import_blockers(proof_blockers),
        missing_identity=bool(missing_identity),
        health_ready=_proof_health_ready(health),
        import_ready=_text(proof.get("state")) in {"import_due", "proof_ready"},
        probe_contract_ready=bool(symbols and _decimal_positive(target_notional)),
    )


def _proofs_rollup(proofs: Sequence[Mapping[str, Any]]) -> _ProofRollup:
    rollup = _ProofRollup()
    for proof in proofs:
        rollup.add(_proof_evaluation(proof))
    return rollup


def _proof_health_gate_payload(
    target_count: int, rollup: _ProofRollup
) -> dict[str, Any]:
    return {
        "ready": bool(target_count)
        and rollup.health_ready_count == target_count
        and not rollup.health_blockers,
        "target_count": target_count,
        "ready_target_count": rollup.health_ready_count,
        "blocked_target_count": max(0, target_count - rollup.health_ready_count),
        "blockers": rollup.health_blockers,
        "promotion_blockers": rollup.health_promotion_blockers,
        "continuity_reasons": [],
        "drift_reasons": [],
    }


def _build_proofs_target_plan_summary(evidence: Mapping[str, Any]) -> dict[str, Any]:
    proofs = [_mapping(item) for item in _sequence(evidence.get("proofs"))]
    rollup = _proofs_rollup(proofs)
    target_count = len(proofs)
    import_ready = target_count > 0 and rollup.import_ready_count == target_count
    return {
        "present": bool(proofs),
        "schema_version": _text(evidence.get("schema_version")),
        "target_count": target_count,
        "actual_target_count": target_count,
        "skipped_target_count": 0,
        "session_window": _mapping(evidence.get("window")),
        "session_readiness_state": "proofs",
        "import_ready": import_ready and not rollup.import_blockers,
        "import_blockers": rollup.import_blockers,
        "required_flags": sorted(REQUIRED_RUNTIME_WINDOW_TARGET_PLAN_FLAGS),
        "missing_required_flags": [],
        "targets": rollup.target_summaries,
        "skipped_targets": [],
        "missing_identity_count": rollup.missing_identity_count,
        "probe_contract_count": rollup.probe_contract_count,
        "promotion_blocked_count": target_count,
        "account_clean": not rollup.account_blockers,
        "account_clean_blockers": sorted(rollup.account_blockers),
        "quote_fillability": _empty_quote_fillability_summary(),
        "runtime_window_import_health_gate": _proof_health_gate_payload(
            target_count, rollup
        ),
    }


def _empty_quote_fillability_summary() -> dict[str, Any]:
    return {
        "present": False,
        "state": "not_reported",
        "blocked": False,
        "blocking_reasons": [],
        "repair_action": "none",
        "targets": [],
    }


def _paper_route_preopen_conditions(
    *,
    profile: str,
    require_market_open: bool,
    require_paper_route_probe_candidate: bool,
    require_paper_route_target_plan: bool,
    require_paper_route_import_ready: bool,
    require_runtime_ledger_profit_proof: bool,
    require_runtime_ledger_proof_packet: bool,
    market_open: bool,
    paper_route_probe: Mapping[str, Any],
    paper_route_target_plan: Mapping[str, Any],
    probe_blockers: Sequence[str],
    import_blockers: Sequence[str],
) -> dict[str, bool]:
    target_plan_health_gate = _mapping(
        paper_route_target_plan.get("runtime_window_import_health_gate")
    )
    return {
        "profile_allows_paper": profile in {"paper", "either"},
        "market_open_not_required": not require_market_open,
        "market_closed": not market_open,
        "probe_candidate_requirement_satisfied": require_paper_route_probe_candidate
        or require_paper_route_target_plan,
        "target_plan_required": require_paper_route_target_plan,
        "import_ready_not_required": not require_paper_route_import_ready,
        "runtime_profit_proof_not_required": not require_runtime_ledger_profit_proof,
        "runtime_packet_not_required": not require_runtime_ledger_proof_packet,
        "probe_present": bool(paper_route_probe.get("route_book_present")),
        "probe_configured": _bool(paper_route_probe.get("configured_enabled")),
        "probe_symbols_present": _int(paper_route_probe.get("eligible_symbol_count"))
        > 0,
        "probe_next_notional_positive": _decimal_positive(
            paper_route_probe.get("next_session_max_notional")
        ),
        "probe_blockers_only_market_closed": all(
            blocker == "market_session_closed" for blocker in probe_blockers
        ),
        "target_plan_present": bool(paper_route_target_plan.get("present")),
        "target_plan_targets_present": _int(
            paper_route_target_plan.get("actual_target_count")
        )
        > 0,
        "target_plan_identity_complete": _int(
            paper_route_target_plan.get("missing_identity_count")
        )
        == 0,
        "target_plan_probe_contract_ready": (
            _int(paper_route_target_plan.get("probe_contract_count"))
            == _int(paper_route_target_plan.get("actual_target_count"))
            and _int(paper_route_target_plan.get("actual_target_count")) > 0
        ),
        "target_plan_promotion_blocked": (
            _int(paper_route_target_plan.get("promotion_blocked_count"))
            == _int(paper_route_target_plan.get("actual_target_count"))
            and _int(paper_route_target_plan.get("actual_target_count")) > 0
        ),
        "target_plan_account_clean": _bool(
            paper_route_target_plan.get("account_clean")
        ),
        "target_plan_health_gate_ready": _bool(target_plan_health_gate.get("ready")),
        "target_plan_import_blockers_only_session_not_open": all(
            blocker == "paper_route_session_window_not_open"
            for blocker in import_blockers
        ),
    }


def _build_paper_route_preopen_evidence_collection_ready(
    *,
    profile: str,
    require_market_open: bool,
    require_paper_route_probe_candidate: bool,
    require_paper_route_target_plan: bool,
    require_paper_route_import_ready: bool,
    require_runtime_ledger_profit_proof: bool,
    require_runtime_ledger_proof_packet: bool,
    market_open: bool,
    paper_route_probe: Mapping[str, Any],
    paper_route_target_plan: Mapping[str, Any],
) -> dict[str, Any]:
    probe_blockers = _text_list(paper_route_probe.get("blocking_reasons"))
    import_blockers = _text_list(paper_route_target_plan.get("import_blockers"))
    conditions = _paper_route_preopen_conditions(
        profile=profile,
        require_market_open=require_market_open,
        require_paper_route_probe_candidate=require_paper_route_probe_candidate,
        require_paper_route_target_plan=require_paper_route_target_plan,
        require_paper_route_import_ready=require_paper_route_import_ready,
        require_runtime_ledger_profit_proof=require_runtime_ledger_profit_proof,
        require_runtime_ledger_proof_packet=require_runtime_ledger_proof_packet,
        market_open=market_open,
        paper_route_probe=paper_route_probe,
        paper_route_target_plan=paper_route_target_plan,
        probe_blockers=probe_blockers,
        import_blockers=import_blockers,
    )
    ready = all(conditions.values())
    return {
        "ready": ready,
        "conditions": conditions,
        "softened_checks": sorted(_PAPER_ROUTE_PREOPEN_SOFT_CHECKS) if ready else [],
        "probe_blockers": probe_blockers,
        "import_blockers": import_blockers,
        "account_clean_blockers": list(
            _sequence(paper_route_target_plan.get("account_clean_blockers"))
        ),
        "note": "pre-open evidence collection only; not promotion, runtime-ledger, or profitability proof",
    }


_PAPER_ROUTE_PREOPEN_SOFT_CHECKS = {
    "proof_floor_state",
    "route_state",
    "capital_state",
    "max_notional_positive",
    "blocking_reasons_empty",
    "alpha_readiness_pass",
    "execution_tca_pass",
    "routeable_symbol_count",
    "route_board_capital_eligible_symbols",
    "route_board_zero_notional_rows",
}


def _target_contract(target: Mapping[str, Any]) -> _ProofPacketTargetContract:
    min_trading_days = _int(target.get("min_runtime_ledger_trading_days"))
    min_net_pnl = _decimal(target.get("min_runtime_ledger_net_pnl_after_costs"))
    min_daily_net_pnl = _decimal(
        target.get("min_runtime_ledger_daily_net_pnl_after_costs")
    )
    source_proof_required = (
        target.get("source_backed_runtime_ledger_proof_required") is True
    )
    non_empty_source_refs_required = (
        target.get("non_empty_runtime_ledger_source_refs_required") is True
    )
    return _ProofPacketTargetContract(
        min_trading_days=min_trading_days,
        min_net_pnl=min_net_pnl,
        min_daily_net_pnl=min_daily_net_pnl,
        source_proof_required=source_proof_required,
        non_empty_source_refs_required=non_empty_source_refs_required,
        ok=(
            min_trading_days >= 20
            and min_net_pnl is not None
            and min_net_pnl >= Decimal("10000")
            and min_daily_net_pnl is not None
            and min_daily_net_pnl >= Decimal("500")
            and source_proof_required
            and non_empty_source_refs_required
        ),
    )


def _mode_contract_allows_authority(proof_mode_contract: Mapping[str, Any]) -> bool:
    return (
        proof_mode_contract.get("mode_can_grant_final_authority") is True
        and proof_mode_contract.get("mode_can_grant_promotion_authority") is True
        and proof_mode_contract.get(
            "requires_explicit_authority_mode_for_final_promotion"
        )
        is True
        and proof_mode_contract.get("implicit_default_final_authority") is False
    )


def _proof_packet_ok(
    *,
    packet: Mapping[str, Any],
    proof_mode: str,
    mode_contract_allows_authority: bool,
    authority_target_contract_ok: bool,
    allowed: bool,
) -> bool:
    return (
        packet.get("ok") is True
        and proof_mode == "authority"
        and mode_contract_allows_authority
        and authority_target_contract_ok
        and packet.get("final_authority_ok") is True
        and packet.get("promotion_allowed") is True
        and packet.get("capital_promotion_allowed") is True
        and packet.get("final_promotion_allowed") is True
        and allowed
    )


def _proof_packet_observed(
    *,
    packet: Mapping[str, Any],
    authority: Mapping[str, Any],
    capital_authority: Mapping[str, Any],
    target: Mapping[str, Any],
    proof_mode_contract: Mapping[str, Any],
    target_contract: _ProofPacketTargetContract,
    schema_version: str,
    proof_mode: str,
    mode_contract_allows_authority: bool,
    authority_target_contract_ok: bool,
) -> dict[str, Any]:
    return {
        "present": bool(packet),
        "schema_version": schema_version,
        "proof_mode": proof_mode,
        "proof_mode_contract": dict(proof_mode_contract),
        "mode_contract_allows_authority": mode_contract_allows_authority,
        "authority_target_contract_ok": authority_target_contract_ok,
        "final_authority_ok": packet.get("final_authority_ok"),
        "promotion_allowed": packet.get("promotion_allowed"),
        "capital_promotion_allowed": packet.get("capital_promotion_allowed"),
        "final_promotion_allowed": packet.get("final_promotion_allowed"),
        "evidence_collection_ok": packet.get("evidence_collection_ok"),
        "ok": packet.get("ok"),
        "verdict": _text(packet.get("verdict")),
        "next_action": _text(packet.get("next_action")),
        "authority_allowed": authority.get("allowed"),
        "capital_authority_allowed": capital_authority.get("allowed"),
        "authority_reason": _text(authority.get("reason")),
        "blocking_reasons": _text_list(authority.get("blocking_reasons")),
        "failed_checks": _text_list(authority.get("failed_checks")),
        "target": dict(target),
        "min_runtime_ledger_trading_days": target_contract.min_trading_days,
        "min_runtime_ledger_net_pnl_after_costs": _text(
            target.get("min_runtime_ledger_net_pnl_after_costs")
        ),
        "min_runtime_ledger_daily_net_pnl_after_costs": _text(
            target.get("min_runtime_ledger_daily_net_pnl_after_costs")
        ),
        "source_backed_runtime_ledger_proof_required": target_contract.source_proof_required,
        "non_empty_runtime_ledger_source_refs_required": target_contract.non_empty_source_refs_required,
    }


def _proof_packet_expected() -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
        "ok": True,
        "proof_mode": "authority",
        "proof_mode_contract.mode_can_grant_final_authority": True,
        "authority_target_contract_ok": True,
        "final_authority_ok": True,
        "promotion_allowed": True,
        "capital_promotion_allowed": True,
        "final_promotion_allowed": True,
        "promotion_authority.allowed": True,
        "target.min_runtime_ledger_trading_days": 20,
        "target.min_runtime_ledger_daily_net_pnl_after_costs": "500",
        "target.source_backed_runtime_ledger_proof_required": True,
        "target.non_empty_runtime_ledger_source_refs_required": True,
    }


def _runtime_ledger_proof_packet_check_payload(
    runtime_ledger_proof_packet: Mapping[str, Any] | None,
) -> tuple[bool, dict[str, Any], dict[str, Any]]:
    packet = _mapping(runtime_ledger_proof_packet)
    authority = _mapping(packet.get("promotion_authority"))
    capital_authority = _mapping(packet.get("capital_promotion_authority"))
    target = _mapping(packet.get("target"))
    proof_mode_contract = _mapping(packet.get("proof_mode_contract"))
    schema_version = _text(packet.get("schema_version"))
    proof_mode = _text(packet.get("proof_mode"))
    target_contract = _target_contract(target)
    mode_allows = _mode_contract_allows_authority(proof_mode_contract)
    packet_ok = _proof_packet_ok(
        packet=packet,
        proof_mode=proof_mode,
        mode_contract_allows_authority=mode_allows,
        authority_target_contract_ok=target_contract.ok,
        allowed=authority.get("allowed") is True,
    )
    observed = _proof_packet_observed(
        packet=packet,
        authority=authority,
        capital_authority=capital_authority,
        target=target,
        proof_mode_contract=proof_mode_contract,
        target_contract=target_contract,
        schema_version=schema_version,
        proof_mode=proof_mode,
        mode_contract_allows_authority=mode_allows,
        authority_target_contract_ok=target_contract.ok,
    )
    expected_schema = schema_version == RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION
    return (
        bool(packet) and expected_schema and packet_ok,
        observed,
        _proof_packet_expected(),
    )


__all__ = [name for name in globals() if not name.startswith("__")]
