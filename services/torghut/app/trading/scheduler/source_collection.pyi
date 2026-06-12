from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
import logging
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, cast
from urllib.parse import urlsplit
from sqlalchemy import desc, select
from sqlalchemy.orm import Session
from ...config import settings
from ...models import Execution, PositionSnapshot, Strategy, TradeDecision
from ..models import StrategyDecision
from ..paper_route_target_plan import (
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    source_decision_mode_is_profit_proof_eligible,
)
from ..session_context import regular_session_open_utc_for
from .target_plan_helpers import (
    _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL,
    _BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS,
    _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS,
    _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS,
    _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS,
    _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON,
    _PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS,
    _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
    _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS,
    _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK,
    _REGULAR_SESSION_MINUTES,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_reserves_account,
    _bounded_sim_collection_target_with_runtime_account_audit,
    _lineage_text_values,
    _merge_paper_route_probe_lineage,
    _optional_decimal,
    _paper_route_probe_lineage_from_params,
    _safe_text,
    _strategy_lookup_names,
    _target_active_in_window,
    _target_bool,
    _target_bounded_collection_authorized,
    _target_has_bounded_sim_collection_source_kind,
    _target_has_bounded_source_collection_authorization,
    _target_lookup_names,
    _target_missing_explicit_probe_window,
    _target_owns_bounded_sim_collection_account,
    _target_pair_balance_state,
    _target_plan_has_active_bounded_sim_collection_owner,
    _target_plan_lineage,
    _target_probe_action,
    _target_probe_cap,
    _target_probe_exit_minute_after_open,
    _target_probe_symbol_actions,
    _target_probe_symbol_quantities,
    _target_probe_window,
    _target_requires_bounded_sim_collection_gate,
    _target_runtime_account_matches,
    _target_symbols,
    _target_truthy,
)

logger: Any

class SimplePipelineSourceCollectionMixin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def _paper_route_target_plan_url_points_to_current_service(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _local_paper_route_target_probe_symbols(*args: Any, **kwargs: Any) -> Any: ...
    def _external_paper_route_target_probe_symbols(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _external_paper_route_target_probe_symbols_cached(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _active_bounded_paper_route_target_window(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_strategy(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_strategy_symbols(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_source_readiness_from_strategy(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_with_local_probe_contract(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_source_decision_metadata(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _bounded_paper_route_execution_metadata(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_source_cap(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_source_decisions(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_plan_reserves_account(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_symbol_has_open_strategy_exposure(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_symbol_has_flat_repair_snapshot(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_symbol_has_open_profit_proof_exposure(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_symbol_has_open_position(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_positions_without_materialized_open_order_projections(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_position_is_materialized_projection(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_account_has_open_exposure(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_target_lineage_for_decision(*args: Any, **kwargs: Any) -> Any: ...
    def _target_matches_decision_strategy(*args: Any, **kwargs: Any) -> Any: ...
    def _decision_event_in_target_window(*args: Any, **kwargs: Any) -> Any: ...
    def _strategy_signal_paper_target_for_decision(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _strategy_signal_paper_metadata(*args: Any, **kwargs: Any) -> Any: ...
    def _with_paper_route_target_lineage(*args: Any, **kwargs: Any) -> Any: ...
