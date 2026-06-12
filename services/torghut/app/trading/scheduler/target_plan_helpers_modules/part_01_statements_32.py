# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, TypeAlias, cast


from ....config import settings
from ....models import (
    Strategy,
)
from ....strategies.catalog import extract_catalog_metadata
from ...autonomy import DriftThresholds
from ...feature_quality import FeatureQualityThresholds
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...runtime_strategy_resolution import strategy_names_from_strategy_id
from ...simple_risk import (
    position_qty_for_symbol,
)

# ruff: noqa: F401,F403,F405,F811,F821


logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)

_SIMPLE_ALLOWED_REJECT_REASONS = {
    "kill_switch_enabled",
    "invalid_qty_increment",
    "qty_below_min_after_clamp",
    "insufficient_buying_power",
    "equity_required_for_exposure_increase",
    "max_notional_exceeded",
    "max_gross_exposure_exceeded",
    "max_symbol_exposure_exceeded",
    "shorting_not_allowed_for_asset",
    "broker_precheck_failed",
    "broker_submit_failed",
}

_PAPER_ROUTE_PROBE_REASONS = {
    "execution_tca_route_universe_empty",
    "execution_tca_symbol_missing",
    "route_tca_passed_but_dependency_receipts_block_capital",
    "tca_evidence_stale",
}

_PaperRouteRetryKind: TypeAlias = Literal[
    "bounded_probe",
    "quote_routeability",
    "target_price",
]

_PAPER_ROUTE_RETRY_KINDS: frozenset[_PaperRouteRetryKind] = frozenset(
    {"bounded_probe", "quote_routeability", "target_price"}
)

_PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS = 86_400

_SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL = timedelta(seconds=30)

_PAPER_ROUTE_PROBE_QTY_STEP = Decimal("0.0001")

_REGULAR_SESSION_MINUTES = 390

_PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS = 3

_PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS = 60

_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = 600

_PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK = timedelta(days=7)

_PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON = Decimal("0.00000001")

_SIGNAL_INGEST_UNAVAILABLE_REASONS = frozenset(
    {
        "clickhouse_signal_query_timeout",
        "clickhouse_url_missing",
    }
)

_BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"

_BOUNDED_SIM_COLLECTION_SOURCE_KIND = "paper_route_probe_runtime_observed"

_BOUNDED_SIM_COLLECTION_SOURCE_KINDS = frozenset(
    {
        _BOUNDED_SIM_COLLECTION_SOURCE_KIND,
        "runtime_ledger_source_collection_candidate",
    }
)

_BOUNDED_SIM_COLLECTION_SCOPE = "paper_route_probe_next_session_only"

_BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS = (
    "bounded_evidence_collection_blockers",
    "runtime_window_import_health_gate_blockers",
    "paper_route_target_account_audit_blockers",
    "paper_route_account_pre_session_blockers",
    "paper_route_account_contamination_blockers",
    "paper_route_hpairs_symbol_blockers",
)

_BOUNDED_SIM_COLLECTION_RESERVATION_BLOCKERS = frozenset(
    {
        "paper_route_target_account_audit_unavailable",
        "paper_route_account_pre_session_snapshot_missing",
        "paper_route_account_pre_session_snapshot_stale",
        "paper_route_account_window_start_snapshot_missing",
        "paper_route_clean_window_baseline_snapshot_pending",
        "paper_route_account_contamination_detected",
        "unlinked_order_events_present",
    }
)

_PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER = (
    "paper_route_target_account_audit_unavailable"
)

_BOUNDED_PAPER_ROUTE_DEFAULT_CLOSEOUT_BUFFER_MINUTES = 15

_PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS = 300

_BOUNDED_SIM_COLLECTION_ALLOWED_HEALTH_GATE_BLOCKERS = frozenset(
    {"evidence_continuity_not_ok"}
)

_BOUNDED_SIM_COLLECTION_SOURCE_AUTHORIZED_SUPERSEDED_BLOCKERS = frozenset(
    {"paper_probation_prerequisites_not_satisfied_for_bounded_collection"}
)

_BOUNDED_SIM_COLLECTION_LINEAGE_KEYS = (
    "account_label",
    "source_account_label",
    "observed_stage",
    "runtime_strategy_name",
    "source_kind",
    "source_manifest_ref",
    "bounded_evidence_collection_scope",
    "bounded_evidence_collection_max_notional",
)

_BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS = (
    "bounded_evidence_collection_authorized",
    "bounded_live_paper_collection_authorized",
    "canary_collection_authorized",
    "evidence_collection_ok",
)

_BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS = (
    "source_decision_readiness",
    "paper_route_target_account_audit_state",
)

_FLATTEN_CLOSE_DECISION_SCHEMA_VERSION = (
    "torghut.paper-account-flatten-close-decision.v1"
)

_BOUNDED_SIM_COLLECTION_RUNTIME_ACCOUNT_ALIAS_FIELDS = (
    "execution_account_label",
    "runtime_account_label",
    "paper_account_label",
    "paper_route_runtime_account_label",
    "source_account_label",
)

_BOUNDED_SIM_COLLECTION_SOURCE_AUTHORIZATION_SCOPES = frozenset(
    {
        "bounded_paper_route_source_decision_collection_only",
        "source_window_evidence_collection_only",
    }
)


@dataclass(frozen=True)
class _PaperRouteRetryTransition:
    kind: _PaperRouteRetryKind
    metadata: dict[str, object]


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float | str | Decimal):
        try:
            return int(value)
        except ValueError:
            return 0
    try:
        return int(cast(Any, value))
    except (TypeError, ValueError):
        return 0


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _symbols_from_mapping(target: Mapping[str, Any]) -> set[str]:
    symbols: set[str] = set()
    for field in (
        "paper_route_probe_symbols",
        "paper_route_probe_raw_target_symbols",
        "symbols",
        "target_symbols",
    ):
        raw_symbols = target.get(field)
        if isinstance(raw_symbols, str):
            values = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols, (str, bytes, bytearray)
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for raw in values:
            if symbol := str(raw).strip().upper():
                symbols.add(symbol)

    for field in (
        "paper_route_probe_symbol_actions",
        "symbol_actions",
        "target_symbol_actions",
    ):
        raw_actions = target.get(field)
        if not isinstance(raw_actions, Mapping):
            continue
        for raw_symbol in cast(Mapping[object, object], raw_actions):
            if symbol := str(raw_symbol).strip().upper():
                symbols.add(symbol)

    return symbols


def _target_symbols(target: Mapping[str, Any]) -> set[str]:
    symbols = _symbols_from_mapping(target)
    for field in (
        "paper_route_clean_window_baseline_state",
        "clean_window_baseline_state",
    ):
        state = target.get(field)
        if not isinstance(state, Mapping):
            continue
        typed_state = cast(Mapping[str, Any], state)
        symbols.update(_symbols_from_mapping(typed_state))
        source_audit = typed_state.get("source_audit")
        if isinstance(source_audit, Mapping):
            symbols.update(_symbols_from_mapping(cast(Mapping[str, Any], source_audit)))

    execution_source_key = target.get("paper_route_execution_source_key")
    if isinstance(execution_source_key, Mapping):
        symbols.update(_target_symbols(cast(Mapping[str, Any], execution_source_key)))

    return symbols


def _target_plan_lineage(
    targets: list[dict[str, Any]], symbol: str
) -> dict[str, object]:
    normalized_symbol = symbol.strip().upper()
    lineage_targets: list[dict[str, str]] = []
    candidate_ids: list[str] = []
    hypothesis_ids: list[str] = []
    strategy_names: list[str] = []
    for target in targets:
        target_symbols = _target_symbols(target)
        if target_symbols and normalized_symbol not in target_symbols:
            continue
        candidate_id = _safe_text(target.get("candidate_id"))
        hypothesis_id = _safe_text(target.get("hypothesis_id"))
        target_strategy_names = _target_lineage_strategy_names(target)
        strategy_name = target_strategy_names[0] if target_strategy_names else None
        item = {
            key: value
            for key, value in {
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "strategy_name": strategy_name,
            }.items()
            if value
        }
        if item:
            lineage_targets.append(item)
        if candidate_id and candidate_id not in candidate_ids:
            candidate_ids.append(candidate_id)
        if hypothesis_id and hypothesis_id not in hypothesis_ids:
            hypothesis_ids.append(hypothesis_id)
        for target_strategy_name in target_strategy_names:
            if target_strategy_name not in strategy_names:
                strategy_names.append(target_strategy_name)
    return {
        "paper_route_probe_lineage_targets": lineage_targets,
        "source_candidate_ids": candidate_ids,
        "source_hypothesis_ids": hypothesis_ids,
        "source_strategy_names": strategy_names,
    }


def _target_lineage_strategy_names(target: Mapping[str, Any]) -> list[str]:
    names: list[str] = []
    for value in (
        target.get("strategy_name"),
        target.get("runtime_strategy_name"),
    ):
        _merge_unique_texts(names, _lineage_text_values(value))
    for resolved_name in strategy_names_from_strategy_id(target.get("strategy_id")):
        _merge_unique_texts(names, [resolved_name])
    if not names:
        _merge_unique_texts(names, _lineage_text_values(target.get("strategy_id")))
    return names


def _target_has_bounded_source_collection_authorization(
    target: Mapping[str, Any],
) -> bool:
    scope = _safe_text(target.get("source_collection_authorization_scope"))
    return (
        _target_truthy(target.get("source_collection_authorized"))
        and _target_has_bounded_sim_collection_source_kind(target)
        and _safe_text(target.get("account_label"))
        == _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL
        and scope in _BOUNDED_SIM_COLLECTION_SOURCE_AUTHORIZATION_SCOPES
    )


def _target_bounded_collection_authorized(target: Mapping[str, Any]) -> bool:
    return (
        _target_truthy(target.get("bounded_evidence_collection_authorized"))
        or _target_truthy(target.get("bounded_live_paper_collection_authorized"))
        or _target_truthy(target.get("canary_collection_authorized"))
        or _target_has_bounded_source_collection_authorization(target)
    )


def _target_has_bounded_sim_collection_source_kind(
    target: Mapping[str, Any],
) -> bool:
    return _safe_text(target.get("source_kind")) in _BOUNDED_SIM_COLLECTION_SOURCE_KINDS


def _bounded_sim_collection_blockers(
    target: Mapping[str, Any],
    *,
    account_label: str | None,
) -> list[str]:
    blockers: list[str] = []
    runtime_account = _safe_text(account_label)
    target_account = _safe_text(target.get("account_label"))
    runtime_account_aliases = _bounded_sim_collection_runtime_account_aliases(target)
    if runtime_account is not None and runtime_account not in runtime_account_aliases:
        blockers.append("bounded_sim_collection_runtime_account_not_target")
    if target_account != _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL:
        blockers.append("bounded_sim_collection_target_account_not_torghut_sim")
    if _safe_text(target.get("observed_stage")) != "paper":
        blockers.append("bounded_sim_collection_paper_stage_required")
    if not _target_has_bounded_sim_collection_source_kind(target):
        blockers.append("bounded_sim_collection_source_kind_required")
    if not (
        _safe_text(target.get("candidate_id"))
        or _lineage_text_values(target.get("source_candidate_ids"))
    ):
        blockers.append("bounded_sim_collection_candidate_id_missing")
    if not (
        _safe_text(target.get("hypothesis_id"))
        or _lineage_text_values(target.get("source_hypothesis_ids"))
    ):
        blockers.append("bounded_sim_collection_hypothesis_id_missing")
    if not (
        _safe_text(target.get("runtime_strategy_name"))
        or _safe_text(target.get("strategy_name"))
        or _lineage_text_values(target.get("source_strategy_names"))
        or strategy_names_from_strategy_id(target.get("strategy_id"))
    ):
        blockers.append("bounded_sim_collection_runtime_strategy_missing")
    if _safe_text(target.get("source_manifest_ref")) is None:
        blockers.append("bounded_sim_collection_source_manifest_missing")
    if not _target_bounded_collection_authorized(target):
        blockers.append("bounded_sim_collection_authorization_missing")
    if not _target_truthy(target.get("evidence_collection_ok")):
        blockers.append("bounded_sim_collection_evidence_collection_not_ready")
    blockers.extend(_bounded_sim_collection_account_audit_blockers(target))
    if (
        _target_truthy(target.get("promotion_allowed"))
        or _target_truthy(target.get("final_promotion_allowed"))
        or _target_truthy(target.get("final_promotion_authorized"))
        or _target_truthy(target.get("capital_promotion_allowed"))
    ):
        blockers.append("bounded_sim_collection_non_final_state_required")
    if _safe_text(target.get("bounded_evidence_collection_scope")) not in {
        None,
        _BOUNDED_SIM_COLLECTION_SCOPE,
    }:
        blockers.append("bounded_sim_collection_scope_not_supported")
    if not _target_symbols(target):
        blockers.append("bounded_sim_collection_probe_symbols_missing")

    readiness = target.get("source_decision_readiness")
    if isinstance(readiness, Mapping):
        typed_readiness = cast(Mapping[str, Any], readiness)
        if not _target_truthy(typed_readiness.get("ready")):
            blockers.append("bounded_sim_collection_source_decision_not_ready")
        blockers.extend(_lineage_text_values(typed_readiness.get("blockers")))
    else:
        blockers.append("bounded_sim_collection_source_decision_readiness_missing")

    if _safe_text(target.get("paper_route_probe_pair_balance_state")) == "imbalanced":
        blockers.append("paper_route_probe_pair_imbalanced")
    for key in _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS:
        field_blockers = _lineage_text_values(target.get(key))
        if key == "runtime_window_import_health_gate_blockers":
            field_blockers = [
                blocker
                for blocker in field_blockers
                if blocker not in _BOUNDED_SIM_COLLECTION_ALLOWED_HEALTH_GATE_BLOCKERS
            ]
        blockers.extend(field_blockers)
    return list(dict.fromkeys(blockers))


def _bounded_sim_collection_account_audit_blockers(
    target: Mapping[str, Any],
) -> list[str]:
    audit_state = target.get("paper_route_target_account_audit_state")
    nested_blockers: list[str] = []
    audit_available: bool | None = None
    if isinstance(audit_state, Mapping):
        typed_audit_state = cast(Mapping[str, Any], audit_state)
        nested_blockers = _lineage_text_values(typed_audit_state.get("blockers"))
        raw_available = _target_bool(typed_audit_state.get("audit_available"))
        state = _safe_text(typed_audit_state.get("state"))
        audit_available = (
            bool(raw_available)
            if raw_available is not None
            else state == "available"
            if state in {"available", "unavailable"}
            else None
        )

    blockers = [
        *nested_blockers,
        *_lineage_text_values(target.get("paper_route_target_account_audit_blockers")),
    ]
    if blockers:
        return blockers
    if audit_available is True:
        return []
    if (
        not isinstance(audit_state, Mapping)
        and "paper_route_target_account_audit_blockers" not in target
        and _PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER
        not in _lineage_text_values(target.get("bounded_evidence_collection_blockers"))
    ):
        return []
    return [_PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER]


def _without_lineage_text_values(value: object, excluded: set[str]) -> list[str]:
    return [item for item in _lineage_text_values(value) if item not in excluded]


def _bounded_sim_collection_target_with_runtime_account_audit(
    target: Mapping[str, Any],
    *,
    positions: Sequence[Mapping[str, Any]] | None,
    account_label: str | None,
) -> dict[str, Any]:
    normalized = dict(target)
    if positions is None:
        return normalized

    if _target_has_bounded_source_collection_authorization(normalized):
        for key in (
            "bounded_evidence_collection_blockers",
            "candidate_blockers",
            "runtime_ledger_target_metadata_blockers",
        ):
            if key in normalized:
                normalized[key] = _without_lineage_text_values(
                    normalized.get(key),
                    set(_BOUNDED_SIM_COLLECTION_SOURCE_AUTHORIZED_SUPERSEDED_BLOCKERS),
                )

    unavailable = {_PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER}
    normalized["paper_route_target_account_audit_state"] = {
        "schema_version": "torghut.paper-route-target-account-audit.v1",
        "scope": "local_torghut_sim_paper_runtime_account_state",
        "state": "available",
        "account_label": _safe_text(account_label)
        or _safe_text(target.get("account_label"))
        or _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL,
        "required_account_label": _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL,
        "symbols": sorted(_target_symbols(target)),
        "audit_available": True,
        "blockers": [],
        "source": "simple_pipeline_runtime_account_snapshot",
    }
    normalized["paper_route_target_account_audit_blockers"] = []
    for key in (
        "bounded_evidence_collection_blockers",
        "candidate_blockers",
    ):
        if key in normalized:
            normalized[key] = _without_lineage_text_values(
                normalized.get(key), unavailable
            )

    evidence_blockers: list[str] = []
    for key in _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS:
        if key == "paper_route_target_account_audit_blockers":
            continue
        field_blockers = _lineage_text_values(normalized.get(key))
        if key == "runtime_window_import_health_gate_blockers":
            field_blockers = [
                blocker
                for blocker in field_blockers
                if blocker not in _BOUNDED_SIM_COLLECTION_ALLOWED_HEALTH_GATE_BLOCKERS
            ]
        evidence_blockers.extend(field_blockers)
    readiness = normalized.get("source_decision_readiness")
    if isinstance(readiness, Mapping):
        typed_readiness = cast(Mapping[str, Any], readiness)
        if not _target_truthy(typed_readiness.get("ready")):
            evidence_blockers.append("bounded_sim_collection_source_decision_not_ready")
        evidence_blockers.extend(_lineage_text_values(typed_readiness.get("blockers")))
    else:
        evidence_blockers.append(
            "bounded_sim_collection_source_decision_readiness_missing"
        )
    if (
        _safe_text(normalized.get("paper_route_probe_pair_balance_state"))
        == "imbalanced"
    ):
        evidence_blockers.append("paper_route_probe_pair_imbalanced")

    if not list(dict.fromkeys(evidence_blockers)):
        normalized["evidence_collection_ok"] = True
        normalized["bounded_evidence_collection_authorized"] = True
        normalized["bounded_live_paper_collection_authorized"] = True
        normalized["canary_collection_authorized"] = True
    return normalized


def _bounded_sim_collection_runtime_account_aliases(
    target: Mapping[str, Any],
) -> set[str]:
    aliases = {_BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL}
    for key in _BOUNDED_SIM_COLLECTION_RUNTIME_ACCOUNT_ALIAS_FIELDS:
        aliases.update(_lineage_text_values(target.get(key)))
    identity = target.get("account_stage_runtime_identity")
    if isinstance(identity, Mapping):
        identity_mapping = cast(Mapping[str, Any], identity)
        aliases.update(_lineage_text_values(identity_mapping.get("account_label")))
        for key in _BOUNDED_SIM_COLLECTION_RUNTIME_ACCOUNT_ALIAS_FIELDS:
            aliases.update(_lineage_text_values(identity_mapping.get(key)))
    return {alias for alias in aliases if alias}


def _bounded_sim_collection_authorized(
    target: Mapping[str, Any],
    *,
    account_label: str | None,
) -> bool:
    return not _bounded_sim_collection_blockers(target, account_label=account_label)


def _bounded_sim_collection_reserves_account(
    target: Mapping[str, Any],
    *,
    account_label: str | None,
) -> bool:
    blockers = _bounded_sim_collection_blockers(target, account_label=account_label)
    if not blockers:
        return True
    return bool(_BOUNDED_SIM_COLLECTION_RESERVATION_BLOCKERS.intersection(blockers))


def _target_owns_bounded_sim_collection_account(target: Mapping[str, Any]) -> bool:
    hypothesis_id = _safe_text(target.get("hypothesis_id"))
    candidate_id = _safe_text(target.get("candidate_id"))
    family_tokens = _target_strategy_family_tokens(target)
    return (
        hypothesis_id == "H-PAIRS-01"
        or candidate_id == "c88421d619759b2cfaa6f4d0"
        or any("microbar_cross_sectional_pairs" in token for token in family_tokens)
    )


def _target_runtime_account_matches(
    target: Mapping[str, Any],
    *,
    account_label: str | None,
) -> bool:
    normalized_account = _safe_text(account_label)
    if not normalized_account:
        return False
    labels = set(_lineage_text_values(target.get("account_label")))
    for key in (
        "execution_account_label",
        "runtime_account_label",
        "paper_account_label",
        "paper_route_runtime_account_label",
    ):
        labels.update(_lineage_text_values(target.get(key)))
    identity = target.get("account_stage_runtime_identity")
    if isinstance(identity, Mapping):
        identity_mapping = cast(Mapping[str, Any], identity)
        labels.update(_lineage_text_values(identity_mapping.get("account_label")))
        for key in (
            "execution_account_label",
            "runtime_account_label",
            "paper_account_label",
            "paper_route_runtime_account_label",
        ):
            labels.update(_lineage_text_values(identity_mapping.get(key)))
    return normalized_account in labels


def _target_active_in_window(target: Mapping[str, Any], now: datetime) -> bool:
    window = _target_probe_window(target)
    if window is None:
        return False
    window_start, window_end = window
    return window_start <= now < window_end


__all__ = [name for name in globals() if not name.startswith("__")]
