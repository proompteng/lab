from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
# ruff: noqa: F401,F811,F821
from typing import Any
import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, cast
from sqlalchemy.orm import Session
from ...config import settings
from ...models import Strategy, TradeDecision
from ..firewall import OrderFirewallBlocked
from ..models import SignalEnvelope, StrategyDecision
from ..prices import MarketSnapshot
from ..quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    assess_signal_quote_quality,
)
from ..quantity_rules import quantize_qty_for_symbol, resolve_quantity_resolution
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ..simple_risk import position_qty_for_symbol, prepare_simple_decision

logger: Any
_status: Any
_extract_json_error_payload: Any
_price_snapshot_payload: Any
_PAPER_ROUTE_PROBE_QTY_STEP: Any
_TargetProbeQuantityResolution: Any
_bounded_collection_decision_requires_target_notional_sizing: Any
_bounded_paper_route_collection_entry_metadata: Any
_bounded_sim_collection_metadata_from_decision: Any
_decimal_from_mapping: Any
_executable_bid_ask_present: Any
_first_decimal: Any
_mapping_value: Any
_min_optional_decimal: Any
_optional_decimal: Any
_paper_route_probe_entry_metadata: Any
_parse_target_datetime: Any
_pct_cap_to_notional: Any
_quote_snapshot_from_mapping: Any
_quote_snapshot_reference_price: Any
_safe_int: Any
_safe_text: Any
_simple_buying_power_consumption: Any
_simple_decision_notional: Any
_snapshot_has_executable_quote: Any
_target_metadata_quote_snapshot: Any
_target_notional_sizing_audit_from_params: Any
_target_probe_cap: Any
_target_probe_symbol_actions: Any
_target_probe_symbol_notional_budget: Any
_target_probe_symbol_quantities: Any
_target_symbols: Any
_text_from_mapping: Any

class SimplePipelineSubmissionPreparationMixin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    def _submission_control_plane_snapshot(*args: Any, **kwargs: Any) -> Any: ...
    def _ensure_decision_price(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_params_with_quote_snapshot(*args: Any, **kwargs: Any) -> Any: ...
    def _decision_has_executable_quote_payload(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_price_snapshot_payload(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_sizing_price(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_quantity_resolution(*args: Any, **kwargs: Any) -> Any: ...
    def _decision_quote_snapshot_for_target_sizing(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _bounded_collection_target_sizing_payload(*args: Any, **kwargs: Any) -> Any: ...
    def _bounded_collection_exit_window_elapsed(*args: Any, **kwargs: Any) -> Any: ...
    def _apply_bounded_collection_exit_window_audit(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _bounded_collection_exit_window_guarded_decision(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _apply_bounded_collection_target_sizing_audit(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _bounded_collection_target_notional_sized_decision(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_decision_requires_executable_quote(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _paper_route_quote_routeability(*args: Any, **kwargs: Any) -> Any: ...
    def _apply_quote_lookup_diagnostic_reason(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_target_plan_source_mismatch(*args: Any, **kwargs: Any) -> Any: ...
    def _target_plan_action_for_symbol(*args: Any, **kwargs: Any) -> Any: ...
    def _normalize_target_plan_action(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_quote_routeability_payload(*args: Any, **kwargs: Any) -> Any: ...
    def _paper_route_quote_routeability_retry_metadata(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _reopen_rejected_paper_route_quote_routeability_decision(
        *args: Any, **kwargs: Any
    ) -> Any: ...
    def _prepare_decision_for_submission(*args: Any, **kwargs: Any) -> Any: ...
    def _passes_risk_verdict(*args: Any, **kwargs: Any) -> Any: ...
    def _is_trading_submission_allowed(*args: Any, **kwargs: Any) -> Any: ...
    def _execution_client_for_symbol(*args: Any, **kwargs: Any) -> Any: ...
    def _submit_order_with_handling(*args: Any, **kwargs: Any) -> Any: ...
    def _reject_submit(*args: Any, **kwargs: Any) -> Any: ...
    def _map_submit_exception(*args: Any, **kwargs: Any) -> Any: ...
    def _simple_shortability_reason(*args: Any, **kwargs: Any) -> Any: ...
    def _apply_simple_projected_position(*args: Any, **kwargs: Any) -> Any: ...
    def _apply_simple_projected_buying_power(*args: Any, **kwargs: Any) -> Any: ...
