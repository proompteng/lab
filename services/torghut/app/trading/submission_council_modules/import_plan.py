# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime ledger source collection import planning."""

from __future__ import annotations

# ruff: noqa: F401,F403,F405,F811,F821
from .common import *

from .runtime_summary import *

from .paper_probation import *


def _runtime_ledger_paper_probation_import_plan(
    candidates: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    targets: list[dict[str, object]] = []
    skipped_targets: list[dict[str, object]] = []
    seen_target_keys: set[tuple[str, ...]] = set()
    for candidate in candidates:
        hypothesis_id = _safe_text(candidate.get("hypothesis_id"))
        candidate_id = _safe_text(candidate.get("candidate_id"))
        strategy_family = _safe_text(candidate.get("strategy_family"))
        strategy_id = _safe_text(candidate.get("strategy_id"))
        candidate_strategy_name = _safe_text(candidate.get("strategy_name"))
        strategy_name = _runtime_ledger_paper_probation_strategy_name(candidate)
        strategy_lookup_names = _strategy_lookup_names(
            candidate.get("strategy_lookup_names"),
            strategy_name,
            candidate_strategy_name,
            strategy_names_from_strategy_id(strategy_id),
            derived_strategy_name_from_strategy_id(strategy_id),
        )
        account_label = _safe_text(candidate.get("account")) or "TORGHUT_SIM"
        window_start, window_end, defaulted_source_collection_window = (
            _bounded_source_collection_probe_window(candidate)
        )
        source_manifest_ref = _safe_text(candidate.get("source_manifest_ref")) or (
            _hypothesis_manifest_ref(hypothesis_id)
        )
        dataset_snapshot_ref = _safe_text(candidate.get("dataset_snapshot_ref"))
        missing = [
            field
            for field, value in (
                ("hypothesis_id", hypothesis_id),
                ("candidate_id", candidate_id),
                ("strategy_family", strategy_family),
                ("strategy_name", strategy_name),
                ("window_start", window_start),
                ("window_end", window_end),
                ("source_manifest_ref", source_manifest_ref),
            )
            if value is None
        ]
        if missing:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "missing_fields": missing,
                    "reason": "runtime_ledger_paper_probation_target_missing_required_fields",
                }
            )
            continue

        source_collection = _runtime_ledger_source_collection_import_candidate(
            candidate
        )
        paper_probation_blockers = (
            []
            if source_collection
            else _runtime_ledger_paper_probation_blockers(candidate)
        )
        paper_probation_satisfied = (
            not source_collection and not paper_probation_blockers
        )
        if paper_probation_blockers:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "strategy_family": strategy_family,
                    "strategy_name": strategy_name,
                    "window_start": window_start,
                    "window_end": window_end,
                    "runtime_ledger_bucket_ref": _runtime_ledger_paper_probation_bucket_ref(
                        candidate
                    ),
                    "reason": "runtime_ledger_paper_probation_prerequisites_not_satisfied",
                    "blockers": paper_probation_blockers,
                }
            )
            continue
        source_kind = (
            _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
            if source_collection
            else _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND
        )
        source_dsn_env = (
            _runtime_ledger_source_collection_source_dsn_env(candidate)
            if source_collection
            else _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV
        )
        target_dsn_env = (
            _RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV
            if source_collection
            else _RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV
        )
        final_blockers = list(
            _RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS
            if source_collection
            else _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS
        )
        profit_target_source_collection = bool(
            candidate.get("source_collection_profit_target_candidate")
        )
        selection_reason = "positive_post_cost_runtime_ledger_bucket"
        if source_collection:
            selection_reason = "positive_activity_needs_source_window_runtime_evidence"
            if profit_target_source_collection:
                selection_reason = (
                    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON
                )
        target_key = (
            hypothesis_id or "",
            candidate_id or "",
            strategy_family or "",
            strategy_name or "",
            account_label,
            dataset_snapshot_ref or "",
            source_manifest_ref or "",
            source_kind,
            window_start or "",
            window_end or "",
        )
        bucket_ref = _runtime_ledger_paper_probation_bucket_ref(candidate)
        if target_key in seen_target_keys:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "strategy_family": strategy_family,
                    "strategy_name": strategy_name,
                    "window_start": window_start,
                    "window_end": window_end,
                    "runtime_ledger_bucket_ref": bucket_ref,
                    "reason": "duplicate_runtime_ledger_paper_probation_target",
                }
            )
            continue
        seen_target_keys.add(target_key)

        reason_codes = _normalize_reason_codes(
            [
                str(reason).strip()
                for reason in cast(
                    Sequence[object], candidate.get("reason_codes") or []
                )
                if str(reason).strip()
            ]
        )
        target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "strategy_id": strategy_id or "",
            "runtime_strategy_name": strategy_name,
            "strategy_lookup_names": strategy_lookup_names,
            "account_label": account_label,
            "source_account_label": account_label,
            "account_stage_runtime_identity": {
                "account_label": account_label,
                "source_account_label": account_label,
                "observed_stage": "paper",
                "runtime_strategy_name": strategy_name,
                "source_kind": source_kind,
            },
            "source_dsn_env": source_dsn_env,
            "target_dsn_env": target_dsn_env,
            "dataset_snapshot_ref": dataset_snapshot_ref or "",
            "source_manifest_ref": source_manifest_ref,
            "source_kind": source_kind,
            "window_start": window_start,
            "window_end": window_end,
            "paper_probation_authorized": paper_probation_satisfied,
            "paper_probation_authorization_scope": (
                "evidence_collection_only" if paper_probation_satisfied else ""
            ),
            "paper_probation_satisfied_for_bounded_live_paper_collection": (
                paper_probation_satisfied
            ),
            "source_collection_authorized": source_collection,
            "source_collection_authorization_scope": (
                "source_window_evidence_collection_only" if source_collection else ""
            ),
            "source_collection_reason_codes": (
                list(
                    cast(
                        Sequence[object],
                        candidate.get("source_collection_reason_codes") or [],
                    )
                )
                if source_collection
                else []
            ),
            "proof_mode": "probation",
            "evidence_collection_ok": True,
            "canary_collection_authorized": paper_probation_satisfied,
            "bounded_live_paper_collection_authorized": paper_probation_satisfied,
            **_bounded_paper_route_probe_collection_payload(
                authorized=paper_probation_satisfied or profit_target_source_collection
            ),
            "capital_promotion_allowed": False,
            "final_authority_ok": False,
            "evidence_collection_stage": "paper",
            "probation_allowed": paper_probation_satisfied,
            "probation_reason": (
                "source_window_evidence_collection_pending"
                if source_collection
                else "source_backed_paper_stage_runtime_ledger_positive_after_costs"
            ),
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "final_promotion_blockers": final_blockers,
            "candidate_blockers": reason_codes,
            "runtime_ledger_target_metadata_blockers": final_blockers,
            "handoff": (
                "runtime_ledger_source_collection_import"
                if source_collection
                else "runtime_ledger_paper_probation_import"
            ),
            "promotion_gate": "runtime_ledger_live_or_live_paper_required",
            "selected_by": (
                "runtime_ledger_source_collection"
                if source_collection
                else "runtime_ledger_paper_probation"
            ),
            "selection_reason": selection_reason,
        }
        target.update(_runtime_ledger_source_evidence_payload(candidate))
        if source_collection:
            target.update(
                {
                    "paper_route_probe_window_start": window_start or "",
                    "paper_route_probe_window_end": window_end or "",
                    "source_collection_priority": (
                        _safe_text(candidate.get("source_collection_priority"))
                        or "source_window_evidence_collection"
                    ),
                    "source_collection_profit_target_candidate": (
                        profit_target_source_collection
                    ),
                    "source_collection_profit_target_net_pnl_after_costs": str(
                        _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS
                    ),
                    "source_collection_net_strategy_pnl_after_costs": (
                        _safe_text(
                            candidate.get(
                                "source_collection_net_strategy_pnl_after_costs"
                            )
                        )
                        or ""
                    ),
                    "source_collection_post_cost_expectancy_bps": (
                        _safe_text(
                            candidate.get("source_collection_post_cost_expectancy_bps")
                        )
                        or ""
                    ),
                    "source_collection_filled_notional": (
                        _safe_text(candidate.get("source_collection_filled_notional"))
                        or ""
                    ),
                    "source_collection_next_action": (
                        _safe_text(candidate.get("source_collection_next_action"))
                        or "materialize_runtime_ledger_source_window_refs"
                    ),
                    "probation_target_shortfall": (
                        _safe_text(candidate.get("probation_target_shortfall")) or ""
                    ),
                    "probation_target_progress_ratio": (
                        _safe_text(candidate.get("probation_target_progress_ratio"))
                        or ""
                    ),
                    "required_notional_repair_scale_to_target": (
                        _safe_text(
                            candidate.get("required_notional_repair_scale_to_target")
                        )
                        or ""
                    ),
                    "required_notional_to_reach_target": (
                        _safe_text(candidate.get("required_notional_to_reach_target"))
                        or ""
                    ),
                    "required_notional_repair_scale_authority": (
                        _safe_text(
                            candidate.get("required_notional_repair_scale_authority")
                        )
                        or "linear_notional_sizing_estimate_for_repair_only_not_capital_authority"
                    ),
                    "live_paper_evidence_requirements": list(
                        _RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS
                    ),
                    "safe_evidence_collection_path": list(
                        _RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH
                    ),
                    "live_capital_authorized": False,
                    "final_promotion_requires_live_paper_runtime_proof": True,
                }
            )
            if defaulted_source_collection_window:
                target.update(
                    {
                        "runtime_ledger_source_collection_window_defaulted": True,
                        "runtime_ledger_source_collection_window_source": (
                            "current_regular_session_bounded_source_collection_default"
                        ),
                    }
                )
        if bucket_ref:
            target["runtime_ledger_bucket_ref"] = bucket_ref
        targets.append(target)

    return {
        "schema_version": _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
        "source": "runtime_ledger_paper_probation_and_source_collection_candidates",
        "purpose": "paper_stage_runtime_ledger_source_evidence_collection",
        "proof_mode": "probation",
        "evidence_collection_ok": bool(targets),
        "paper_probation_satisfied_for_bounded_live_paper_collection": any(
            bool(
                target.get(
                    "paper_probation_satisfied_for_bounded_live_paper_collection"
                )
            )
            for target in targets
        ),
        "canary_collection_authorized": any(
            bool(target.get("canary_collection_authorized")) for target in targets
        ),
        "bounded_live_paper_collection_authorized": any(
            bool(target.get("bounded_live_paper_collection_authorized"))
            for target in targets
        ),
        "capital_promotion_allowed": False,
        "final_authority_ok": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "target_count": len(targets),
        "paper_probation_target_count": sum(
            1 for target in targets if bool(target.get("paper_probation_authorized"))
        ),
        "source_collection_target_count": sum(
            1 for target in targets if bool(target.get("source_collection_authorized"))
        ),
        "source_collection_profit_target_count": sum(
            1
            for target in targets
            if bool(target.get("source_collection_profit_target_candidate"))
        ),
        "skipped_target_count": len(skipped_targets),
        "targets": targets,
        "skipped_targets": skipped_targets,
    }


def _runtime_ledger_import_plan_has_target(
    plan: Mapping[str, object],
    *,
    hypothesis_id: str,
    candidate_id: str,
) -> bool:
    for target in cast(Sequence[object], plan.get("targets") or []):
        if not isinstance(target, Mapping):
            continue
        typed_target = cast(Mapping[str, object], target)
        if (
            _safe_text(typed_target.get("hypothesis_id")) == hypothesis_id
            and _safe_text(typed_target.get("candidate_id")) == candidate_id
        ):
            return True
    return False


def _bounded_paper_route_manifest_collection_targets(
    registry_items: Sequence[Mapping[str, object]],
    *,
    existing_plan: Mapping[str, object],
) -> list[dict[str, object]]:
    """Return bounded manifest-seeded source collection targets.

    Runtime-ledger repair candidates are intentionally strict and require
    existing filled paper activity. H-PAIRS can get stuck before that first
    source-backed row exists, so seed only the known H-PAIRS paper-route
    collection handoff from source-controlled registry metadata. The returned
    targets are collection-only: they do not grant promotion authority or live
    capital routing, and the downstream paper-route target-plan audit still
    applies source-strategy, account-cleanliness, dependency, and runtime-window
    readiness gates before the scheduler can submit paper orders.
    """

    targets: list[dict[str, object]] = []
    for item in registry_items:
        hypothesis_id = _safe_text(item.get("hypothesis_id"))
        candidate_id = _safe_text(item.get("candidate_id"))
        if (
            hypothesis_id != _HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID
            or candidate_id != _HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID
        ):
            continue
        if _runtime_ledger_import_plan_has_target(
            existing_plan,
            hypothesis_id=hypothesis_id,
            candidate_id=candidate_id,
        ):
            continue

        strategy_id = _safe_text(item.get("strategy_id"))
        manifest_strategy_name = _runtime_ledger_paper_probation_strategy_name(item)
        strategy_family = _safe_text(item.get("strategy_family"))
        source_manifest_ref = _hypothesis_manifest_ref(hypothesis_id)
        missing = [
            field
            for field, value in (
                ("strategy_family", strategy_family),
                ("strategy_name", manifest_strategy_name),
                ("source_manifest_ref", source_manifest_ref),
            )
            if value is None
        ]
        if missing:
            continue

        strategy_lookup_names = _strategy_lookup_names(
            item.get("strategy_lookup_names"),
            manifest_strategy_name,
            strategy_names_from_strategy_id(strategy_id),
            derived_strategy_name_from_strategy_id(strategy_id),
        )
        targets.append(
            {
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id,
                "observed_stage": "paper",
                "strategy_family": strategy_family,
                "strategy_name": manifest_strategy_name,
                "strategy_id": strategy_id or "",
                "runtime_strategy_name": manifest_strategy_name,
                "strategy_lookup_names": strategy_lookup_names,
                "account_label": "TORGHUT_SIM",
                "source_account_label": "TORGHUT_SIM",
                "account_stage_runtime_identity": {
                    "account_label": "TORGHUT_SIM",
                    "source_account_label": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "runtime_strategy_name": manifest_strategy_name,
                    "source_kind": _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND,
                },
                "source_dsn_env": "SIM_DB_DSN",
                "target_dsn_env": "SIM_DB_DSN",
                "dataset_snapshot_ref": _safe_text(item.get("dataset_snapshot_ref"))
                or "",
                "source_manifest_ref": source_manifest_ref,
                "source_kind": _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND,
                "paper_probation_authorized": False,
                "paper_probation_authorization_scope": "",
                "paper_probation_satisfied_for_bounded_live_paper_collection": False,
                "source_collection_authorized": True,
                "source_collection_authorization_scope": (
                    "bounded_paper_route_source_decision_collection_only"
                ),
                "source_collection_reason_codes": [
                    "runtime_ledger_source_decisions_missing",
                    "bounded_paper_route_manifest_seed",
                ],
                "proof_mode": "probation",
                "evidence_collection_ok": True,
                "canary_collection_authorized": False,
                "bounded_live_paper_collection_authorized": False,
                "bounded_evidence_collection_authorized": False,
                "bounded_evidence_collection_scope": (
                    _BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE
                ),
                "capital_promotion_allowed": False,
                "final_authority_ok": False,
                "evidence_collection_stage": "paper",
                "probation_allowed": False,
                "probation_reason": "source_backed_paper_probation_required",
                "promotion_allowed": False,
                "final_promotion_authorized": False,
                "final_promotion_allowed": False,
                "final_promotion_blockers": list(
                    _BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS
                ),
                "candidate_blockers": [
                    "runtime_ledger_source_decisions_missing",
                    "source_backed_paper_probation_required",
                    "paper_route_runtime_ledger_import_pending",
                ],
                "runtime_ledger_target_metadata_blockers": list(
                    _BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS
                ),
                "handoff": "next_paper_route_runtime_window_import",
                "promotion_gate": "runtime_ledger_live_or_live_paper_required",
                "selected_by": "hypothesis_manifest_bounded_paper_route_collection",
                "selection_reason": "source_decisions_missing_for_bounded_paper_route",
                "max_notional": "0",
            }
        )
    return targets


def _with_bounded_paper_route_manifest_collection_targets(
    plan: Mapping[str, object],
    *,
    registry_items: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    merged_plan = dict(plan)
    manifest_targets = _bounded_paper_route_manifest_collection_targets(
        registry_items,
        existing_plan=merged_plan,
    )
    if not manifest_targets:
        return merged_plan

    targets = [
        dict(cast(Mapping[str, object], target))
        for target in cast(Sequence[object], merged_plan.get("targets") or [])
        if isinstance(target, Mapping)
    ]
    targets.extend(manifest_targets)
    merged_plan["targets"] = targets
    merged_plan["target_count"] = len(targets)
    merged_plan["manifest_bounded_collection_target_count"] = len(manifest_targets)
    merged_plan["source_collection_target_count"] = _safe_int(
        merged_plan.get("source_collection_target_count")
    ) + len(manifest_targets)
    merged_plan["evidence_collection_ok"] = bool(targets)
    merged_plan["paper_probation_satisfied_for_bounded_live_paper_collection"] = any(
        bool(target.get("paper_probation_satisfied_for_bounded_live_paper_collection"))
        for target in targets
    )
    merged_plan["canary_collection_authorized"] = any(
        bool(target.get("canary_collection_authorized")) for target in targets
    )
    merged_plan["bounded_live_paper_collection_authorized"] = any(
        bool(target.get("bounded_live_paper_collection_authorized"))
        for target in targets
    )
    merged_plan["capital_promotion_allowed"] = False
    merged_plan["final_authority_ok"] = False
    merged_plan["promotion_allowed"] = False
    merged_plan["final_promotion_authorized"] = False
    merged_plan["final_promotion_allowed"] = False
    return merged_plan


def _paper_probation_eligible_total_with_runtime_ledger(
    *,
    legacy_total: int,
    runtime_items: Sequence[Mapping[str, Any]],
    runtime_ledger_candidates: Sequence[Mapping[str, object]],
) -> int:
    keys: set[tuple[str, str]] = set()
    for item in runtime_items:
        if not bool(item.get("paper_probation_eligible")):
            continue
        hypothesis_id = _safe_text(item.get("hypothesis_id")) or ""
        candidate_id = _safe_text(item.get("candidate_id")) or ""
        keys.add((hypothesis_id, candidate_id))
    for candidate in runtime_ledger_candidates:
        hypothesis_id = _safe_text(candidate.get("hypothesis_id")) or ""
        candidate_id = _safe_text(candidate.get("candidate_id")) or ""
        keys.add((hypothesis_id, candidate_id))
    return max(legacy_total, len(keys))


__all__ = [name for name in globals() if not name.startswith("__")]
