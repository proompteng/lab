# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Order execution and idempotency helpers."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, NamedTuple, Optional, cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    Execution,
    LeanExecutionShadowEvent,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ...config import settings
from ...snapshots import sync_order_to_db
from ..route_metadata import resolve_order_route_metadata
from ..execution_policy import should_retry_order_error
from ..models import ExecutionRequest, StrategyDecision, decision_hash
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    qty_has_valid_increment,
    qty_step_for_symbol,
    resolve_quantity_resolution,
)
from ..simulation import (
    resolve_event_persisted_at,
    resolve_simulation_context,
    simulation_context_enabled,
)
from ..time_source import trading_now
from ..tca import upsert_execution_tca_metric

# ruff: noqa: F401,F403,F405,F811,F821


logger = logging.getLogger(__name__)

_SHORTING_METADATA_CACHE_TTL_SECONDS = 30.0

_EXECUTION_POLICY_HASH_KEYS = (
    "execution_policy_hash",
    "execution_policy_sha256",
    "policy_hash",
)

_COST_MODEL_HASH_KEYS = (
    "cost_model_hash",
    "cost_model_sha256",
    "fee_model_hash",
)

_COST_MODEL_PAYLOAD_KEYS = (
    "cost_model",
    "cost_model_config",
    "transaction_cost_model",
    "fee_model",
    "fees_model",
    "market_impact_cost_model",
    "proportional_cost_model",
)

_LINEAGE_HASH_KEYS = (
    "lineage_hash",
    "candidate_lineage_hash",
    "replay_lineage_hash",
)

_LINEAGE_PAYLOAD_KEYS = (
    "lineage",
    "candidate_lineage",
    "source_lineage",
    "runtime_lineage",
    "replay_lineage",
)

_RUNTIME_COST_PAYLOAD_KEYS = (
    "runtime_ledger_cost",
    "execution_cost",
    "explicit_execution_cost",
)

_RUNTIME_COST_AMOUNT_KEYS = (
    "cost_amount",
    "explicit_cost",
    "commission",
    "fees",
    "fee_amount",
    "broker_fee",
)

_RUNTIME_COST_BASIS_KEYS = (
    "cost_basis",
    "cost_source",
    "fee_basis",
    "commission_basis",
    "broker_fee_basis",
)

_BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE = "bounded_paper_route_collection"

_TARGET_PLAN_SOURCE_DECISION_MODE = "paper_route_target_plan_source_decision"

_TARGET_PLAN_SOURCE_DECISION_REQUIRED_REFS = (
    "hypothesis_id",
    "candidate_id",
    "runtime_strategy_name",
    "account_label",
    "observed_stage",
)


def _mapping_payload(value: object) -> dict[str, Any]:
    coerced = coerce_json_payload(value)
    if not isinstance(coerced, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], coerced).items()}


def _target_plan_source_metadata(payload: object) -> dict[str, Any]:
    payload_mapping = _mapping_payload(payload)
    params = _mapping_payload(payload_mapping.get("params"))
    metadata = _mapping_payload(params.get("paper_route_target_plan_source_decision"))
    if metadata:
        return metadata
    return _mapping_payload(params.get("paper_route_target_plan"))


def _target_plan_source_decision_mode(payload: object) -> str | None:
    payload_mapping = _mapping_payload(payload)
    params = _mapping_payload(payload_mapping.get("params"))
    metadata = _target_plan_source_metadata(payload_mapping)
    for item in (
        params.get("source_decision_mode"),
        metadata.get("source_decision_mode"),
        payload_mapping.get("source_decision_mode"),
    ):
        text = str(item or "").strip()
        if text:
            return text
    return None


def _target_plan_ref_value(payload: object, key: str) -> str | None:
    payload_mapping = _mapping_payload(payload)
    params = _mapping_payload(payload_mapping.get("params"))
    metadata = _target_plan_source_metadata(payload_mapping)
    for item in (params.get(key), metadata.get(key), payload_mapping.get(key)):
        text = str(item or "").strip()
        if text:
            return text
    return None


def _has_target_plan_source_decision(payload: object) -> bool:
    metadata = _target_plan_source_metadata(payload)
    return str(metadata.get("mode") or "").strip() == _TARGET_PLAN_SOURCE_DECISION_MODE


def _target_plan_source_decision_needs_refresh(
    existing_payload: object,
    new_payload: object,
) -> bool:
    """Return true when an idempotent target-plan decision row lacks source refs.

    ``decision_hash`` intentionally ignores telemetry, so a pre-existing planned
    row can otherwise shadow a newer bounded H-PAIRS target-plan decision that
    carries the durable hypothesis/candidate/runtime/account/stage refs needed
    for downstream source evidence.
    """

    if not _has_target_plan_source_decision(new_payload):
        return False
    if (
        _target_plan_source_decision_mode(new_payload)
        != _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
    ):
        return False
    if not _has_target_plan_source_decision(existing_payload):
        return True
    if (
        _target_plan_source_decision_mode(existing_payload)
        != _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
    ):
        return True
    for key in _TARGET_PLAN_SOURCE_DECISION_REQUIRED_REFS:
        new_value = _target_plan_ref_value(new_payload, key)
        existing_value = _target_plan_ref_value(existing_payload, key)
        if new_value and existing_value != new_value:
            return True
    return False


class _OrderExecutorFields:
    """Submit orders to a broker adapter with idempotency guards."""


__all__ = [name for name in globals() if not name.startswith("__")]
