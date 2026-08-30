"""Runtime ledger source collection import planning."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast

from app.trading.evidence_collection_policy import (
    collection_blocked_policy,
    paper_probation_policy,
    source_collection_policy,
)

from .common import (
    bounded_paper_route_probe_collection_payload as _bounded_paper_route_probe_collection_payload,
    derived_strategy_name_from_strategy_id,
    normalize_reason_codes as _normalize_reason_codes,
    safe_int as _safe_int,
    safe_text as _safe_text,
    strategy_names_from_strategy_id,
)
from .paper_probation import (
    BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS as _BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND as _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND,
    HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID as _HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID,
    HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID as _HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID,
    RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION as _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
    RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS as _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV as _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV,
    RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND as _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND,
    RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV as _RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV,
    RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH as _RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND as _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND,
    RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV as _RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV,
    bounded_source_collection_probe_window as _bounded_source_collection_probe_window,
    hypothesis_manifest_ref as _hypothesis_manifest_ref,
    runtime_ledger_paper_probation_blockers as _runtime_ledger_paper_probation_blockers,
    runtime_ledger_paper_probation_bucket_ref as _runtime_ledger_paper_probation_bucket_ref,
    runtime_ledger_paper_probation_payload as _runtime_ledger_paper_probation_payload,
    runtime_ledger_paper_probation_strategy_name as _runtime_ledger_paper_probation_strategy_name,
    runtime_ledger_source_collection_import_candidate as _runtime_ledger_source_collection_import_candidate,
    runtime_ledger_source_collection_source_dsn_env as _runtime_ledger_source_collection_source_dsn_env,
    strategy_lookup_names as _strategy_lookup_names,
)


_RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS = (
    "source_window_start",
    "source_window_end",
    "source_refs",
    "source_ref",
    "source_row_counts",
    "source_window_ids",
    "source_window_id",
    "trade_decision_ids",
    "execution_ids",
    "execution_tca_metric_ids",
    "execution_order_event_ids",
    "source_offsets",
    "source_materialization",
    "authority_class",
    "authority_reason",
    "pnl_derivation",
    "cost_basis_counts",
)


@dataclass(frozen=True)
class RuntimeLedgerImportCandidate:
    raw: Mapping[str, object]
    hypothesis_id: str | None
    candidate_id: str | None
    strategy_family: str | None
    strategy_id: str | None
    strategy_name: str | None
    strategy_lookup_names: list[str]
    account_label: str
    window_start: str | None
    window_end: str | None
    defaulted_source_collection_window: bool
    source_manifest_ref: str | None
    dataset_snapshot_ref: str | None
    source_collection: bool
    paper_probation_blockers: list[str]

    @property
    def missing_fields(self) -> list[str]:
        return [
            field
            for field, value in (
                ("hypothesis_id", self.hypothesis_id),
                ("candidate_id", self.candidate_id),
                ("strategy_family", self.strategy_family),
                ("strategy_name", self.strategy_name),
                ("window_start", self.window_start),
                ("window_end", self.window_end),
                ("source_manifest_ref", self.source_manifest_ref),
            )
            if value is None
        ]

    @property
    def paper_probation_satisfied(self) -> bool:
        return not self.source_collection and not self.paper_probation_blockers

    @property
    def profit_target_source_collection(self) -> bool:
        return bool(self.raw.get("source_collection_profit_target_candidate"))

    @property
    def source_kind(self) -> str:
        if self.source_collection:
            return _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
        return _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND

    @property
    def source_dsn_env(self) -> str:
        if self.source_collection:
            return _runtime_ledger_source_collection_source_dsn_env(self.raw)
        return _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV

    @property
    def target_dsn_env(self) -> str:
        if self.source_collection:
            return _RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV
        return _RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV

    @property
    def final_blockers(self) -> list[str]:
        if self.source_collection:
            return list(_RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS)
        return list(_RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS)

    @property
    def selection_reason(self) -> str:
        if not self.source_collection:
            return "positive_post_cost_runtime_ledger_bucket"
        if self.profit_target_source_collection:
            return _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON
        return "positive_activity_needs_source_window_runtime_evidence"


def _runtime_ledger_source_evidence_payload(
    candidate: Mapping[str, object],
) -> dict[str, object]:
    payload = _runtime_ledger_paper_probation_payload(candidate)
    evidence: dict[str, object] = {}
    for key in _RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS:
        value = payload.get(key)
        if value is None or value == "" or value == [] or value == {}:
            continue
        evidence[key] = value
    return evidence


def runtime_ledger_paper_probation_import_plan(
    candidates: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    targets: list[dict[str, object]] = []
    skipped_targets: list[dict[str, object]] = []
    seen_target_keys: set[tuple[str, ...]] = set()
    for raw_candidate in candidates:
        candidate = runtime_ledger_import_candidate(raw_candidate)
        if candidate.missing_fields:
            skipped_targets.append(missing_import_target(candidate))
            continue

        if candidate.paper_probation_blockers:
            skipped_targets.append(blocked_import_target(candidate))
            continue

        target_key = runtime_ledger_import_target_key(candidate)
        bucket_ref = _runtime_ledger_paper_probation_bucket_ref(candidate.raw)
        if target_key in seen_target_keys:
            skipped_targets.append(duplicate_import_target(candidate, bucket_ref))
            continue
        seen_target_keys.add(target_key)

        targets.append(runtime_ledger_import_target(candidate, bucket_ref))

    return runtime_ledger_import_plan_payload(targets, skipped_targets)


def runtime_ledger_import_candidate(
    candidate: Mapping[str, object],
) -> RuntimeLedgerImportCandidate:
    strategy_id = _safe_text(candidate.get("strategy_id"))
    strategy_name = _runtime_ledger_paper_probation_strategy_name(candidate)
    window_start, window_end, defaulted_window = (
        _bounded_source_collection_probe_window(candidate)
    )
    source_collection = _runtime_ledger_source_collection_import_candidate(candidate)
    blockers = (
        [] if source_collection else _runtime_ledger_paper_probation_blockers(candidate)
    )
    return RuntimeLedgerImportCandidate(
        raw=candidate,
        hypothesis_id=_safe_text(candidate.get("hypothesis_id")),
        candidate_id=_safe_text(candidate.get("candidate_id")),
        strategy_family=_safe_text(candidate.get("strategy_family")),
        strategy_id=strategy_id,
        strategy_name=strategy_name,
        strategy_lookup_names=_strategy_lookup_names(
            candidate.get("strategy_lookup_names"),
            strategy_name,
            _safe_text(candidate.get("strategy_name")),
            strategy_names_from_strategy_id(strategy_id),
            derived_strategy_name_from_strategy_id(strategy_id),
        ),
        account_label=_safe_text(candidate.get("account")) or "TORGHUT_SIM",
        window_start=window_start,
        window_end=window_end,
        defaulted_source_collection_window=defaulted_window,
        source_manifest_ref=_safe_text(candidate.get("source_manifest_ref"))
        or _hypothesis_manifest_ref(candidate.get("hypothesis_id")),
        dataset_snapshot_ref=_safe_text(candidate.get("dataset_snapshot_ref")),
        source_collection=source_collection,
        paper_probation_blockers=blockers,
    )


def missing_import_target(
    candidate: RuntimeLedgerImportCandidate,
) -> dict[str, object]:
    return {
        "hypothesis_id": candidate.hypothesis_id,
        "candidate_id": candidate.candidate_id,
        "missing_fields": candidate.missing_fields,
        "reason": "runtime_ledger_paper_probation_target_missing_required_fields",
    }


def blocked_import_target(
    candidate: RuntimeLedgerImportCandidate,
) -> dict[str, object]:
    return {
        "hypothesis_id": candidate.hypothesis_id,
        "candidate_id": candidate.candidate_id,
        "strategy_family": candidate.strategy_family,
        "strategy_name": candidate.strategy_name,
        "window_start": candidate.window_start,
        "window_end": candidate.window_end,
        "runtime_ledger_bucket_ref": _runtime_ledger_paper_probation_bucket_ref(
            candidate.raw
        ),
        "reason": "runtime_ledger_paper_probation_prerequisites_not_satisfied",
        "blockers": candidate.paper_probation_blockers,
    }


def duplicate_import_target(
    candidate: RuntimeLedgerImportCandidate,
    bucket_ref: str | None,
) -> dict[str, object]:
    return {
        "hypothesis_id": candidate.hypothesis_id,
        "candidate_id": candidate.candidate_id,
        "strategy_family": candidate.strategy_family,
        "strategy_name": candidate.strategy_name,
        "window_start": candidate.window_start,
        "window_end": candidate.window_end,
        "runtime_ledger_bucket_ref": bucket_ref,
        "reason": "duplicate_runtime_ledger_paper_probation_target",
    }


def runtime_ledger_import_target_key(
    candidate: RuntimeLedgerImportCandidate,
) -> tuple[str, ...]:
    return (
        candidate.hypothesis_id or "",
        candidate.candidate_id or "",
        candidate.strategy_family or "",
        candidate.strategy_name or "",
        candidate.account_label,
        candidate.dataset_snapshot_ref or "",
        candidate.source_manifest_ref or "",
        candidate.source_kind,
        candidate.window_start or "",
        candidate.window_end or "",
    )


def runtime_ledger_import_target(
    candidate: RuntimeLedgerImportCandidate,
    bucket_ref: str | None,
) -> dict[str, object]:
    target = runtime_ledger_base_import_target(candidate)
    target.update(_runtime_ledger_source_evidence_payload(candidate.raw))
    if candidate.source_collection:
        target.update(source_collection_import_target_metadata(candidate))
    if bucket_ref:
        target["runtime_ledger_bucket_ref"] = bucket_ref
    return target


def runtime_ledger_base_import_target(
    candidate: RuntimeLedgerImportCandidate,
) -> dict[str, object]:
    bounded_probe_payload = _bounded_paper_route_probe_collection_payload(
        authorized=candidate.paper_probation_satisfied or candidate.source_collection
    )
    bounded_probe_authorized = bool(
        bounded_probe_payload.get("bounded_evidence_collection_authorized")
    )
    authority = (
        source_collection_policy(
            blockers=candidate.final_blockers,
            bounded_live_paper_collection_authorized=bounded_probe_authorized,
        )
        if candidate.source_collection
        else paper_probation_policy(
            blockers=candidate.final_blockers,
            bounded_live_paper_collection_authorized=bounded_probe_authorized,
        )
    )
    return {
        "hypothesis_id": candidate.hypothesis_id,
        "candidate_id": candidate.candidate_id,
        "observed_stage": "paper",
        "strategy_family": candidate.strategy_family,
        "strategy_name": candidate.strategy_name,
        "strategy_id": candidate.strategy_id or "",
        "runtime_strategy_name": candidate.strategy_name,
        "strategy_lookup_names": candidate.strategy_lookup_names,
        "account_label": candidate.account_label,
        "source_account_label": candidate.account_label,
        "account_stage_runtime_identity": {
            "account_label": candidate.account_label,
            "source_account_label": candidate.account_label,
            "observed_stage": "paper",
            "runtime_strategy_name": candidate.strategy_name,
            "source_kind": candidate.source_kind,
        },
        "source_dsn_env": candidate.source_dsn_env,
        "target_dsn_env": candidate.target_dsn_env,
        "dataset_snapshot_ref": candidate.dataset_snapshot_ref or "",
        "source_manifest_ref": candidate.source_manifest_ref,
        "source_kind": candidate.source_kind,
        "window_start": candidate.window_start,
        "window_end": candidate.window_end,
        "paper_probation_authorization_scope": (
            "evidence_collection_only" if candidate.paper_probation_satisfied else ""
        ),
        "paper_probation_satisfied_for_bounded_live_paper_collection": (
            candidate.paper_probation_satisfied
        ),
        "source_collection_authorization_scope": (
            "source_window_evidence_collection_only"
            if candidate.source_collection
            else ""
        ),
        "source_collection_reason_codes": source_collection_reason_codes(candidate),
        "proof_mode": "probation",
        "canary_collection_authorized": candidate.paper_probation_satisfied,
        **authority.as_target_fields(),
        **bounded_probe_payload,
        "evidence_collection_stage": "paper",
        "probation_allowed": candidate.paper_probation_satisfied,
        "probation_reason": runtime_ledger_import_probation_reason(candidate),
        "candidate_blockers": candidate_reason_codes(candidate),
        "handoff": runtime_ledger_import_handoff(candidate),
        "promotion_gate": "runtime_ledger_live_or_live_paper_required",
        "selected_by": runtime_ledger_import_selector(candidate),
        "selection_reason": candidate.selection_reason,
    }


def source_collection_reason_codes(
    candidate: RuntimeLedgerImportCandidate,
) -> list[object]:
    if not candidate.source_collection:
        return []
    return list(
        cast(
            Sequence[object], candidate.raw.get("source_collection_reason_codes") or []
        )
    )


def candidate_reason_codes(candidate: RuntimeLedgerImportCandidate) -> list[str]:
    return _normalize_reason_codes(
        [
            str(reason).strip()
            for reason in cast(
                Sequence[object], candidate.raw.get("reason_codes") or []
            )
            if str(reason).strip()
        ]
    )


def runtime_ledger_import_probation_reason(
    candidate: RuntimeLedgerImportCandidate,
) -> str:
    if candidate.source_collection:
        return "source_window_evidence_collection_pending"
    return "source_backed_paper_stage_runtime_ledger_positive_after_costs"


def runtime_ledger_import_handoff(candidate: RuntimeLedgerImportCandidate) -> str:
    if candidate.source_collection:
        return "runtime_ledger_source_collection_import"
    return "runtime_ledger_paper_probation_import"


def runtime_ledger_import_selector(candidate: RuntimeLedgerImportCandidate) -> str:
    if candidate.source_collection:
        return "runtime_ledger_source_collection"
    return "runtime_ledger_paper_probation"


def source_collection_import_target_metadata(
    candidate: RuntimeLedgerImportCandidate,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "paper_route_probe_window_start": candidate.window_start or "",
        "paper_route_probe_window_end": candidate.window_end or "",
        "source_collection_priority": (
            _safe_text(candidate.raw.get("source_collection_priority"))
            or "source_window_evidence_collection"
        ),
        "source_collection_profit_target_candidate": (
            candidate.profit_target_source_collection
        ),
        "source_collection_profit_target_net_pnl_after_costs": str(
            _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS
        ),
        "source_collection_net_strategy_pnl_after_costs": (
            _safe_text(
                candidate.raw.get("source_collection_net_strategy_pnl_after_costs")
            )
            or ""
        ),
        "source_collection_post_cost_expectancy_bps": (
            _safe_text(candidate.raw.get("source_collection_post_cost_expectancy_bps"))
            or ""
        ),
        "source_collection_filled_notional": (
            _safe_text(candidate.raw.get("source_collection_filled_notional")) or ""
        ),
        "source_collection_next_action": (
            _safe_text(candidate.raw.get("source_collection_next_action"))
            or "materialize_runtime_ledger_source_window_refs"
        ),
        "probation_target_shortfall": (
            _safe_text(candidate.raw.get("probation_target_shortfall")) or ""
        ),
        "probation_target_progress_ratio": (
            _safe_text(candidate.raw.get("probation_target_progress_ratio")) or ""
        ),
        "required_notional_repair_scale_to_target": (
            _safe_text(candidate.raw.get("required_notional_repair_scale_to_target"))
            or ""
        ),
        "required_notional_to_reach_target": (
            _safe_text(candidate.raw.get("required_notional_to_reach_target")) or ""
        ),
        "required_notional_repair_scale_authority": (
            _safe_text(candidate.raw.get("required_notional_repair_scale_authority"))
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
    if candidate.defaulted_source_collection_window:
        metadata.update(
            {
                "runtime_ledger_source_collection_window_defaulted": True,
                "runtime_ledger_source_collection_window_source": (
                    "current_regular_session_bounded_source_collection_default"
                ),
            }
        )
    return metadata


def runtime_ledger_import_plan_payload(
    targets: Sequence[Mapping[str, object]],
    skipped_targets: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    paper_probation_target_count = sum(
        1 for target in targets if bool(target.get("paper_probation_authorized"))
    )
    source_collection_target_count = sum(
        1 for target in targets if bool(target.get("source_collection_authorized"))
    )
    bounded_live_paper_collection_authorized = any(
        bool(target.get("bounded_live_paper_collection_authorized"))
        for target in targets
    )
    if source_collection_target_count:
        authority = source_collection_policy(
            blockers=list(_RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS),
            bounded_live_paper_collection_authorized=(
                bounded_live_paper_collection_authorized
            ),
        )
    elif paper_probation_target_count:
        authority = paper_probation_policy(
            blockers=list(_RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS),
            bounded_live_paper_collection_authorized=(
                bounded_live_paper_collection_authorized
            ),
        )
    else:
        authority = collection_blocked_policy(
            blockers=["runtime_ledger_paper_probation_import_targets_missing"],
        )
    return {
        "schema_version": _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
        "source": "runtime_ledger_paper_probation_and_source_collection_candidates",
        "purpose": "paper_stage_runtime_ledger_source_evidence_collection",
        "proof_mode": "probation",
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
        **authority.as_target_fields(),
        "target_count": len(targets),
        "paper_probation_target_count": paper_probation_target_count,
        "source_collection_target_count": source_collection_target_count,
        "source_collection_profit_target_count": sum(
            1
            for target in targets
            if bool(target.get("source_collection_profit_target_candidate"))
        ),
        "skipped_target_count": len(skipped_targets),
        "targets": targets,
        "skipped_targets": skipped_targets,
    }


def runtime_ledger_import_plan_has_target(
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


def bounded_paper_route_manifest_collection_targets(
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
        if runtime_ledger_import_plan_has_target(
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
                "paper_probation_authorization_scope": "",
                "paper_probation_satisfied_for_bounded_live_paper_collection": False,
                "source_collection_authorization_scope": (
                    "bounded_paper_route_source_decision_collection_only"
                ),
                "source_collection_reason_codes": [
                    "runtime_ledger_source_decisions_missing",
                    "bounded_paper_route_manifest_seed",
                ],
                "proof_mode": "probation",
                "canary_collection_authorized": False,
                **source_collection_policy(
                    blockers=list(_BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS),
                    bounded_live_paper_collection_authorized=True,
                ).as_target_fields(),
                **_bounded_paper_route_probe_collection_payload(authorized=True),
                "evidence_collection_stage": "paper",
                "probation_allowed": False,
                "probation_reason": "source_backed_paper_probation_required",
                "candidate_blockers": [
                    "runtime_ledger_source_decisions_missing",
                    "source_backed_paper_probation_required",
                    "paper_route_runtime_ledger_import_pending",
                ],
                "handoff": "next_paper_route_runtime_window_import",
                "promotion_gate": "runtime_ledger_live_or_live_paper_required",
                "selected_by": "hypothesis_manifest_bounded_paper_route_collection",
                "selection_reason": "source_decisions_missing_for_bounded_paper_route",
            }
        )
    return targets


def with_bounded_paper_route_manifest_collection_targets(
    plan: Mapping[str, object],
    *,
    registry_items: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    merged_plan = dict(plan)
    manifest_targets = bounded_paper_route_manifest_collection_targets(
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
    merged_plan.update(
        source_collection_policy(
            blockers=list(_BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS),
            bounded_live_paper_collection_authorized=bool(
                merged_plan["bounded_live_paper_collection_authorized"]
            ),
        ).as_target_fields()
    )
    return merged_plan


def paper_probation_eligible_total_with_runtime_ledger(
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


__all__ = [
    "_RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS",
    "RuntimeLedgerImportCandidate",
    "blocked_import_target",
    "bounded_paper_route_manifest_collection_targets",
    "candidate_reason_codes",
    "duplicate_import_target",
    "missing_import_target",
    "paper_probation_eligible_total_with_runtime_ledger",
    "runtime_ledger_base_import_target",
    "runtime_ledger_import_candidate",
    "runtime_ledger_import_handoff",
    "runtime_ledger_import_plan_has_target",
    "runtime_ledger_import_plan_payload",
    "runtime_ledger_import_probation_reason",
    "runtime_ledger_import_selector",
    "runtime_ledger_import_target",
    "runtime_ledger_import_target_key",
    "runtime_ledger_paper_probation_import_plan",
    "_runtime_ledger_source_evidence_payload",
    "source_collection_import_target_metadata",
    "source_collection_reason_codes",
    "with_bounded_paper_route_manifest_collection_targets",
]
