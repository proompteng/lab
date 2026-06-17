from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
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

logger: Any
_BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL: Any
_BOUNDED_SIM_COLLECTION_BLOCKER_FIELDS: Any
_BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS: Any
_BOUNDED_SIM_COLLECTION_LINEAGE_KEYS: Any
_BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS: Any
_PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON: Any
_PAPER_ROUTE_TARGET_PLAN_CACHE_SECONDS: Any
_PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS: Any
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS: Any
_PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK: Any
_REGULAR_SESSION_MINUTES: Any
_bounded_sim_collection_blockers: Any
_bounded_sim_collection_reserves_account: Any
_bounded_sim_collection_target_with_runtime_account_audit: Any
_lineage_text_values: Any
_merge_paper_route_probe_lineage: Any
_optional_decimal: Any
_paper_route_probe_lineage_from_params: Any
_safe_text: Any
_strategy_lookup_names: Any
_target_active_in_window: Any
_target_bool: Any
_target_bounded_collection_authorized: Any
_target_has_bounded_sim_collection_source_kind: Any
_target_has_bounded_source_collection_authorization: Any
_target_lookup_names: Any
_target_missing_explicit_probe_window: Any
_target_owns_bounded_sim_collection_account: Any
_target_pair_balance_state: Any
_target_plan_has_active_bounded_sim_collection_owner: Any
_target_plan_lineage: Any
_target_probe_action: Any
_target_probe_cap: Any
_target_probe_exit_minute_after_open: Any
_target_probe_symbol_actions: Any
_target_probe_symbol_quantities: Any
_target_probe_window: Any
_target_requires_bounded_sim_collection_gate: Any
_target_runtime_account_matches: Any
_target_symbols: Any
_target_truthy: Any

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
