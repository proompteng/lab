"""Runtime-ledger proof packet builder."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, cast

from app.trading.runtime_ledger_proof_policy import normalize_runtime_ledger_proof_mode
from scripts.assemble_runtime_ledger_proof_packet_modules.common import (
    DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
    DEFAULT_RUNTIME_LEDGER_PROOF_POLICY,
    RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER,
    SCHEMA_VERSION,
    _bool,
    _contains_tigerbeetle_claim,
    _decimal_text,
    _int,
    _mapping,
    _text,
    _text_list,
    _utc_now,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.hpairs import (
    _extend_unique,
    _hpairs_source_proof_census_status,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.lineage_verdict import (
    _first_identity,
    _required_actions,
    _runtime_code_parity,
    _runtime_ledger_immutable_lineage,
    _status_gate_blocker_summary,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.paper_route import (
    _check,
    _missing_target_identity_count,
    _paper_route_import_blockers,
    _paper_route_runtime_window_import_audit,
    _paper_route_runtime_window_import_audit_blockers,
    _paper_route_runtime_window_import_audit_counts,
    _paper_route_runtime_window_import_target_blockers,
    _paper_route_source_activity_blockers,
    _paper_route_target_plan,
    _paper_route_targets,
    _runtime_window_import_health_gate_summary,
    _runtime_window_import_items,
    _runtime_window_import_lineage,
    _runtime_window_import_payload,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.runtime_import_materialization import (
    _runtime_import_authoritative_observation_count,
    _runtime_import_blockers,
    _runtime_import_materialization_summary,
)
from scripts.assemble_runtime_ledger_proof_packet_modules.runtime_ledger_checks import (
    RuntimeLedgerCheckContext,
    RuntimeLedgerThresholds,
    evaluate_runtime_ledger_checks,
)


def build_runtime_ledger_proof_packet(
    status: Mapping[str, Any],
    *,
    proof_mode: str = DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
    paper_route_evidence: Mapping[str, Any] | None = None,
    runtime_window_import: Mapping[str, Any] | None = None,
    completion_status: Mapping[str, Any] | None = None,
    hpairs_source_proof_census: Mapping[str, Any] | None = None,
    min_runtime_ledger_net_pnl: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_net_pnl_after_costs
    ),
    min_runtime_ledger_daily_net_pnl: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_daily_net_pnl_after_costs
    ),
    min_runtime_ledger_trading_days: int = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.min_trading_days
    ),
    max_runtime_ledger_drawdown_pct_equity: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_drawdown_pct_equity
    ),
    max_runtime_ledger_best_day_share: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_best_day_share
    ),
    max_runtime_ledger_symbol_concentration_share: Decimal = (
        DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.max_symbol_concentration_share
    ),
    generated_at: str | None = None,
) -> dict[str, Any]:
    checks: dict[str, dict[str, Any]] = {}
    blockers: list[str] = []
    generated_at = generated_at or _utc_now()
    resolved_proof_mode = normalize_runtime_ledger_proof_mode(proof_mode)
    proof_mode_targets = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.targets_for_mode(
        resolved_proof_mode
    )
    proof_mode_contract = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.mode_contract(
        resolved_proof_mode
    )
    min_runtime_ledger_net_pnl = max(
        min_runtime_ledger_net_pnl,
        cast(Decimal, proof_mode_targets["min_net_pnl_after_costs"]),
    )
    min_runtime_ledger_daily_net_pnl = max(
        min_runtime_ledger_daily_net_pnl,
        cast(Decimal, proof_mode_targets["min_daily_net_pnl_after_costs"]),
    )
    min_runtime_ledger_trading_days = max(
        min_runtime_ledger_trading_days,
        cast(int, proof_mode_targets["min_trading_days"]),
    )
    max_runtime_ledger_drawdown_pct_equity = min(
        max_runtime_ledger_drawdown_pct_equity,
        cast(Decimal, proof_mode_targets["max_drawdown_pct_equity"]),
    )
    max_runtime_ledger_best_day_share = min(
        max_runtime_ledger_best_day_share,
        cast(Decimal, proof_mode_targets["max_best_day_share"]),
    )
    max_runtime_ledger_symbol_concentration_share = min(
        max_runtime_ledger_symbol_concentration_share,
        cast(Decimal, proof_mode_targets["max_symbol_concentration_share"]),
    )
    min_runtime_ledger_closed_round_trips = cast(
        int, proof_mode_targets["min_closed_round_trips"]
    )
    min_runtime_ledger_filled_notional = cast(
        Decimal, proof_mode_targets["min_filled_notional"]
    )
    final_authority_mode = bool(proof_mode_targets["final_authority"])
    evidence_collection_mode = not final_authority_mode
    mode_authority_blockers = (
        []
        if final_authority_mode
        else [RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER]
    )
    mode_authority_failed_checks = (
        [] if final_authority_mode else ["runtime_ledger_proof_mode_authority_required"]
    )
    _check(
        checks,
        "runtime_ledger_proof_mode_contract",
        passed=True,
        observed={
            "proof_mode": resolved_proof_mode,
            "final_authority": final_authority_mode,
            "evidence_collection_only": evidence_collection_mode,
            "evidence_collection_ok": bool(
                proof_mode_targets["evidence_collection_ok"]
            ),
            "canary_collection_authorized": bool(
                proof_mode_targets["canary_collection_authorized"]
            ),
            "mode_contract": proof_mode_contract,
            "promotion_allowed": False,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
        },
        expected="explicit proof mode; only authority mode can grant promotion authority",
        blockers=[],
    )

    status_gate = _status_gate_blocker_summary(status)
    raw_live_blockers = status_gate["raw_blockers"]
    live_blockers = status_gate["proof_blockers"]
    capital_status_blockers = status_gate["capital_promotion_blockers"]
    _check(
        checks,
        "live_status_gate",
        passed=not live_blockers,
        observed={
            "proof_blockers": live_blockers,
            "capital_promotion_blockers": capital_status_blockers,
            "raw_blockers": raw_live_blockers,
        },
        expected=(
            "no live runtime/proof blockers; capital promotion blockers are "
            "reported separately"
        ),
        blockers=live_blockers,
    )
    _extend_unique(blockers, live_blockers)

    runtime_code_parity = _runtime_code_parity(status)
    runtime_code_parity_blockers = _text_list(runtime_code_parity.get("blockers"))
    _check(
        checks,
        "runtime_code_parity",
        passed=not runtime_code_parity_blockers,
        observed=runtime_code_parity,
        expected=(
            "proof-packet assembler runtime image and commit match live Torghut "
            "status when both sides expose build identity"
        ),
        blockers=runtime_code_parity_blockers,
    )
    _extend_unique(blockers, runtime_code_parity_blockers)

    plan = _paper_route_target_plan(paper_route_evidence)
    paper_targets = _paper_route_targets(plan)
    paper_import_blockers = _paper_route_import_blockers(plan)
    import_audit = _paper_route_runtime_window_import_audit(paper_route_evidence)
    import_audit_counts = _paper_route_runtime_window_import_audit_counts(import_audit)
    import_audit_blockers = _paper_route_runtime_window_import_audit_blockers(
        import_audit
    )
    import_audit_target_blockers = _paper_route_runtime_window_import_target_blockers(
        import_audit
    )
    source_activity_blockers = _paper_route_source_activity_blockers(
        import_audit_blockers
    )
    health_gate_summary = _runtime_window_import_health_gate_summary(
        plan=plan,
        targets=paper_targets,
    )
    health_gate_blockers = _text_list(health_gate_summary.get("blockers"))
    health_gate_promotion_blockers = _text_list(
        health_gate_summary.get("promotion_blockers")
    )
    handoff = _mapping(plan.get("runtime_window_import_handoff"))
    session_readiness = _mapping(plan.get("session_readiness"))
    import_ready = _bool(session_readiness.get("import_ready")) or _bool(
        handoff.get("import_ready")
    )
    missing_identity_count = _missing_target_identity_count(paper_targets)
    _check(
        checks,
        "paper_route_target_plan_present",
        passed=bool(plan) and bool(paper_targets),
        observed={"plan_present": bool(plan), "target_count": len(paper_targets)},
        expected="paper-route runtime-window target plan with at least one target",
        blockers=[]
        if bool(plan) and bool(paper_targets)
        else ["paper_route_target_plan_missing"],
    )
    if not plan or not paper_targets:
        _extend_unique(blockers, ["paper_route_target_plan_missing"])
    _check(
        checks,
        "paper_route_target_identity",
        passed=bool(paper_targets) and missing_identity_count == 0,
        observed={"missing_identity_count": missing_identity_count},
        expected="all targets carry candidate, hypothesis, strategy, source manifest, and window identity",
        blockers=[]
        if missing_identity_count == 0
        else ["paper_route_target_identity_incomplete"],
    )
    if missing_identity_count:
        _extend_unique(blockers, ["paper_route_target_identity_incomplete"])
    _check(
        checks,
        "paper_route_import_health_gate",
        passed=bool(paper_targets) and bool(health_gate_summary.get("ready")),
        observed=health_gate_summary,
        expected="every paper-route runtime-window target has allow quorum, continuity_ok true, and drift_ok true",
        blockers=health_gate_blockers
        or (
            []
            if bool(paper_targets) and bool(health_gate_summary.get("ready"))
            else ["runtime_window_import_health_gate_missing"]
        ),
    )
    if health_gate_blockers:
        _extend_unique(blockers, health_gate_blockers)
    elif paper_targets and not bool(health_gate_summary.get("ready")):
        _extend_unique(blockers, ["runtime_window_import_health_gate_missing"])
    _check(
        checks,
        "paper_route_import_ready",
        passed=import_ready and not paper_import_blockers and not health_gate_blockers,
        observed={
            "import_ready": import_ready,
            "import_blockers": paper_import_blockers,
            "health_gate_blockers": health_gate_blockers,
        },
        expected="paper-route target window closed, settled, and import-ready",
        blockers=paper_import_blockers
        or health_gate_blockers
        or ([] if import_ready else ["paper_route_import_not_ready"]),
    )
    if paper_import_blockers:
        _extend_unique(blockers, paper_import_blockers)
    elif not import_ready:
        _extend_unique(blockers, ["paper_route_import_not_ready"])

    runtime_import_due = (
        import_ready and not paper_import_blockers and not health_gate_blockers
    )
    deferred_until_runtime_import_due = (
        "deferred_until_paper_route_runtime_window_import_is_due"
    )
    _check(
        checks,
        "paper_route_runtime_window_import_audit",
        passed=not runtime_import_due or bool(import_audit),
        observed={
            "present": bool(import_audit),
            "state": _text(import_audit.get("state"), "missing"),
            "next_action": _text(import_audit.get("next_action")),
            "import_ready": import_audit.get("import_ready"),
            "blockers": import_audit_blockers,
            "target_blockers": import_audit_target_blockers,
        },
        expected="paper-route evidence includes runtime_window_import_audit when import is due",
        blockers=[]
        if (not runtime_import_due or bool(import_audit))
        else ["runtime_window_import_audit_missing"],
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    if runtime_import_due and not import_audit:
        _extend_unique(blockers, ["runtime_window_import_audit_missing"])

    source_target_count = _int(import_audit_counts.get("source_plan_target_count"))
    targets_with_source_activity = _int(
        import_audit_counts.get("targets_with_source_activity")
    )
    source_activity_ok = (
        not runtime_import_due
        or not import_audit
        or (
            source_target_count > 0
            and targets_with_source_activity >= source_target_count
            and not source_activity_blockers
        )
    )
    _check(
        checks,
        "paper_route_source_activity",
        passed=source_activity_ok,
        observed={
            "runtime_import_due": runtime_import_due,
            "source_plan_target_count": source_target_count,
            "targets_with_source_activity": targets_with_source_activity,
            "blockers": source_activity_blockers,
        },
        expected="paper-route source decisions, executions, and TCA exist for every import target when runtime import is due",
        blockers=source_activity_blockers
        or ([] if source_activity_ok else ["paper_route_source_activity_missing"]),
        status=None if runtime_import_due else deferred_until_runtime_import_due,
    )
    if not source_activity_ok:
        _extend_unique(
            blockers,
            source_activity_blockers or ["paper_route_source_activity_missing"],
        )

    runtime_import = _runtime_window_import_payload(runtime_window_import)
    runtime_import_items = _runtime_window_import_items(runtime_import)
    runtime_import_lineage = _runtime_window_import_lineage(
        raw_payload=runtime_window_import,
        payload=runtime_import,
    )
    runtime_import_blockers = _runtime_import_blockers(runtime_import)
    runtime_import_check_blockers = list(runtime_import_blockers)
    if (
        runtime_import_due
        and import_audit
        and not runtime_import_check_blockers
        and import_audit_blockers
    ):
        runtime_import_check_blockers = list(import_audit_blockers)
    authoritative_observation_count = _runtime_import_authoritative_observation_count(
        runtime_import
    )
    materialization_summary = _runtime_import_materialization_summary(runtime_import)
    runtime_import_materialization_ok = not runtime_import_due or (
        _int(materialization_summary.get("authoritative_observation_count")) > 0
        and _int(
            materialization_summary.get(
                "authoritative_runtime_ledger_profit_proof_count"
            )
        )
        > 0
        and _int(materialization_summary.get("materialized_target_count")) > 0
        and _int(materialization_summary.get("unmaterialized_target_count")) == 0
        and _int(materialization_summary.get("missing_target_import_count")) == 0
        and not _text_list(materialization_summary.get("blockers"))
    )
    runtime_import_ok = (
        runtime_import_due
        and bool(runtime_import)
        and _text(runtime_import.get("proof_status"), "blocked") == "ok"
        and not runtime_import_blockers
        and authoritative_observation_count > 0
        and all(
            _text(item.get("proof_status"), "blocked") == "ok"
            for item in runtime_import_items
        )
    )
    _check(
        checks,
        "runtime_window_import_proof",
        passed=runtime_import_ok,
        observed={
            "present": bool(runtime_import),
            "proof_status": _text(runtime_import.get("proof_status"), "missing"),
            "target_count": len(runtime_import_items),
            "runtime_import_due": runtime_import_due,
            "authoritative_observation_count": authoritative_observation_count,
            "materialization": materialization_summary,
            "proof_blockers": runtime_import_blockers,
            "import_audit_state": _text(import_audit.get("state"), "missing"),
            "import_audit_blockers": import_audit_blockers,
        },
        expected="runtime-window import proof_status ok with authoritative runtime observations and no proof blockers",
        blockers=runtime_import_check_blockers
        or (
            []
            if runtime_import_ok or not runtime_import_due
            else ["runtime_window_import_missing"]
        ),
        status=None
        if runtime_import_due
        else "waiting_for_paper_route_runtime_window_import",
    )
    if runtime_import_blockers:
        _extend_unique(blockers, runtime_import_blockers)
    elif runtime_import_due and import_audit_blockers:
        _extend_unique(blockers, import_audit_blockers)
    elif runtime_import_due and not runtime_import_ok:
        _extend_unique(blockers, ["runtime_window_import_missing"])
    materialization_blockers = _text_list(materialization_summary.get("blockers"))
    _check(
        checks,
        "runtime_window_import_materialization",
        passed=runtime_import_materialization_ok,
        observed=materialization_summary,
        expected="every runtime-window import target contains authoritative runtime-ledger profit-proof materialization",
        blockers=materialization_blockers
        or (
            []
            if runtime_import_materialization_ok or not runtime_import_due
            else ["runtime_window_import_runtime_ledger_materialization_missing"]
        ),
        status=None
        if runtime_import_due
        else "waiting_for_paper_route_runtime_window_import",
    )
    if runtime_import_due and not runtime_import_materialization_ok:
        _extend_unique(
            blockers,
            materialization_blockers
            or ["runtime_window_import_runtime_ledger_materialization_missing"],
        )
    runtime_import_profit_proof_blockers = _text_list(
        materialization_summary.get("profit_proof_blockers")
    )
    runtime_import_profit_proof_ok = (
        not runtime_import_due or not runtime_import_profit_proof_blockers
    )
    _check(
        checks,
        "runtime_window_import_profit_proof_blockers",
        passed=runtime_import_profit_proof_ok,
        observed={
            "runtime_import_due": runtime_import_due,
            "blockers": runtime_import_profit_proof_blockers,
            "materialization_blockers": materialization_blockers,
        },
        expected=(
            "runtime-window import carries no remaining proof/economics blockers; "
            "source-row materialization blockers are reported separately"
        ),
        blockers=runtime_import_profit_proof_blockers,
        status=None
        if runtime_import_due
        else "waiting_for_paper_route_runtime_window_import",
    )
    if runtime_import_due:
        _extend_unique(blockers, runtime_import_profit_proof_blockers)

    runtime_ledger_result = evaluate_runtime_ledger_checks(
        checks=checks,
        blockers=blockers,
        completion_status=completion_status,
        context=RuntimeLedgerCheckContext(
            runtime_import_due=runtime_import_due,
            deferred_until_runtime_import_due=deferred_until_runtime_import_due,
            final_authority_mode=final_authority_mode,
            thresholds=RuntimeLedgerThresholds(
                min_net_pnl=min_runtime_ledger_net_pnl,
                min_daily_net_pnl=min_runtime_ledger_daily_net_pnl,
                min_trading_days=min_runtime_ledger_trading_days,
                min_closed_round_trips=min_runtime_ledger_closed_round_trips,
                min_filled_notional=min_runtime_ledger_filled_notional,
                max_drawdown_pct_equity=max_runtime_ledger_drawdown_pct_equity,
                max_best_day_share=max_runtime_ledger_best_day_share,
                max_symbol_concentration_share=max_runtime_ledger_symbol_concentration_share,
            ),
        ),
    )
    live_scale_gate = runtime_ledger_result.live_scale_gate
    runtime_summary = runtime_ledger_result.runtime_summary
    ledger_refs = runtime_ledger_result.ledger_refs
    unbacked_refs = runtime_ledger_result.unbacked_refs
    target_implied_avg_daily_filled_notional = (
        runtime_ledger_result.target_implied_avg_daily_filled_notional
    )

    hpairs_source_proof_census_status = _hpairs_source_proof_census_status(
        hpairs_source_proof_census
    )
    hpairs_census_blockers = _text_list(
        hpairs_source_proof_census_status.get("blockers")
    )
    hpairs_census_present = bool(hpairs_source_proof_census_status.get("present"))
    hpairs_census_ok = (not hpairs_census_present) or bool(
        hpairs_source_proof_census_status.get("census_ready")
    )
    _check(
        checks,
        "hpairs_source_proof_census_status",
        passed=hpairs_census_ok,
        observed=hpairs_source_proof_census_status,
        expected=(
            "attached read-only H-PAIRS source-proof census with no blockers; "
            "census is evidence/status only and cannot grant authority by itself"
        ),
        blockers=hpairs_census_blockers
        or (
            []
            if hpairs_census_ok or not hpairs_census_present
            else ["hpairs_source_proof_census_not_ready"]
        ),
        status="non_authority_evidence_status",
    )
    _extend_unique(
        blockers,
        hpairs_census_blockers
        or (
            []
            if hpairs_census_ok or not hpairs_census_present
            else ["hpairs_source_proof_census_not_ready"]
        ),
    )

    tigerbeetle_status = _mapping(
        status.get("tigerbeetle_ledger") or status.get("tigerbeetle")
    )
    latest_tigerbeetle_reconciliation = _mapping(
        tigerbeetle_status.get("latest_reconciliation")
    )
    tigerbeetle_ref_counts = _mapping(
        tigerbeetle_status.get("ref_counts")
        or latest_tigerbeetle_reconciliation.get("ref_counts")
    )
    tigerbeetle_claimed = (
        _bool(tigerbeetle_status.get("enabled"))
        or _bool(tigerbeetle_status.get("required"))
        or _bool(tigerbeetle_status.get("journal_enabled"))
        or _bool(tigerbeetle_status.get("reconcile_required"))
        # Runtime-import TigerBeetle refs are proof artifacts; require live
        # reconciliation status only when the status or completion gate claims
        # TigerBeetle authority.
        or _contains_tigerbeetle_claim(live_scale_gate)
    )
    tigerbeetle_required_for_authority = (
        final_authority_mode and tigerbeetle_claimed and runtime_import_due
    )
    tigerbeetle_blockers = _text_list(tigerbeetle_status.get("blockers"))
    if tigerbeetle_required_for_authority:
        if not latest_tigerbeetle_reconciliation:
            _extend_unique(tigerbeetle_blockers, ["tigerbeetle_reconciliation_missing"])
        elif not _bool(latest_tigerbeetle_reconciliation.get("ok")):
            _extend_unique(tigerbeetle_blockers, ["tigerbeetle_reconciliation_not_ok"])
        _extend_unique(
            tigerbeetle_blockers,
            _text_list(latest_tigerbeetle_reconciliation.get("blockers")),
        )
        required_runtime_ref_count = max(1, len(ledger_refs))
        runtime_ref_count = _int(tigerbeetle_ref_counts.get("runtime_ledger_ref_count"))
        signed_ref_count = _int(
            latest_tigerbeetle_reconciliation.get(
                "runtime_ledger_signed_transfer_count"
            )
        )
        if runtime_ref_count < required_runtime_ref_count:
            _extend_unique(
                tigerbeetle_blockers, ["tigerbeetle_runtime_ledger_refs_missing"]
            )
        if signed_ref_count < required_runtime_ref_count:
            _extend_unique(
                tigerbeetle_blockers,
                ["tigerbeetle_runtime_ledger_signed_refs_missing"],
            )
    else:
        required_runtime_ref_count = 0
        runtime_ref_count = _int(tigerbeetle_ref_counts.get("runtime_ledger_ref_count"))
        signed_ref_count = _int(
            latest_tigerbeetle_reconciliation.get(
                "runtime_ledger_signed_transfer_count"
            )
        )
    _check(
        checks,
        "tigerbeetle_runtime_pnl_authority_refs",
        passed=not tigerbeetle_required_for_authority or not tigerbeetle_blockers,
        observed={
            "claimed": tigerbeetle_claimed,
            "required_for_authority": tigerbeetle_required_for_authority,
            "runtime_import_due": runtime_import_due,
            "enabled": tigerbeetle_status.get("enabled"),
            "required": tigerbeetle_status.get("required"),
            "journal_enabled": tigerbeetle_status.get("journal_enabled"),
            "reconcile_required": tigerbeetle_status.get("reconcile_required"),
            "status_ok": tigerbeetle_status.get("ok"),
            "reconciliation_ok": tigerbeetle_status.get("reconciliation_ok"),
            "required_runtime_ledger_ref_count": required_runtime_ref_count,
            "runtime_ledger_ref_count": runtime_ref_count,
            "runtime_ledger_signed_transfer_count": signed_ref_count,
            "latest_reconciliation": dict(latest_tigerbeetle_reconciliation),
            "blockers": tigerbeetle_blockers,
        },
        expected=(
            "authority packets require reconciled signed TigerBeetle runtime-ledger "
            "PnL refs when TigerBeetle is enabled or claimed"
        ),
        blockers=tigerbeetle_blockers,
        status=None
        if tigerbeetle_required_for_authority
        else "not_claimed_not_due_or_not_authority_mode",
    )
    if tigerbeetle_required_for_authority:
        _extend_unique(blockers, tigerbeetle_blockers)

    failed_checks = [key for key, value in checks.items() if not value["passed"]]
    post_cost_proof_satisfied = not failed_checks
    post_cost_proof_authority_allowed = (
        post_cost_proof_satisfied and final_authority_mode
    )
    authority_blockers = list(blockers)
    _extend_unique(authority_blockers, mode_authority_blockers)
    authority_failed_checks = list(failed_checks)
    _extend_unique(authority_failed_checks, mode_authority_failed_checks)
    promotion_prerequisite_blockers = list(mode_authority_blockers)
    _extend_unique(promotion_prerequisite_blockers, capital_status_blockers)
    _extend_unique(promotion_prerequisite_blockers, health_gate_promotion_blockers)
    capital_promotion_allowed = (
        post_cost_proof_authority_allowed and not promotion_prerequisite_blockers
    )
    capital_promotion_failed_checks: list[str] = []
    if mode_authority_blockers:
        capital_promotion_failed_checks.append(
            "runtime_ledger_proof_mode_authority_required"
        )
    if capital_status_blockers:
        capital_promotion_failed_checks.append("capital_promotion_gate")
    if health_gate_promotion_blockers:
        capital_promotion_failed_checks.append("paper_route_promotion_health_gate")
    promotion_failed_checks = list(failed_checks)
    _extend_unique(promotion_failed_checks, capital_promotion_failed_checks)
    promotion_blockers = list(blockers)
    _extend_unique(promotion_blockers, promotion_prerequisite_blockers)
    waiting_blockers = {
        "paper_route_session_window_not_open",
        "paper_route_session_window_not_closed",
        "paper_route_session_settlement_pending",
        "paper_route_import_not_ready",
    }
    if post_cost_proof_authority_allowed and not promotion_prerequisite_blockers:
        verdict = "promotion_authority_allowed"
        reason = "runtime_ledger_live_paper_post_cost_proof_satisfied"
        promotion_reason = reason
        capital_reason = "live_capital_promotion_gate_clear"
    elif post_cost_proof_authority_allowed:
        verdict = "post_cost_proof_authority_allowed_capital_promotion_blocked"
        reason = (
            "runtime_ledger_live_paper_post_cost_proof_satisfied_"
            "capital_promotion_blocked"
        )
        promotion_reason = "live_capital_promotion_gate_blocked"
        capital_reason = "live_capital_promotion_gate_blocked"
    elif post_cost_proof_satisfied and not final_authority_mode:
        verdict = f"{resolved_proof_mode}_proof_satisfied_evidence_collection_only"
        reason = f"runtime_ledger_{resolved_proof_mode}_proof_satisfied"
        promotion_reason = RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER
        capital_reason = RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER
    elif set(blockers).issubset(waiting_blockers):
        verdict = "waiting_for_runtime_window"
        reason = "paper_route_runtime_window_not_importable_yet"
        promotion_reason = reason
        capital_reason = "post_cost_proof_not_satisfied"
    else:
        verdict = "blocked"
        reason = "runtime_ledger_live_paper_post_cost_proof_blocked"
        promotion_reason = reason
        capital_reason = "post_cost_proof_not_satisfied"
    required_actions = _required_actions(promotion_blockers, verdict=verdict)
    candidate_identity = _first_identity(
        paper_targets=paper_targets,
        runtime_import=runtime_import,
        completion_gate=live_scale_gate,
    )
    immutable_lineage = _runtime_ledger_immutable_lineage(
        identity=candidate_identity,
        paper_targets=paper_targets,
        runtime_import=runtime_import,
        runtime_summary=runtime_summary,
        ledger_refs=ledger_refs,
        unbacked_refs=unbacked_refs,
        materialization_summary=materialization_summary,
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "proof_mode": resolved_proof_mode,
        "proof_mode_contract": proof_mode_contract,
        "verdict": verdict,
        "ok": post_cost_proof_satisfied,
        "final_authority_ok": post_cost_proof_authority_allowed,
        "evidence_collection_only": evidence_collection_mode,
        "evidence_collection_ok": evidence_collection_mode
        and post_cost_proof_satisfied,
        "canary_collection_authorized": resolved_proof_mode == "probation"
        and post_cost_proof_satisfied,
        "promotion_allowed": capital_promotion_allowed,
        "capital_promotion_allowed": capital_promotion_allowed,
        "final_promotion_allowed": capital_promotion_allowed,
        "authority_blockers": authority_blockers,
        "blockers": promotion_blockers,
        "next_action": required_actions[0] if required_actions else "none",
        "post_cost_proof_authority": {
            "allowed": post_cost_proof_authority_allowed,
            "proof_satisfied": post_cost_proof_satisfied,
            "reason": reason,
            "blocking_reasons": authority_blockers,
            "failed_checks": authority_failed_checks,
        },
        "capital_promotion_authority": {
            "allowed": capital_promotion_allowed,
            "reason": capital_reason,
            "blocking_reasons": promotion_prerequisite_blockers,
            "proof_prerequisite_blocking_reasons": authority_blockers,
            "failed_checks": capital_promotion_failed_checks
            if post_cost_proof_authority_allowed
            else promotion_failed_checks,
        },
        "promotion_authority": {
            "allowed": capital_promotion_allowed,
            "reason": promotion_reason,
            "blocking_reasons": promotion_blockers,
            "failed_checks": promotion_failed_checks,
        },
        "target": {
            "proof_mode": resolved_proof_mode,
            "final_authority": final_authority_mode,
            "evidence_collection_only": evidence_collection_mode,
            "evidence_collection_ok": bool(
                proof_mode_targets["evidence_collection_ok"]
            ),
            "canary_collection_authorized": bool(
                proof_mode_targets["canary_collection_authorized"]
            ),
            "promotion_allowed": False,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "source_backed_runtime_ledger_proof_required": final_authority_mode,
            "non_empty_runtime_ledger_source_refs_required": final_authority_mode,
            "runtime_ledger_import_readback_required": final_authority_mode,
            "min_runtime_ledger_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_net_pnl
            ),
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                min_runtime_ledger_daily_net_pnl
            ),
            "min_runtime_ledger_trading_days": min_runtime_ledger_trading_days,
            "min_runtime_ledger_closed_round_trips": (
                min_runtime_ledger_closed_round_trips
            ),
            "min_runtime_ledger_filled_notional": _decimal_text(
                min_runtime_ledger_filled_notional
            ),
            "min_runtime_ledger_median_daily_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
            ),
            "min_runtime_ledger_p10_daily_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
            ),
            "min_runtime_ledger_worst_day_net_pnl_after_costs": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
            ),
            "max_runtime_ledger_drawdown_pct_equity": _decimal_text(
                max_runtime_ledger_drawdown_pct_equity
            ),
            "max_runtime_ledger_intraday_drawdown": _decimal_text(
                DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
            ),
            "max_runtime_ledger_best_day_share": _decimal_text(
                max_runtime_ledger_best_day_share
            ),
            "max_runtime_ledger_symbol_concentration_share": _decimal_text(
                max_runtime_ledger_symbol_concentration_share
            ),
            "target_implied_avg_daily_filled_notional": _decimal_text(
                target_implied_avg_daily_filled_notional
            ),
        },
        "candidate": candidate_identity,
        "lineage": immutable_lineage,
        "required_actions": required_actions,
        "checks": checks,
        "evidence": {
            "status": {
                "mode": status.get("mode"),
                "running": status.get("running"),
                "live_status_blockers": live_blockers,
                "capital_promotion_blockers": promotion_prerequisite_blockers,
                "raw_live_status_blockers": raw_live_blockers,
            },
            "paper_route_target_plan": {
                "schema_version": plan.get("schema_version"),
                "target_count": len(paper_targets),
                "import_ready": import_ready,
                "import_blockers": paper_import_blockers,
                "session_window": _mapping(plan.get("session_window")),
                "runtime_window_import_health_gate": health_gate_summary,
            },
            "paper_route_runtime_window_import_audit": {
                "present": bool(import_audit),
                "state": import_audit.get("state"),
                "next_action": import_audit.get("next_action"),
                "import_ready": import_audit.get("import_ready"),
                "blockers": import_audit_blockers,
                "target_blockers": import_audit_target_blockers,
                "counts": dict(import_audit_counts),
            },
            "runtime_window_import": {
                "present": bool(runtime_import),
                "proof_status": runtime_import.get("proof_status"),
                "target_count": len(runtime_import_items),
                "proof_blockers": runtime_import_blockers,
                "authoritative_observation_count": authoritative_observation_count,
                "materialization": materialization_summary,
                "lineage": runtime_import_lineage,
            },
            "runtime_code_parity": runtime_code_parity,
            "completion_live_scale": {
                "gate_status": live_scale_gate.get("status"),
                "runtime_ledger_summary": dict(runtime_summary),
                "strategy_runtime_ledger_bucket_refs": ledger_refs,
                "unbacked_metric_window_refs": unbacked_refs,
            },
            "hpairs_source_proof_census": hpairs_source_proof_census_status,
        },
    }


__all__ = ("build_runtime_ledger_proof_packet",)
