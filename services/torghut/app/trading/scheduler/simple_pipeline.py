"""Simplified trading pipeline with a minimal direct-submit hot path."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, cast
from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import desc, select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Execution,
    PositionSnapshot,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ...strategies.catalog import extract_catalog_metadata
from ..autonomy import DriftThresholds, detect_drift
from ..empirical_jobs import build_empirical_jobs_status
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..firewall import OrderFirewallBlocked
from ..ingest import SignalBatch
from ..models import SignalEnvelope, StrategyDecision
from ..paper_route_target_plan import (
    fetch_paper_route_target_plan_url,
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ..prices import MarketSnapshot
from ..quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    assess_signal_quote_quality,
)
from ..proof_floor import build_profitability_proof_floor_receipt
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_strategy_resolution import strategy_names_from_strategy_id
from ..session_context import regular_session_open_utc_for
from ..simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
from ..submission_council import (
    build_hypothesis_runtime_summary,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..tca import build_tca_gate_inputs
from ..time_source import trading_now
from .pipeline import TradingPipeline
from .pipeline_helpers import (
    _extract_json_error_payload,
    _price_snapshot_payload,
)

logger = logging.getLogger(__name__)

_SIMPLE_ALLOWED_REJECT_REASONS = {
    "kill_switch_enabled",
    "invalid_qty_increment",
    "qty_below_min_after_clamp",
    "insufficient_buying_power",
    "max_notional_exceeded",
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


def _target_symbols(target: Mapping[str, Any]) -> set[str]:
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


def _target_requires_bounded_sim_collection_gate(target: Mapping[str, Any]) -> bool:
    hypothesis_id = _safe_text(target.get("hypothesis_id"))
    candidate_id = _safe_text(target.get("candidate_id"))
    account_label = _safe_text(target.get("account_label"))
    family_tokens = _target_strategy_family_tokens(target)
    return (
        hypothesis_id == "H-PAIRS-01"
        or candidate_id == "c88421d619759b2cfaa6f4d0"
        or account_label == _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL
        or any("microbar_cross_sectional_pairs" in token for token in family_tokens)
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
        exit_minute = SimpleTradingPipeline._paper_route_probe_exit_minute_value(
            target.get(key)
        )
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


class SimpleTradingPipeline(TradingPipeline):
    """Minimal signal -> hard-risk -> direct execution lane."""

    _paper_route_target_plan_cache: (
        tuple[
            set[str],
            str | None,
            list[dict[str, Any]],
            datetime,
        ]
        | None
    ) = None
    _paper_route_target_plan_success_cache: (
        tuple[
            set[str],
            list[dict[str, Any]],
            datetime,
        ]
        | None
    ) = None

    def run_once(self) -> None:
        self._label_mature_rejected_signal_outcome_events()
        with self.session_factory() as session:
            self.state.metrics.planned_decision_age_seconds = 0
            strategies = self._prepare_run_once(session)
            if not strategies:
                return
            self._capture_runtime_window_account_snapshot_if_due(session)
            self._warm_session_context_from_open(session, strategies=strategies)

            signal_scope = self._bounded_paper_route_signal_scope(
                strategies,
                session=session,
            )
            batch = self._fetch_signal_batch(session, signal_scope=signal_scope)
            self._record_ingest_window(batch)
            if self._signal_ingest_unavailable(batch):
                self._prepare_batch_for_decisions(
                    session,
                    batch,
                    quality_signals=[],
                )
                self._record_bounded_signal_ingest_blocker(
                    batch=batch,
                    signal_scope=signal_scope,
                )
                return
            if not batch.signals:
                self._prepare_batch_for_decisions(
                    session,
                    batch,
                    quality_signals=batch.signals,
                )
                context = self._build_run_context(session)
                if context is None:
                    return
                _account_snapshot, account, positions, allowed_symbols = context
                self._process_paper_route_probe_exit_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                self._process_paper_route_materialized_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                self._process_paper_route_probe_retry_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                self._process_paper_route_target_source_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                return
            context = self._build_run_context(session)
            if context is None:
                self.ingestor.commit_cursor(session, batch)
                return
            account_snapshot, account, positions, allowed_symbols = context
            self._process_paper_route_probe_exit_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._process_paper_route_materialized_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._process_paper_route_target_source_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            if self._paper_route_target_plan_reserves_account(
                allowed_symbols=allowed_symbols
            ):
                logger.info(
                    "Skipping regular simple-lane signal processing while bounded "
                    "paper-route evidence collection owns account=%s",
                    self.account_label,
                )
                self.ingestor.commit_cursor(session, batch)
                return
            quality_signals = self._quality_gate_signals(
                signals=batch.signals,
                strategies=strategies,
                allowed_symbols=allowed_symbols,
            )
            if not self._prepare_batch_for_decisions(
                session,
                batch,
                quality_signals=quality_signals,
            ):
                return
            self._process_batch_signals(
                session=session,
                batch=batch,
                strategies=strategies,
                account_snapshot=account_snapshot,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._process_paper_route_probe_retry_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self.ingestor.commit_cursor(session, batch)

    def _fetch_signal_batch(
        self,
        session: Session,
        *,
        signal_scope: tuple[set[str], set[str]] | None,
    ) -> SignalBatch:
        if signal_scope is None:
            return self.ingestor.fetch_signals(session)
        symbols, timeframes = signal_scope
        try:
            return self.ingestor.fetch_signals(
                session,
                symbols=symbols,
                timeframes=timeframes,
            )
        except TypeError as exc:
            if "unexpected keyword" not in str(exc):
                raise
            logger.warning(
                "Signal ingestor does not support scoped polling; falling back to unscoped fetch account_label=%s symbols=%s timeframes=%s",
                self.account_label,
                ",".join(sorted(symbols)) or "*",
                ",".join(sorted(timeframes)) or "*",
            )
            return self.ingestor.fetch_signals(session)

    @staticmethod
    def _signal_ingest_unavailable(batch: SignalBatch) -> bool:
        return (
            batch.no_signal_reason in _SIGNAL_INGEST_UNAVAILABLE_REASONS
            or not batch.signals_authoritative
        )

    def _record_bounded_signal_ingest_blocker(
        self,
        *,
        batch: SignalBatch,
        signal_scope: tuple[set[str], set[str]] | None,
    ) -> None:
        reason = batch.no_signal_reason or "signal_ingest_unavailable"
        symbols: set[str] = set()
        timeframes: set[str] = set()
        if signal_scope is not None:
            symbols, timeframes = signal_scope
        blocker = {
            "blockers": [reason],
            "reason": reason,
            "account_label": self.account_label,
            "symbols": sorted(symbols),
            "timeframes": sorted(timeframes),
            "signals_authoritative": batch.signals_authoritative,
            "fallback_signal_count": len(batch.fallback_signals),
            "degraded_signal_source": batch.degraded_signal_source,
            "query_start": batch.query_start.isoformat()
            if batch.query_start is not None
            else None,
            "query_end": batch.query_end.isoformat()
            if batch.query_end is not None
            else None,
        }
        setattr(self.state, "last_bounded_evidence_collection_blocker", blocker)
        logger.warning(
            "Blocking bounded paper-route evidence decisions because signal ingest is unavailable account_label=%s reason=%s symbols=%s timeframes=%s fallback_signal_count=%s",
            self.account_label,
            reason,
            ",".join(sorted(symbols)) or "*",
            ",".join(sorted(timeframes)) or "*",
            len(batch.fallback_signals),
        )

    def _record_bounded_target_plan_blocker(
        self,
        *,
        reason: str,
        symbols: set[str] | None = None,
        targets: Sequence[Mapping[str, Any]] | None = None,
    ) -> None:
        normalized_reason = reason.strip() or "paper_route_target_plan_unavailable"
        blocker = {
            "blockers": [normalized_reason],
            "reason": normalized_reason,
            "account_label": self.account_label,
            "source": "external_target_plan_url",
            "target_plan_url_configured": bool(
                str(settings.trading_paper_route_target_plan_url or "").strip()
            ),
            "target_symbols": sorted(symbols or set()),
            "target_count": len(targets or []),
            "fetch_attempts": _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
        }
        setattr(self.state, "last_bounded_evidence_collection_blocker", blocker)
        logger.warning(
            "Blocking bounded paper-route evidence decisions because target plan is unavailable account_label=%s reason=%s symbols=%s target_count=%s attempts=%s",
            self.account_label,
            normalized_reason,
            ",".join(sorted(symbols or set())) or "*",
            len(targets or []),
            _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
        )

    def _bounded_paper_route_signal_scope(
        self,
        strategies: Sequence[Strategy],
        *,
        session: Session | None = None,
    ) -> tuple[set[str], set[str]] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            return None
        target_symbols, target_plan_error, targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            self._record_bounded_target_plan_blocker(
                reason=target_plan_error,
                symbols=target_symbols,
                targets=targets,
            )
            return None
        if not target_symbols:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason="paper_route_target_plan_probe_symbols_missing",
                    symbols=target_symbols,
                    targets=targets,
                )
            return None

        symbols: set[str] = set()
        timeframes: set[str] = set()
        for target in targets:
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            if not _bounded_sim_collection_reserves_account(
                target,
                account_label=self.account_label,
            ):
                continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            scoped_symbols = _target_symbols(target) & target_symbols
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if strategy_symbols:
                scoped_symbols = scoped_symbols & strategy_symbols
            symbols.update(scoped_symbols)
            timeframe = (
                _safe_text(target.get("timeframe"))
                or _safe_text(target.get("base_timeframe"))
                or _safe_text(strategy.base_timeframe)
            )
            if timeframe:
                timeframes.add(timeframe)
        if not symbols:
            return None
        return symbols, timeframes

    def _live_submission_gate(
        self,
        *,
        session: Session | None = None,
        hypothesis_summary: Mapping[str, Any] | None = None,
        empirical_jobs_status: Mapping[str, Any] | None = None,
        dspy_runtime_status: Mapping[str, Any] | None = None,
        quant_health_status: Mapping[str, Any] | None = None,
    ) -> dict[str, object]:
        gate = super()._live_submission_gate(
            session=session,
            hypothesis_summary=hypothesis_summary,
            empirical_jobs_status=empirical_jobs_status,
            dspy_runtime_status=dspy_runtime_status,
            quant_health_status=quant_health_status,
        )
        if settings.trading_mode != "live":
            return gate

        simple_blocked_reasons: list[str] = []
        if not settings.trading_enabled:
            simple_blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            simple_blocked_reasons.append("kill_switch_enabled")
        if not settings.trading_simple_submit_enabled:
            simple_blocked_reasons.append("simple_submit_disabled")
        if settings.trading_emergency_stop_enabled and bool(
            getattr(self.state, "emergency_stop_active", False)
        ):
            simple_blocked_reasons.append(
                str(
                    getattr(self.state, "emergency_stop_reason", "")
                    or "emergency_stop_active"
                )
            )

        gate_blocked_reasons = [
            str(item).strip()
            for item in cast(list[object], gate.get("blocked_reasons") or [])
            if str(item).strip()
        ]
        merged_blocked_reasons = list(
            dict.fromkeys([*gate_blocked_reasons, *simple_blocked_reasons])
        )
        gate["allowed"] = (
            bool(gate.get("allowed", False)) and not simple_blocked_reasons
        )
        gate["blocked_reasons"] = merged_blocked_reasons
        if simple_blocked_reasons:
            gate["reason"] = simple_blocked_reasons[0]
            gate["capital_stage"] = "shadow"
            gate["capital_state"] = "observe"
        gate["pipeline_mode"] = "simple"
        gate["simple_lane"] = {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": simple_blocked_reasons,
        }
        self._last_live_submission_gate = dict(gate)
        return gate

    def _prepare_run_once(self, session: Session) -> list[Strategy]:
        if settings.trading_simple_order_feed_telemetry_enabled:
            self._ingest_order_feed(session)
        self.order_firewall.cancel_open_orders_if_kill_switch()
        if self.strategy_catalog is not None:
            self.strategy_catalog.refresh(session)
        self._refresh_market_context_for_proof_floor()
        strategies = self._load_strategies(session)
        if not strategies:
            logger.info("No enabled strategies found; skipping simple trading cycle")
        return strategies

    def _prepare_batch_for_decisions(
        self,
        session: Session,
        batch: SignalBatch,
        *,
        quality_signals: list[SignalEnvelope],
    ) -> bool:
        if not super()._prepare_batch_for_decisions(
            session,
            batch,
            quality_signals=quality_signals,
        ):
            return False
        self._run_simple_drift_check(quality_signals)
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.last_signal_continuity_state = "signals_present"
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = False
        return True

    def _run_simple_drift_check(self, quality_signals: list[SignalEnvelope]) -> None:
        if not settings.trading_drift_governance_enabled or not quality_signals:
            return
        now = datetime.now(timezone.utc)
        feature_report = evaluate_feature_batch_quality(
            quality_signals,
            thresholds=_simple_drift_feature_thresholds(),
        )
        fallback_total = sum(self.state.metrics.execution_fallback_total.values())
        submitted_total = max(1, self.state.metrics.orders_submitted_total)
        detection = detect_drift(
            run_id=f"simple-runtime:{self.account_label}:{now.isoformat()}",
            feature_quality_report=feature_report,
            gate_report_payload={},
            fallback_ratio=Decimal(str(fallback_total / submitted_total)),
            thresholds=_simple_drift_thresholds(),
            detected_at=now,
        )
        self.state.metrics.drift_detection_checks_total += 1
        self.state.drift_last_detection_at = detection.detected_at
        if detection.drift_detected:
            self.state.metrics.drift_incidents_total += 1
            self.state.drift_active_incident_id = detection.incident_id
            self.state.drift_active_reason_codes = list(detection.reason_codes)
            self.state.drift_status = "drift_detected"
            self.state.drift_live_promotion_eligible = False
            self.state.drift_live_promotion_reasons = list(detection.reason_codes)
            for reason_code in detection.reason_codes:
                self.state.metrics.drift_incident_reason_total[reason_code] = (
                    self.state.metrics.drift_incident_reason_total.get(reason_code, 0)
                    + 1
                )
        else:
            self.state.drift_active_incident_id = None
            self.state.drift_active_reason_codes = []
            self.state.drift_status = "stable"
            self.state.drift_live_promotion_eligible = True
            self.state.drift_live_promotion_reasons = []

    def _process_batch_signals(
        self,
        *,
        session: Session,
        batch: SignalBatch,
        strategies: list[Strategy],
        account_snapshot: Any,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        filtered_signals = self._quality_gate_signals(
            signals=batch.signals,
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        for signal in filtered_signals:
            decisions = self._evaluate_signal_decisions(
                signal,
                strategies,
                equity=account_snapshot.equity,
                positions=positions,
            )
            if not decisions:
                continue
            for decision in decisions:
                self.state.metrics.decisions_total += 1
                try:
                    submitted = self._handle_decision(
                        session,
                        decision,
                        strategies,
                        account,
                        positions,
                        allowed_symbols,
                    )
                    if submitted is not None:
                        self._apply_simple_projected_buying_power(
                            account,
                            positions,
                            submitted,
                        )
                        self._apply_simple_projected_position(positions, submitted)
                except Exception:
                    logger.exception(
                        "Simple decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                        decision.strategy_id,
                        decision.symbol,
                        decision.timeframe,
                    )
                    self.state.metrics.orders_rejected_total += 1
                    self.state.metrics.record_decision_rejection_reasons(
                        ["broker_submit_failed"]
                    )

    @staticmethod
    def _trade_decision_from_retry_row(
        decision_row: TradeDecision,
    ) -> StrategyDecision | None:
        decision_json = decision_row.decision_json
        if not isinstance(decision_json, Mapping):
            return None
        decision_payload = cast(Mapping[str, Any], decision_json)
        if (
            str(decision_payload.get("schema_version") or "").strip()
            == _FLATTEN_CLOSE_DECISION_SCHEMA_VERSION
            or str(decision_payload.get("flatten_lineage_role") or "").strip()
            == "close"
        ):
            return None
        try:
            return StrategyDecision.model_validate(decision_payload)
        except Exception:
            logger.warning(
                "Skipping paper route probe retry with invalid decision payload decision_id=%s",
                decision_row.id,
                exc_info=True,
            )
            return None

    @staticmethod
    def _paper_route_probe_exit_metadata(
        decision: StrategyDecision,
    ) -> Mapping[str, Any] | None:
        metadata = decision.params.get("paper_route_probe_exit")
        if not isinstance(metadata, Mapping):
            return None
        metadata_mapping = cast(Mapping[str, Any], metadata)
        mode = str(metadata_mapping.get("mode") or "").strip()
        if mode != "paper_route_exit":
            return None
        return metadata_mapping

    def _paper_route_probe_retry_session_open(self) -> datetime:
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        return regular_session_open_utc_for(now)

    @staticmethod
    def _paper_route_probe_strategy(
        *,
        session: Session,
        decision: StrategyDecision,
    ) -> Strategy | None:
        try:
            strategy_id = UUID(decision.strategy_id)
        except (TypeError, ValueError):
            return None
        return session.get(Strategy, strategy_id)

    @staticmethod
    def _paper_route_probe_exit_minute_value(raw_value: object) -> int | None:
        if raw_value is None:
            return None
        if isinstance(raw_value, str):
            text = raw_value.strip().lower()
            if not text:
                return None
            if text == "close":
                return _REGULAR_SESSION_MINUTES
            try:
                return max(0, int(Decimal(text)))
            except Exception:
                return None
        try:
            return max(0, int(cast(Any, raw_value)))
        except (TypeError, ValueError, ArithmeticError):
            return None

    @staticmethod
    def _paper_route_probe_exit_minute_after_open(
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> int | None:
        direct_exit_minute = SimpleTradingPipeline._paper_route_probe_exit_minute_value(
            decision.params.get("exit_minute_after_open")
        )
        if direct_exit_minute is not None:
            return direct_exit_minute
        probe_metadata = decision.params.get("paper_route_probe")
        if isinstance(probe_metadata, Mapping):
            probe_mapping = cast(Mapping[str, object], probe_metadata)
            for key in (
                "exit_minute_after_open",
                "effective_exit_minute_after_open",
            ):
                metadata_exit_minute = (
                    SimpleTradingPipeline._paper_route_probe_exit_minute_value(
                        probe_mapping.get(key)
                    )
                )
                if metadata_exit_minute is not None:
                    return metadata_exit_minute
        for params_key in (
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "strategy_signal_paper",
        ):
            target_metadata = decision.params.get(params_key)
            if not isinstance(target_metadata, Mapping):
                continue
            target_mapping = cast(Mapping[str, object], target_metadata)
            for key in (
                "exit_minute_after_open",
                "effective_exit_minute_after_open",
            ):
                metadata_exit_minute = (
                    SimpleTradingPipeline._paper_route_probe_exit_minute_value(
                        target_mapping.get(key)
                    )
                )
                if metadata_exit_minute is not None:
                    return metadata_exit_minute
        if strategy is None:
            return None
        metadata = extract_catalog_metadata(strategy.description)
        metadata_params = metadata.get("params")
        if not isinstance(metadata_params, Mapping):
            return None
        params = cast(Mapping[str, object], metadata_params)
        return SimpleTradingPipeline._paper_route_probe_exit_minute_value(
            params.get("exit_minute_after_open")
        )

    @staticmethod
    def _paper_route_probe_session_open(value: datetime) -> datetime:
        ts = (
            value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        ).astimezone(timezone.utc)
        return regular_session_open_utc_for(ts)

    @staticmethod
    def _paper_route_probe_exit_session_open(
        *,
        decision: StrategyDecision,
        fallback: datetime,
    ) -> datetime:
        metadata = SimpleTradingPipeline._paper_route_probe_exit_metadata(decision)
        if metadata is not None:
            raw_session_open = metadata.get("session_open")
            if isinstance(raw_session_open, datetime):
                return SimpleTradingPipeline._paper_route_probe_session_open(
                    raw_session_open
                )
            raw_text = str(raw_session_open or "").strip()
            if raw_text:
                try:
                    parsed = datetime.fromisoformat(raw_text.replace("Z", "+00:00"))
                    return SimpleTradingPipeline._paper_route_probe_session_open(parsed)
                except ValueError:
                    pass
        return SimpleTradingPipeline._paper_route_probe_session_open(fallback)

    def _paper_route_probe_entry_after_exit_minute(
        self,
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> bool:
        if decision.action not in {"buy", "sell"}:
            return False
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        if exit_minute is None:
            return False
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        session_open = regular_session_open_utc_for(now)
        minutes_elapsed = int((now - session_open).total_seconds() // 60)
        return minutes_elapsed >= exit_minute

    def _created_in_current_regular_session(
        self,
        decision_row: TradeDecision,
        decision: StrategyDecision,
        *,
        session_open: datetime,
    ) -> bool:
        for raw_ts in (decision.event_ts, decision_row.created_at):
            ts = (
                raw_ts
                if raw_ts.tzinfo is not None
                else raw_ts.replace(tzinfo=timezone.utc)
            )
            if ts.astimezone(timezone.utc) >= session_open:
                return True
        return False

    def _paper_route_probe_retry_decisions(
        self,
        *,
        session: Session,
    ) -> list[StrategyDecision]:
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        batch_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_batch_limit),
            0,
        )
        scan_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_scan_limit),
            0,
        )
        if batch_limit <= 0 or scan_limit <= 0:
            return []

        session_open = self._paper_route_probe_retry_session_open()
        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.status.in_(("blocked", "rejected")),
                    TradeDecision.alpaca_account_label == self.account_label,
                )
                .order_by(TradeDecision.created_at.desc())
                .limit(scan_limit)
            )
            .scalars()
            .all()
        )
        decisions: list[StrategyDecision] = []
        for decision_row in rows:
            if len(decisions) >= batch_limit:
                break
            if (
                self._paper_route_probe_retry_metadata(decision_row) is None
                and self._paper_route_quote_routeability_retry_metadata(decision_row)
                is None
            ):
                continue
            if self.executor.execution_exists(session, decision_row):
                continue
            decision = self._trade_decision_from_retry_row(decision_row)
            if decision is None:
                continue
            if not self._created_in_current_regular_session(
                decision_row,
                decision,
                session_open=session_open,
            ):
                continue
            strategy = self._paper_route_probe_strategy(
                session=session,
                decision=decision,
            )
            if self._paper_route_probe_entry_after_exit_minute(
                decision=decision,
                strategy=strategy,
            ):
                logger.warning(
                    "Skipping stale paper route probe entry retry after strategy exit minute strategy_id=%s symbol=%s",
                    decision.strategy_id,
                    decision.symbol,
                )
                continue
            decisions.append(decision)
        return decisions

    def _paper_route_probe_exit_decisions(
        self,
        *,
        session: Session,
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            self._record_bounded_target_plan_blocker(
                reason="paper_route_session_window_not_open"
            )
            return []

        session_open = regular_session_open_utc_for(now)
        exit_lookback_hours = max(
            0,
            _safe_int(settings.trading_simple_paper_route_probe_exit_lookback_hours),
        )
        lookback_start = (
            now - timedelta(hours=exit_lookback_hours)
            if exit_lookback_hours > 0
            else session_open
        )
        rows = session.execute(
            select(Execution, TradeDecision)
            .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
            .where(
                Execution.alpaca_account_label == self.account_label,
                TradeDecision.alpaca_account_label == self.account_label,
                Execution.status == "filled",
                Execution.filled_qty > Decimal("0"),
                Execution.created_at >= lookback_start,
            )
            .order_by(Execution.created_at.asc())
        ).all()
        exposures: dict[tuple[str, str, str], dict[str, Any]] = {}
        for execution, decision_row in rows:
            decision = self._trade_decision_from_retry_row(decision_row)
            if decision is None:
                continue
            decision_json = decision_row.decision_json
            if not isinstance(decision_json, Mapping):
                continue
            params = decision.params
            probe_entry_metadata = _paper_route_probe_entry_metadata(params)
            bounded_collection_entry_metadata = (
                _bounded_paper_route_collection_entry_metadata(params)
            )
            strategy_signal_entry_metadata = _strategy_signal_paper_entry_metadata(
                params
            )
            is_entry = (
                probe_entry_metadata is not None
                or bounded_collection_entry_metadata is not None
                or strategy_signal_entry_metadata is not None
            )
            is_exit = isinstance(params.get("paper_route_probe_exit"), Mapping)
            if not is_entry and not is_exit:
                continue
            side = str(execution.side or "").strip().lower()
            if side not in {"buy", "sell"}:
                continue
            filled_qty = _optional_decimal(execution.filled_qty)
            if filled_qty is None or filled_qty <= 0:
                continue
            strategy = session.get(Strategy, decision_row.strategy_id)
            if strategy is None:
                continue
            symbol = str(execution.symbol or decision_row.symbol or "").strip().upper()
            if not symbol:
                continue

            entry_session_open = (
                self._paper_route_probe_session_open(decision.event_ts)
                if is_entry
                else self._paper_route_probe_exit_session_open(
                    decision=decision,
                    fallback=decision.event_ts,
                )
            )
            key = (str(strategy.id), symbol, entry_session_open.isoformat())
            exposure = exposures.setdefault(
                key,
                {
                    "strategy": strategy,
                    "symbol": symbol,
                    "timeframe": decision.timeframe,
                    "session_open": entry_session_open,
                    "net_qty": Decimal("0"),
                    "buy_qty": Decimal("0"),
                    "buy_notional": Decimal("0"),
                    "sell_qty": Decimal("0"),
                    "sell_notional": Decimal("0"),
                    "latest_entry_at": None,
                    "exit_minute_after_open": None,
                    "exit_source": None,
                    "paper_route_probe_lineage": {},
                },
            )
            if strategy_signal_entry_metadata is not None:
                exposure["exit_source"] = "filled_strategy_signal_paper_executions"
            elif bounded_collection_entry_metadata is not None:
                exposure["exit_source"] = (
                    "filled_bounded_paper_route_collection_executions"
                )
            elif (
                probe_entry_metadata is not None and exposure.get("exit_source") is None
            ):
                exposure["exit_source"] = "filled_paper_route_probe_executions"
            lineage = _paper_route_probe_lineage_from_params(params)
            if lineage:
                exposure_lineage = cast(
                    dict[str, Any], exposure["paper_route_probe_lineage"]
                )
                _merge_paper_route_probe_lineage(exposure_lineage, lineage)
            signed_qty = filled_qty if side == "buy" else -filled_qty
            exposure["net_qty"] = cast(Decimal, exposure["net_qty"]) + signed_qty
            if side == "buy":
                exit_minute = self._paper_route_probe_exit_minute_after_open(
                    decision=decision,
                    strategy=strategy,
                )
                if exit_minute is not None:
                    exposure["exit_minute_after_open"] = exit_minute
                avg_fill_price = _optional_decimal(execution.avg_fill_price)
                if avg_fill_price is not None and avg_fill_price > 0:
                    exposure["buy_qty"] = (
                        cast(Decimal, exposure["buy_qty"]) + filled_qty
                    )
                    exposure["buy_notional"] = cast(
                        Decimal,
                        exposure["buy_notional"],
                    ) + (filled_qty * avg_fill_price)
            elif side == "sell":
                exit_minute = self._paper_route_probe_exit_minute_after_open(
                    decision=decision,
                    strategy=strategy,
                )
                if exit_minute is not None:
                    exposure["exit_minute_after_open"] = exit_minute
                avg_fill_price = _optional_decimal(execution.avg_fill_price)
                if avg_fill_price is not None and avg_fill_price > 0:
                    exposure["sell_qty"] = (
                        cast(Decimal, exposure["sell_qty"]) + filled_qty
                    )
                    exposure["sell_notional"] = cast(
                        Decimal,
                        exposure["sell_notional"],
                    ) + (filled_qty * avg_fill_price)
            latest_entry_at = exposure.get("latest_entry_at")
            execution_created_at = (
                execution.created_at
                if execution.created_at.tzinfo is not None
                else execution.created_at.replace(tzinfo=timezone.utc)
            ).astimezone(timezone.utc)
            if not isinstance(latest_entry_at, datetime) or (
                execution_created_at > latest_entry_at
            ):
                exposure["latest_entry_at"] = execution_created_at

        decisions: list[StrategyDecision] = []
        for exposure in exposures.values():
            net_qty = cast(Decimal, exposure["net_qty"])
            if net_qty == 0:
                continue
            raw_exit_minute = exposure.get("exit_minute_after_open")
            exit_minute = raw_exit_minute if isinstance(raw_exit_minute, int) else None
            if exit_minute is None:
                continue
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            entry_session_open = cast(datetime, exposure["session_open"])
            exit_due_at = entry_session_open + timedelta(minutes=effective_exit_minute)
            if now < exit_due_at:
                continue
            strategy = cast(Strategy, exposure["strategy"])
            symbol = str(exposure["symbol"])
            if self._paper_route_probe_exit_already_recorded(
                session=session,
                strategy=strategy,
                symbol=symbol,
                session_open=entry_session_open,
                exit_due_at=exit_due_at,
            ):
                continue
            buy_qty = cast(Decimal, exposure["buy_qty"])
            buy_notional = cast(Decimal, exposure["buy_notional"])
            sell_qty = cast(Decimal, exposure["sell_qty"])
            sell_notional = cast(Decimal, exposure["sell_notional"])
            exit_action: Literal["buy", "sell"] = "sell" if net_qty > 0 else "buy"
            exit_qty = abs(net_qty)
            avg_entry_price = None
            if net_qty > 0 and buy_qty > 0:
                avg_entry_price = buy_notional / buy_qty
            elif net_qty < 0 and sell_qty > 0:
                avg_entry_price = sell_notional / sell_qty
            exit_source = (
                _safe_text(exposure.get("exit_source"))
                or "filled_paper_route_probe_executions"
            )
            params: dict[str, Any] = {
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "source": exit_source,
                    "symbol": symbol,
                    "strategy_id": str(strategy.id),
                    "db_open_qty": str(exit_qty),
                    "db_open_signed_qty": str(net_qty),
                    "db_open_side": "long" if net_qty > 0 else "short",
                    "exit_minute_after_open": exit_minute,
                    "effective_exit_minute_after_open": effective_exit_minute,
                    "exit_due_at": exit_due_at.isoformat(),
                    "session_open": entry_session_open.isoformat(),
                    "stale_exit_repair": entry_session_open.date() < now.date(),
                    "latest_entry_at": exposure["latest_entry_at"].isoformat()
                    if isinstance(exposure.get("latest_entry_at"), datetime)
                    else None,
                    "avg_entry_price": str(avg_entry_price)
                    if avg_entry_price is not None
                    else None,
                    **cast(
                        dict[str, Any], exposure.get("paper_route_probe_lineage") or {}
                    ),
                },
                "simple_lane": {
                    "final_qty": str(exit_qty),
                    "notional": str(exit_qty * avg_entry_price)
                    if avg_entry_price is not None
                    else None,
                    "quantity_resolution": {
                        "reason": (
                            "sell_reducing_paper_route_probe_exit"
                            if exit_action == "sell"
                            else "buy_reducing_paper_route_probe_short_exit"
                        ),
                        "short_increasing": False,
                        "position_qty": str(net_qty),
                    },
                },
            }
            exit_lineage = cast(
                Mapping[str, Any], exposure.get("paper_route_probe_lineage") or {}
            )
            for key in ("source_decision_mode", "profit_proof_eligible"):
                if key in exit_lineage:
                    params[key] = exit_lineage[key]
            if avg_entry_price is not None:
                params["price"] = avg_entry_price
            exit_event_ts = now if now > exit_due_at else exit_due_at
            if exit_event_ts != exit_due_at:
                params["paper_route_probe_exit"]["retry_event_ts"] = (
                    exit_event_ts.isoformat()
                )
            decisions.append(
                StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol=symbol,
                    event_ts=exit_event_ts,
                    timeframe=str(exposure["timeframe"] or strategy.base_timeframe),
                    action=exit_action,
                    qty=exit_qty,
                    rationale="paper-route-probe-exit",
                    params=params,
                )
            )
        return decisions

    def _paper_route_probe_exit_already_recorded(
        self,
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        session_open: datetime,
        exit_due_at: datetime,
    ) -> bool:
        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.strategy_id == strategy.id,
                    TradeDecision.alpaca_account_label == self.account_label,
                    TradeDecision.symbol == symbol,
                    TradeDecision.created_at >= session_open,
                )
                .order_by(TradeDecision.created_at.desc())
            )
            .scalars()
            .all()
        )
        exit_due_at_text = exit_due_at.isoformat()
        for row in rows:
            decision = self._trade_decision_from_retry_row(row)
            if decision is None:
                continue
            metadata = self._paper_route_probe_exit_metadata(decision)
            if metadata is None:
                continue
            if str(metadata.get("exit_due_at") or "") != exit_due_at_text:
                continue
            linked_executions = (
                session.execute(
                    select(Execution)
                    .where(Execution.trade_decision_id == row.id)
                    .order_by(Execution.created_at.desc())
                )
                .scalars()
                .all()
            )
            filled_execution_recorded = any(
                _safe_text(execution.status) == "filled"
                or (_optional_decimal(execution.filled_qty) or Decimal("0"))
                > Decimal("0")
                for execution in linked_executions
            )
            if row.status in {"filled", "executed"} or filled_execution_recorded:
                return True
            if row.status in {"planned", "submitted"}:
                created_at = (
                    row.created_at
                    if row.created_at.tzinfo is not None
                    else row.created_at.replace(tzinfo=timezone.utc)
                ).astimezone(timezone.utc)
                now = trading_now(account_label=self.account_label).astimezone(
                    timezone.utc
                )
                if (
                    now - created_at
                ).total_seconds() < _PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS:
                    return True
                continue
            if row.status == "rejected":
                continue
        return False

    def _reopen_rejected_paper_route_probe_exit_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        if decision_row.status != "rejected":
            return None
        exit_metadata = self._paper_route_probe_exit_metadata(decision)
        if exit_metadata is None:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        raw_decision_json: object = decision_row.decision_json
        decision_json: dict[str, Any] = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_exit_retry_attempts")
        )
        if retry_limit > 0 and retry_attempts >= retry_limit:
            return None
        previous_stage = str(decision_json.get("submission_stage") or "rejected")
        raw_previous_risk_reasons = decision_json.get("risk_reasons")
        previous_risk_reason_items: Sequence[object] = []
        if isinstance(raw_previous_risk_reasons, Sequence) and not isinstance(
            raw_previous_risk_reasons,
            (str, bytes, bytearray),
        ):
            previous_risk_reason_items = cast(
                Sequence[object], raw_previous_risk_reasons
            )
        previous_risk_reasons = [
            str(item) for item in previous_risk_reason_items if str(item).strip()
        ]
        self.executor.sync_decision_state(session, decision_row, decision)
        raw_decision_json = decision_row.decision_json
        decision_json = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        decision_json["submission_stage"] = "paper_route_probe_exit_retry_pending"
        decision_json["paper_route_probe_exit_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_probe_exit_retry"] = {
            "previous_decision_status": "rejected",
            "previous_submission_stage": previous_stage,
            "previous_risk_reasons": previous_risk_reasons,
            "submission_stage": "paper_route_probe_exit_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "exit_due_at": str(exit_metadata.get("exit_due_at") or ""),
        }
        for key in (
            "risk_reasons",
            "reject_reason_atomic",
            "reject_class",
            "reject_origin",
            "broker_precheck",
        ):
            decision_json.pop(key, None)
        decision_row.status = "planned"
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening rejected paper route probe exit strategy_id=%s decision_id=%s symbol=%s previous_stage=%s reasons=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            previous_stage,
            ",".join(previous_risk_reasons),
        )
        return decision_row

    @staticmethod
    def _paper_route_target_price_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "rejected":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, object], decision_json_raw)
        if decision_json.get("submission_stage") != "rejected_pre_submit":
            return None
        params_raw = decision_json.get("params")
        if not isinstance(params_raw, Mapping):
            return None
        params = cast(Mapping[str, object], params_raw)
        if not isinstance(params.get("paper_route_target_plan"), Mapping):
            return None
        precheck_raw = params.get("simple_lane_precheck")
        if not isinstance(precheck_raw, Mapping):
            return None
        precheck = cast(Mapping[str, object], precheck_raw)
        if precheck.get("price") is not None:
            return None
        raw_risk_reasons = decision_json.get("risk_reasons")
        risk_reason_items: Sequence[object] = []
        if isinstance(raw_risk_reasons, Sequence) and not isinstance(
            raw_risk_reasons,
            (str, bytes, bytearray),
        ):
            risk_reason_items = cast(Sequence[object], raw_risk_reasons)
        risk_reasons = [
            str(item).strip() for item in risk_reason_items if str(item).strip()
        ]
        if "broker_precheck_failed" not in risk_reasons:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_target_price_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        return {
            "previous_decision_status": "rejected",
            "previous_submission_stage": "rejected_pre_submit",
            "previous_risk_reasons": risk_reasons,
            "previous_retry_attempts": retry_attempts,
        }

    def _reopen_rejected_paper_route_target_price_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_metadata = self._paper_route_target_price_retry_metadata(decision_row)
        if retry_metadata is None:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None

        self.executor.sync_decision_state(session, decision_row, decision)
        raw_decision_json = decision_row.decision_json
        decision_json = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        retry_attempts = _safe_int(
            decision_json.get("paper_route_target_price_retry_attempts")
        )
        decision_json["submission_stage"] = "paper_route_target_price_retry_pending"
        decision_json["paper_route_target_price_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_target_price_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_target_price_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
        }
        for key in (
            "risk_reasons",
            "reject_reason_atomic",
            "reject_class",
            "reject_origin",
            "broker_precheck",
        ):
            decision_json.pop(key, None)
        decision_row.status = "planned"
        decision_row.created_at = trading_now(account_label=self.account_label)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening paper route target source decision after transient price precheck failure strategy_id=%s decision_id=%s symbol=%s previous_reasons=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            ",".join(
                cast(list[str], retry_metadata.get("previous_risk_reasons") or [])
            ),
        )
        return decision_row

    @staticmethod
    def _restore_simulation_paper_route_probe_exit_position(
        *,
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        metadata: Mapping[str, Any],
        price: Decimal | None,
        execution_adapter: Any | None,
        trading_mode: str | None,
    ) -> Decimal | None:
        if str(trading_mode or "").strip().lower() != "paper":
            return None
        if (
            str(getattr(execution_adapter, "name", "") or "").strip().lower()
            != "simulation"
        ):
            return None
        db_open_qty = _optional_decimal(metadata.get("db_open_qty"))
        if db_open_qty is None or db_open_qty <= 0:
            return None
        open_side = str(metadata.get("db_open_side") or "long").strip().lower()
        if open_side not in {"long", "short"}:
            open_side = "long"
        seed_missing = getattr(
            execution_adapter, "seed_missing_position_snapshot", None
        )
        if not callable(seed_missing):
            return None

        restored_qty = (
            min(db_open_qty, decision.qty) if decision.qty > 0 else db_open_qty
        )
        position: dict[str, Any] = {
            "symbol": decision.symbol,
            "qty": str(restored_qty),
            "side": open_side,
        }
        if price is not None and price > 0:
            position["market_value"] = str(restored_qty * price)
        try:
            seeded = bool(seed_missing(position))
        except Exception as exc:
            logger.warning(
                "Failed to restore simulation paper route probe exit position symbol=%s error=%s",
                decision.symbol,
                exc,
            )
            return None
        if not seeded:
            return None
        positions.append(dict(position))
        return restored_qty

    @staticmethod
    def _prepare_paper_route_probe_exit_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        *,
        execution_adapter: Any | None = None,
        trading_mode: str | None = None,
    ) -> StrategyDecision | None:
        if SimpleTradingPipeline._paper_route_probe_exit_metadata(decision) is None:
            return decision
        current_qty = position_qty_for_symbol(positions, decision.symbol)
        params = dict(decision.params)
        metadata = dict(cast(Mapping[str, Any], params["paper_route_probe_exit"]))
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        quantity_resolution = dict(
            cast(Mapping[str, Any], simple_lane.get("quantity_resolution") or {})
        )
        is_short_exit = decision.action == "buy"
        effective_position_qty = abs(current_qty)
        position_missing = current_qty >= 0 if is_short_exit else current_qty <= 0
        if position_missing:
            price = _optional_decimal(params.get("price"))
            restored_qty = (
                SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                    positions=positions,
                    decision=decision,
                    metadata=metadata,
                    price=price,
                    execution_adapter=execution_adapter,
                    trading_mode=trading_mode,
                )
                if current_qty == 0
                else None
            )
            if restored_qty is None:
                return None
            metadata["broker_position_qty"] = str(current_qty)
            metadata["db_position_qty_fallback"] = True
            metadata["position_source"] = "source_execution_db_open_qty"
            current_qty = -restored_qty if is_short_exit else restored_qty
            effective_position_qty = restored_qty
        else:
            effective_position_qty = abs(current_qty)
        if effective_position_qty < decision.qty:
            decision = decision.model_copy(update={"qty": effective_position_qty})
            metadata["qty_capped_to_position"] = True
        metadata.setdefault("broker_position_qty", str(current_qty))
        metadata["effective_position_qty"] = str(effective_position_qty)

        quantity_resolution["position_qty"] = str(decision.qty)
        simple_lane["final_qty"] = str(decision.qty)
        simple_lane["quantity_resolution"] = quantity_resolution
        price = _optional_decimal(params.get("price"))
        if price is not None and price > 0:
            simple_lane["notional"] = str(decision.qty * price)
        params["paper_route_probe_exit"] = metadata
        params["simple_lane"] = simple_lane
        return decision.model_copy(update={"params": params})

    def _process_paper_route_probe_retry_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_probe_retry_decisions(session=session)
        for decision in decisions:
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Paper route probe retry handling failed strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    @staticmethod
    def _paper_route_materialized_source_payload(
        decision_row: TradeDecision,
    ) -> Mapping[str, Any] | None:
        payload = decision_row.decision_json
        if not isinstance(payload, Mapping):
            return None
        typed_payload = cast(Mapping[str, Any], payload)
        params = typed_payload.get("params")
        if not isinstance(params, Mapping):
            return None
        typed_params = cast(Mapping[str, Any], params)
        materialized = _target_truthy(
            typed_params.get("paper_route_target_plan_materialized")
        )
        if (
            not materialized
            and _safe_text(typed_payload.get("submission_stage"))
            != "bounded_paper_route_materialized"
        ):
            return None
        source = _safe_text(typed_payload.get("source")) or _safe_text(
            typed_params.get("source")
        )
        if source not in {None, "paper_route_target_plan_materializer"}:
            return None
        source_decision_mode = _safe_text(
            typed_payload.get("source_decision_mode")
        ) or _safe_text(typed_params.get("source_decision_mode"))
        if source_decision_mode != BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE:
            return None
        return typed_payload

    @staticmethod
    def _paper_route_materialized_target_from_payload(
        payload: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        params = payload.get("params")
        if not isinstance(params, Mapping):
            return None
        typed_params = cast(Mapping[str, Any], params)
        target: dict[str, Any] | None = None
        for key in (
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "paper_route_probe",
        ):
            raw_target = typed_params.get(key)
            if isinstance(raw_target, Mapping):
                target = dict(cast(Mapping[str, Any], raw_target))
                break
        if target is None:
            return None

        identity = payload.get("target_plan_identity")
        identity_mapping: Mapping[str, Any] = (
            cast(Mapping[str, Any], identity) if isinstance(identity, Mapping) else {}
        )
        for key in (
            "hypothesis_id",
            "candidate_id",
            "runtime_strategy_name",
            "strategy_name",
            "strategy_id",
            "account_label",
            "source_account_label",
            "source_kind",
            "source_plan_ref",
            "source_manifest_ref",
            "observed_stage",
            "bounded_collection_stage",
            "window_start",
            "window_end",
            "paper_route_probe_window_start",
            "paper_route_probe_window_end",
            "target_notional",
            "target_quantity",
            "paper_route_probe_next_session_max_notional",
        ):
            value = (
                target.get(key)
                or typed_params.get(key)
                or payload.get(key)
                or identity_mapping.get(key)
            )
            if value is not None:
                target.setdefault(key, value)
        target.setdefault("source", "paper_route_target_plan_materializer")
        target.setdefault(
            "paper_route_target_plan_source",
            "paper_route_target_plan_materializer",
        )
        target.setdefault("observed_stage", "paper")
        target.setdefault("bounded_collection_stage", "bounded_paper_collection")
        target.setdefault("promotion_allowed", False)
        target.setdefault("final_authority_ok", False)
        target.setdefault("final_promotion_authorized", False)
        target.setdefault("final_promotion_allowed", False)
        target.setdefault("live_capital_routing_enabled", False)
        if target.get("paper_route_probe_window_start") is None:
            target["paper_route_probe_window_start"] = target.get(
                "window_start"
            ) or identity_mapping.get("window_start")
        if target.get("paper_route_probe_window_end") is None:
            target["paper_route_probe_window_end"] = target.get(
                "window_end"
            ) or identity_mapping.get("window_end")

        runtime_identity = target.get("account_stage_runtime_identity")
        if not isinstance(runtime_identity, Mapping):
            target["account_stage_runtime_identity"] = {
                "account_label": _safe_text(target.get("account_label")),
                "source_account_label": _safe_text(target.get("source_account_label")),
                "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
                "runtime_strategy_name": _safe_text(
                    target.get("runtime_strategy_name")
                ),
                "source_kind": _safe_text(target.get("source_kind")),
            }
        return target

    def _paper_route_materialized_decision_with_execution_metadata(
        self,
        *,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        action: Literal["buy", "sell"],
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
        now: datetime,
    ) -> StrategyDecision | None:
        target_symbols = sorted(_target_symbols(target))
        symbol_quantities = _target_probe_symbol_quantities(target, target_symbols)
        metadata = self._paper_route_target_source_decision_metadata(
            target=target,
            strategy=strategy,
            symbol=symbol,
            window_start=window_start,
            window_end=window_end,
            max_notional=max_notional,
        )
        metadata["source"] = "paper_route_target_plan_materializer"
        metadata["paper_route_target_plan_source"] = (
            "paper_route_target_plan_materializer"
        )
        metadata["paper_route_target_plan_materialized"] = True
        metadata["materialized_trade_decision_id"] = str(decision_row.id)
        metadata["paper_route_probe_symbol_actions"] = _target_probe_symbol_actions(
            target,
            target_symbols,
        )
        if symbol_quantities:
            metadata["paper_route_probe_symbol_quantities"] = {
                item_symbol: str(quantity)
                for item_symbol, quantity in symbol_quantities.items()
            }
        metadata["paper_route_probe_leg_action"] = action

        execution_metadata = self._bounded_paper_route_execution_metadata(
            target=target,
            strategy=strategy,
            symbol=symbol,
            action=action,
            account_label=self.account_label,
            max_notional=max_notional,
        )
        source_decision_mode = BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        metadata["source_decision_mode"] = source_decision_mode
        metadata["profit_proof_eligible"] = True
        metadata["bounded_paper_route_submit_path"] = execution_metadata["submit_path"]
        metadata["bounded_paper_route_execution_policy"] = execution_metadata[
            "execution_policy"
        ]

        simple_lane = {
            "source": "paper_route_target_plan_materializer",
            "target_plan_source_decision": True,
            "paper_route_target_plan_materialized": True,
            "paper_route_probe_max_notional": str(max_notional),
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_symbol_actions": metadata[
                "paper_route_probe_symbol_actions"
            ],
            "paper_route_probe_leg_action": action,
            "live_capital_routing_enabled": False,
            "client_order_id_basis": "materialized_trade_decision_hash",
            "execution_account_label": execution_metadata["execution_account_label"],
            "submit_path": execution_metadata["submit_path"],
        }
        if symbol_quantities:
            simple_lane["paper_route_probe_symbol_quantities"] = {
                item_symbol: str(quantity)
                for item_symbol, quantity in symbol_quantities.items()
            }

        params: dict[str, Any] = {
            "paper_route_target_plan_materialized": True,
            "paper_route_materialized_trade_decision_id": str(decision_row.id),
            "paper_route_materialized_decision_hash": decision_row.decision_hash,
            "paper_route_target_plan": metadata,
            "paper_route_target_plan_source_decision": metadata,
            "simple_lane": simple_lane,
            "source_decision_mode": source_decision_mode,
            "profit_proof_eligible": True,
            "hypothesis_id": metadata.get("hypothesis_id"),
            "candidate_id": metadata.get("candidate_id"),
            "strategy_name": metadata.get("strategy_name"),
            "runtime_strategy_name": metadata.get("runtime_strategy_name"),
            "account_label": metadata.get("account_label"),
            "source_account_label": metadata.get("source_account_label"),
            "source_kind": metadata.get("source_kind"),
            "source_manifest_ref": metadata.get("source_manifest_ref"),
            "source_plan_ref": metadata.get("source_plan_ref"),
            "paper_route_target_plan_source": metadata.get(
                "paper_route_target_plan_source"
            ),
            "paper_route_probe_scope_authority": metadata.get(
                "paper_route_probe_scope_authority"
            ),
            "paper_route_probe_symbols": metadata.get("paper_route_probe_symbols"),
            "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
            "bounded_collection_stage": "bounded_paper_collection",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            "live_capital_routing_enabled": False,
            **execution_metadata,
            "bounded_paper_route_submit_path": execution_metadata["submit_path"],
            "bounded_paper_route_execution_policy": execution_metadata[
                "execution_policy"
            ],
            **_target_plan_lineage([dict(target)], symbol),
        }
        if "exit_minute_after_open" in metadata:
            params["exit_minute_after_open"] = metadata["exit_minute_after_open"]
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )

        event_ts = _parse_target_datetime(payload.get("event_ts"))
        if event_ts is None:
            raw_created_at = decision_row.created_at
            event_ts = (
                raw_created_at
                if raw_created_at.tzinfo is not None
                else raw_created_at.replace(tzinfo=timezone.utc)
            )
        event_ts = event_ts.astimezone(timezone.utc)
        qty = (
            _optional_decimal(payload.get("qty"))
            or symbol_quantities.get(symbol)
            or Decimal("1")
        )
        if qty <= 0:
            return None

        order_type_text = _safe_text(payload.get("order_type")) or "market"
        order_type: Literal["market", "limit", "stop", "stop_limit"] = (
            cast(
                Literal["market", "limit", "stop", "stop_limit"],
                order_type_text,
            )
            if order_type_text in {"market", "limit", "stop", "stop_limit"}
            else "market"
        )
        time_in_force_text = _safe_text(payload.get("time_in_force")) or "day"
        time_in_force: Literal["day", "gtc", "ioc", "fok"] = (
            cast(Literal["day", "gtc", "ioc", "fok"], time_in_force_text)
            if time_in_force_text in {"day", "gtc", "ioc", "fok"}
            else "day"
        )

        return StrategyDecision(
            strategy_id=str(strategy.id),
            symbol=symbol,
            event_ts=event_ts or now,
            timeframe=_safe_text(payload.get("timeframe"))
            or strategy.base_timeframe
            or "1Min",
            action=action,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            rationale=("materialized bounded paper-route target plan source decision"),
            params=params,
        )

    def _paper_route_materialized_planned_decisions(
        self,
        *,
        session: Session,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        positions: Sequence[Mapping[str, Any]],
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            return []

        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.status == "planned",
                    TradeDecision.alpaca_account_label == self.account_label,
                )
                .order_by(TradeDecision.created_at.asc(), TradeDecision.symbol.asc())
                .limit(100)
            )
            .scalars()
            .all()
        )
        normalized_allowed = {
            symbol.strip().upper() for symbol in allowed_symbols if symbol.strip()
        }
        decisions: list[StrategyDecision] = []
        seen: set[str] = set()
        for decision_row in rows:
            if str(decision_row.id) in seen:
                continue
            payload = self._paper_route_materialized_source_payload(decision_row)
            if payload is None:
                continue
            if self.executor.execution_exists(session, decision_row):
                continue
            raw_target = self._paper_route_materialized_target_from_payload(payload)
            if raw_target is None:
                continue
            target = _bounded_sim_collection_target_with_runtime_account_audit(
                raw_target,
                positions=positions,
                account_label=self.account_label,
            )
            if _target_requires_bounded_sim_collection_gate(target):
                collection_blockers = _bounded_sim_collection_blockers(
                    target,
                    account_label=self.account_label,
                )
                if collection_blockers:
                    logger.warning(
                        "Skipping materialized paper-route target source decision "
                        "because bounded SIM collection is not authorized "
                        "decision_id=%s blockers=%s",
                        decision_row.id,
                        ",".join(collection_blockers),
                    )
                    continue
            else:
                continue

            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            target_cap = _target_probe_cap(target)
            if target_cap is None or target_cap <= 0:
                continue
            strategy = session.get(Strategy, decision_row.strategy_id)
            if strategy is None:
                strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            symbol = _safe_text(decision_row.symbol) or _safe_text(
                payload.get("symbol")
            )
            if symbol is None:
                continue
            symbol = symbol.upper()
            if normalized_allowed and symbol not in normalized_allowed:
                continue
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if strategy_symbols and symbol not in strategy_symbols:
                continue
            symbol_actions = _target_probe_symbol_actions(target, [symbol])
            action_text = _safe_text(payload.get("action")) or symbol_actions.get(
                symbol
            )
            if action_text not in {"buy", "sell"}:
                action_text = _target_probe_action(target)
            action = cast(Literal["buy", "sell"], action_text)
            if action == "sell" and not settings.trading_allow_shorts:
                continue
            if self._paper_route_target_account_has_open_exposure(positions):
                logger.warning(
                    "Skipping materialized paper-route target source decision because "
                    "account is not flat for bounded SIM evidence decision_id=%s",
                    decision_row.id,
                )
                continue
            if self._paper_route_target_symbol_has_open_position(positions, symbol):
                continue
            if self._paper_route_target_symbol_has_open_strategy_exposure(
                session=session,
                strategy=strategy,
                symbol=symbol,
                account_label=self.account_label,
                window_start=window_start,
            ):
                continue
            if self._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=session,
                strategy=strategy,
                symbol=symbol,
                account_label=self.account_label,
                window_start=window_start,
            ):
                continue
            decision = self._paper_route_materialized_decision_with_execution_metadata(
                decision_row=decision_row,
                payload=payload,
                target=target,
                strategy=strategy,
                symbol=symbol,
                action=action,
                window_start=window_start,
                window_end=window_end,
                max_notional=target_cap,
                now=now,
            )
            if decision is None:
                continue
            decisions.append(decision)
            seen.add(str(decision_row.id))
        return decisions

    def _process_paper_route_materialized_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_materialized_planned_decisions(
            session=session,
            strategies=strategies,
            positions=positions,
            allowed_symbols=allowed_symbols,
        )
        for decision in decisions:
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Materialized paper-route target source decision handling failed "
                    "strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _process_paper_route_probe_exit_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_probe_exit_decisions(session=session)
        for decision in decisions:
            prepared_decision = self._prepare_paper_route_probe_exit_position(
                positions,
                decision,
                execution_adapter=self.execution_adapter,
                trading_mode=settings.trading_mode,
            )
            if prepared_decision is None:
                continue
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    prepared_decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Paper route probe exit handling failed strategy_id=%s symbol=%s timeframe=%s",
                    prepared_decision.strategy_id,
                    prepared_decision.symbol,
                    prepared_decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _process_paper_route_target_source_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_target_source_decisions(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
            positions=positions,
            session=session,
        )
        for decision in decisions:
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Paper-route target source decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _submission_control_plane_snapshot(
        self,
        *,
        capital_stage: str | None = None,
    ) -> dict[str, object]:
        snapshot = super()._submission_control_plane_snapshot(
            capital_stage=capital_stage
        )
        snapshot["pipeline_mode"] = settings.trading_pipeline_mode
        snapshot["execution_lane"] = "simple"
        snapshot["submit_path"] = "direct_alpaca"
        return snapshot

    def _ensure_decision_price(
        self, decision: StrategyDecision, signal_price: Any
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]]:
        requires_executable_quote = (
            self._paper_route_decision_requires_executable_quote(decision)
        )
        if signal_price is not None and "price_snapshot" in decision.params:
            if (
                not requires_executable_quote
                or self._decision_has_executable_quote_payload(decision)
            ):
                return decision, None
        if (
            signal_price is not None
            and requires_executable_quote
            and self._decision_has_executable_quote_payload(decision)
        ):
            return decision, None
        snapshot = self.price_fetcher.fetch_market_snapshot(
            SignalEnvelope(
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                payload={},
                timeframe=decision.timeframe,
            )
        )
        target_snapshot = _target_metadata_quote_snapshot(
            decision.params,
            symbol=decision.symbol,
        )
        snapshot_has_executable_quote = (
            snapshot is not None
            and snapshot.bid is not None
            and snapshot.ask is not None
            and snapshot.bid > 0
            and snapshot.ask >= snapshot.bid
        )
        if (
            (
                snapshot is None
                or snapshot.price is None
                or (requires_executable_quote and not snapshot_has_executable_quote)
            )
            and target_snapshot is not None
            and _snapshot_has_executable_quote(target_snapshot)
        ):
            updated_params = self._paper_route_params_with_quote_snapshot(
                decision.params,
                target_snapshot,
                signal_price=signal_price,
            )
            return decision.model_copy(update={"params": updated_params}), None
        if snapshot is None or snapshot.price is None:
            return decision, None
        updated_params = dict(decision.params)
        if signal_price is None:
            updated_params["price"] = snapshot.price
        updated_params["price_snapshot"] = self._paper_route_price_snapshot_payload(
            snapshot
        )
        if snapshot.spread is not None and "spread" not in updated_params:
            updated_params["spread"] = snapshot.spread
        if snapshot.bid is not None:
            updated_params.setdefault("imbalance_bid_px", snapshot.bid)
        if snapshot.ask is not None:
            updated_params.setdefault("imbalance_ask_px", snapshot.ask)
        if snapshot.spread is not None:
            updated_params.setdefault("imbalance_spread", snapshot.spread)
        return decision.model_copy(update={"params": updated_params}), snapshot

    @staticmethod
    def _paper_route_params_with_quote_snapshot(
        params: Mapping[str, Any],
        snapshot: Mapping[str, Any],
        *,
        signal_price: Any,
    ) -> dict[str, Any]:
        updated_params = dict(params)
        price = _decimal_from_mapping(
            snapshot, ("price", "mid", "mid_price", "midpoint")
        )
        bid = _decimal_from_mapping(snapshot, ("bid", "bid_px", "bid_price", "bp"))
        ask = _decimal_from_mapping(snapshot, ("ask", "ask_px", "ask_price", "ap"))
        spread = _decimal_from_mapping(snapshot, ("spread", "imbalance_spread"))
        computed_spread = ask - bid if bid is not None and ask is not None else None
        quote_as_of = (
            _parse_target_datetime(snapshot.get("quote_as_of"))
            or _parse_target_datetime(snapshot.get("as_of"))
            or _parse_target_datetime(snapshot.get("timestamp"))
        )
        source = _text_from_mapping(snapshot, ("quote_source", "source", "feed"))
        if price is None and bid is not None and ask is not None:
            price = (bid + ask) / Decimal("2")
        if signal_price is None and price is not None:
            updated_params["price"] = price
        if bid is not None:
            updated_params.setdefault("imbalance_bid_px", bid)
        if ask is not None:
            updated_params.setdefault("imbalance_ask_px", ask)
        if spread is not None or computed_spread is not None:
            effective_spread = spread if spread is not None else computed_spread
            updated_params.setdefault("spread", effective_spread)
            updated_params.setdefault("imbalance_spread", effective_spread)
        updated_params["price_snapshot"] = {
            "source": source,
            "quote_source": source,
            "as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
            "quote_as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
            "price": str(price) if price is not None else None,
            "bid": str(bid) if bid is not None else None,
            "ask": str(ask) if ask is not None else None,
            "spread": str(spread if spread is not None else computed_spread)
            if spread is not None or computed_spread is not None
            else None,
        }
        return updated_params

    @staticmethod
    def _decision_has_executable_quote_payload(decision: StrategyDecision) -> bool:
        params = decision.params
        if _executable_bid_ask_present(params):
            return True
        price_snapshot = params.get("price_snapshot")
        if isinstance(price_snapshot, Mapping):
            return _executable_bid_ask_present(cast(Mapping[str, Any], price_snapshot))
        return False

    @staticmethod
    def _paper_route_price_snapshot_payload(
        snapshot: MarketSnapshot,
    ) -> dict[str, Any]:
        payload = _price_snapshot_payload(snapshot)
        if snapshot.bid is not None:
            payload["bid"] = str(snapshot.bid)
        if snapshot.ask is not None:
            payload["ask"] = str(snapshot.ask)
        if snapshot.quote_as_of is not None:
            payload["quote_as_of"] = snapshot.quote_as_of.isoformat()
        if snapshot.quote_source is not None:
            payload["quote_source"] = snapshot.quote_source
        return payload

    @staticmethod
    def _paper_route_decision_requires_executable_quote(
        decision: StrategyDecision,
    ) -> bool:
        if isinstance(decision.params.get("paper_route_probe_exit"), Mapping):
            return False
        if isinstance(decision.params.get("paper_route_target_plan"), Mapping):
            return True
        if isinstance(
            decision.params.get("paper_route_target_plan_source_decision"), Mapping
        ):
            return True
        if isinstance(decision.params.get("paper_route_probe"), Mapping):
            return True
        if isinstance(decision.params.get("strategy_signal_paper"), Mapping):
            return True
        mode = normalize_source_decision_mode(
            decision.params.get("source_decision_mode")
        )
        return mode in {
            ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
        }

    def _paper_route_quote_routeability(
        self,
        decision: StrategyDecision,
        snapshot: MarketSnapshot | None,
    ) -> tuple[QuoteQualityStatus, dict[str, object]]:
        params = decision.params
        price_snapshot_raw = params.get("price_snapshot")
        price_snapshot: Mapping[str, Any]
        if isinstance(price_snapshot_raw, Mapping):
            price_snapshot = cast(Mapping[str, Any], price_snapshot_raw)
        else:
            price_snapshot = {}
        target_quote_snapshot = _target_metadata_quote_snapshot(
            params,
            symbol=decision.symbol,
        )
        target_price_snapshot: Mapping[str, Any] = (
            target_quote_snapshot
            if target_quote_snapshot is not None
            else cast(Mapping[str, Any], {})
        )
        if not price_snapshot and target_quote_snapshot is not None:
            price_snapshot = target_quote_snapshot

        params_price = _optional_decimal(params.get("price"))
        snapshot_price = snapshot.price if snapshot is not None else None
        payload_price = _decimal_from_mapping(
            price_snapshot,
            ("price", "mid", "mid_price", "midpoint"),
        )
        target_payload_price = _decimal_from_mapping(
            target_price_snapshot,
            ("price", "mid", "mid_price", "midpoint"),
        )
        price = _first_decimal(
            snapshot_price,
            payload_price,
            target_payload_price,
            params_price,
        )

        snapshot_bid = snapshot.bid if snapshot is not None else None
        payload_bid = _decimal_from_mapping(
            price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        )
        target_payload_bid = _decimal_from_mapping(
            target_price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        )
        params_bid = _optional_decimal(params.get("imbalance_bid_px"))
        bid = _first_decimal(snapshot_bid, payload_bid, target_payload_bid, params_bid)

        snapshot_ask = snapshot.ask if snapshot is not None else None
        payload_ask = _decimal_from_mapping(
            price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        )
        target_payload_ask = _decimal_from_mapping(
            target_price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        )
        params_ask = _optional_decimal(params.get("imbalance_ask_px"))
        ask = _first_decimal(snapshot_ask, payload_ask, target_payload_ask, params_ask)

        snapshot_spread = snapshot.spread if snapshot is not None else None
        payload_spread = _decimal_from_mapping(
            price_snapshot,
            ("spread", "imbalance_spread"),
        )
        target_payload_spread = _decimal_from_mapping(
            target_price_snapshot,
            ("spread", "imbalance_spread"),
        )
        params_spread = _optional_decimal(params.get("spread"))
        computed_spread = ask - bid if bid is not None and ask is not None else None
        spread = _first_decimal(
            snapshot_spread,
            payload_spread,
            target_payload_spread,
            params_spread,
            computed_spread,
        )
        using_target_executable_quote = (
            target_quote_snapshot is not None
            and snapshot_bid is None
            and snapshot_ask is None
            and payload_bid is None
            and payload_ask is None
            and target_payload_bid is not None
            and target_payload_ask is not None
        )
        target_quote_as_of = (
            _parse_target_datetime(target_price_snapshot.get("quote_as_of"))
            or _parse_target_datetime(target_price_snapshot.get("as_of"))
            or _parse_target_datetime(target_price_snapshot.get("timestamp"))
        )
        price_snapshot_quote_as_of = (
            _parse_target_datetime(price_snapshot.get("quote_as_of"))
            or _parse_target_datetime(price_snapshot.get("as_of"))
            or _parse_target_datetime(price_snapshot.get("timestamp"))
        )
        quote_as_of = (
            target_quote_as_of
            if using_target_executable_quote and target_quote_as_of is not None
            else (
                snapshot.quote_as_of
                if snapshot is not None and snapshot.quote_as_of is not None
                else price_snapshot_quote_as_of or target_quote_as_of
            )
        )
        target_source = _text_from_mapping(
            target_price_snapshot,
            ("quote_source", "source", "feed"),
        )
        price_snapshot_source = _text_from_mapping(
            price_snapshot,
            ("quote_source", "source", "feed"),
        )
        source = (
            target_source
            if using_target_executable_quote and target_source is not None
            else (
                str(
                    (
                        snapshot.quote_source
                        if snapshot is not None and snapshot.quote_source is not None
                        else price_snapshot_source
                        or target_source
                        or (snapshot.source if snapshot is not None else "")
                    )
                    or ""
                ).strip()
                or None
            )
        )
        quality_payload: dict[str, object] = {
            "price": price,
            "imbalance_bid_px": bid,
            "imbalance_ask_px": ask,
            "spread": spread,
            "price_snapshot": {
                "source": source,
                "quote_source": source,
                "as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
                "quote_as_of": quote_as_of.isoformat()
                if quote_as_of is not None
                else None,
                "price": str(price) if price is not None else None,
                "bid": str(bid) if bid is not None else None,
                "ask": str(ask) if ask is not None else None,
                "spread": str(spread) if spread is not None else None,
            },
        }
        status = assess_signal_quote_quality(
            signal=SignalEnvelope(
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                payload=quality_payload,
                timeframe=decision.timeframe,
            ),
            previous_price=None,
            policy=QuoteQualityPolicy(
                max_executable_spread_bps=settings.trading_signal_max_executable_spread_bps,
                max_quote_mid_jump_bps=settings.trading_signal_max_quote_mid_jump_bps,
                max_jump_with_wide_spread_bps=settings.trading_signal_max_jump_with_wide_spread_bps,
                max_executable_quote_age_seconds=settings.trading_executable_quote_lookback_seconds,
            ),
        )
        target_mismatch = self._paper_route_target_plan_source_mismatch(decision)
        if target_mismatch is not None:
            status = QuoteQualityStatus(
                valid=False,
                reason="target_plan_source_mismatch",
                spread_bps=status.spread_bps,
                jump_bps=status.jump_bps,
                quote_age_seconds=status.quote_age_seconds,
                source=source,
                price=status.price,
                bid=status.bid,
                ask=status.ask,
                fillability_state="blocked",
                repair_action="skip_symbol_until_target_plan_source_matches_decision",
                operator_next_action="skip_symbol",
                evidence_requirements=(
                    "target_plan_symbol_scope",
                    "strategy_source_decision_lineage",
                ),
            )
        routeability = self._paper_route_quote_routeability_payload(
            decision=decision,
            status=status,
            source=source,
            quote_as_of=quote_as_of,
            target_mismatch=target_mismatch,
        )
        return status, routeability

    @staticmethod
    def _paper_route_target_plan_source_mismatch(
        decision: StrategyDecision,
    ) -> dict[str, object] | None:
        metadata = _mapping_value(
            decision.params.get("paper_route_target_plan_source_decision")
        ) or _mapping_value(decision.params.get("paper_route_target_plan"))
        if metadata is None:
            return None
        symbol = decision.symbol.strip().upper()
        metadata_symbol = _safe_text(metadata.get("symbol"))
        target_symbols = _target_symbols(metadata)
        mismatches: list[str] = []
        if metadata_symbol is not None and metadata_symbol.upper() != symbol:
            mismatches.append("target_plan_symbol_mismatch")
        if target_symbols and symbol not in target_symbols:
            mismatches.append("target_plan_symbol_scope_mismatch")
        expected_action = SimpleTradingPipeline._target_plan_action_for_symbol(
            metadata,
            symbol=symbol,
        )
        decision_action = SimpleTradingPipeline._normalize_target_plan_action(
            decision.action
        )
        if expected_action is not None and decision_action != expected_action:
            mismatches.append("target_plan_side_mismatch")
        if not mismatches:
            return None
        return {
            "schema_version": "torghut.paper-route-target-plan-source-mismatch.v1",
            "symbol": symbol,
            "metadata_symbol": metadata_symbol,
            "target_symbols": sorted(target_symbols),
            "decision_action": decision_action,
            "target_action": expected_action,
            "mismatches": mismatches,
        }

    @staticmethod
    def _target_plan_action_for_symbol(
        metadata: Mapping[str, Any],
        *,
        symbol: str,
    ) -> Literal["buy", "sell"] | None:
        normalized_symbol = symbol.strip().upper()
        raw_actions = metadata.get("paper_route_probe_symbol_actions")
        if isinstance(raw_actions, Mapping):
            for raw_symbol, raw_action in cast(
                Mapping[object, object], raw_actions
            ).items():
                if str(raw_symbol).strip().upper() != normalized_symbol:
                    continue
                return SimpleTradingPipeline._normalize_target_plan_action(raw_action)
        metadata_symbol = _safe_text(metadata.get("symbol"))
        direct_symbol_matches = (
            metadata_symbol is None or metadata_symbol.upper() == normalized_symbol
        )
        if not direct_symbol_matches:
            return None
        for key in (
            "paper_route_probe_leg_action",
            "paper_route_probe_action",
            "probe_action",
            "action",
            "side",
        ):
            action = SimpleTradingPipeline._normalize_target_plan_action(
                metadata.get(key)
            )
            if action is not None:
                return action
        return None

    @staticmethod
    def _normalize_target_plan_action(value: object) -> Literal["buy", "sell"] | None:
        normalized = str(value or "").strip().lower()
        if normalized in {"buy", "long"}:
            return "buy"
        if normalized in {"sell", "short"}:
            return "sell"
        return None

    @staticmethod
    def _paper_route_quote_routeability_payload(
        *,
        decision: StrategyDecision,
        status: QuoteQualityStatus,
        source: str | None,
        quote_as_of: datetime | None,
        target_mismatch: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        blockers = [] if status.valid else [status.reason or "missing_executable_quote"]
        return {
            "schema_version": "torghut.paper-route-quote-routeability.v1",
            "status": "accepted" if status.valid else "blocked",
            "reason": status.reason if not status.valid else "executable_quote_ready",
            "symbol": decision.symbol.strip().upper(),
            "source": source,
            "quote_as_of": quote_as_of.isoformat() if quote_as_of is not None else None,
            "quote_age_seconds": str(status.quote_age_seconds)
            if status.quote_age_seconds is not None
            else None,
            "spread_bps": str(status.spread_bps)
            if status.spread_bps is not None
            else None,
            "max_spread_bps": str(settings.trading_signal_max_executable_spread_bps),
            "max_quote_age_seconds": settings.trading_executable_quote_lookback_seconds,
            "bid": str(status.bid) if status.bid is not None else None,
            "ask": str(status.ask) if status.ask is not None else None,
            "price": str(status.price) if status.price is not None else None,
            "capability": "executable_bid_ask",
            "fillability_state": status.fillability_state,
            "repair_action": status.repair_action,
            "operator_next_action": status.operator_next_action,
            "bounded_evidence_collection_ready": status.valid,
            "bounded_evidence_collection_action": (
                "allow_bounded_collection"
                if status.valid
                else status.operator_next_action or "refresh_source_snapshot"
            ),
            "promotion_allowed": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            "readiness": {
                "schema_version": "torghut.paper-route-fillability-readiness.v1",
                "state": "ready" if status.valid else "blocked",
                "blockers": blockers,
                "next_operator_action": status.operator_next_action,
                "repair_action": status.repair_action,
                "evidence_requirements": list(status.evidence_requirements),
                "promotion_allowed": False,
                "final_authority_ok": False,
            },
            "target_plan_source_mismatch": dict(target_mismatch)
            if target_mismatch is not None
            else None,
        }

    @staticmethod
    def _paper_route_quote_routeability_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "rejected":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, Any], decision_json_raw)
        params = _mapping_value(decision_json.get("params"))
        if params is None:
            return None
        if not (
            isinstance(params.get("paper_route_target_plan_source_decision"), Mapping)
            or isinstance(params.get("paper_route_target_plan"), Mapping)
            or isinstance(params.get("paper_route_probe"), Mapping)
        ):
            return None
        routeability = _mapping_value(params.get("quote_routeability"))
        if routeability is None:
            return None
        if _safe_text(routeability.get("status")) != "blocked":
            return None
        reason = _safe_text(routeability.get("reason"))
        retryable_reasons = {
            "absent_snapshot_fallback",
            "missing_executable_quote",
            "missing_bid",
            "missing_ask",
            "non_positive_price",
            "non_positive_bid",
            "non_positive_ask",
            "crossed_quote",
            "stale_quote",
            "spread_bps_exceeded",
            "wide_spread_midpoint_jump",
        }
        if reason not in retryable_reasons:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_quote_routeability_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        return {
            "previous_decision_status": "rejected",
            "previous_submission_stage": "rejected_quote_routeability",
            "previous_quote_routeability_reason": reason,
            "previous_quote_routeability": dict(routeability),
            "previous_retry_attempts": retry_attempts,
        }

    def _reopen_rejected_paper_route_quote_routeability_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_metadata = self._paper_route_quote_routeability_retry_metadata(
            decision_row
        )
        if retry_metadata is None:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None

        self.executor.sync_decision_state(session, decision_row, decision)
        raw_decision_json = decision_row.decision_json
        decision_json = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        retry_attempts = _safe_int(
            decision_json.get("paper_route_quote_routeability_retry_attempts")
        )
        params_mapping = _mapping_value(decision_json.get("params"))
        params = dict(params_mapping) if params_mapping is not None else {}
        params.pop("quote_routeability", None)
        decision_json["params"] = params
        decision_json["submission_stage"] = (
            "paper_route_quote_routeability_retry_pending"
        )
        decision_json["paper_route_quote_routeability_retry_attempts"] = (
            retry_attempts + 1
        )
        decision_json["paper_route_quote_routeability_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_quote_routeability_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
        }
        for key in (
            "risk_reasons",
            "reject_reason_atomic",
            "reject_class",
            "reject_origin",
            "broker_precheck",
        ):
            decision_json.pop(key, None)
        decision_row.status = "planned"
        decision_row.created_at = trading_now(account_label=self.account_label)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening paper route target source decision after transient quote routeability failure strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_quote_routeability_reason"],
        )
        return decision_row

    def _prepare_decision_for_submission(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        decision, snapshot = self._ensure_decision_price(
            decision, signal_price=decision.params.get("price")
        )
        if self._paper_route_decision_requires_executable_quote(decision):
            quote_status, routeability = self._paper_route_quote_routeability(
                decision,
                snapshot,
            )
            params_update = dict(decision.params)
            params_update["quote_routeability"] = routeability
            decision = decision.model_copy(update={"params": params_update})
            self.executor.update_decision_params(session, decision_row, params_update)
            if not quote_status.valid:
                reason = quote_status.reason or "missing_executable_quote"
                self._record_decision_rejection(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reasons=[reason],
                    log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
                )
                return None
        proof_floor = self._profitability_proof_floor(session=session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        if (
            proof_floor_block_reason is not None
            and settings.trading_mode == "paper"
            and self._paper_route_probe_exit_metadata(decision) is None
            and _paper_route_probe_entry_metadata(decision.params) is None
        ):
            probe_context = self._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
                strategy=strategy,
                session=session,
                strategies=[strategy],
            )
            capped_decision = self._paper_route_probe_capped_decision(
                decision=decision,
                proof_floor=proof_floor,
                context=probe_context or {},
            )
            if capped_decision is not None:
                decision = capped_decision
        max_notional_per_order = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_max_notional_per_order),
            _optional_decimal(settings.trading_max_notional_per_trade),
            _optional_decimal(strategy.max_notional_per_trade),
        )
        equity = _optional_decimal(account.get("equity"))
        max_notional_per_symbol = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_max_notional_per_symbol),
            _optional_decimal(settings.trading_allocator_max_symbol_notional),
            _pct_cap_to_notional(
                equity=equity,
                pct=_optional_decimal(settings.trading_max_position_pct_equity),
            ),
            _pct_cap_to_notional(
                equity=equity,
                pct=_optional_decimal(strategy.max_position_pct_equity),
            ),
        )
        preparation = prepare_simple_decision(
            decision=decision,
            account=account,
            positions=positions,
            fractional_equities_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            max_notional_per_order=max_notional_per_order,
            max_notional_per_symbol=max_notional_per_symbol,
            buying_power_reserve_bps=_optional_decimal(
                settings.trading_simple_buying_power_reserve_bps
            )
            or Decimal("0"),
        )
        prepared_decision = self._align_prechecked_paper_route_probe_cap(
            preparation.decision
        )
        self.executor.sync_decision_state(session, decision_row, prepared_decision)
        if preparation.diagnostics:
            params_update = dict(prepared_decision.params)
            params_update["simple_lane_precheck"] = preparation.diagnostics
            self.executor.update_decision_params(session, decision_row, params_update)
        if not preparation.approved or preparation.reject_reason is not None:
            reason = preparation.reject_reason or "broker_precheck_failed"
            self._record_decision_rejection(
                session=session,
                decision=prepared_decision,
                decision_row=decision_row,
                reasons=[reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        return prepared_decision, snapshot

    def _passes_risk_verdict(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        symbol_allowlist: set[str],
        execution_advisor: Mapping[str, Any] | None,
    ) -> bool:
        _ = (strategy, account, symbol_allowlist, execution_advisor)
        short_reason = self._simple_shortability_reason(
            decision=decision,
            positions=positions,
        )
        if short_reason is None:
            return True
        self._record_decision_rejection(
            session=session,
            decision=decision,
            decision_row=decision_row,
            reasons=[short_reason],
            log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
        )
        return False

    def _profitability_proof_floor(self, *, session: Session) -> Mapping[str, object]:
        try:
            self._refresh_market_context_for_proof_floor()
            market_context_status = build_submission_gate_market_context_status(
                self.state
            )
            hypothesis_payload = build_hypothesis_runtime_summary(
                session,
                state=self.state,
                market_context_status=market_context_status,
            )
            empirical_jobs_status = build_empirical_jobs_status(
                session=session,
                stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
            )
            quant_evidence = load_quant_evidence_status(
                account_label=self.account_label
            )
            live_submission_gate = self._live_submission_gate(
                session=session,
                hypothesis_summary=hypothesis_payload,
                empirical_jobs_status=empirical_jobs_status,
                quant_health_status=quant_evidence,
            )
            return build_profitability_proof_floor_receipt(
                account_label=self.account_label,
                torghut_revision=None,
                trading_mode=settings.trading_mode,
                market_session_open=cast(
                    bool | None,
                    getattr(self.state, "market_session_open", None),
                ),
                live_submission_gate=live_submission_gate,
                hypothesis_payload=hypothesis_payload,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                tca_summary=build_tca_gate_inputs(
                    session=session,
                    account_label=self.account_label,
                    symbols=self.universe_resolver.get_resolution().symbols,
                ),
                simple_lane_status={
                    "enabled": settings.trading_pipeline_mode == "simple",
                    "submit_enabled": settings.trading_simple_submit_enabled,
                    "order_feed_telemetry_enabled": (
                        settings.trading_simple_order_feed_telemetry_enabled
                    ),
                    "order_feed_ingestion_enabled": (
                        settings.trading_order_feed_enabled
                    ),
                    "order_feed_bootstrap_configured": bool(
                        settings.trading_order_feed_bootstrap_server_list
                    ),
                    "order_feed_topic_count": len(settings.trading_order_feed_topics),
                    "order_feed_assignment_mode": (
                        settings.trading_order_feed_assignment_mode
                    ),
                    "order_feed_auto_offset_reset": (
                        settings.trading_order_feed_auto_offset_reset
                    ),
                    "order_feed_lifecycle_required": (
                        settings.trading_pipeline_mode == "simple"
                        and settings.trading_mode in {"paper", "live"}
                    ),
                    "order_feed_lifecycle_status": (
                        "enabled"
                        if settings.trading_simple_order_feed_telemetry_enabled
                        else "disabled"
                    ),
                    "paper_route_probe_enabled": (
                        settings.trading_simple_paper_route_probe_enabled
                    ),
                    "paper_route_probe_max_notional": (
                        settings.trading_simple_paper_route_probe_max_notional
                    ),
                    "route_symbol_filter_enabled": True,
                    "max_notional_per_order": settings.trading_simple_max_notional_per_order,
                    "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
                    "allowed_reject_reasons": sorted(_SIMPLE_ALLOWED_REJECT_REASONS),
                },
                tca_max_age_seconds=_PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
            )
        except Exception as exc:  # pragma: no cover - defensive capital safety
            logger.exception("Simple-lane proof floor unavailable")
            return {
                "schema_version": "torghut.profitability-proof-floor.v1",
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    f"profitability_proof_floor_unavailable:{type(exc).__name__}"
                ],
            }

    def _refresh_market_context_for_proof_floor(self) -> None:
        """Keep simple-lane proof-floor market context fresh without the LLM path.

        The legacy pipeline records market context while building LLM review
        requests. Simple mode can run with LLM disabled, so the proof floor must
        refresh the same state explicitly before alpha-readiness checks.
        """

        if not settings.trading_market_context_url:
            return

        now = datetime.now(timezone.utc)
        self._age_market_context_freshness(now)
        if self._market_context_refresh_recent(now):
            return
        freshness_seconds = self.state.last_market_context_freshness_seconds
        if (
            freshness_seconds is not None
            and freshness_seconds
            <= settings.trading_market_context_max_staleness_seconds
            and not self.state.market_context_alert_active
        ):
            return

        symbol = self._market_context_probe_symbol()
        if not symbol:
            return
        market_context, market_context_error = self._fetch_market_context(symbol)
        self._record_market_context_observation(
            symbol=symbol,
            market_context=market_context,
            market_context_error=market_context_error,
        )

    def _age_market_context_freshness(self, now: datetime) -> None:
        as_of = self.state.last_market_context_as_of
        if as_of is None:
            return
        if as_of.tzinfo is None:
            as_of = as_of.replace(tzinfo=timezone.utc)
        freshness_seconds = max(
            0,
            int(
                (
                    now.astimezone(timezone.utc) - as_of.astimezone(timezone.utc)
                ).total_seconds()
            ),
        )
        self.state.last_market_context_freshness_seconds = freshness_seconds

    def _market_context_refresh_recent(self, now: datetime) -> bool:
        checked_at = self.state.last_market_context_checked_at
        if checked_at is None:
            return False
        if checked_at.tzinfo is None:
            checked_at = checked_at.replace(tzinfo=timezone.utc)
        return (
            now.astimezone(timezone.utc) - checked_at.astimezone(timezone.utc)
        ) < _SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL

    def _market_context_probe_symbol(self) -> str | None:
        existing_symbol = (
            str(self.state.last_market_context_symbol or "").strip().upper()
        )
        if existing_symbol:
            return existing_symbol
        try:
            symbols = self.universe_resolver.get_resolution().symbols
        except Exception:
            logger.exception("Simple-lane market context probe symbol unavailable")
            return None
        for raw_symbol in symbols:
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                return symbol
        return None

    @staticmethod
    def _proof_floor_submission_block_reason(
        proof_floor: Mapping[str, object],
    ) -> str | None:
        route_state = str(proof_floor.get("route_state") or "").strip()
        capital_state = str(proof_floor.get("capital_state") or "").strip()
        max_notional = _optional_decimal(proof_floor.get("max_notional"))
        if (
            route_state == "repair_only"
            or capital_state == "zero_notional"
            or (max_notional is not None and max_notional <= 0)
        ):
            blocking_reasons = proof_floor.get("blocking_reasons")
            if isinstance(blocking_reasons, list):
                for item in cast(list[object], blocking_reasons):
                    reason = str(item).strip()
                    if reason:
                        return reason
            return "profitability_proof_floor_zero_notional"
        return None

    @staticmethod
    def _proof_floor_market_session_open(proof_floor: Mapping[str, object]) -> bool:
        market_window = proof_floor.get("market_window")
        if not isinstance(market_window, Mapping):
            return False
        return bool(cast(Mapping[str, object], market_window).get("session_open"))

    @staticmethod
    def _proof_floor_route_candidate_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        summary = route_book_mapping.get("summary")
        if not isinstance(summary, Mapping):
            return set()
        summary_mapping = cast(Mapping[str, Any], summary)
        raw_symbols = summary_mapping.get("candidate_symbols")
        if not isinstance(raw_symbols, list):
            return set()
        candidate_symbols: set[str] = set()
        for raw_symbol in cast(list[object], raw_symbols):
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                candidate_symbols.add(symbol)
        return candidate_symbols

    @staticmethod
    def _proof_floor_route_repair_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        summary = cast(Mapping[str, Any], route_book).get("summary")
        if not isinstance(summary, Mapping):
            return set()
        repair_symbols: set[str] = set()
        for key in ("repair_candidate_symbols", "candidate_symbols"):
            raw_symbols = cast(Mapping[str, Any], summary).get(key)
            if not isinstance(raw_symbols, list):
                continue
            for raw_symbol in cast(list[object], raw_symbols):
                symbol = str(raw_symbol).strip().upper()
                if symbol:
                    repair_symbols.add(symbol)
        return repair_symbols

    @staticmethod
    def _proof_floor_paper_route_probe_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        probe = route_book_mapping.get("paper_route_probe")
        summary = route_book_mapping.get("summary")
        symbols: set[str] = set()
        for source, keys in (
            (probe, ("active_symbols", "eligible_symbols")),
            (
                summary,
                (
                    "paper_route_probe_active_symbols",
                    "paper_route_probe_eligible_symbols",
                ),
            ),
        ):
            if not isinstance(source, Mapping):
                continue
            source_mapping = cast(Mapping[str, Any], source)
            for key in keys:
                raw_symbols = source_mapping.get(key)
                if not isinstance(raw_symbols, list):
                    continue
                for raw_symbol in cast(list[object], raw_symbols):
                    symbol = str(raw_symbol).strip().upper()
                    if symbol:
                        symbols.add(symbol)
        return symbols

    @staticmethod
    def _proof_floor_symbol_route_probe_reasons(
        proof_floor: Mapping[str, object],
        symbol: str,
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        raw_summary = cast(Mapping[str, Any], route_book).get("summary")
        summary: Mapping[str, Any]
        if isinstance(raw_summary, Mapping):
            summary = cast(Mapping[str, Any], raw_summary)
        else:
            summary = {}
        normalized_symbol = symbol.strip().upper()
        reasons: set[str] = set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        candidate_sources: list[object] = [
            summary.get("repair_candidates"),
            route_book_mapping.get("records"),
        ]
        for raw_candidates in candidate_sources:
            if not isinstance(raw_candidates, list):
                continue
            for raw_candidate in cast(list[object], raw_candidates):
                if not isinstance(raw_candidate, Mapping):
                    continue
                candidate = cast(Mapping[str, Any], raw_candidate)
                candidate_symbol = str(candidate.get("symbol") or "").strip().upper()
                if not candidate_symbol or candidate_symbol != normalized_symbol:
                    continue
                state = str(candidate.get("state") or "").strip()
                if state not in {"missing", "probing"}:
                    continue
                reason = str(candidate.get("reason") or "").strip()
                if reason in _PAPER_ROUTE_PROBE_REASONS:
                    reasons.add(reason)
        return reasons

    @staticmethod
    def _paper_route_probe_reference_price(
        decision: StrategyDecision,
    ) -> Decimal | None:
        for value in (
            decision.limit_price,
            decision.params.get("price"),
            cast(Mapping[str, Any], decision.params.get("simple_lane") or {}).get(
                "price"
            )
            if isinstance(decision.params.get("simple_lane"), Mapping)
            else None,
            cast(Mapping[str, Any], decision.params.get("price_snapshot") or {}).get(
                "price"
            )
            if isinstance(decision.params.get("price_snapshot"), Mapping)
            else None,
        ):
            price = _optional_decimal(value)
            if price is not None and price > 0:
                return price
        return None

    @staticmethod
    def _paper_route_probe_short_increasing_sell(decision: StrategyDecision) -> bool:
        if decision.action != "sell":
            return False
        for key in ("simple_lane", "sizing"):
            section = decision.params.get(key)
            if not isinstance(section, Mapping):
                continue
            quantity_resolution = cast(Mapping[str, Any], section).get(
                "quantity_resolution"
            )
            if not isinstance(quantity_resolution, Mapping):
                continue
            resolution = cast(Mapping[str, Any], quantity_resolution)
            short_increasing = resolution.get("short_increasing")
            if isinstance(short_increasing, bool):
                return short_increasing
            if isinstance(short_increasing, str):
                normalized = short_increasing.strip().lower()
                if normalized in {"true", "1", "yes", "on"}:
                    return True
                if normalized in {"false", "0", "no", "off"}:
                    return False
            reason = str(resolution.get("reason") or "").strip().lower()
            if reason.startswith("sell_reducing_"):
                return False
            if "short_increasing" in reason:
                return True
        return True

    @staticmethod
    def _paper_route_target_plan_url_points_to_current_service(url: str) -> bool:
        parsed = urlsplit(url)
        path = (parsed.path or "").rstrip("/")
        if path != "/trading/paper-route-target-plan":
            return False
        hostname = (parsed.hostname or "").strip().lower()
        service_name = os.getenv("K_SERVICE", "").strip().lower()
        if not hostname or not service_name:
            return False
        namespace = (
            os.getenv("POD_NAMESPACE", os.getenv("NAMESPACE", "")).strip().lower()
        )
        service_hosts = {service_name}
        if namespace:
            service_hosts.update(
                {
                    f"{service_name}.{namespace}",
                    f"{service_name}.{namespace}.svc",
                    f"{service_name}.{namespace}.svc.cluster.local",
                }
            )
        return hostname in service_hosts or hostname.startswith(f"{service_name}.")

    def _local_paper_route_target_probe_symbols(
        self,
        *,
        session: Session | None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]:
        try:
            gate = self._live_submission_gate(session=session)
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            logger.exception(
                "Local paper-route target plan unavailable for bounded probe"
            )
            return (
                set(),
                f"paper_route_target_plan_local_gate_failed:{type(exc).__name__}",
                [],
            )

        plan = paper_route_target_plan_from_payload(gate)
        targets = paper_route_target_plan_targets(plan)
        if not targets:
            return set(), "paper_route_target_plan_missing", []

        resolved_targets: list[dict[str, Any]] = []
        for target in targets:
            resolved_target = self._paper_route_target_with_local_probe_contract(
                {
                    **dict(target),
                    "paper_route_target_plan_source": _safe_text(
                        target.get("paper_route_target_plan_source")
                    )
                    or "local_live_submission_gate",
                },
                strategies=strategies,
            )
            resolved_targets.append(resolved_target)
        symbols = set(
            paper_route_target_plan_probe_symbols({"targets": resolved_targets})
        )
        if not symbols:
            return (
                set(),
                "paper_route_target_plan_probe_symbols_missing",
                resolved_targets,
            )
        return symbols, None, resolved_targets

    def _external_paper_route_target_probe_symbols(
        self,
        *,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[
        set[str],
        str | None,
        list[dict[str, Any]],
    ]:
        url = str(settings.trading_paper_route_target_plan_url or "").strip()
        if not url:
            return set(), None, []
        if self._paper_route_target_plan_url_points_to_current_service(url):
            return self._local_paper_route_target_probe_symbols(
                session=session,
                strategies=strategies,
            )
        plan = fetch_paper_route_target_plan_url(
            url,
            timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
            attempts=_PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
            retry_backoff_seconds=0.25,
        )
        load_error = str(plan.get("load_error") or "").strip()
        if load_error:
            logger.warning(
                "Paper-route target plan unavailable for bounded probe url=%s error=%s attempts=%s",
                url,
                load_error,
                plan.get("fetch_attempts") or 1,
            )
            return set(), load_error, []
        targets = [
            self._paper_route_target_with_local_probe_contract(
                target,
                strategies=strategies,
            )
            for target in paper_route_target_plan_targets(plan)
        ]
        symbols = set(paper_route_target_plan_probe_symbols({"targets": targets}))
        if not symbols:
            return set(), "paper_route_target_plan_probe_symbols_missing", []
        return symbols, None, targets

    def _external_paper_route_target_probe_symbols_cached(
        self,
        *,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]:
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        cached = self._paper_route_target_plan_cache
        if cached is not None:
            symbols, load_error, targets, cached_at = cached
            if (
                now - cached_at.astimezone(timezone.utc)
            ).total_seconds() < _PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS:
                return set(symbols), load_error, [dict(target) for target in targets]
        symbols, load_error, targets = self._external_paper_route_target_probe_symbols(
            session=session,
            strategies=strategies,
        )
        used_stale_success = False
        if load_error:
            success_cached = self._paper_route_target_plan_success_cache
            if success_cached is not None:
                cached_symbols, cached_targets, success_cached_at = success_cached
                success_age_seconds = max(
                    (now - success_cached_at.astimezone(timezone.utc)).total_seconds(),
                    0.0,
                )
                if success_age_seconds < _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS:
                    logger.warning(
                        "Using stale successful paper-route target plan for bounded probe error=%s age_seconds=%.1f",
                        load_error,
                        success_age_seconds,
                    )
                    targets = [
                        {
                            **dict(target),
                            "paper_route_target_plan_cache_status": "stale_success",
                            "paper_route_target_plan_last_load_error": load_error,
                            "paper_route_target_plan_stale_success_age_seconds": int(
                                max(success_age_seconds, 0.0)
                            ),
                        }
                        for target in cached_targets
                    ]
                    symbols = set(cached_symbols)
                    load_error = None
                    used_stale_success = True
        if load_error is None and symbols and targets and not used_stale_success:
            self._paper_route_target_plan_success_cache = (
                set(symbols),
                [dict(target) for target in targets],
                now,
            )
        self._paper_route_target_plan_cache = (
            set(symbols),
            load_error,
            [dict(target) for target in targets],
            now,
        )
        return symbols, load_error, targets

    def _active_bounded_paper_route_target_window(
        self,
        decision: StrategyDecision,
    ) -> dict[str, object] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        symbol = decision.symbol.strip().upper()
        if not symbol:
            return None

        target_symbols, target_plan_error, targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_symbols:
            return None

        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        active_targets: list[dict[str, Any]] = []
        active_windows: list[dict[str, str]] = []
        window_starts: list[datetime] = []
        window_ends: list[datetime] = []
        for target in targets:
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            if symbol not in _target_symbols(target):
                continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            active_targets.append(dict(target))
            window_starts.append(window_start)
            window_ends.append(window_end)
            active_windows.append(
                {
                    "window_start": window_start.isoformat(),
                    "window_end": window_end.isoformat(),
                }
            )
        if not active_targets:
            return None
        gate: dict[str, object] = {
            "mode": "paper_route_target_window_submission_gate",
            "symbol": symbol,
            "account_label": self.account_label,
            "target_count": len(active_targets),
            "target_symbols": sorted(target_symbols),
            "active_windows": active_windows[:5],
            "requires_scoped_source_decision": True,
        }
        if window_starts and window_ends:
            gate["window_start"] = min(window_starts).isoformat()
            gate["window_end"] = max(window_ends).isoformat()
        gate.update(_target_plan_lineage(active_targets, symbol))
        return gate

    @staticmethod
    def _paper_route_target_strategy(
        target: Mapping[str, Any],
        strategies: Sequence[Strategy],
    ) -> Strategy | None:
        lookup_names = {
            value.strip().lower()
            for value in _target_lookup_names(target)
            if value.strip()
        }
        if not lookup_names:
            return None
        for strategy in strategies:
            if any(
                candidate.strip().lower() in lookup_names
                for candidate in _strategy_lookup_names(strategy)
                if candidate.strip()
            ):
                return strategy
        return None

    @staticmethod
    def _paper_route_target_strategy_symbols(strategy: Strategy) -> set[str]:
        raw_symbols = strategy.universe_symbols
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols, (bytes, bytearray)
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        return {symbol for raw in values if (symbol := str(raw).strip().upper())}

    @staticmethod
    def _paper_route_target_source_readiness_from_strategy(
        target: Mapping[str, Any],
        *,
        strategy: Strategy | None,
        raw_probe_symbols: set[str],
        scoped_probe_symbols: set[str],
    ) -> dict[str, object]:
        lookup_names = [
            name for name in _target_lookup_names(target) if str(name).strip()
        ]
        blockers: list[str] = []
        matched: dict[str, object] | None = None
        if strategy is None:
            if not lookup_names:
                blockers.append("source_strategy_lookup_missing")
            blockers.append("source_strategy_missing")
        else:
            if not lookup_names:
                lookup_names = _strategy_lookup_names(strategy)
            matched = {
                "strategy_id": str(strategy.id or ""),
                "strategy_name": str(strategy.name or ""),
                "enabled": bool(strategy.enabled),
                "base_timeframe": str(strategy.base_timeframe or ""),
                "universe_symbols": sorted(
                    SimpleTradingPipeline._paper_route_target_strategy_symbols(strategy)
                ),
                "max_notional_per_trade": str(strategy.max_notional_per_trade or ""),
            }
            if not bool(strategy.enabled):
                blockers.append("source_strategy_disabled")
        if not raw_probe_symbols:
            blockers.append("paper_route_probe_symbol_missing")
        elif not scoped_probe_symbols:
            blockers.append("source_strategy_universe_excludes_probe_symbols")
        source = "local_target_plan_probe_symbols"
        if _target_truthy(target.get("paper_route_probe_strategy_universe_fallback")):
            source = "local_strategy_universe_target_plan_fallback"
        elif strategy is None:
            source = "local_target_plan_strategy_unresolved"
        return {
            "schema_version": "torghut.paper-route-source-decision-readiness.v1",
            "ready": not blockers,
            "source": source,
            "blockers": blockers,
            "strategy_lookup_names": lookup_names,
            "matched_strategy": matched,
            "raw_probe_symbols": sorted(raw_probe_symbols),
            "scoped_probe_symbols": sorted(scoped_probe_symbols),
        }

    def _paper_route_target_with_local_probe_contract(
        self,
        target: Mapping[str, Any],
        *,
        strategies: Sequence[Strategy] | None,
    ) -> dict[str, Any]:
        normalized = dict(target)
        strategy = (
            self._paper_route_target_strategy(normalized, strategies)
            if strategies is not None
            else None
        )
        raw_symbols = _target_symbols(normalized)
        scoped_symbols = set(raw_symbols)
        strategy_symbols: set[str] = set()
        if strategy is not None:
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if not raw_symbols and strategy_symbols:
                raw_symbols = set(strategy_symbols)
                scoped_symbols = set(strategy_symbols)
                normalized.setdefault("paper_route_probe_raw_target_symbols", [])
                normalized.setdefault("paper_route_probe_strategy_scope_applied", True)
                normalized.setdefault(
                    "paper_route_probe_strategy_universe_fallback",
                    True,
                )
                normalized.setdefault(
                    "paper_route_probe_strategy_universe_symbols",
                    sorted(strategy_symbols),
                )
                normalized.setdefault(
                    "paper_route_probe_scope_authority",
                    "strategy_universe",
                )
            elif strategy_symbols:
                scoped_symbols = raw_symbols & strategy_symbols

        if raw_symbols and not _target_symbols(normalized):
            normalized["paper_route_probe_symbols"] = sorted(raw_symbols)
        elif raw_symbols and "paper_route_probe_symbols" not in normalized:
            normalized["paper_route_probe_symbols"] = sorted(raw_symbols)

        if not isinstance(normalized.get("source_decision_readiness"), Mapping):
            normalized["source_decision_readiness"] = (
                self._paper_route_target_source_readiness_from_strategy(
                    normalized,
                    strategy=strategy,
                    raw_probe_symbols=raw_symbols,
                    scoped_probe_symbols=scoped_symbols,
                )
            )
        return normalized

    @staticmethod
    def _paper_route_target_source_decision_metadata(
        *,
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
    ) -> dict[str, Any]:
        lineage = _target_plan_lineage([dict(target)], symbol)
        bounded_collection_authorized = _target_bounded_collection_authorized(target)
        target_runtime_strategy_name = (
            _safe_text(target.get("runtime_strategy_name")) or strategy.name
        )
        metadata: dict[str, Any] = {
            "mode": "paper_route_target_plan_source_decision",
            "source": "external_target_plan_url",
            "symbol": symbol,
            "strategy_name": strategy.name,
            "runtime_strategy_name": target_runtime_strategy_name,
            "strategy_lookup_names": _target_lookup_names(target),
            "paper_route_probe_symbols": sorted(_target_symbols(target)),
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": str(max_notional),
            "paper_route_probe_effective_max_notional": str(max_notional),
            "paper_route_probe_symbol_quantities": {
                item_symbol: str(quantity)
                for item_symbol, quantity in _target_probe_symbol_quantities(
                    target,
                    sorted(_target_symbols(target)),
                ).items()
            },
            "paper_route_target_plan_source": "external_target_plan_url",
            "paper_route_probe_scope_authority": "external_target_plan",
            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": False,
            "source_kind": _safe_text(target.get("source_kind")),
            "account_label": _safe_text(target.get("account_label")),
            "source_account_label": _safe_text(target.get("source_account_label")),
            "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
            "bounded_collection_stage": "bounded_paper_collection",
            "account_stage_runtime_identity": {
                "account_label": _safe_text(target.get("account_label")),
                "source_account_label": _safe_text(target.get("source_account_label")),
                "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
                "runtime_strategy_name": target_runtime_strategy_name,
                "source_kind": _safe_text(target.get("source_kind")),
            },
            "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
            "paper_probation_authorized": bool(
                target.get("paper_probation_authorized")
            ),
            "source_collection_authorized": bool(
                target.get("source_collection_authorized")
            ),
            "source_collection_authorization_scope": _safe_text(
                target.get("source_collection_authorization_scope")
            ),
            "source_collection_reason_codes": [
                str(item).strip()
                for item in _lineage_text_values(
                    target.get("source_collection_reason_codes")
                )
                if str(item).strip()
            ],
            "bounded_evidence_collection_authorized": bounded_collection_authorized,
            "bounded_live_paper_collection_authorized": (bounded_collection_authorized),
            "canary_collection_authorized": bounded_collection_authorized,
            "evidence_collection_ok": _target_truthy(
                target.get("evidence_collection_ok")
            ),
            "bounded_evidence_collection_scope": (
                _safe_text(target.get("bounded_evidence_collection_scope"))
                or "paper_route_probe_next_session_only"
            ),
            "bounded_evidence_collection_max_notional": str(max_notional),
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            **lineage,
        }
        for key in (
            "source_decision_readiness",
            "paper_route_target_account_audit_state",
            "paper_route_target_account_audit_blockers",
            "bounded_evidence_collection_blockers",
            "runtime_window_import_health_gate_blockers",
            "paper_route_account_pre_session_blockers",
            "paper_route_account_contamination_blockers",
            "paper_route_hpairs_symbol_blockers",
            "paper_route_probe_pair_balance_state",
        ):
            if key in target:
                metadata[key] = target[key]
        exit_minute, exit_defaulted = _target_probe_exit_minute_after_open(target)
        if exit_minute is not None:
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            metadata["exit_minute_after_open"] = exit_minute
            metadata["effective_exit_minute_after_open"] = effective_exit_minute
            metadata["exit_due_at"] = (
                window_start + timedelta(minutes=effective_exit_minute)
            ).isoformat()
            if exit_defaulted:
                metadata["paper_route_probe_exit_defaulted"] = True
                metadata["paper_route_probe_exit_default_reason"] = (
                    "target_plan_evidence_collection_session_close"
                )
        for key in (
            "candidate_id",
            "hypothesis_id",
            "observed_stage",
            "strategy_family",
        ):
            value = _safe_text(target.get(key))
            if value is not None:
                metadata[key] = value
        return metadata

    @staticmethod
    def _bounded_paper_route_execution_metadata(
        *,
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        action: str,
        account_label: str | None,
        max_notional: Decimal,
    ) -> dict[str, Any]:
        target_account_label = (
            _safe_text(target.get("account_label"))
            or _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL
        )
        runtime_account_label = (
            _safe_text(account_label)
            or _safe_text(target.get("execution_account_label"))
            or target_account_label
        )
        source_account_label = _safe_text(target.get("source_account_label"))
        execution_policy = {
            "schema_version": "torghut.bounded-paper-route-execution-policy.v1",
            "authority": "bounded_paper_route_collection_only",
            "live_capital_routing_enabled": False,
            "capital_promotion_allowed": False,
            "target_account_label": target_account_label,
            "runtime_account_label": runtime_account_label,
            "source_account_label": source_account_label,
            "strategy_id": str(strategy.id),
            "strategy_name": strategy.name,
            "symbol": symbol,
            "side": action,
            "max_notional": str(max_notional),
            "idempotency_key_basis": "trade_decision_hash_client_order_id",
            "order_feed_linkage_keys": [
                "alpaca_account_label",
                "client_order_id",
            ],
        }
        return {
            "execution_lane": "simple",
            "submit_path": "bounded_paper_route_collection",
            "execution_account_label": runtime_account_label,
            "execution_policy": execution_policy,
            "lineage": {
                "schema_version": "torghut.bounded-paper-route-lineage.v1",
                "hypothesis_id": _safe_text(target.get("hypothesis_id")),
                "candidate_id": _safe_text(target.get("candidate_id")),
                "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
                "target_account_label": target_account_label,
                "runtime_account_label": runtime_account_label,
                "source_account_label": source_account_label,
                "source_kind": _safe_text(target.get("source_kind")),
                "bounded_evidence_collection_scope": _safe_text(
                    target.get("bounded_evidence_collection_scope")
                ),
            },
        }

    @staticmethod
    def _paper_route_target_source_cap(
        params: Mapping[str, Any],
    ) -> Decimal | None:
        metadata = params.get("paper_route_target_plan_source_decision")
        if not isinstance(metadata, Mapping):
            metadata = params.get("paper_route_target_plan")
        if not isinstance(metadata, Mapping):
            return None
        mode = str(cast(Mapping[str, Any], metadata).get("mode") or "").strip()
        if mode != "paper_route_target_plan_source_decision":
            return None
        cap = _optional_decimal(
            cast(Mapping[str, Any], metadata).get(
                "paper_route_probe_next_session_max_notional"
            )
        )
        return cap if cap is not None and cap > 0 else None

    def _paper_route_target_source_decisions(
        self,
        *,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        positions: Sequence[Mapping[str, Any]] | None = None,
        session: Session | None = None,
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            self._record_bounded_target_plan_blocker(
                reason="paper_route_session_window_not_open"
            )
            return []
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            self._record_bounded_target_plan_blocker(
                reason=target_plan_error,
                symbols=target_symbols,
                targets=target_plan_targets,
            )
            return []
        if not target_symbols:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason="paper_route_target_plan_probe_symbols_missing",
                    symbols=target_symbols,
                    targets=target_plan_targets,
                )
            return []

        normalized_allowed = {
            symbol.strip().upper() for symbol in allowed_symbols if symbol.strip()
        }
        decisions: list[StrategyDecision] = []
        seen: set[tuple[str, str, str, str]] = set()
        for raw_target in target_plan_targets:
            target = _bounded_sim_collection_target_with_runtime_account_audit(
                raw_target,
                positions=(
                    positions
                    if _target_requires_bounded_sim_collection_gate(raw_target)
                    else None
                ),
                account_label=self.account_label,
            )
            if _target_requires_bounded_sim_collection_gate(target):
                collection_blockers = _bounded_sim_collection_blockers(
                    target,
                    account_label=self.account_label,
                )
                if collection_blockers:
                    logger.warning(
                        "Skipping paper-route target source collection because bounded SIM collection is not authorized blockers=%s",
                        ",".join(collection_blockers),
                    )
                    continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            target_cap = _target_probe_cap(target)
            if target_cap is None or target_cap <= 0:
                continue
            strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            symbols = sorted(_target_symbols(target) & target_symbols)
            if normalized_allowed:
                symbols = [symbol for symbol in symbols if symbol in normalized_allowed]
            if strategy_symbols:
                symbols = [symbol for symbol in symbols if symbol in strategy_symbols]
            symbol_actions = _target_probe_symbol_actions(target, symbols)
            symbol_quantities = _target_probe_symbol_quantities(target, symbols)
            pair_balance_state = _target_pair_balance_state(target, symbol_actions)
            if _target_requires_bounded_sim_collection_gate(
                target
            ) and self._paper_route_target_account_has_open_exposure(positions):
                logger.warning(
                    "Skipping paper-route target source collection because account "
                    "is not flat for bounded SIM evidence strategy=%s symbols=%s",
                    strategy.name,
                    symbols,
                )
                continue
            if pair_balance_state == "imbalanced":
                logger.warning(
                    "Skipping imbalanced paper-route pair target strategy=%s symbols=%s actions=%s",
                    strategy.name,
                    symbols,
                    symbol_actions,
                )
                continue
            if (
                pair_balance_state == "balanced"
                and any(action == "sell" for action in symbol_actions.values())
                and not settings.trading_allow_shorts
            ):
                logger.warning(
                    "Skipping balanced paper-route pair target because shorts are disabled strategy=%s symbols=%s",
                    strategy.name,
                    symbols,
                )
                continue
            blocked_open_exposure_symbols: list[str] = []
            for symbol in symbols:
                if self._paper_route_target_symbol_has_open_position(
                    positions,
                    symbol,
                ):
                    blocked_open_exposure_symbols.append(symbol)
                    continue
                if (
                    session is not None
                    and self._paper_route_target_symbol_has_open_strategy_exposure(
                        session=session,
                        strategy=strategy,
                        symbol=symbol,
                        account_label=self.account_label,
                        window_start=window_start,
                    )
                ):
                    blocked_open_exposure_symbols.append(symbol)
            if blocked_open_exposure_symbols and pair_balance_state == "balanced":
                logger.warning(
                    "Skipping balanced paper-route pair target because existing "
                    "strategy exposure is still open strategy=%s symbols=%s "
                    "blocked_symbols=%s",
                    strategy.name,
                    symbols,
                    blocked_open_exposure_symbols,
                )
                continue
            for symbol in symbols:
                action = symbol_actions.get(symbol, _target_probe_action(target))
                if action == "sell" and not settings.trading_allow_shorts:
                    continue
                if symbol in blocked_open_exposure_symbols:
                    continue
                if (
                    session is not None
                    and self._paper_route_target_symbol_has_open_profit_proof_exposure(
                        session=session,
                        strategy=strategy,
                        symbol=symbol,
                        account_label=self.account_label,
                        window_start=window_start,
                    )
                ):
                    continue
                key = (str(strategy.id), symbol, window_start.isoformat(), action)
                if key in seen:
                    continue
                seen.add(key)
                metadata = self._paper_route_target_source_decision_metadata(
                    target=target,
                    strategy=strategy,
                    symbol=symbol,
                    window_start=window_start,
                    window_end=window_end,
                    max_notional=target_cap,
                )
                metadata["paper_route_probe_symbol_actions"] = dict(symbol_actions)
                if symbol_quantities:
                    metadata["paper_route_probe_symbol_quantities"] = {
                        item_symbol: str(quantity)
                        for item_symbol, quantity in symbol_quantities.items()
                    }
                metadata["paper_route_probe_pair_balance_required"] = (
                    pair_balance_state != "not_required"
                )
                metadata["paper_route_probe_pair_balance_state"] = pair_balance_state
                metadata["paper_route_probe_leg_action"] = action
                execution_metadata = (
                    self._bounded_paper_route_execution_metadata(
                        target=target,
                        strategy=strategy,
                        symbol=symbol,
                        action=action,
                        account_label=self.account_label,
                        max_notional=target_cap,
                    )
                    if _target_requires_bounded_sim_collection_gate(target)
                    else {}
                )
                source_decision_mode = ROUTE_ACQUISITION_SOURCE_DECISION_MODE
                profit_proof_eligible = False
                if (
                    _safe_text(execution_metadata.get("submit_path"))
                    == "bounded_paper_route_collection"
                ):
                    source_decision_mode = (
                        BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                    )
                    profit_proof_eligible = True
                    metadata["source_decision_mode"] = source_decision_mode
                    metadata["profit_proof_eligible"] = profit_proof_eligible
                    metadata["bounded_paper_route_submit_path"] = execution_metadata[
                        "submit_path"
                    ]
                    metadata["bounded_paper_route_execution_policy"] = (
                        execution_metadata["execution_policy"]
                    )
                simple_lane = {
                    "source": "external_target_plan_url",
                    "target_plan_source_decision": True,
                    "paper_route_probe_max_notional": str(target_cap),
                    "paper_route_probe_window_start": window_start.isoformat(),
                    "paper_route_probe_window_end": window_end.isoformat(),
                    "paper_route_probe_symbol_actions": dict(symbol_actions),
                    **(
                        {
                            "paper_route_probe_symbol_quantities": {
                                item_symbol: str(quantity)
                                for item_symbol, quantity in symbol_quantities.items()
                            }
                        }
                        if symbol_quantities
                        else {}
                    ),
                    "paper_route_probe_pair_balance_state": pair_balance_state,
                    "paper_route_probe_leg_action": action,
                    "live_capital_routing_enabled": False,
                    "client_order_id_basis": "trade_decision_hash",
                    **(
                        {
                            "execution_account_label": execution_metadata[
                                "execution_account_label"
                            ],
                            "submit_path": execution_metadata["submit_path"],
                        }
                        if execution_metadata
                        else {}
                    ),
                }
                params: dict[str, Any] = {
                    "paper_route_target_plan": metadata,
                    "paper_route_target_plan_source_decision": metadata,
                    "simple_lane": simple_lane,
                    "source_decision_mode": source_decision_mode,
                    "profit_proof_eligible": profit_proof_eligible,
                    "hypothesis_id": metadata.get("hypothesis_id"),
                    "candidate_id": metadata.get("candidate_id"),
                    "strategy_name": metadata.get("strategy_name"),
                    "runtime_strategy_name": metadata.get("runtime_strategy_name"),
                    "account_label": metadata.get("account_label"),
                    "source_account_label": metadata.get("source_account_label"),
                    "source_kind": metadata.get("source_kind"),
                    "source_manifest_ref": metadata.get("source_manifest_ref"),
                    "paper_route_target_plan_source": metadata.get(
                        "paper_route_target_plan_source"
                    ),
                    "paper_route_probe_scope_authority": metadata.get(
                        "paper_route_probe_scope_authority"
                    ),
                    "paper_route_probe_symbols": metadata.get(
                        "paper_route_probe_symbols"
                    ),
                    "observed_stage": _safe_text(target.get("observed_stage"))
                    or "paper",
                    "bounded_collection_stage": "bounded_paper_collection",
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_authority_ok": False,
                    "final_promotion_allowed": False,
                    "live_capital_routing_enabled": False,
                    **execution_metadata,
                    **(
                        {
                            "bounded_paper_route_submit_path": execution_metadata[
                                "submit_path"
                            ],
                            "bounded_paper_route_execution_policy": (
                                execution_metadata["execution_policy"]
                            ),
                        }
                        if execution_metadata
                        else {}
                    ),
                    **_target_plan_lineage([dict(target)], symbol),
                }
                if "exit_minute_after_open" in metadata:
                    params["exit_minute_after_open"] = metadata[
                        "exit_minute_after_open"
                    ]
                _merge_paper_route_probe_lineage(
                    params,
                    _paper_route_probe_lineage_from_params(params),
                )
                timeframe = (
                    _safe_text(target.get("timeframe"))
                    or _safe_text(target.get("base_timeframe"))
                    or _safe_text(strategy.base_timeframe)
                    or "1Min"
                )
                decisions.append(
                    StrategyDecision(
                        strategy_id=str(strategy.id),
                        symbol=symbol,
                        event_ts=now,
                        timeframe=timeframe,
                        action=action,
                        qty=symbol_quantities.get(symbol, Decimal("1")),
                        order_type="market",
                        time_in_force="day",
                        rationale="external paper-route target plan source decision",
                        params=params,
                    )
                )
        return decisions

    def _paper_route_target_plan_reserves_account(
        self,
        *,
        allowed_symbols: set[str],
    ) -> bool:
        if settings.trading_mode != "paper":
            return False
        if not settings.trading_simple_paper_route_probe_enabled:
            return False
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            return False
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason=target_plan_error,
                    symbols=target_symbols,
                    targets=target_plan_targets,
                )
                return True
            return False
        if not target_symbols:
            return False
        normalized_allowed = {
            symbol.strip().upper() for symbol in allowed_symbols if symbol.strip()
        }
        for target in target_plan_targets:
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            if not _bounded_sim_collection_reserves_account(
                target,
                account_label=self.account_label,
            ):
                continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            symbols = _target_symbols(target) & target_symbols
            if normalized_allowed:
                symbols = {symbol for symbol in symbols if symbol in normalized_allowed}
            if symbols:
                return True
        return False

    @staticmethod
    def _paper_route_target_symbol_has_open_strategy_exposure(
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        account_label: str,
        window_start: datetime,
    ) -> bool:
        strategy_id = getattr(strategy, "id", None)
        normalized_symbol = symbol.strip().upper()
        if strategy_id is None or not normalized_symbol:
            return False

        guard_start = window_start - _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK
        try:
            rows = session.execute(
                select(Execution.side, Execution.filled_qty, Execution.created_at)
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == account_label,
                    TradeDecision.alpaca_account_label == account_label,
                    TradeDecision.strategy_id == strategy_id,
                    Execution.symbol == normalized_symbol,
                    TradeDecision.symbol == normalized_symbol,
                    Execution.filled_qty > 0,
                    Execution.status.in_(("filled", "partially_filled")),
                    Execution.created_at >= guard_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route target strategy exposure "
                "strategy_id=%s symbol=%s account_label=%s",
                strategy_id,
                normalized_symbol,
                account_label,
            )
            return True

        signed_qty = Decimal("0")
        latest_fill_at: datetime | None = None
        for row in rows:
            side = row[0]
            filled_qty = row[1]
            created_at = row[2] if len(row) > 2 else None
            qty = _optional_decimal(filled_qty)
            if qty is None or qty <= 0:
                continue
            if str(side or "").strip().lower() == "sell":
                signed_qty -= qty
            else:
                signed_qty += qty
            if isinstance(created_at, datetime):
                latest_fill_at = (
                    created_at
                    if latest_fill_at is None or created_at > latest_fill_at
                    else latest_fill_at
                )
        if abs(signed_qty) <= _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON:
            return False
        if SimpleTradingPipeline._paper_route_target_symbol_has_flat_repair_snapshot(
            session=session,
            account_label=account_label,
            symbol=normalized_symbol,
            after=latest_fill_at,
        ):
            return False
        return True

    @staticmethod
    def _paper_route_target_symbol_has_flat_repair_snapshot(
        *,
        session: Session,
        account_label: str,
        symbol: str,
        after: datetime | None,
    ) -> bool:
        if after is None:
            return False
        try:
            row = session.execute(
                select(PositionSnapshot.positions, PositionSnapshot.as_of)
                .where(
                    PositionSnapshot.alpaca_account_label == account_label,
                    PositionSnapshot.as_of >= after,
                )
                .order_by(desc(PositionSnapshot.as_of))
                .limit(1)
            ).first()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route flat repair snapshot symbol=%s account_label=%s",
                symbol,
                account_label,
            )
            return False
        if row is None:
            return False
        positions = row[0]
        if not isinstance(positions, Sequence) or isinstance(
            positions, (bytes, bytearray, str)
        ):
            return False
        return not SimpleTradingPipeline._paper_route_target_symbol_has_open_position(
            cast(Sequence[Mapping[str, Any]], positions),
            symbol,
        )

    @staticmethod
    def _paper_route_target_symbol_has_open_profit_proof_exposure(
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        account_label: str,
        window_start: datetime,
    ) -> bool:
        strategy_id = getattr(strategy, "id", None)
        normalized_symbol = symbol.strip().upper()
        if strategy_id is None or not normalized_symbol:
            return False

        guard_start = window_start - _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK
        try:
            rows = session.execute(
                select(
                    Execution.side,
                    Execution.filled_qty,
                    TradeDecision.decision_json,
                )
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == account_label,
                    TradeDecision.alpaca_account_label == account_label,
                    TradeDecision.strategy_id == strategy_id,
                    Execution.symbol == normalized_symbol,
                    TradeDecision.symbol == normalized_symbol,
                    Execution.filled_qty > 0,
                    Execution.status.in_(("filled", "partially_filled")),
                    Execution.created_at >= guard_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route target source proof exposure "
                "strategy_id=%s symbol=%s account_label=%s",
                strategy_id,
                normalized_symbol,
                account_label,
            )
            return True

        signed_qty = Decimal("0")
        for side, filled_qty, raw_decision_json in rows:
            if not isinstance(raw_decision_json, Mapping):
                continue
            decision_json = cast(Mapping[str, Any], raw_decision_json)
            raw_params = decision_json.get("params")
            if not isinstance(raw_params, Mapping):
                continue
            params = cast(Mapping[str, Any], raw_params)
            lineage = _paper_route_probe_lineage_from_params(params)
            profit_proof_eligible = _target_bool(lineage.get("profit_proof_eligible"))
            if profit_proof_eligible is False:
                continue
            if (
                profit_proof_eligible is not True
                and not source_decision_mode_is_profit_proof_eligible(
                    lineage.get("source_decision_mode")
                )
            ):
                continue
            qty = _optional_decimal(filled_qty)
            if qty is None or qty <= 0:
                continue
            if str(side or "").strip().lower() == "sell":
                signed_qty -= qty
            else:
                signed_qty += qty
        return abs(signed_qty) > _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON

    @staticmethod
    def _paper_route_target_symbol_has_open_position(
        positions: Sequence[Mapping[str, Any]] | None,
        symbol: str,
    ) -> bool:
        if not positions:
            return False
        normalized_symbol = symbol.strip().upper()
        if not normalized_symbol:
            return False
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            for qty_key in ("qty", "quantity", "qty_available"):
                qty = _optional_decimal(position.get(qty_key))
                if qty is not None and qty != 0:
                    return True
            market_value = _optional_decimal(position.get("market_value"))
            if market_value is not None and market_value != 0:
                return True
        return False

    @staticmethod
    def _paper_route_target_account_has_open_exposure(
        positions: Sequence[Mapping[str, Any]] | None,
    ) -> bool:
        if not positions:
            return False
        for position in positions:
            for qty_key in ("qty", "quantity", "qty_available"):
                qty = _optional_decimal(position.get(qty_key))
                if qty is not None and qty != 0:
                    return True
            market_value = _optional_decimal(position.get("market_value"))
            if market_value is not None and market_value != 0:
                return True
        return False

    def _paper_route_target_lineage_for_decision(
        self,
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> dict[str, Any]:
        if settings.trading_mode != "paper":
            return {}
        if not settings.trading_simple_paper_route_probe_enabled:
            return {}
        symbol = decision.symbol.strip().upper()
        if not symbol:
            return {}
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_plan_symbols:
            return {}
        matching_targets: list[dict[str, Any]] = []
        for target in target_plan_targets:
            target_symbols = _target_symbols(target)
            if target_symbols and symbol not in target_symbols:
                continue
            if not self._target_matches_decision_strategy(target, decision, strategy):
                continue
            if _target_probe_window(target) is not None and not (
                self._decision_event_in_target_window(decision, target)
            ):
                continue
            matching_targets.append(dict(target))
        if not matching_targets:
            return {}
        lineage = _target_plan_lineage(matching_targets, symbol)
        if not any(
            lineage.get(key)
            for key in (
                "source_candidate_ids",
                "source_hypothesis_ids",
                "paper_route_probe_lineage_targets",
            )
        ):
            return {}
        return {
            "mode": "paper_route_target_lineage",
            "source": "external_target_plan_url",
            "symbol": symbol,
            "paper_route_target_plan_symbols": sorted(target_plan_symbols),
            **lineage,
        }

    @staticmethod
    def _target_matches_decision_strategy(
        target: Mapping[str, Any],
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> bool:
        lookup_names = {value.lower() for value in _target_lookup_names(target)}
        if not lookup_names:
            return False
        candidate_names = {
            str(decision.strategy_id).strip(),
        }
        if strategy is not None:
            candidate_names.update(_strategy_lookup_names(strategy))
        return any(
            candidate.strip().lower() in lookup_names
            for candidate in candidate_names
            if candidate.strip()
        )

    @staticmethod
    def _decision_event_in_target_window(
        decision: StrategyDecision,
        target: Mapping[str, Any],
    ) -> bool:
        window = _target_probe_window(target)
        if window is None:
            return False
        window_start, window_end = window
        event_ts = decision.event_ts
        if event_ts.tzinfo is None:
            event_ts = event_ts.replace(tzinfo=timezone.utc)
        event_ts = event_ts.astimezone(timezone.utc)
        return window_start <= event_ts < window_end

    def _strategy_signal_paper_target_for_decision(
        self,
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> Mapping[str, Any] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        if self._paper_route_target_source_cap(decision.params) is not None:
            return None
        if isinstance(
            decision.params.get("paper_route_target_plan_source_decision"), Mapping
        ):
            return None
        if isinstance(decision.params.get("paper_route_probe_exit"), Mapping):
            return None
        existing_mode = (
            str(decision.params.get("source_decision_mode") or "")
            .strip()
            .lower()
            .replace("-", "_")
        )
        if existing_mode == ROUTE_ACQUISITION_SOURCE_DECISION_MODE:
            return None
        symbol = decision.symbol.strip().upper()
        if not symbol:
            return None
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or symbol not in target_plan_symbols:
            return None
        for target in target_plan_targets:
            target_symbols = _target_symbols(target)
            if target_symbols and symbol not in target_symbols:
                continue
            if not self._decision_event_in_target_window(decision, target):
                continue
            if not self._target_matches_decision_strategy(target, decision, strategy):
                continue
            if _safe_text(target.get("candidate_id")) is None:
                continue
            if _safe_text(target.get("hypothesis_id")) is None:
                continue
            if str(target.get("observed_stage") or "").strip().lower() != "paper":
                continue
            if not _target_has_bounded_sim_collection_source_kind(target):
                continue
            if _target_requires_bounded_sim_collection_gate(target):
                blockers = _bounded_sim_collection_blockers(
                    target,
                    account_label=self.account_label,
                )
                if blockers:
                    logger.warning(
                        "Skipping strategy-signal paper authority because bounded SIM "
                        "collection is not authorized strategy=%s symbol=%s blockers=%s",
                        strategy.name if strategy is not None else decision.strategy_id,
                        symbol,
                        ",".join(blockers),
                    )
                    continue
            if not _target_truthy(target.get("paper_probation_authorized")):
                continue
            return target
        return None

    @staticmethod
    def _strategy_signal_paper_metadata(
        *,
        decision: StrategyDecision,
        target: Mapping[str, Any],
        strategy: Strategy | None,
    ) -> dict[str, Any]:
        lineage = _target_plan_lineage([dict(target)], decision.symbol)
        window = _target_probe_window(target)
        metadata: dict[str, Any] = {
            "mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
            "source": "external_target_plan_url",
            "symbol": decision.symbol.strip().upper(),
            "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
            "profit_proof_eligible": True,
            "paper_route_target_plan_source": "external_target_plan_url",
            "paper_route_probe_scope_authority": "external_target_plan",
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            **lineage,
        }
        if strategy is not None:
            metadata["strategy_name"] = strategy.name
            metadata["strategy_id"] = str(strategy.id)
        for key in (
            "candidate_id",
            "hypothesis_id",
            "observed_stage",
            "strategy_family",
            "runtime_strategy_name",
            "source_kind",
            "source_manifest_ref",
            "dataset_snapshot_ref",
        ):
            value = _safe_text(target.get(key))
            if value is not None:
                metadata[key] = value
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
            value = _safe_text(target.get(key))
            if value is not None:
                metadata[key] = value
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS:
            value = _target_bool(target.get(key))
            if value is not None:
                metadata[key] = value
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS:
            value = target.get(key)
            if isinstance(value, Mapping):
                metadata[key] = dict(cast(Mapping[str, Any], value))
        for key in _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS:
            values = _lineage_text_values(target.get(key))
            if values:
                metadata[key] = values
        symbols = _lineage_text_values(target.get("paper_route_probe_symbols"))
        if symbols:
            metadata["paper_route_probe_symbols"] = symbols
        for key in (
            "paper_route_probe_pair_balance_required",
            "paper_route_probe_pair_balance_state",
        ):
            value = target.get(key)
            if value is not None:
                metadata[key] = value
        if window is not None:
            window_start, window_end = window
            metadata["paper_route_probe_window_start"] = window_start.isoformat()
            metadata["paper_route_probe_window_end"] = window_end.isoformat()
            exit_minute, exit_defaulted = _target_probe_exit_minute_after_open(target)
            if exit_minute is not None:
                effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
                metadata["exit_minute_after_open"] = exit_minute
                metadata["effective_exit_minute_after_open"] = effective_exit_minute
                metadata["exit_due_at"] = (
                    window_start + timedelta(minutes=effective_exit_minute)
                ).isoformat()
                if exit_defaulted:
                    metadata["paper_route_probe_exit_defaulted"] = True
                    metadata["paper_route_probe_exit_default_reason"] = (
                        "target_plan_evidence_collection_session_close"
                    )
        return metadata

    def _with_paper_route_target_lineage(
        self,
        decision: StrategyDecision,
        *,
        strategy: Strategy | None = None,
    ) -> StrategyDecision:
        lineage = self._paper_route_target_lineage_for_decision(decision, strategy)
        if not lineage:
            return decision
        params = dict(decision.params)
        existing = params.get("paper_route_target_plan")
        if isinstance(existing, Mapping):
            merged_target_plan = dict(cast(Mapping[str, Any], existing))
            _merge_paper_route_probe_lineage(merged_target_plan, lineage)
            for key, value in lineage.items():
                merged_target_plan.setdefault(key, value)
            params["paper_route_target_plan"] = merged_target_plan
        else:
            params["paper_route_target_plan"] = lineage
        _merge_paper_route_probe_lineage(params, lineage)
        strategy_signal_target = self._strategy_signal_paper_target_for_decision(
            decision, strategy
        )
        if strategy_signal_target is not None:
            metadata = self._strategy_signal_paper_metadata(
                decision=decision,
                target=strategy_signal_target,
                strategy=strategy,
            )
            params["strategy_signal_paper"] = metadata
            params["source_decision_mode"] = STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE
            params["profit_proof_eligible"] = True
            params.setdefault("promotion_allowed", False)
            params.setdefault("final_promotion_authorized", False)
            params.setdefault("final_promotion_allowed", False)
            if "exit_minute_after_open" in metadata:
                params.setdefault(
                    "exit_minute_after_open",
                    metadata["exit_minute_after_open"],
                )
            target_plan = params.get("paper_route_target_plan")
            if isinstance(target_plan, Mapping):
                merged_target_plan = dict(cast(Mapping[str, Any], target_plan))
                for key, value in metadata.items():
                    merged_target_plan.setdefault(key, value)
                params["paper_route_target_plan"] = merged_target_plan
        return decision.model_copy(update={"params": params})

    def _paper_route_probe_context(
        self,
        *,
        proof_floor: Mapping[str, object],
        decision: StrategyDecision,
        strategy: Strategy | None = None,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> dict[str, object] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        if (
            decision.action == "sell"
            and not settings.trading_allow_shorts
            and self._paper_route_probe_short_increasing_sell(decision)
        ):
            return None
        if decision.action not in {"buy", "sell"}:
            return None
        target_source_cap = self._paper_route_target_source_cap(decision.params)
        if target_source_cap is not None:
            cap = target_source_cap
        else:
            cap = _optional_decimal(
                settings.trading_simple_paper_route_probe_max_notional
            )
        if cap is None or cap <= 0:
            return None
        if not self._proof_floor_market_session_open(proof_floor):
            return None
        if self._paper_route_probe_entry_after_exit_minute(
            decision=decision,
            strategy=strategy,
        ):
            return None
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        effective_exit_minute: int | None = None
        exit_due_at: str | None = None
        if exit_minute is not None:
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
            session_open = regular_session_open_utc_for(now)
            exit_due_at = (
                session_open + timedelta(minutes=effective_exit_minute)
            ).isoformat()

        blocking_reasons = {
            str(item).strip()
            for item in cast(list[object], proof_floor.get("blocking_reasons") or [])
            if str(item).strip()
        }
        symbol = decision.symbol.strip().upper()
        target_plan_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            return None
        if target_plan_symbols and symbol not in target_plan_symbols:
            return None
        target_source_authorized = (
            self._paper_route_target_source_cap(decision.params) is not None
            and bool(target_plan_symbols)
            and symbol in target_plan_symbols
        )
        if target_plan_symbols and not target_source_authorized:
            return None
        symbol_route_probe_reasons = self._proof_floor_symbol_route_probe_reasons(
            proof_floor,
            symbol,
        )
        paper_route_probe_symbols = self._proof_floor_paper_route_probe_symbols(
            proof_floor
        )
        symbol_paper_route_probe_eligible = symbol in paper_route_probe_symbols
        if not (
            (blocking_reasons & _PAPER_ROUTE_PROBE_REASONS)
            or symbol_route_probe_reasons
            or symbol_paper_route_probe_eligible
            or target_source_authorized
        ):
            return None

        repair_symbols = self._proof_floor_route_repair_symbols(proof_floor)
        if (
            repair_symbols
            and symbol not in repair_symbols
            and not symbol_paper_route_probe_eligible
        ):
            return None

        source_decision_mode = ROUTE_ACQUISITION_SOURCE_DECISION_MODE
        profit_proof_eligible = False
        context_mode = "paper_route_acquisition"
        bounded_execution_policy: Mapping[str, Any] | None = None
        bounded_submit_path: str | None = None
        if target_source_authorized:
            requested_source_decision_mode = normalize_source_decision_mode(
                decision.params.get("source_decision_mode")
            )
            if (
                requested_source_decision_mode
                == BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                and _target_bool(decision.params.get("profit_proof_eligible")) is True
            ):
                source_decision_mode = (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                )
                profit_proof_eligible = True
                context_mode = "bounded_paper_route_collection"
                raw_bounded_policy = decision.params.get(
                    "bounded_paper_route_execution_policy"
                )
                if isinstance(raw_bounded_policy, Mapping):
                    bounded_execution_policy = cast(
                        Mapping[str, Any], raw_bounded_policy
                    )
                bounded_submit_path = _safe_text(
                    decision.params.get("bounded_paper_route_submit_path")
                )

        context: dict[str, object] = {
            "enabled": True,
            "mode": context_mode,
            "source_decision_mode": source_decision_mode,
            "profit_proof_eligible": profit_proof_eligible,
            "max_notional": str(cap),
            "symbol": symbol,
            "side": decision.action,
            "blocking_reasons": sorted(blocking_reasons | symbol_route_probe_reasons),
            "target_source_authorized": target_source_authorized,
            "route_repair_symbols": sorted(repair_symbols),
            "paper_route_probe_symbols": sorted(paper_route_probe_symbols),
            "paper_route_target_plan_symbols": sorted(target_plan_symbols),
            "paper_route_target_plan_source": "external_target_plan_url"
            if target_plan_symbols
            else None,
            **_target_plan_lineage(target_plan_targets, symbol),
            "exit_minute_after_open": exit_minute,
            "effective_exit_minute_after_open": effective_exit_minute,
            "exit_due_at": exit_due_at,
            "simple_submit_enabled": settings.trading_simple_submit_enabled,
            "simple_submit_bypass_scope": "paper_route_probe_only"
            if not settings.trading_simple_submit_enabled
            else None,
        }
        if bounded_execution_policy is not None:
            context["bounded_paper_route_execution_policy"] = dict(
                bounded_execution_policy
            )
        if bounded_submit_path is not None:
            context["bounded_paper_route_submit_path"] = bounded_submit_path
        return context

    @staticmethod
    def _paper_route_probe_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "blocked":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, object], decision_json_raw)
        if decision_json.get("submission_stage") != "blocked_profitability_proof_floor":
            return None
        reason = str(decision_json.get("submission_block_reason") or "").strip()
        if not reason:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        proof_floor = decision_json.get("profitability_proof_floor")
        if not isinstance(proof_floor, Mapping):
            return None
        return {
            "previous_submission_stage": "blocked_profitability_proof_floor",
            "previous_submission_block_reason": reason,
            "previous_decision_status": "blocked",
            "previous_paper_route_probe_retry_attempts": retry_attempts,
        }

    def _reopen_bounded_sim_collection_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_metadata = self._paper_route_probe_retry_metadata(decision_row)
        if retry_metadata is None:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None
        collection_metadata = _bounded_sim_collection_metadata_from_decision(
            decision,
            account_label=self.account_label,
            trading_mode=settings.trading_mode,
        )
        if collection_metadata is None:
            return None
        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None

        decision_row.status = "planned"
        decision_row.created_at = trading_now(account_label=self.account_label)
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["bounded_sim_collection_retry"] = {
            **retry_metadata,
            "submission_stage": "bounded_sim_collection_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "collection_metadata": dict(collection_metadata),
        }
        decision_json["submission_stage"] = "bounded_sim_collection_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded SIM evidence collection strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row

    def _claim_materialized_paper_route_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        row_id_text = _safe_text(
            decision.params.get("paper_route_materialized_trade_decision_id")
        )
        if row_id_text is None:
            return None
        try:
            row_id = UUID(row_id_text)
        except ValueError:
            return None
        decision_row = session.get(TradeDecision, row_id)
        if decision_row is None:
            return None
        if decision_row.alpaca_account_label != self.account_label:
            return None
        if decision_row.status != "planned":
            return None
        if self.executor.execution_exists(session, decision_row):
            return None

        decision_row.strategy_id = strategy.id
        decision_row.symbol = decision.symbol
        decision_row.timeframe = decision.timeframe
        decision_row.decision_json = coerce_json_payload(
            decision.model_dump(mode="json")
        )
        decision_row.rationale = decision.rationale
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        return decision_row

    def _ensure_pending_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        decision = self._with_paper_route_target_lineage(decision, strategy=strategy)
        if (
            _safe_text(
                decision.params.get("paper_route_materialized_trade_decision_id")
            )
            is not None
        ):
            decision_row = self._claim_materialized_paper_route_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
            if decision_row is None:
                return None
        else:
            decision_row = self.executor.ensure_decision(
                session, decision, strategy, self.account_label
            )
        reopened_quote_routeability = (
            self._reopen_rejected_paper_route_quote_routeability_decision(
                session=session,
                decision=decision,
                decision_row=decision_row,
            )
        )
        if reopened_quote_routeability is not None:
            return reopened_quote_routeability
        if "paper_route_target_plan" in decision.params:
            self.executor.update_decision_params(session, decision_row, decision.params)
            self.executor.sync_decision_state(session, decision_row, decision)
        reopened_exit = self._reopen_rejected_paper_route_probe_exit_decision(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened_exit is not None:
            return reopened_exit
        reopened_price_retry = self._reopen_rejected_paper_route_target_price_decision(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened_price_retry is not None:
            return reopened_price_retry
        if (
            decision_row.status == "planned"
            and self._paper_route_target_source_cap(decision.params) is not None
        ):
            decision_row.created_at = trading_now(account_label=self.account_label)
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)
        reopened_bounded_collection = self._reopen_bounded_sim_collection_decision(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened_bounded_collection is not None:
            return reopened_bounded_collection
        if (
            _safe_text(
                decision.params.get("paper_route_materialized_trade_decision_id")
            )
            is not None
        ):
            return decision_row
        retry_metadata = self._paper_route_probe_retry_metadata(decision_row)
        if retry_metadata is None:
            return super()._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
        if self.executor.execution_exists(session, decision_row):
            return None

        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None
        probe_context = self._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=decision,
            strategy=strategy,
            session=session,
            strategies=[strategy],
        )
        if probe_context is None:
            return None
        if self._paper_route_probe_reference_price(decision) is None:
            return None

        decision_row.status = "planned"
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_probe_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_probe_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "context": dict(probe_context),
        }
        decision_json["submission_stage"] = "paper_route_probe_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded paper route probe strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row

    def _paper_route_probe_capped_decision(
        self,
        *,
        decision: StrategyDecision,
        proof_floor: Mapping[str, object],
        context: Mapping[str, object],
    ) -> StrategyDecision | None:
        cap = _optional_decimal(context.get("max_notional"))
        price = self._paper_route_probe_reference_price(decision)
        if cap is None or cap <= 0 or price is None or price <= 0:
            return None

        capped_qty = (cap / price).quantize(
            _PAPER_ROUTE_PROBE_QTY_STEP,
            rounding=ROUND_DOWN,
        )
        if capped_qty <= 0:
            return None
        target_source_authorized = bool(context.get("target_source_authorized"))
        if decision.qty > 0 and not target_source_authorized:
            capped_qty = min(decision.qty, capped_qty)

        capped_notional = capped_qty * price
        params = dict(decision.params)
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["final_qty"] = str(capped_qty)
        simple_lane["notional"] = str(capped_notional)
        simple_lane["paper_route_probe_cap_applied"] = True
        if target_source_authorized:
            simple_lane["target_source_notional_sized"] = True
        params["simple_lane"] = simple_lane
        params["paper_route_probe"] = {
            **dict(context),
            "reference_price": str(price),
            "capped_qty": str(capped_qty),
            "capped_notional": str(capped_notional),
            "capital_stage": str(proof_floor.get("capital_state") or "zero_notional"),
            "target_source_notional_sized": target_source_authorized,
        }
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return decision.model_copy(update={"qty": capped_qty, "params": params})

    def _align_prechecked_paper_route_probe_cap(
        self,
        decision: StrategyDecision,
    ) -> StrategyDecision:
        metadata = _paper_route_probe_entry_metadata(decision.params)
        if metadata is None:
            return decision
        price = self._paper_route_probe_reference_price(decision)
        if price is None or price <= 0:
            return decision

        notional = decision.qty * price
        params = dict(decision.params)
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["final_qty"] = str(decision.qty)
        simple_lane["notional"] = str(notional)
        simple_lane["paper_route_probe_cap_applied"] = True
        if bool(metadata.get("target_source_authorized")):
            simple_lane["target_source_notional_sized"] = True

        probe_metadata = dict(metadata)
        probe_metadata["reference_price"] = str(price)
        probe_metadata["capped_qty"] = str(decision.qty)
        probe_metadata["capped_notional"] = str(notional)

        params["simple_lane"] = simple_lane
        params["paper_route_probe"] = probe_metadata
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return decision.model_copy(update={"params": params})

    @staticmethod
    def _proof_floor_symbol_block_reason(
        proof_floor: Mapping[str, object],
        symbol: str,
    ) -> str | None:
        candidate_symbols = SimpleTradingPipeline._proof_floor_route_candidate_symbols(
            proof_floor
        )
        if not candidate_symbols:
            return None
        normalized_symbol = symbol.strip().upper()
        if normalized_symbol and normalized_symbol not in candidate_symbols:
            return "profitability_route_symbol_excluded"
        return None

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        if not settings.trading_enabled:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason="trading_disabled",
                submission_stage="blocked_trading_disabled",
            )
            return False
        firewall_status = self.order_firewall.status()
        if firewall_status.kill_switch_enabled:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=["kill_switch_enabled"],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return False
        if settings.trading_mode == "live":
            live_submission_gate = self._live_submission_gate(session=session)
            if not bool(live_submission_gate.get("allowed", False)):
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason=str(
                        live_submission_gate.get("reason")
                        or "live_submission_gate_blocked"
                    ),
                    submission_stage="blocked_live_submission_gate",
                    extra_metadata={"live_submission_gate": live_submission_gate},
                )
                return False
        proof_floor = self._profitability_proof_floor(session=session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        paper_route_probe_applied = False
        if proof_floor_block_reason is not None:
            collection_metadata = _bounded_sim_collection_metadata_from_decision(
                decision,
                account_label=self.account_label,
                trading_mode=settings.trading_mode,
            )
            if not settings.trading_simple_submit_enabled:
                if collection_metadata is None:
                    self._block_decision_submission(
                        session=session,
                        decision=decision,
                        decision_row=decision_row,
                        reason="simple_submit_disabled",
                        submission_stage="blocked_simple_submit_disabled",
                        capital_stage="shadow",
                        extra_metadata={
                            "simple_lane": {
                                "submit_enabled": False,
                                "bounded_sim_collection_bypass": False,
                                "bounded_sim_collection_required": True,
                                "proof_floor_block_reason": proof_floor_block_reason,
                            }
                        },
                    )
                    return False
            if settings.trading_mode == "paper" and (
                self._paper_route_probe_exit_metadata(decision) is not None
                or _paper_route_probe_entry_metadata(decision.params) is not None
                or collection_metadata is not None
            ):
                paper_route_probe_applied = True
            if not paper_route_probe_applied:
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason=proof_floor_block_reason,
                    submission_stage="blocked_profitability_proof_floor",
                    capital_stage=str(
                        proof_floor.get("capital_state") or "zero_notional"
                    ),
                    extra_metadata={"profitability_proof_floor": dict(proof_floor)},
                )
                return False
        proof_floor_symbol_block_reason = (
            self._proof_floor_symbol_block_reason(
                proof_floor,
                decision.symbol,
            )
            if not paper_route_probe_applied
            else None
        )
        if proof_floor_symbol_block_reason is not None:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=proof_floor_symbol_block_reason,
                submission_stage="blocked_profitability_route_symbol",
                capital_stage=str(proof_floor.get("capital_state") or "zero_notional"),
                extra_metadata={"profitability_proof_floor": dict(proof_floor)},
            )
            return False
        if settings.trading_emergency_stop_enabled and self.state.emergency_stop_active:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=self.state.emergency_stop_reason or "emergency_stop_active",
                submission_stage="blocked_emergency_stop",
            )
            return False
        active_target_window = self._active_bounded_paper_route_target_window(decision)
        if active_target_window is not None:
            collection_metadata = _bounded_sim_collection_metadata_from_decision(
                decision,
                account_label=self.account_label,
                trading_mode=settings.trading_mode,
            )
            exit_metadata = self._paper_route_probe_exit_metadata(decision)
            if collection_metadata is None and exit_metadata is None:
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason="paper_route_target_window_requires_scoped_source_decision",
                    submission_stage="blocked_paper_route_target_window_unscoped",
                    capital_stage="shadow",
                    extra_metadata={
                        "paper_route_target_window": active_target_window,
                        "simple_lane": {
                            "submit_enabled": settings.trading_simple_submit_enabled,
                            "bounded_sim_collection_required": True,
                            "bounded_sim_collection_bypass": False,
                        },
                    },
                )
                return False
        return True

    def _execution_client_for_symbol(
        self, symbol: str, *, symbol_allowlist: set[str] | None = None
    ) -> Any:
        _ = (symbol, symbol_allowlist)
        return self.execution_adapter

    def _submit_order_with_handling(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        retry_delays: list[int],
    ) -> tuple[Any | None, bool]:
        try:
            retry_delays_seconds = [float(delay) for delay in retry_delays]
            execution = self.executor.submit_order(
                session,
                execution_client,
                decision,
                decision_row,
                self.account_label,
                execution_expected_adapter=selected_adapter_name,
                retry_delays=retry_delays_seconds,
            )
            return execution, False
        except OrderFirewallBlocked:
            return self._reject_submit(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                reason="kill_switch_enabled",
                rejection_type="firewall_blocked",
            )
        except Exception as exc:
            payload = _extract_json_error_payload(exc) or {}
            reason = self._map_submit_exception(payload)
            metadata = {"broker_precheck": payload} if payload else None
            return self._reject_submit(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                reason=reason,
                rejection_type="submit_failed",
                metadata=metadata,
            )

    def _reject_submit(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        reason: str,
        rejection_type: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons([reason])
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=selected_adapter_name,
        )
        self.executor.mark_rejected(
            session,
            decision_row,
            reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit",
                extra=metadata,
            ),
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.rejected",
            severity="warning",
            decision=decision,
            decision_row=decision_row,
            reason_codes=[reason],
            extra_properties={"rejection_type": rejection_type},
        )
        return None, True

    @staticmethod
    def _map_submit_exception(payload: Mapping[str, Any]) -> str:
        source = str(payload.get("source") or "").strip().lower()
        code = str(payload.get("code") or "").strip().lower()
        if source == "local_pre_submit":
            if code in {"local_qty_invalid_increment"}:
                return "invalid_qty_increment"
            if code in {"local_qty_below_min", "local_qty_non_positive"}:
                return "qty_below_min_after_clamp"
            if code in {
                "local_account_shorting_disabled",
                "local_symbol_not_shortable",
                "local_symbol_not_tradable",
                "local_shorts_not_allowed",
                "shorting_metadata_unavailable",
            }:
                return "shorting_not_allowed_for_asset"
            return "broker_precheck_failed"
        return "broker_submit_failed"

    def _simple_shortability_reason(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
    ) -> str | None:
        if decision.action != "sell":
            return None
        current_qty = position_qty_for_symbol(positions, decision.symbol)
        if current_qty > 0 and decision.qty <= current_qty:
            return None
        if not settings.trading_allow_shorts:
            return "shorting_not_allowed_for_asset"

        account = self.order_firewall.get_account()
        if account is not None:
            shorting_enabled = account.get("shorting_enabled")
            if isinstance(shorting_enabled, bool) and not shorting_enabled:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"

        asset = self.order_firewall.get_asset(decision.symbol)
        if asset is not None:
            tradable = asset.get("tradable")
            shortable = asset.get("shortable")
            if isinstance(tradable, bool) and not tradable:
                return "shorting_not_allowed_for_asset"
            if isinstance(shortable, bool) and not shortable:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"
        return None

    @staticmethod
    def _apply_simple_projected_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
    ) -> None:
        normalized_symbol = decision.symbol.strip().upper()
        updated = False
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            raw_qty = position.get("qty") or position.get("quantity") or "0"
            try:
                qty = Decimal(str(raw_qty))
            except (ArithmeticError, ValueError):
                qty = Decimal("0")
            side = str(position.get("side") or "").strip().lower()
            signed_qty = -abs(qty) if side == "short" else qty
            delta = decision.qty if decision.action == "buy" else -decision.qty
            next_qty = signed_qty + delta
            position["qty"] = str(abs(next_qty))
            position["side"] = "short" if next_qty < 0 else "long"
            updated = True
            break
        if not updated:
            positions.append(
                {
                    "symbol": normalized_symbol,
                    "qty": str(decision.qty),
                    "side": "long" if decision.action == "buy" else "short",
                }
            )

    @staticmethod
    def _apply_simple_projected_buying_power(
        account: dict[str, str],
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
    ) -> None:
        buying_power = _optional_decimal(account.get("buying_power"))
        if buying_power is None:
            return
        notional = _simple_decision_notional(decision)
        if notional is None or notional <= 0:
            return
        consumed = _simple_buying_power_consumption(
            positions=positions,
            decision=decision,
            notional=notional,
        )
        if consumed <= 0:
            return
        account["buying_power"] = str(max(buying_power - consumed, Decimal("0")))


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
