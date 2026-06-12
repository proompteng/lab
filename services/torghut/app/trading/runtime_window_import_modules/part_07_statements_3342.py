# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ...config import settings
from ...models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    VNextDatasetSnapshot,
)
from ..hypotheses import (
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    load_hypothesis_registry,
)
from ..runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
from ..runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from ..runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_ledger_proof_policy import runtime_ledger_proof_policy_from_env
from ..runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_DISABLED,
    TIGERBEETLE_BLOCKER_JOURNAL_ENTRY_UNAVAILABLE,
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TigerBeetleLedgerJournal,
    tigerbeetle_runtime_ledger_journal_payload,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_63 import *
from .part_02_delay_adjusted_depth_stress_blocking_reaso import *
from .part_03_build_observed_runtime_buckets import *
from .part_04_runtime_ledger_bucket_replacement_scopes import *
from .part_05_runtime_ledger_daily_summary_from_observed import *
from .part_06_persist_observed_runtime_windows import *

__all__ = [
    "ObservedRuntimeBucket",
    "build_observed_runtime_buckets",
    "build_regular_session_buckets",
    "persist_observed_runtime_windows",
    "resolve_hypothesis_manifest",
]


__all__ = [name for name in globals() if not name.startswith("__")]
