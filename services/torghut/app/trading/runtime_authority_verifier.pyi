from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
)
from app.trading.runtime_ledger_proof_policy import (
    DEFAULT_RUNTIME_LEDGER_PROOF_POLICY,
    RuntimeLedgerProofPolicy,
    normalize_runtime_ledger_proof_mode,
)
from app.trading.runtime_ledger_source_authority import (
    EXECUTION_ECONOMICS_MISSING_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_source_window_present,
)

DEFAULT_HPAIRS_HYPOTHESIS_ID: Any
DEFAULT_HPAIRS_CANDIDATE_ID: Any
DEFAULT_HPAIRS_RUNTIME_STRATEGY: Any
DEFAULT_HPAIRS_ACCOUNT_LABEL: Any
HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION: Any
AUTHORITY_TRADING_DAYS_BLOCKER: Any
AUTHORITY_MEAN_PNL_BLOCKER: Any
AUTHORITY_MEDIAN_PNL_BLOCKER: Any
AUTHORITY_P10_PNL_BLOCKER: Any
AUTHORITY_WORST_DAY_BLOCKER: Any
AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER: Any
AUTHORITY_FILLED_NOTIONAL_BLOCKER: Any
AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER: Any
AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER: Any
AUTHORITY_OPEN_POSITIONS_BLOCKER: Any
AUTHORITY_EXPLICIT_COSTS_BLOCKER: Any
AUTHORITY_BUCKET_BLOCKERS_PRESENT: Any
AUTHORITY_EVIDENCE_MISSING_BLOCKER: Any
AUTHORITY_READ_ERROR_BLOCKER: Any
AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER: Any
AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER: Any
AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER: Any
AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER: Any
AUTHORITY_LEDGER_SCHEMA_BLOCKER: Any
AUTHORITY_PNL_BASIS_BLOCKER: Any
AUTHORITY_COST_BASIS_BLOCKER: Any
AUTHORITY_POLICY_HASH_BLOCKER: Any
AUTHORITY_COST_MODEL_HASH_BLOCKER: Any
AUTHORITY_LINEAGE_HASH_BLOCKER: Any
_PROMOTION_GRADE_LEDGER_SCHEMAS: Any

class RuntimeAuthorityEvidenceRow:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    row_id: str
    run_id: str | None
    candidate_id: str | None
    hypothesis_id: str | None
    observed_stage: str | None
    bucket_started_at: datetime
    bucket_ended_at: datetime
    account_label: str | None
    runtime_strategy_name: str | None
    strategy_family: str | None
    fill_count: int
    decision_count: int
    submitted_order_count: int
    cancelled_order_count: int
    rejected_order_count: int
    unfilled_order_count: int
    closed_trade_count: int
    open_position_count: int
    filled_notional: Decimal
    gross_strategy_pnl: Decimal
    cost_amount: Decimal
    net_strategy_pnl_after_costs: Decimal
    post_cost_expectancy_bps: Decimal | None
    ledger_schema_version: str | None
    pnl_basis: str | None
    execution_policy_hash_counts: Mapping[str, object]
    cost_model_hash_counts: Mapping[str, object]
    lineage_hash_counts: Mapping[str, object]
    blockers: tuple[str, ...]
    payload: Mapping[str, object]

class _DailyAccumulator:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    trading_day: str
    net_strategy_pnl_after_costs: Decimal
    filled_notional: Decimal
    closed_trade_count: int
    open_position_count: int
    fill_count: int
    decision_count: int
    submitted_order_count: int
    explicit_cost_bucket_count: int
    source_window_count: int
    source_window_id_count: int
    source_ref_count: int
    source_offset_count: int
    trade_decision_ref_count: int
    execution_ref_count: int
    execution_order_event_ref_count: int
    source_materialization_count: int
    authority_class_count: int
    bucket_count: int
    source_authority_bucket_count: int
    clean_authority_bucket_count: int
    clean_authority_net_strategy_pnl_after_costs: Decimal
    clean_authority_filled_notional: Decimal
    clean_authority_closed_trade_count: int
    row_refs: list[str] | None
    blockers: list[str] | None
    def add_ref(*args: Any, **kwargs: Any) -> Any: ...
    def add_blockers(*args: Any, **kwargs: Any) -> Any: ...

def load_runtime_authority_rows(*args: Any, **kwargs: Any) -> Any: ...
def build_runtime_authority_report(*args: Any, **kwargs: Any) -> Any: ...
def runtime_authority_report_json(*args: Any, **kwargs: Any) -> Any: ...
def _row_from_bucket(*args: Any, **kwargs: Any) -> Any: ...
def _normalize_row(*args: Any, **kwargs: Any) -> Any: ...
def _daily_rows(*args: Any, **kwargs: Any) -> Any: ...
def _aggregate(*args: Any, **kwargs: Any) -> Any: ...
def _authority_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _row_authority_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _promotion_payload(*args: Any, **kwargs: Any) -> Any: ...
def _explicit_costs_present(*args: Any, **kwargs: Any) -> Any: ...
def _daily_payload(*args: Any, **kwargs: Any) -> Any: ...
def _authority_targets(*args: Any, **kwargs: Any) -> Any: ...
def _authority_gaps(*args: Any, **kwargs: Any) -> Any: ...
def _blocker_counts(*args: Any, **kwargs: Any) -> Any: ...
def _next_actions(*args: Any, **kwargs: Any) -> Any: ...
def _mean(*args: Any, **kwargs: Any) -> Any: ...
def _median(*args: Any, **kwargs: Any) -> Any: ...
def _p10(*args: Any, **kwargs: Any) -> Any: ...
def _max_drawdown(*args: Any, **kwargs: Any) -> Any: ...
def _ref_count(*args: Any, **kwargs: Any) -> Any: ...
def _source_offset_count(*args: Any, **kwargs: Any) -> Any: ...
def _source_offset_triplet_present(*args: Any, **kwargs: Any) -> Any: ...
def _positive_hash_count(*args: Any, **kwargs: Any) -> Any: ...
def _as_mapping(*args: Any, **kwargs: Any) -> Any: ...
def _as_sequence(*args: Any, **kwargs: Any) -> Any: ...
def _string_tuple(*args: Any, **kwargs: Any) -> Any: ...
def _text(*args: Any, **kwargs: Any) -> Any: ...
def _int(*args: Any, **kwargs: Any) -> Any: ...
def _decimal(*args: Any, **kwargs: Any) -> Any: ...
def _optional_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _required_datetime(*args: Any, **kwargs: Any) -> Any: ...
def _parse_datetime(*args: Any, **kwargs: Any) -> Any: ...
def _utc(*args: Any, **kwargs: Any) -> Any: ...
def _isoformat(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_text(*args: Any, **kwargs: Any) -> Any: ...

__all__: Any
