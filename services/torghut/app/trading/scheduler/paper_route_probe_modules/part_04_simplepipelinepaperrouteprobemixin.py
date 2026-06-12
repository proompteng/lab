# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    Strategy,
    TradeDecision,
)
from ....strategies.catalog import extract_catalog_metadata
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...session_context import regular_session_open_utc_for
from ...simple_risk import (
    position_qty_for_symbol,
)
from ..submission_preparation import SimplePipelineSubmissionPreparationMixin
from ..target_plan_helpers import (
    _FLATTEN_CLOSE_DECISION_SCHEMA_VERSION,
    _PAPER_ROUTE_PROBE_EXIT_PENDING_GRACE_SECONDS,
    _PAPER_ROUTE_PROBE_QTY_STEP,
    _PAPER_ROUTE_PROBE_REASONS,
    _PAPER_ROUTE_RETRY_KINDS,
    _PaperRouteRetryKind,
    _PaperRouteRetryTransition,
    _REGULAR_SESSION_MINUTES,
    _bounded_paper_route_collection_entry_metadata,
    _merge_paper_route_probe_lineage,
    _optional_decimal,
    _paper_route_probe_entry_metadata,
    _paper_route_probe_lineage_from_params,
    _safe_int,
    _safe_text,
    _strategy_signal_paper_entry_metadata,
    _target_bool,
    _target_notional_sizing_audit_from_params,
    _target_plan_lineage,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_55 import *
from .part_02_simplepipelinepaperrouteprobemixinmethodsp import *
from .part_03_simplepipelinepaperrouteprobemixinmethodsp import *


class SimplePipelinePaperRouteProbeMixin(
    _SimplePipelinePaperRouteProbeMixinMethodsPart1,
    _SimplePipelinePaperRouteProbeMixinMethodsPart2,
    object,
):
    pass


__all__ = [name for name in globals() if not name.startswith("__")]
