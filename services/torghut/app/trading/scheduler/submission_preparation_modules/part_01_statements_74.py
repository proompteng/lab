# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, cast

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Strategy,
    TradeDecision,
)
from ...firewall import OrderFirewallBlocked
from ...models import SignalEnvelope, StrategyDecision
from ...prices import MarketSnapshot
from ...quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    _status,
    assess_signal_quote_quality,
)
from ...quantity_rules import quantize_qty_for_symbol, resolve_quantity_resolution
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
from ..pipeline_helpers import (
    _extract_json_error_payload,
    _price_snapshot_payload,
)
from ..target_plan_helpers import (
    _PAPER_ROUTE_PROBE_QTY_STEP,
    _TargetProbeQuantityResolution,
    _bounded_collection_decision_requires_target_notional_sizing,
    _bounded_paper_route_collection_entry_metadata,
    _bounded_sim_collection_metadata_from_decision,
    _decimal_from_mapping,
    _executable_bid_ask_present,
    _first_decimal,
    _mapping_value,
    _min_optional_decimal,
    _optional_decimal,
    _paper_route_probe_entry_metadata,
    _parse_target_datetime,
    _pct_cap_to_notional,
    _quote_snapshot_from_mapping,
    _quote_snapshot_reference_price,
    _safe_int,
    _safe_text,
    _simple_buying_power_consumption,
    _simple_decision_notional,
    _snapshot_has_executable_quote,
    _target_metadata_quote_snapshot,
    _target_notional_sizing_audit_from_params,
    _target_probe_cap,
    _target_probe_symbol_actions,
    _target_probe_symbol_notional_budget,
    _target_probe_symbol_quantities,
    _target_symbols,
    _text_from_mapping,
)

# ruff: noqa: F401,F403,F405,F811,F821


logger = logging.getLogger(__name__)


__all__ = [name for name in globals() if not name.startswith("__")]
