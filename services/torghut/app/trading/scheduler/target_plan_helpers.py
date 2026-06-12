# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false, reportUnusedFunction=false, reportUnusedClass=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, TypeAlias, cast


from ...config import settings
from ...models import (
    Strategy,
)
from ...strategies.catalog import extract_catalog_metadata
from ..autonomy import DriftThresholds
from ..feature_quality import FeatureQualityThresholds
from ..models import StrategyDecision
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ..runtime_strategy_resolution import strategy_names_from_strategy_id
from ..simple_risk import (
    position_qty_for_symbol,
)

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


def _target_plan_has_active_bounded_sim_collection_owner(
    targets: Sequence[Mapping[str, Any]],
    *,
    account_label: str | None,
    now: datetime,
) -> bool:
    for target in targets:
        if not _target_owns_bounded_sim_collection_account(target):
            continue
        if not _target_runtime_account_matches(target, account_label=account_label):
            continue
        if not _bounded_sim_collection_reserves_account(
            target,
            account_label=account_label,
        ):
            continue
        if _target_active_in_window(target, now):
            return True
    return False


def _target_requires_bounded_sim_collection_gate(target: Mapping[str, Any]) -> bool:
    account_label = _safe_text(target.get("account_label"))
    return (
        _target_owns_bounded_sim_collection_account(target)
        or account_label == _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL
    )


def _bounded_sim_collection_metadata_from_decision(
    decision: StrategyDecision,
    *,
    account_label: str | None,
    trading_mode: str,
) -> Mapping[str, Any] | None:
    if trading_mode != "paper":
        return None
    for key in (
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "strategy_signal_paper",
        "paper_route_probe",
        "paper_route_probe_exit",
    ):
        value = decision.params.get(key)
        if not isinstance(value, Mapping):
            continue
        metadata = cast(Mapping[str, Any], value)
        if _bounded_sim_collection_authorized(metadata, account_label=account_label):
            return metadata
    return None


def _target_lookup_names(target: Mapping[str, Any]) -> list[str]:
    names: list[str] = []
    strategy_id = target.get("strategy_id")
    for value in (
        strategy_id,
        target.get("runtime_strategy_name"),
        target.get("strategy_name"),
        target.get("strategy_lookup_names"),
    ):
        _merge_unique_texts(names, _lineage_text_values(value))
    for resolved_name in strategy_names_from_strategy_id(strategy_id):
        _merge_unique_texts(names, [resolved_name])
    return names


def _strategy_lookup_names(strategy: Strategy) -> list[str]:
    names: list[str] = []
    _merge_unique_texts(names, _lineage_text_values(str(strategy.id)))
    _merge_unique_texts(names, _lineage_text_values(strategy.name))

    metadata = extract_catalog_metadata(strategy.description)
    for key in ("strategy_id", "runtime_strategy_name", "strategy_name"):
        _merge_unique_texts(names, _lineage_text_values(metadata.get(key)))
    declared_strategy_id = metadata.get("strategy_id")
    for resolved_name in strategy_names_from_strategy_id(declared_strategy_id):
        _merge_unique_texts(names, [resolved_name])
    return names


def _parse_target_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        raw_text = _safe_text(value)
        if raw_text is None:
            return None
        try:
            parsed = datetime.fromisoformat(raw_text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _mapping_value(value: object) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return None


def _decimal_from_mapping(
    payload: Mapping[str, Any],
    keys: Sequence[str],
) -> Decimal | None:
    for key in keys:
        value = _optional_decimal(payload.get(key))
        if value is not None:
            return value
    return None


def _text_from_mapping(payload: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key in keys:
        value = _safe_text(payload.get(key))
        if value is not None:
            return value
    return None


def _target_metadata_quote_snapshot(
    params: Mapping[str, Any],
    *,
    symbol: str,
) -> Mapping[str, Any] | None:
    normalized_symbol = symbol.strip().upper()
    for metadata_key in (
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "paper_route_probe",
        "strategy_signal_paper",
    ):
        metadata = _mapping_value(params.get(metadata_key))
        if metadata is None:
            continue
        snapshot = _quote_snapshot_from_mapping(metadata, symbol=normalized_symbol)
        if snapshot is not None:
            return snapshot
    return None


def _quote_snapshot_from_mapping(
    payload: Mapping[str, Any],
    *,
    symbol: str,
) -> Mapping[str, Any] | None:
    for direct_key in (
        "price_snapshot",
        "executable_quote",
        "quote",
        "nbbo",
        "market_snapshot",
    ):
        direct = _mapping_value(payload.get(direct_key))
        if direct is not None and _quote_snapshot_matches_symbol(direct, symbol=symbol):
            return direct

    readiness = _mapping_value(payload.get("source_decision_readiness"))
    if readiness is not None:
        snapshot = _quote_snapshot_from_mapping(readiness, symbol=symbol)
        if snapshot is not None:
            return snapshot

    for symbol_map_key in (
        "paper_route_probe_symbol_quotes",
        "source_symbol_quotes",
        "symbol_quotes",
        "executable_quotes",
        "price_snapshots",
        "latest_quotes",
    ):
        symbol_map = _mapping_value(payload.get(symbol_map_key))
        if symbol_map is None:
            continue
        for raw_symbol, raw_snapshot in symbol_map.items():
            if str(raw_symbol).strip().upper() != symbol:
                continue
            snapshot = _mapping_value(raw_snapshot)
            if snapshot is not None:
                return snapshot
    return None


def _quote_snapshot_matches_symbol(
    snapshot: Mapping[str, Any],
    *,
    symbol: str,
) -> bool:
    snapshot_symbol = _safe_text(snapshot.get("symbol"))
    return snapshot_symbol is None or snapshot_symbol.upper() == symbol


def _snapshot_has_executable_quote(snapshot: Mapping[str, Any]) -> bool:
    bid = _decimal_from_mapping(snapshot, ("bid", "bid_px", "bid_price", "bp"))
    ask = _decimal_from_mapping(snapshot, ("ask", "ask_px", "ask_price", "ap"))
    return bid is not None and ask is not None and bid > 0 and ask >= bid


def _target_probe_window(target: Mapping[str, Any]) -> tuple[datetime, datetime] | None:
    window_start = _parse_target_datetime(
        target.get("paper_route_probe_window_start") or target.get("window_start")
    )
    window_end = _parse_target_datetime(
        target.get("paper_route_probe_window_end") or target.get("window_end")
    )
    if window_start is None or window_end is None or window_end <= window_start:
        return None
    return window_start, window_end


def _target_missing_explicit_probe_window(target: Mapping[str, Any]) -> bool:
    return all(
        _safe_text(target.get(key)) is None
        for key in (
            "paper_route_probe_window_start",
            "paper_route_probe_window_end",
            "window_start",
            "window_end",
        )
    )


def _target_probe_action(target: Mapping[str, Any]) -> Literal["buy", "sell"]:
    for key in (
        "paper_route_probe_action",
        "paper_route_probe_side",
        "probe_action",
        "probe_side",
        "action",
        "side",
    ):
        normalized = str(target.get(key) or "").strip().lower()
        if normalized in {"buy", "long"}:
            return "buy"
        if normalized in {"sell", "short"}:
            return "sell"
    return "buy"


def _target_probe_cap(target: Mapping[str, Any]) -> Decimal | None:
    for key in (
        "paper_route_probe_next_session_max_notional",
        "bounded_evidence_collection_max_notional",
        "paper_route_probe_effective_max_notional",
        "paper_route_probe_target_notional",
        "target_notional",
        "max_notional",
    ):
        cap = _optional_decimal(target.get(key))
        if cap is not None and cap > 0:
            return cap
    return None


def _target_probe_exit_minute_after_open(
    target: Mapping[str, Any],
) -> tuple[int | None, bool]:
    for key in ("exit_minute_after_open", "paper_route_probe_exit_minute_after_open"):
        raw_value = target.get(key)
        if raw_value is None:
            exit_minute = None
        elif isinstance(raw_value, str):
            text = raw_value.strip().lower()
            if not text:
                exit_minute = None
            elif text == "close":
                exit_minute = _REGULAR_SESSION_MINUTES
            else:
                try:
                    exit_minute = max(0, int(Decimal(text)))
                except Exception:
                    exit_minute = None
        else:
            try:
                exit_minute = max(0, int(cast(Any, raw_value)))
            except (TypeError, ValueError, ArithmeticError):
                exit_minute = None
        if exit_minute is not None:
            return exit_minute, False
    if _target_has_bounded_sim_collection_source_kind(target) and (
        _target_truthy(target.get("bounded_evidence_collection_authorized"))
        or _target_truthy(target.get("paper_probation_authorized"))
        or _target_truthy(target.get("source_collection_authorized"))
    ):
        return (
            max(
                0,
                _REGULAR_SESSION_MINUTES
                - _BOUNDED_PAPER_ROUTE_DEFAULT_CLOSEOUT_BUFFER_MINUTES,
            ),
            True,
        )
    return None, False


def _target_strategy_family_tokens(target: Mapping[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for key in (
        "strategy_family",
        "strategy_name",
        "runtime_strategy_name",
        "strategy_id",
        "universe_type",
    ):
        value = _safe_text(target.get(key))
        if value:
            tokens.add(value.strip().lower().replace("-", "_"))
    return tokens


def _target_requires_balanced_pair_legs(target: Mapping[str, Any]) -> bool:
    explicit = _target_bool(target.get("paper_route_probe_pair_balance_required"))
    if explicit is not None:
        return explicit
    return any(
        "microbar_cross_sectional_pairs" in token
        for token in _target_strategy_family_tokens(target)
    )


def _target_probe_symbol_actions(
    target: Mapping[str, Any],
    symbols: Sequence[str],
) -> dict[str, Literal["buy", "sell"]]:
    normalized_symbols = [
        symbol.strip().upper() for symbol in symbols if symbol.strip()
    ]
    actions: dict[str, Literal["buy", "sell"]] = {}
    raw_actions = target.get("paper_route_probe_symbol_actions")
    if isinstance(raw_actions, Mapping):
        for raw_symbol, raw_action in cast(
            Mapping[object, object], raw_actions
        ).items():
            symbol = str(raw_symbol).strip().upper()
            action = str(raw_action or "").strip().lower()
            if symbol in normalized_symbols and action in {"buy", "long"}:
                actions[symbol] = "buy"
            elif symbol in normalized_symbols and action in {"sell", "short"}:
                actions[symbol] = "sell"
    elif isinstance(raw_actions, Sequence) and not isinstance(
        raw_actions, (str, bytes, bytearray)
    ):
        for raw_item in cast(Sequence[object], raw_actions):
            if not isinstance(raw_item, Mapping):
                continue
            item = cast(Mapping[str, object], raw_item)
            symbol = str(item.get("symbol") or "").strip().upper()
            action = str(item.get("action") or item.get("side") or "").strip().lower()
            if symbol in normalized_symbols and action in {"buy", "long"}:
                actions[symbol] = "buy"
            elif symbol in normalized_symbols and action in {"sell", "short"}:
                actions[symbol] = "sell"

    missing_symbols = [symbol for symbol in normalized_symbols if symbol not in actions]
    if missing_symbols and _target_requires_balanced_pair_legs(target):
        selection_mode = (
            str(target.get("selection_mode") or "continuation").strip().lower()
        )
        first_action: Literal["buy", "sell"] = (
            "sell" if selection_mode == "reversal" else "buy"
        )
        second_action: Literal["buy", "sell"] = (
            "buy" if first_action == "sell" else "sell"
        )
        buy_count = sum(1 for action in actions.values() if action == "buy")
        sell_count = sum(1 for action in actions.values() if action == "sell")
        balanced_seed_index = 0
        for symbol in missing_symbols:
            if buy_count < sell_count:
                action = "buy"
            elif sell_count < buy_count:
                action = "sell"
            else:
                action = first_action if balanced_seed_index % 2 == 0 else second_action
                balanced_seed_index += 1
            actions[symbol] = action
            if action == "buy":
                buy_count += 1
            else:
                sell_count += 1

    default_action = _target_probe_action(target)
    return {
        symbol: actions.get(symbol, default_action) for symbol in normalized_symbols
    }


def _target_probe_symbol_quantities(
    target: Mapping[str, Any],
    symbols: Sequence[str],
) -> dict[str, Decimal]:
    normalized_symbols = [
        symbol.strip().upper() for symbol in symbols if symbol.strip()
    ]
    quantities: dict[str, Decimal] = {}
    for field in (
        "paper_route_probe_symbol_quantities",
        "target_symbol_quantities",
        "symbol_quantities",
    ):
        raw_quantities = target.get(field)
        if not isinstance(raw_quantities, Mapping):
            continue
        for raw_symbol, raw_quantity in cast(
            Mapping[object, object], raw_quantities
        ).items():
            symbol = str(raw_symbol).strip().upper()
            quantity = _optional_decimal(raw_quantity)
            if symbol in normalized_symbols and quantity is not None and quantity > 0:
                quantities.setdefault(symbol, quantity)
    fallback_quantity = _optional_decimal(
        target.get("paper_route_probe_target_quantity")
    ) or _optional_decimal(target.get("target_quantity"))
    if fallback_quantity is not None and fallback_quantity > 0:
        for symbol in normalized_symbols:
            quantities.setdefault(symbol, fallback_quantity)
    return quantities


@dataclass(frozen=True)
class _TargetProbeQuantityResolution:
    qty: Decimal
    audit: dict[str, Any]
    price_params: dict[str, Any]


def _target_probe_symbol_notional_budget(
    *,
    target: Mapping[str, Any],
    symbol: str,
    symbols: Sequence[str],
    symbol_quantities: Mapping[str, Decimal],
    max_notional: Decimal,
) -> Decimal | None:
    target_notional = _target_probe_cap(target) or max_notional
    if target_notional <= 0 or max_notional <= 0:
        return None
    budget = min(target_notional, max_notional)
    normalized_symbols = [item.strip().upper() for item in symbols if item.strip()]
    if symbol not in normalized_symbols:
        return None
    weights = {
        item: symbol_quantities[item]
        for item in normalized_symbols
        if symbol_quantities.get(item, Decimal("0")) > 0
    }
    if weights:
        total_weight = sum(weights.values(), Decimal("0"))
        if total_weight > 0:
            return budget * (weights.get(symbol, Decimal("0")) / total_weight)
    return budget / Decimal(len(normalized_symbols))


def _quote_snapshot_reference_price(
    snapshot: Mapping[str, Any],
    *,
    action: Literal["buy", "sell"],
) -> Decimal | None:
    bid = _decimal_from_mapping(snapshot, ("bid", "bid_px", "bid_price", "bp"))
    ask = _decimal_from_mapping(snapshot, ("ask", "ask_px", "ask_price", "ap"))
    price = _decimal_from_mapping(snapshot, ("price", "mid", "mid_price", "midpoint"))
    if action == "buy" and ask is not None and ask > 0:
        return ask
    if action == "sell" and bid is not None and bid > 0:
        return bid
    if bid is not None and ask is not None and bid > 0 and ask >= bid:
        return (bid + ask) / Decimal("2")
    if price is not None and price > 0:
        return price
    return None


def _target_pair_balance_state(
    target: Mapping[str, Any],
    symbol_actions: Mapping[str, Literal["buy", "sell"]],
) -> str:
    if not _target_requires_balanced_pair_legs(target):
        return "not_required"
    buy_count = sum(1 for action in symbol_actions.values() if action == "buy")
    sell_count = sum(1 for action in symbol_actions.values() if action == "sell")
    if buy_count > 0 and buy_count == sell_count:
        return "balanced"
    return "imbalanced"


def _target_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _target_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _lineage_text_values(value: object) -> list[str]:
    raw_items: Sequence[object]
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = cast(Sequence[object], value)
    else:
        raw_items = (value,)

    values: list[str] = []
    for raw_item in raw_items:
        text = _safe_text(raw_item)
        if text and text not in values:
            values.append(text)
    return values


def _merge_unique_texts(target: list[str], values: Sequence[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)


def _single_lineage_text(value: object) -> str | None:
    values = _lineage_text_values(value)
    if len(values) != 1:
        return None
    return values[0]


def _paper_route_probe_lineage_from_params(params: Mapping[str, Any]) -> dict[str, Any]:
    payloads: list[Mapping[str, Any]] = [params]
    for key in (
        "paper_route_probe",
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "paper_route_probe_exit",
        "strategy_signal_paper",
    ):
        value = params.get(key)
        if isinstance(value, Mapping):
            payloads.append(cast(Mapping[str, Any], value))

    candidate_ids: list[str] = []
    hypothesis_ids: list[str] = []
    strategy_names: list[str] = []
    lineage_targets: list[dict[str, str]] = []
    lineage_target_keys: set[tuple[str | None, str | None, str | None]] = set()
    source_decision_mode = _safe_text(params.get("source_decision_mode"))
    profit_proof_eligible = _target_bool(params.get("profit_proof_eligible"))
    fallback_source_decision_modes: list[str] = []
    fallback_profit_proof_values: list[bool] = []
    collection_lineage: dict[str, Any] = {}
    for payload in payloads:
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("candidate_id"))
        )
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("source_candidate_id"))
        )
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("source_candidate_ids"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("hypothesis_id"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("source_hypothesis_id"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("source_hypothesis_ids"))
        )
        _merge_unique_texts(
            strategy_names, _lineage_text_values(payload.get("runtime_strategy_name"))
        )
        _merge_unique_texts(
            strategy_names, _lineage_text_values(payload.get("source_strategy_name"))
        )
        _merge_unique_texts(
            strategy_names, _lineage_text_values(payload.get("source_strategy_names"))
        )
        if payload is not params:
            if mode := _safe_text(payload.get("source_decision_mode")):
                fallback_source_decision_modes.append(mode)
            if (
                eligible := _target_bool(payload.get("profit_proof_eligible"))
            ) is not None:
                fallback_profit_proof_values.append(eligible)
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
            if key not in collection_lineage and (
                value := _safe_text(payload.get(key))
            ):
                collection_lineage[key] = value
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS:
            value = _target_bool(payload.get(key))
            if key not in collection_lineage and value is not None:
                collection_lineage[key] = value
        if "paper_route_probe_symbols" not in collection_lineage:
            symbols = _lineage_text_values(payload.get("paper_route_probe_symbols"))
            if symbols:
                collection_lineage["paper_route_probe_symbols"] = symbols
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS:
            value = payload.get(key)
            if key not in collection_lineage and isinstance(value, Mapping):
                collection_lineage[key] = dict(cast(Mapping[str, Any], value))

        raw_targets = payload.get("paper_route_probe_lineage_targets")
        if isinstance(raw_targets, Sequence) and not isinstance(
            raw_targets, (str, bytes, bytearray)
        ):
            for raw_target in cast(Sequence[object], raw_targets):
                if not isinstance(raw_target, Mapping):
                    continue
                lineage_target = _lineage_target_from_mapping(
                    cast(Mapping[str, object], raw_target)
                )
                if not lineage_target:
                    continue
                lineage_key = _lineage_target_key(lineage_target)
                if lineage_key not in lineage_target_keys:
                    lineage_target_keys.add(lineage_key)
                    lineage_targets.append(lineage_target)

    lineage: dict[str, Any] = {}
    if candidate_ids:
        lineage["source_candidate_ids"] = candidate_ids
    single_candidate_id = _single_lineage_text(candidate_ids)
    if single_candidate_id is not None:
        lineage["candidate_id"] = single_candidate_id
    if hypothesis_ids:
        lineage["source_hypothesis_ids"] = hypothesis_ids
    single_hypothesis_id = _single_lineage_text(hypothesis_ids)
    if single_hypothesis_id is not None:
        lineage["hypothesis_id"] = single_hypothesis_id
    if strategy_names:
        lineage["source_strategy_names"] = strategy_names
    single_strategy_name = _single_lineage_text(strategy_names)
    if single_strategy_name is not None:
        lineage.setdefault("runtime_strategy_name", single_strategy_name)
    if lineage_targets:
        lineage["paper_route_probe_lineage_targets"] = lineage_targets
    if source_decision_mode:
        lineage["source_decision_mode"] = source_decision_mode
    else:
        unique_modes = list(dict.fromkeys(fallback_source_decision_modes))
        if len(unique_modes) == 1:
            lineage["source_decision_mode"] = unique_modes[0]
    if profit_proof_eligible is not None:
        lineage["profit_proof_eligible"] = profit_proof_eligible
    elif fallback_profit_proof_values:
        lineage["profit_proof_eligible"] = all(fallback_profit_proof_values)
    lineage.update(collection_lineage)
    return lineage


def _paper_route_probe_entry_metadata(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    metadata = params.get("paper_route_probe")
    if not isinstance(metadata, Mapping):
        return None

    source_decision_mode = normalize_source_decision_mode(
        params.get("source_decision_mode")
    )
    if source_decision_mode == STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE:
        return None
    if _target_bool(params.get("profit_proof_eligible")) is True:
        return None

    probe_metadata = cast(Mapping[str, Any], metadata)
    probe_source_decision_mode = normalize_source_decision_mode(
        probe_metadata.get("source_decision_mode")
    )
    if (
        probe_source_decision_mode is not None
        and probe_source_decision_mode != ROUTE_ACQUISITION_SOURCE_DECISION_MODE
    ):
        return None
    if _target_bool(probe_metadata.get("profit_proof_eligible")) is True:
        return None
    return probe_metadata


def _target_notional_sizing_audit_from_params(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    direct = _mapping_value(params.get("paper_route_target_notional_sizing"))
    if (
        direct is not None
        and _safe_text(direct.get("sizing_source")) == "target_notional"
    ):
        return direct
    for key in (
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "paper_route_probe",
        "simple_lane",
    ):
        metadata = _mapping_value(params.get(key))
        if metadata is None:
            continue
        audit = _mapping_value(metadata.get("paper_route_target_notional_sizing"))
        if (
            audit is not None
            and _safe_text(audit.get("sizing_source")) == "target_notional"
        ):
            return audit
    return None


def _bounded_collection_decision_requires_target_notional_sizing(
    params: Mapping[str, Any],
) -> bool:
    source_decision_mode = normalize_source_decision_mode(
        params.get("source_decision_mode")
    )
    return (
        source_decision_mode == BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        and _target_bool(params.get("profit_proof_eligible")) is True
    )


def _bounded_paper_route_collection_entry_metadata(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    for key in (
        "paper_route_probe",
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
    ):
        metadata = params.get(key)
        if not isinstance(metadata, Mapping):
            continue
        probe_metadata = cast(Mapping[str, Any], metadata)
        source_decision_mode = normalize_source_decision_mode(
            params.get("source_decision_mode")
        ) or normalize_source_decision_mode(probe_metadata.get("source_decision_mode"))
        if source_decision_mode != BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE:
            continue
        if not (
            _target_bool(params.get("profit_proof_eligible")) is True
            or _target_bool(probe_metadata.get("profit_proof_eligible")) is True
        ):
            continue
        return probe_metadata
    return None


def _strategy_signal_paper_entry_metadata(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    source_decision_mode = normalize_source_decision_mode(
        params.get("source_decision_mode")
    )
    if source_decision_mode != STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE:
        return None
    if _target_bool(params.get("profit_proof_eligible")) is not True:
        return None

    metadata = params.get("strategy_signal_paper")
    if not isinstance(metadata, Mapping):
        return None
    metadata_mapping = cast(Mapping[str, Any], metadata)
    metadata_mode = normalize_source_decision_mode(
        metadata_mapping.get("source_decision_mode") or metadata_mapping.get("mode")
    )
    if metadata_mode not in {None, STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE}:
        return None
    if _target_bool(metadata_mapping.get("profit_proof_eligible")) is False:
        return None
    return metadata_mapping


def _lineage_target_from_mapping(raw_target: Mapping[str, object]) -> dict[str, str]:
    return {
        key: value
        for key, value in {
            "candidate_id": _safe_text(raw_target.get("candidate_id")),
            "hypothesis_id": _safe_text(raw_target.get("hypothesis_id")),
            "strategy_name": _safe_text(raw_target.get("strategy_name")),
        }.items()
        if value
    }


def _lineage_target_key(
    lineage_target: Mapping[str, str],
) -> tuple[str | None, str | None, str | None]:
    return (
        lineage_target.get("candidate_id"),
        lineage_target.get("hypothesis_id"),
        lineage_target.get("strategy_name"),
    )


def _merge_paper_route_probe_lineage(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
    for key in (
        "source_candidate_ids",
        "source_hypothesis_ids",
        "source_strategy_names",
    ):
        values = _lineage_text_values(lineage.get(key))
        if not values:
            continue
        current = target.setdefault(key, [])
        if isinstance(current, list):
            _merge_unique_texts(cast(list[str], current), values)

    identity_fallbacks = {
        "candidate_id": "source_candidate_ids",
        "hypothesis_id": "source_hypothesis_ids",
        "runtime_strategy_name": "source_strategy_names",
    }
    for key, source_key in identity_fallbacks.items():
        if _safe_text(target.get(key)) is not None:
            continue
        value = _safe_text(lineage.get(key)) or _single_lineage_text(
            lineage.get(source_key)
        )
        if value is not None:
            target[key] = value

    for key in ("source_decision_mode", "profit_proof_eligible"):
        if key in lineage and key not in target:
            target[key] = lineage[key]
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
        value = _safe_text(lineage.get(key))
        if value is not None and key not in target:
            target[key] = value
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS:
        value = _target_bool(lineage.get(key))
        if value is not None and key not in target:
            target[key] = value
    symbols = _lineage_text_values(lineage.get("paper_route_probe_symbols"))
    if symbols and "paper_route_probe_symbols" not in target:
        target["paper_route_probe_symbols"] = symbols
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS:
        value = lineage.get(key)
        if key not in target and isinstance(value, Mapping):
            target[key] = dict(cast(Mapping[str, Any], value))

    raw_targets = lineage.get("paper_route_probe_lineage_targets")
    if not isinstance(raw_targets, Sequence) or isinstance(
        raw_targets, (str, bytes, bytearray)
    ):
        return
    current_targets = target.setdefault("paper_route_probe_lineage_targets", [])
    if not isinstance(current_targets, list):
        return
    typed_current_targets = cast(list[object], current_targets)
    existing_keys: set[tuple[str | None, str | None, str | None]] = set()
    for item in typed_current_targets:
        if isinstance(item, Mapping):
            existing_keys.add(_lineage_target_key(cast(Mapping[str, str], item)))
    for raw_target in cast(Sequence[object], raw_targets):
        if not isinstance(raw_target, Mapping):
            continue
        lineage_target = _lineage_target_from_mapping(
            cast(Mapping[str, object], raw_target)
        )
        lineage_key = _lineage_target_key(lineage_target)
        if lineage_target and lineage_key not in existing_keys:
            existing_keys.add(lineage_key)
            typed_current_targets.append(lineage_target)


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _first_decimal(*values: Decimal | None) -> Decimal | None:
    for value in values:
        if value is not None:
            return value
    return None


def _executable_bid_ask_present(payload: Mapping[str, Any]) -> bool:
    bid = _first_decimal(
        _optional_decimal(payload.get("imbalance_bid_px")),
        _optional_decimal(payload.get("bid")),
    )
    ask = _first_decimal(
        _optional_decimal(payload.get("imbalance_ask_px")),
        _optional_decimal(payload.get("ask")),
    )
    if bid is None or ask is None:
        return False
    return bid > 0 and ask >= bid


def _min_optional_decimal(*values: Decimal | None) -> Decimal | None:
    candidates = [value for value in values if value is not None and value >= 0]
    if not candidates:
        return None
    return min(candidates)


def _simple_drift_feature_thresholds() -> FeatureQualityThresholds:
    return FeatureQualityThresholds(
        max_required_null_rate=settings.trading_drift_max_required_null_rate,
        max_staleness_ms=settings.trading_drift_max_staleness_ms_p95,
        max_duplicate_ratio=settings.trading_drift_max_duplicate_ratio,
    )


def _simple_drift_thresholds() -> DriftThresholds:
    return DriftThresholds(
        max_required_null_rate=Decimal(
            str(settings.trading_drift_max_required_null_rate)
        ),
        max_staleness_ms_p95=max(0, int(settings.trading_drift_max_staleness_ms_p95)),
        max_duplicate_ratio=Decimal(str(settings.trading_drift_max_duplicate_ratio)),
        max_schema_mismatch_total=max(
            0, int(settings.trading_drift_max_schema_mismatch_total)
        ),
        max_model_calibration_error=Decimal(
            str(settings.trading_drift_max_model_calibration_error)
        ),
        max_model_llm_error_ratio=Decimal(
            str(settings.trading_drift_max_model_llm_error_ratio)
        ),
        min_performance_net_pnl=Decimal(
            str(settings.trading_drift_min_performance_net_pnl)
        ),
        max_performance_drawdown=Decimal(
            str(settings.trading_drift_max_performance_drawdown)
        ),
        max_performance_cost_bps=Decimal(
            str(settings.trading_drift_max_performance_cost_bps)
        ),
        max_execution_fallback_ratio=Decimal(
            str(settings.trading_drift_max_execution_fallback_ratio)
        ),
    )


def _pct_cap_to_notional(
    *, equity: Decimal | None, pct: Decimal | None
) -> Decimal | None:
    if equity is None or equity <= 0 or pct is None or pct <= 0:
        return None
    return equity * pct


def _simple_decision_notional(decision: StrategyDecision) -> Decimal | None:
    simple_lane = decision.params.get("simple_lane")
    if isinstance(simple_lane, Mapping):
        simple_lane_payload = cast(Mapping[str, Any], simple_lane)
        notional = _optional_decimal(simple_lane_payload.get("notional"))
        if notional is not None:
            return notional
    price = _optional_decimal(decision.params.get("price"))
    if price is None:
        return None
    return price * decision.qty


def _simple_buying_power_consumption(
    *,
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
    notional: Decimal,
) -> Decimal:
    action = decision.action.strip().lower()
    if action == "buy":
        return notional
    if action != "sell" or decision.qty <= 0:
        return Decimal("0")
    current_qty = position_qty_for_symbol(positions, decision.symbol)
    if current_qty >= decision.qty:
        return Decimal("0")
    short_increasing_qty = (
        decision.qty if current_qty <= 0 else decision.qty - current_qty
    )
    return notional * (short_increasing_qty / decision.qty)
