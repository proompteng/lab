"""Simplified trading pipeline with a minimal direct-submit hot path."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, cast
from uuid import UUID

from sqlalchemy import desc, select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ...config import settings
from ...models import Execution, PositionSnapshot, Strategy, TradeDecision
from ...strategies.catalog import extract_catalog_metadata
from ..autonomy import DriftThresholds, detect_drift
from ..empirical_jobs import build_empirical_jobs_status
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..firewall import OrderFirewallBlocked
from ..ingest import SignalBatch
from ..models import SignalEnvelope, StrategyDecision
from ..paper_route_target_plan import (
    fetch_paper_route_target_plan_url,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ..prices import MarketSnapshot
from ..proof_floor import build_profitability_proof_floor_receipt
from ..runtime_decision_authority import (
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
    source_decision_mode_is_profit_proof_eligible,
)
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
_PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS = 60
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = 600
_PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK = timedelta(days=7)
_PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON = Decimal("0.00000001")
_BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"
_BOUNDED_SIM_COLLECTION_SOURCE_KIND = "paper_route_probe_runtime_observed"
_BOUNDED_SIM_COLLECTION_SCOPE = "paper_route_probe_next_session_only"
_BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS = (
    "bounded_evidence_collection_blockers",
    "runtime_window_import_health_gate_blockers",
    "paper_route_account_pre_session_blockers",
    "paper_route_account_contamination_blockers",
    "paper_route_hpairs_symbol_blockers",
)
_BOUNDED_SIM_COLLECTION_RESERVATION_BLOCKERS = frozenset(
    {
        "paper_route_account_contamination_detected",
        "unlinked_order_events_present",
    }
)
_BOUNDED_SIM_COLLECTION_ALLOWED_HEALTH_GATE_BLOCKERS = frozenset(
    {"evidence_continuity_not_ok"}
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
_BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS = ("source_decision_readiness",)
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
    raw_symbols = target.get("paper_route_probe_symbols")
    if isinstance(raw_symbols, str):
        values = raw_symbols.split(",")
    elif isinstance(raw_symbols, Sequence) and not isinstance(
        raw_symbols, (str, bytes, bytearray)
    ):
        values = cast(Sequence[object], raw_symbols)
    else:
        values = ()
    return {symbol for raw in values if (symbol := str(raw).strip().upper())}


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
        strategy_name = _safe_text(target.get("strategy_name"))
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
        if strategy_name and strategy_name not in strategy_names:
            strategy_names.append(strategy_name)
    return {
        "paper_route_probe_lineage_targets": lineage_targets,
        "source_candidate_ids": candidate_ids,
        "source_hypothesis_ids": hypothesis_ids,
        "source_strategy_names": strategy_names,
    }


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
    if _safe_text(target.get("source_kind")) != _BOUNDED_SIM_COLLECTION_SOURCE_KIND:
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
    ):
        blockers.append("bounded_sim_collection_runtime_strategy_missing")
    if _safe_text(target.get("source_manifest_ref")) is None:
        blockers.append("bounded_sim_collection_source_manifest_missing")
    if not (
        _target_truthy(target.get("bounded_evidence_collection_authorized"))
        or _target_truthy(target.get("bounded_live_paper_collection_authorized"))
        or _target_truthy(target.get("canary_collection_authorized"))
    ):
        blockers.append("bounded_sim_collection_authorization_missing")
    if not _target_truthy(target.get("evidence_collection_ok")):
        blockers.append("bounded_sim_collection_evidence_collection_not_ready")
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
    for value in (
        target.get("strategy_id"),
        target.get("runtime_strategy_name"),
        target.get("strategy_name"),
        target.get("strategy_lookup_names"),
    ):
        _merge_unique_texts(names, _lineage_text_values(value))
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


def _target_probe_exit_minute_after_open(
    target: Mapping[str, Any],
) -> tuple[int | None, bool]:
    for key in ("exit_minute_after_open", "paper_route_probe_exit_minute_after_open"):
        exit_minute = SimpleTradingPipeline._paper_route_probe_exit_minute_value(
            target.get(key)
        )
        if exit_minute is not None:
            return exit_minute, False
    if _safe_text(
        target.get("source_kind")
    ) == "paper_route_probe_runtime_observed" and (
        _target_truthy(target.get("bounded_evidence_collection_authorized"))
        or _target_truthy(target.get("paper_probation_authorized"))
        or _target_truthy(target.get("source_collection_authorized"))
    ):
        return _REGULAR_SESSION_MINUTES, True
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


def _paper_route_probe_lineage_from_params(params: Mapping[str, Any]) -> dict[str, Any]:
    payloads: list[Mapping[str, Any]] = [params]
    for key in ("paper_route_probe", "paper_route_probe_exit"):
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
            candidate_ids, _lineage_text_values(payload.get("source_candidate_id"))
        )
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("source_candidate_ids"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("source_hypothesis_id"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("source_hypothesis_ids"))
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
    if hypothesis_ids:
        lineage["source_hypothesis_ids"] = hypothesis_ids
    if strategy_names:
        lineage["source_strategy_names"] = strategy_names
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

            batch = self.ingestor.fetch_signals(session)
            self._record_ingest_window(batch)
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
                    TradeDecision.status == "blocked",
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
            if self._paper_route_probe_retry_metadata(decision_row) is None:
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
            is_entry = _paper_route_probe_entry_metadata(params) is not None
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
                    "paper_route_probe_lineage": {},
                },
            )
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
            params: dict[str, Any] = {
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "source": "filled_paper_route_probe_executions",
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
            decisions.append(
                StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol=symbol,
                    event_ts=exit_due_at,
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
            if row.status in {"planned", "submitted", "filled", "rejected"}:
                if row.status == "rejected" and not self.executor.execution_exists(
                    session, row
                ):
                    continue
                return True
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
    def _external_paper_route_target_probe_symbols() -> tuple[
        set[str],
        str | None,
        list[dict[str, Any]],
    ]:
        url = str(settings.trading_paper_route_target_plan_url or "").strip()
        if not url:
            return set(), None, []
        plan = fetch_paper_route_target_plan_url(
            url,
            timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
            attempts=2,
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
        symbols = paper_route_target_plan_probe_symbols(plan)
        if not symbols:
            return set(), "paper_route_target_plan_probe_symbols_missing", []
        return symbols, None, paper_route_target_plan_targets(plan)

    def _external_paper_route_target_probe_symbols_cached(
        self,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]:
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        cached = self._paper_route_target_plan_cache
        if cached is not None:
            symbols, load_error, targets, cached_at = cached
            if (
                now - cached_at.astimezone(timezone.utc)
            ).total_seconds() < _PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS:
                return set(symbols), load_error, [dict(target) for target in targets]
        symbols, load_error, targets = self._external_paper_route_target_probe_symbols()
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
        lookup_names = set(_target_lookup_names(target))
        if not lookup_names:
            return None
        for strategy in strategies:
            if str(strategy.id) in lookup_names or strategy.name in lookup_names:
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
        bounded_collection_authorized = (
            _target_truthy(target.get("bounded_evidence_collection_authorized"))
            or _target_truthy(target.get("bounded_live_paper_collection_authorized"))
            or _target_truthy(target.get("canary_collection_authorized"))
        )
        metadata: dict[str, Any] = {
            "mode": "paper_route_target_plan_source_decision",
            "source": "external_target_plan_url",
            "symbol": symbol,
            "strategy_name": strategy.name,
            "runtime_strategy_name": _safe_text(target.get("runtime_strategy_name")),
            "strategy_lookup_names": _target_lookup_names(target),
            "paper_route_probe_symbols": sorted(_target_symbols(target)),
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": str(max_notional),
            "paper_route_probe_effective_max_notional": str(max_notional),
            "paper_route_target_plan_source": "external_target_plan_url",
            "paper_route_probe_scope_authority": "external_target_plan",
            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": False,
            "source_kind": _safe_text(target.get("source_kind")),
            "account_label": _safe_text(target.get("account_label")),
            "source_account_label": _safe_text(target.get("source_account_label")),
            "account_stage_runtime_identity": {
                "account_label": _safe_text(target.get("account_label")),
                "source_account_label": _safe_text(target.get("source_account_label")),
                "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
                "runtime_strategy_name": _safe_text(
                    target.get("runtime_strategy_name")
                ),
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
            "bounded_evidence_collection_blockers",
            "runtime_window_import_health_gate_blockers",
            "paper_route_account_pre_session_blockers",
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
            return []
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error or not target_symbols:
            return []

        normalized_allowed = {
            symbol.strip().upper() for symbol in allowed_symbols if symbol.strip()
        }
        decisions: list[StrategyDecision] = []
        seen: set[tuple[str, str, str, str]] = set()
        for target in target_plan_targets:
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
            target_cap = _optional_decimal(
                target.get("paper_route_probe_next_session_max_notional")
            )
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
                simple_lane = {
                    "source": "external_target_plan_url",
                    "target_plan_source_decision": True,
                    "paper_route_probe_max_notional": str(target_cap),
                    "paper_route_probe_window_start": window_start.isoformat(),
                    "paper_route_probe_window_end": window_end.isoformat(),
                    "paper_route_probe_symbol_actions": dict(symbol_actions),
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
                    "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                    "profit_proof_eligible": False,
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_authority_ok": False,
                    "final_promotion_allowed": False,
                    "live_capital_routing_enabled": False,
                    **execution_metadata,
                    **_target_plan_lineage([dict(target)], symbol),
                }
                if "exit_minute_after_open" in metadata:
                    params["exit_minute_after_open"] = metadata[
                        "exit_minute_after_open"
                    ]
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
                        event_ts=window_start,
                        timeframe=timeframe,
                        action=action,
                        qty=Decimal("1"),
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
        if target_plan_error or not target_symbols:
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
            candidate_names.add(str(strategy.id))
            candidate_names.add(str(strategy.name))
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
            if (
                _safe_text(target.get("source_kind"))
                != "paper_route_probe_runtime_observed"
            ):
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
        cap = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_paper_route_probe_max_notional),
            self._paper_route_target_source_cap(decision.params),
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
            self._external_paper_route_target_probe_symbols()
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

        return {
            "enabled": True,
            "mode": "paper_route_acquisition",
            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": False,
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

    def _ensure_pending_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        decision = self._with_paper_route_target_lineage(decision, strategy=strategy)
        decision_row = self.executor.ensure_decision(
            session, decision, strategy, self.account_label
        )
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
