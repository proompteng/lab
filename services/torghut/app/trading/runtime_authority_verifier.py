"""Read-only H-PAIRS runtime authority proof verifier.

This module deliberately only reads durable runtime-ledger buckets and turns them
into a stable JSON-compatible proof report. It does not write promotion
state, upload proof packets, or mutate cluster/database state.
"""

from __future__ import annotations

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
from app.trading.runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
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

DEFAULT_HPAIRS_HYPOTHESIS_ID = 'H-PAIRS-01'
DEFAULT_HPAIRS_CANDIDATE_ID = 'c88421d619759b2cfaa6f4d0'
DEFAULT_HPAIRS_RUNTIME_STRATEGY = 'microbar-cross-sectional-pairs-v1'
DEFAULT_HPAIRS_ACCOUNT_LABEL = 'TORGHUT_SIM'
HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION = 'torghut.hpairs-runtime-authority-proof.v1'

AUTHORITY_TRADING_DAYS_BLOCKER = 'runtime_ledger_trading_days_below_authority_minimum'
AUTHORITY_MEAN_PNL_BLOCKER = 'mean_daily_net_pnl_after_costs_below_500'
AUTHORITY_MEDIAN_PNL_BLOCKER = 'median_daily_net_pnl_after_costs_below_250'
AUTHORITY_P10_PNL_BLOCKER = 'p10_daily_net_pnl_after_costs_below_floor'
AUTHORITY_WORST_DAY_BLOCKER = 'worst_day_net_pnl_after_costs_below_floor'
AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER = 'best_day_concentration_above_25pct'
AUTHORITY_FILLED_NOTIONAL_BLOCKER = 'filled_notional_below_authority_minimum'
AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER = 'filled_notional_missing'
AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER = 'closed_round_trips_below_authority_minimum'
AUTHORITY_OPEN_POSITIONS_BLOCKER = 'open_positions_present'
AUTHORITY_EXPLICIT_COSTS_BLOCKER = 'explicit_costs_missing'
AUTHORITY_BUCKET_BLOCKERS_PRESENT = 'runtime_ledger_bucket_blockers_present'
AUTHORITY_EVIDENCE_MISSING_BLOCKER = 'runtime_ledger_evidence_missing'
AUTHORITY_READ_ERROR_BLOCKER = 'runtime_ledger_read_error'
AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER = 'runtime_fills_missing'
AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER = 'runtime_decisions_missing'
AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER = ORDER_FEED_LIFECYCLE_MISSING_BLOCKER
AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER = 'closed_round_trip_missing'
AUTHORITY_LEDGER_SCHEMA_BLOCKER = 'runtime_ledger_schema_version_invalid'
AUTHORITY_PNL_BASIS_BLOCKER = 'runtime_ledger_pnl_basis_invalid'
AUTHORITY_COST_BASIS_BLOCKER = 'runtime_ledger_cost_basis_non_promotion_grade'
AUTHORITY_POLICY_HASH_BLOCKER = 'execution_policy_hash_missing'
AUTHORITY_COST_MODEL_HASH_BLOCKER = 'cost_model_hash_missing'
AUTHORITY_LINEAGE_HASH_BLOCKER = 'lineage_hash_missing'

_PROMOTION_GRADE_LEDGER_SCHEMAS = frozenset({EXACT_REPLAY_LEDGER_SCHEMA_VERSION})


@dataclass(frozen=True)
class RuntimeAuthorityEvidenceRow:
    """Normalized read-only runtime-ledger bucket evidence."""

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


@dataclass
class _DailyAccumulator:
    trading_day: str
    net_strategy_pnl_after_costs: Decimal = Decimal('0')
    filled_notional: Decimal = Decimal('0')
    closed_trade_count: int = 0
    open_position_count: int = 0
    fill_count: int = 0
    decision_count: int = 0
    submitted_order_count: int = 0
    explicit_cost_bucket_count: int = 0
    source_window_count: int = 0
    source_window_id_count: int = 0
    source_ref_count: int = 0
    source_offset_count: int = 0
    trade_decision_ref_count: int = 0
    execution_ref_count: int = 0
    execution_order_event_ref_count: int = 0
    source_materialization_count: int = 0
    authority_class_count: int = 0
    bucket_count: int = 0
    source_authority_bucket_count: int = 0
    row_refs: list[str] | None = None
    blockers: list[str] | None = None

    def add_ref(self, row_id: str) -> None:
        if self.row_refs is None:
            self.row_refs = []
        self.row_refs.append(row_id)

    def add_blockers(self, blockers: Sequence[str]) -> None:
        if self.blockers is None:
            self.blockers = []
        for blocker in blockers:
            if blocker not in self.blockers:
                self.blockers.append(blocker)


def load_runtime_authority_rows(
    session: Session,
    *,
    hypothesis_id: str = DEFAULT_HPAIRS_HYPOTHESIS_ID,
    candidate_id: str = DEFAULT_HPAIRS_CANDIDATE_ID,
    runtime_strategy_name: str = DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    account_label: str = DEFAULT_HPAIRS_ACCOUNT_LABEL,
    observed_stage: str | None = None,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
) -> list[RuntimeAuthorityEvidenceRow]:
    """Read runtime-ledger buckets for an H-PAIRS proof window without writes."""

    statement = select(StrategyRuntimeLedgerBucket).where(
        StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id,
        StrategyRuntimeLedgerBucket.candidate_id == candidate_id,
        StrategyRuntimeLedgerBucket.account_label == account_label,
        StrategyRuntimeLedgerBucket.runtime_strategy_name == runtime_strategy_name,
    )
    if observed_stage is not None:
        statement = statement.where(StrategyRuntimeLedgerBucket.observed_stage == observed_stage)
    if started_at is not None:
        statement = statement.where(StrategyRuntimeLedgerBucket.bucket_ended_at >= _utc(started_at))
    if ended_at is not None:
        statement = statement.where(StrategyRuntimeLedgerBucket.bucket_started_at < _utc(ended_at))
    statement = statement.order_by(
        StrategyRuntimeLedgerBucket.bucket_started_at.asc(),
        StrategyRuntimeLedgerBucket.bucket_ended_at.asc(),
        StrategyRuntimeLedgerBucket.created_at.asc(),
        StrategyRuntimeLedgerBucket.id.asc(),
    )
    buckets = session.scalars(statement).all()
    return [_row_from_bucket(bucket) for bucket in buckets]


def build_runtime_authority_report(
    rows: Sequence[RuntimeAuthorityEvidenceRow | Mapping[str, object]],
    *,
    mode: str = 'authority',
    hypothesis_id: str = DEFAULT_HPAIRS_HYPOTHESIS_ID,
    candidate_id: str = DEFAULT_HPAIRS_CANDIDATE_ID,
    runtime_strategy_name: str = DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    account_label: str = DEFAULT_HPAIRS_ACCOUNT_LABEL,
    observed_stage: str | None = None,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
    evidence_read_error: str | None = None,
    policy: RuntimeLedgerProofPolicy = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY,
) -> dict[str, object]:
    """Build a stable JSON-compatible final-authority proof report."""

    proof_mode = normalize_runtime_ledger_proof_mode(mode)
    normalized_rows = [_normalize_row(row) for row in rows]
    daily = _daily_rows(normalized_rows)
    aggregate = _aggregate(daily, normalized_rows, policy=policy)
    blockers = _authority_blockers(
        daily,
        normalized_rows,
        aggregate=aggregate,
        policy=policy,
        evidence_read_error=evidence_read_error,
    )
    return {
        'schema_version': HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION,
        'mode': proof_mode,
        'final_authority_ok': not blockers,
        'identity': {
            'hypothesis_id': hypothesis_id,
            'candidate_id': candidate_id,
            'runtime_strategy_name': runtime_strategy_name,
            'account_label': account_label,
            'observed_stage': observed_stage,
        },
        'window': {
            'started_at': _isoformat(started_at) if started_at is not None else None,
            'ended_at': _isoformat(ended_at) if ended_at is not None else None,
        },
        'evidence_read_error': evidence_read_error,
        'targets': _authority_targets(policy),
        'trading_days': [_daily_payload(item) for item in daily],
        'aggregate': aggregate,
        'blockers': blockers,
    }


def runtime_authority_report_json(report: Mapping[str, object]) -> str:
    """Serialize a report as deterministic JSON."""

    import json

    return json.dumps(report, indent=2, sort_keys=True) + '\n'


def _row_from_bucket(bucket: StrategyRuntimeLedgerBucket) -> RuntimeAuthorityEvidenceRow:
    payload = _as_mapping(bucket.payload_json)
    blockers = _string_tuple([*_as_sequence(bucket.blockers_json), *_as_sequence(payload.get('blockers'))])
    return RuntimeAuthorityEvidenceRow(
        row_id=str(bucket.id),
        run_id=_text(bucket.run_id),
        candidate_id=_text(bucket.candidate_id),
        hypothesis_id=_text(bucket.hypothesis_id),
        observed_stage=_text(bucket.observed_stage),
        bucket_started_at=_utc(bucket.bucket_started_at),
        bucket_ended_at=_utc(bucket.bucket_ended_at),
        account_label=_text(bucket.account_label),
        runtime_strategy_name=_text(bucket.runtime_strategy_name),
        strategy_family=_text(bucket.strategy_family),
        fill_count=_int(bucket.fill_count),
        decision_count=_int(bucket.decision_count),
        submitted_order_count=_int(bucket.submitted_order_count),
        cancelled_order_count=_int(bucket.cancelled_order_count),
        rejected_order_count=_int(bucket.rejected_order_count),
        unfilled_order_count=_int(bucket.unfilled_order_count),
        closed_trade_count=_int(bucket.closed_trade_count),
        open_position_count=_int(bucket.open_position_count),
        filled_notional=_decimal(bucket.filled_notional),
        gross_strategy_pnl=_decimal(bucket.gross_strategy_pnl),
        cost_amount=_decimal(bucket.cost_amount),
        net_strategy_pnl_after_costs=_decimal(bucket.net_strategy_pnl_after_costs),
        post_cost_expectancy_bps=_optional_decimal(bucket.post_cost_expectancy_bps),
        ledger_schema_version=_text(bucket.ledger_schema_version),
        pnl_basis=_text(bucket.pnl_basis),
        execution_policy_hash_counts=_as_mapping(bucket.execution_policy_hash_counts),
        cost_model_hash_counts=_as_mapping(bucket.cost_model_hash_counts),
        lineage_hash_counts=_as_mapping(bucket.lineage_hash_counts),
        blockers=blockers,
        payload=payload,
    )


def _normalize_row(row: RuntimeAuthorityEvidenceRow | Mapping[str, object]) -> RuntimeAuthorityEvidenceRow:
    if isinstance(row, RuntimeAuthorityEvidenceRow):
        return row
    bucket_start = _required_datetime(row.get('bucket_started_at'), field_name='bucket_started_at')
    bucket_end = _required_datetime(row.get('bucket_ended_at'), field_name='bucket_ended_at')
    payload = _as_mapping(row.get('payload_json') or row.get('payload'))
    blockers = _string_tuple([*_as_sequence(row.get('blockers_json')), *_as_sequence(row.get('blockers'))])
    return RuntimeAuthorityEvidenceRow(
        row_id=_text(row.get('id') or row.get('row_id')) or '',
        run_id=_text(row.get('run_id')),
        candidate_id=_text(row.get('candidate_id')),
        hypothesis_id=_text(row.get('hypothesis_id')),
        observed_stage=_text(row.get('observed_stage')),
        bucket_started_at=bucket_start,
        bucket_ended_at=bucket_end,
        account_label=_text(row.get('account_label')),
        runtime_strategy_name=_text(row.get('runtime_strategy_name')),
        strategy_family=_text(row.get('strategy_family')),
        fill_count=_int(row.get('fill_count')),
        decision_count=_int(row.get('decision_count')),
        submitted_order_count=_int(row.get('submitted_order_count')),
        cancelled_order_count=_int(row.get('cancelled_order_count')),
        rejected_order_count=_int(row.get('rejected_order_count')),
        unfilled_order_count=_int(row.get('unfilled_order_count')),
        closed_trade_count=_int(row.get('closed_trade_count')),
        open_position_count=_int(row.get('open_position_count')),
        filled_notional=_decimal(row.get('filled_notional')),
        gross_strategy_pnl=_decimal(row.get('gross_strategy_pnl')),
        cost_amount=_decimal(row.get('cost_amount')),
        net_strategy_pnl_after_costs=_decimal(row.get('net_strategy_pnl_after_costs')),
        post_cost_expectancy_bps=_optional_decimal(row.get('post_cost_expectancy_bps')),
        ledger_schema_version=_text(row.get('ledger_schema_version')),
        pnl_basis=_text(row.get('pnl_basis')),
        execution_policy_hash_counts=_as_mapping(row.get('execution_policy_hash_counts')),
        cost_model_hash_counts=_as_mapping(row.get('cost_model_hash_counts')),
        lineage_hash_counts=_as_mapping(row.get('lineage_hash_counts')),
        blockers=blockers,
        payload=payload,
    )


def _daily_rows(rows: Sequence[RuntimeAuthorityEvidenceRow]) -> list[_DailyAccumulator]:
    accumulators: dict[str, _DailyAccumulator] = {}
    for row in rows:
        day = row.bucket_started_at.astimezone(timezone.utc).date().isoformat()
        accumulator = accumulators.setdefault(day, _DailyAccumulator(trading_day=day))
        payload = _promotion_payload(row)
        row_blockers = _row_authority_blockers(row, payload)
        source_blockers = runtime_ledger_promotion_source_authority_blockers(payload)
        accumulator.net_strategy_pnl_after_costs += row.net_strategy_pnl_after_costs
        accumulator.filled_notional += row.filled_notional
        accumulator.closed_trade_count += max(0, row.closed_trade_count)
        accumulator.open_position_count += max(0, row.open_position_count)
        accumulator.fill_count += max(0, row.fill_count)
        accumulator.decision_count += max(0, row.decision_count)
        accumulator.submitted_order_count += max(0, row.submitted_order_count)
        accumulator.bucket_count += 1
        if _explicit_costs_present(row, payload):
            accumulator.explicit_cost_bucket_count += 1
        if runtime_ledger_source_window_present(payload):
            accumulator.source_window_count += 1
        if not source_blockers:
            accumulator.source_authority_bucket_count += 1
        accumulator.source_window_id_count += _ref_count(
            payload,
            'source_window_ids',
            'source_window_id',
            'runtime_ledger_source_window_ids',
            'runtime_ledger_source_window_id',
        )
        accumulator.source_ref_count += _ref_count(payload, 'source_refs', 'source_ref')
        accumulator.source_offset_count += _source_offset_count(payload)
        accumulator.trade_decision_ref_count += _ref_count(
            payload,
            'trade_decision_ids',
            'trade_decision_refs',
            'trade_decision_id',
            'decision_ids',
            'decision_id',
        )
        accumulator.execution_ref_count += _ref_count(payload, 'execution_ids', 'execution_refs', 'execution_id')
        accumulator.execution_order_event_ref_count += _ref_count(
            payload,
            'execution_order_event_ids',
            'execution_order_event_refs',
            'execution_order_event_id',
        )
        accumulator.source_materialization_count += int(_text(payload.get('source_materialization')) is not None)
        accumulator.authority_class_count += int(_text(payload.get('authority_class')) is not None)
        accumulator.add_ref(row.row_id)
        accumulator.add_blockers([*row_blockers, *source_blockers])
    return [accumulators[day] for day in sorted(accumulators)]


def _aggregate(
    daily: Sequence[_DailyAccumulator],
    rows: Sequence[RuntimeAuthorityEvidenceRow],
    *,
    policy: RuntimeLedgerProofPolicy,
) -> dict[str, object]:
    daily_net = [item.net_strategy_pnl_after_costs for item in daily]
    total_net = sum(daily_net, Decimal('0'))
    positive_total_net = sum((max(item, Decimal('0')) for item in daily_net), Decimal('0'))
    best_day_net = max(daily_net) if daily_net else Decimal('0')
    best_day_share = (
        max(best_day_net, Decimal('0')) / positive_total_net if positive_total_net > 0 else None
    )
    max_drawdown = _max_drawdown(daily_net)
    filled_notional = sum((row.filled_notional for row in rows), Decimal('0'))
    closed_round_trips = sum((max(0, row.closed_trade_count) for row in rows), 0)
    cost_amount = sum((row.cost_amount for row in rows), Decimal('0'))
    return {
        'bucket_count': len(rows),
        'trading_day_count': len(daily),
        'mean_daily_net_pnl_after_costs': _decimal_text(_mean(daily_net)),
        'median_daily_net_pnl_after_costs': _decimal_text(_median(daily_net)),
        'p10_daily_net_pnl_after_costs': _decimal_text(_p10(daily_net)),
        'worst_day_net_pnl_after_costs': _decimal_text(min(daily_net) if daily_net else Decimal('0')),
        'best_day_net_pnl_after_costs': _decimal_text(best_day_net),
        'best_day_share': _decimal_text(best_day_share) if best_day_share is not None else None,
        'max_drawdown': _decimal_text(max_drawdown) if daily else None,
        'total_net_strategy_pnl_after_costs': _decimal_text(total_net),
        'total_filled_notional': _decimal_text(filled_notional),
        'total_explicit_costs': _decimal_text(cost_amount),
        'closed_round_trips': closed_round_trips,
        'open_position_count': sum((max(0, row.open_position_count) for row in rows), 0),
        'source_authority_bucket_count': sum(item.source_authority_bucket_count for item in daily),
        'explicit_cost_bucket_count': sum(item.explicit_cost_bucket_count for item in daily),
        'authority_min_trading_days': policy.authority_min_trading_days,
        'authority_min_filled_notional': _decimal_text(policy.authority_min_filled_notional),
        'authority_min_closed_round_trips': policy.authority_min_closed_round_trips,
    }


def _authority_blockers(
    daily: Sequence[_DailyAccumulator],
    rows: Sequence[RuntimeAuthorityEvidenceRow],
    *,
    aggregate: Mapping[str, object],
    policy: RuntimeLedgerProofPolicy,
    evidence_read_error: str | None = None,
) -> list[str]:
    blockers: list[str] = []
    if evidence_read_error is not None:
        blockers.append(AUTHORITY_READ_ERROR_BLOCKER)
    if not rows:
        blockers.append(AUTHORITY_EVIDENCE_MISSING_BLOCKER)
    daily_net = [item.net_strategy_pnl_after_costs for item in daily]
    if len(daily) < policy.authority_min_trading_days:
        blockers.append(AUTHORITY_TRADING_DAYS_BLOCKER)
    if _mean(daily_net) < policy.authority_min_mean_daily_net_pnl_after_costs:
        blockers.append(AUTHORITY_MEAN_PNL_BLOCKER)
    if _median(daily_net) < policy.authority_min_median_daily_net_pnl_after_costs:
        blockers.append(AUTHORITY_MEDIAN_PNL_BLOCKER)
    if _p10(daily_net) < policy.authority_min_p10_daily_net_pnl_after_costs:
        blockers.append(AUTHORITY_P10_PNL_BLOCKER)
    if (min(daily_net) if daily_net else Decimal('0')) < policy.authority_min_worst_day_net_pnl_after_costs:
        blockers.append(AUTHORITY_WORST_DAY_BLOCKER)
    best_day_share = _optional_decimal(aggregate.get('best_day_share'))
    if best_day_share is not None and best_day_share > policy.authority_max_best_day_share:
        blockers.append(AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER)
    filled_notional = _decimal(aggregate.get('total_filled_notional'))
    if filled_notional <= 0:
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if filled_notional < policy.authority_min_filled_notional:
        blockers.append(AUTHORITY_FILLED_NOTIONAL_BLOCKER)
    if _int(aggregate.get('closed_round_trips')) < policy.authority_min_closed_round_trips:
        blockers.append(AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER)
    if _int(aggregate.get('open_position_count')) > 0:
        blockers.append(AUTHORITY_OPEN_POSITIONS_BLOCKER)
    if rows and _int(aggregate.get('explicit_cost_bucket_count')) < len(rows):
        blockers.append(AUTHORITY_EXPLICIT_COSTS_BLOCKER)
    for item in daily:
        blockers.extend(item.blockers or [])
    return list(dict.fromkeys(blockers))


def _row_authority_blockers(
    row: RuntimeAuthorityEvidenceRow,
    payload: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = list(row.blockers)
    if row.blockers:
        blockers.append(AUTHORITY_BUCKET_BLOCKERS_PRESENT)
    if row.ledger_schema_version not in _PROMOTION_GRADE_LEDGER_SCHEMAS:
        blockers.append(AUTHORITY_LEDGER_SCHEMA_BLOCKER)
    if row.pnl_basis != POST_COST_PNL_BASIS:
        blockers.append(AUTHORITY_PNL_BASIS_BLOCKER)
    if row.fill_count <= 0:
        blockers.append(AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER)
    if row.decision_count <= 0:
        blockers.append(AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER)
    if row.submitted_order_count <= 0:
        blockers.append(AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER)
    if row.closed_trade_count <= 0:
        blockers.append(AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER)
    if row.open_position_count > 0:
        blockers.append(AUTHORITY_OPEN_POSITIONS_BLOCKER)
    if row.filled_notional <= 0:
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if not _explicit_costs_present(row, payload):
        blockers.append(AUTHORITY_EXPLICIT_COSTS_BLOCKER)
    if not _positive_hash_count(row.execution_policy_hash_counts):
        blockers.append(AUTHORITY_POLICY_HASH_BLOCKER)
    if not _positive_hash_count(row.cost_model_hash_counts):
        blockers.append(AUTHORITY_COST_MODEL_HASH_BLOCKER)
    if not _positive_hash_count(row.lineage_hash_counts):
        blockers.append(AUTHORITY_LINEAGE_HASH_BLOCKER)
    return list(dict.fromkeys(blockers))


def _promotion_payload(row: RuntimeAuthorityEvidenceRow) -> dict[str, object]:
    payload = dict(row.payload)
    payload.update(
        {
            'run_id': row.run_id,
            'candidate_id': row.candidate_id,
            'hypothesis_id': row.hypothesis_id,
            'observed_stage': row.observed_stage,
            'account_label': row.account_label,
            'runtime_strategy_name': row.runtime_strategy_name,
            'strategy_family': row.strategy_family,
            'fill_count': row.fill_count,
            'decision_count': row.decision_count,
            'submitted_order_count': row.submitted_order_count,
            'cancelled_order_count': row.cancelled_order_count,
            'rejected_order_count': row.rejected_order_count,
            'unfilled_order_count': row.unfilled_order_count,
            'closed_trade_count': row.closed_trade_count,
            'open_position_count': row.open_position_count,
            'filled_notional': row.filled_notional,
            'gross_strategy_pnl': row.gross_strategy_pnl,
            'cost_amount': row.cost_amount,
            'net_strategy_pnl_after_costs': row.net_strategy_pnl_after_costs,
            'post_cost_expectancy_bps': row.post_cost_expectancy_bps,
            'ledger_schema_version': row.ledger_schema_version,
            'pnl_basis': row.pnl_basis,
            'execution_policy_hash_counts': row.execution_policy_hash_counts,
            'cost_model_hash_counts': row.cost_model_hash_counts,
            'lineage_hash_counts': row.lineage_hash_counts,
        }
    )
    return payload


def _explicit_costs_present(row: RuntimeAuthorityEvidenceRow, payload: Mapping[str, object]) -> bool:
    if is_non_promotion_grade_runtime_cost_basis(payload.get('cost_basis')):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(payload.get('cost_basis_counts')):
        return False
    cost_basis_counts = _as_mapping(payload.get('cost_basis_counts'))
    return bool(cost_basis_counts) and _positive_hash_count(row.cost_model_hash_counts)


def _daily_payload(item: _DailyAccumulator) -> dict[str, object]:
    return {
        'trading_day': item.trading_day,
        'net_strategy_pnl_after_costs': _decimal_text(item.net_strategy_pnl_after_costs),
        'filled_notional': _decimal_text(item.filled_notional),
        'closed_trade_count': item.closed_trade_count,
        'open_position_count': item.open_position_count,
        'fill_count': item.fill_count,
        'decision_count': item.decision_count,
        'submitted_order_count': item.submitted_order_count,
        'bucket_count': item.bucket_count,
        'explicit_cost_bucket_count': item.explicit_cost_bucket_count,
        'source_window_count': item.source_window_count,
        'source_window_id_count': item.source_window_id_count,
        'source_ref_count': item.source_ref_count,
        'source_offset_count': item.source_offset_count,
        'trade_decision_ref_count': item.trade_decision_ref_count,
        'execution_ref_count': item.execution_ref_count,
        'execution_order_event_ref_count': item.execution_order_event_ref_count,
        'source_materialization_count': item.source_materialization_count,
        'authority_class_count': item.authority_class_count,
        'source_authority_bucket_count': item.source_authority_bucket_count,
        'row_refs': sorted(item.row_refs or []),
        'blockers': sorted(item.blockers or []),
    }


def _authority_targets(policy: RuntimeLedgerProofPolicy) -> dict[str, object]:
    return {
        'min_trading_days': policy.authority_min_trading_days,
        'min_mean_daily_net_pnl_after_costs': _decimal_text(policy.authority_min_mean_daily_net_pnl_after_costs),
        'min_median_daily_net_pnl_after_costs': _decimal_text(policy.authority_min_median_daily_net_pnl_after_costs),
        'min_p10_daily_net_pnl_after_costs': _decimal_text(policy.authority_min_p10_daily_net_pnl_after_costs),
        'min_worst_day_net_pnl_after_costs': _decimal_text(policy.authority_min_worst_day_net_pnl_after_costs),
        'max_best_day_share': _decimal_text(policy.authority_max_best_day_share),
        'min_filled_notional': _decimal_text(policy.authority_min_filled_notional),
        'min_closed_round_trips': policy.authority_min_closed_round_trips,
    }


def _mean(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    return sum(values, Decimal('0')) / Decimal(len(values))


def _median(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return sorted_values[middle]
    return (sorted_values[middle - 1] + sorted_values[middle]) / Decimal('2')


def _p10(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    sorted_values = sorted(values)
    index = max(0, ((len(sorted_values) + 9) // 10) - 1)
    return sorted_values[index]


def _max_drawdown(values: Sequence[Decimal]) -> Decimal:
    cumulative = Decimal('0')
    peak = Decimal('0')
    max_drawdown = Decimal('0')
    for value in values:
        cumulative += value
        if cumulative > peak:
            peak = cumulative
        drawdown = peak - cumulative
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _ref_count(bucket: Mapping[str, object], *keys: str) -> int:
    refs: set[str] = set()
    for key in keys:
        value = bucket.get(key)
        if isinstance(value, Mapping):
            for ref_key, ref_value in cast(Mapping[object, object], value).items():
                if ref_value is None or ref_value is False:
                    continue
                ref_text = _text(ref_value)
                if ref_value is True or ref_text is None:
                    ref_text = _text(ref_key)
                if ref_text is not None:
                    refs.add(ref_text)
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            for item in cast(Sequence[object], value):
                if (text := _text(item)) is not None:
                    refs.add(text)
        elif (text := _text(value)) is not None:
            refs.add(text)
    return len(refs)


def _source_offset_count(bucket: Mapping[str, object]) -> int:
    offsets = bucket.get('source_offsets')
    if isinstance(offsets, Mapping):
        return int(_source_offset_triplet_present(cast(Mapping[object, object], offsets)))
    if isinstance(offsets, Sequence) and not isinstance(offsets, (str, bytes, bytearray)):
        seen: set[tuple[str, str, str]] = set()
        for item in cast(Sequence[object], offsets):
            if not isinstance(item, Mapping):
                continue
            typed_item = cast(Mapping[object, object], item)
            if _source_offset_triplet_present(typed_item):
                seen.add((str(typed_item.get('topic')), str(typed_item.get('partition')), str(typed_item.get('offset'))))
        return len(seen)
    return int(
        _text(bucket.get('source_topic')) is not None
        and bucket.get('source_partition') is not None
        and bucket.get('source_offset') is not None
    )


def _source_offset_triplet_present(value: Mapping[object, object]) -> bool:
    return (
        _text(value.get('topic')) is not None
        and value.get('partition') is not None
        and value.get('offset') is not None
    )


def _positive_hash_count(value: Mapping[str, object]) -> bool:
    for item in value.values():
        if _decimal(item) > 0:
            return True
    return False


def _as_mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}


def _as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    if value is None:
        return ()
    return (value,)


def _string_tuple(values: Sequence[object]) -> tuple[str, ...]:
    normalized: list[str] = []
    for value in values:
        text = _text(value)
        if text is not None and text not in normalized:
            normalized.append(text)
    return tuple(normalized)


def _text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: object) -> int:
    try:
        return int(str(value or '0'))
    except (TypeError, ValueError):
        return 0


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value if value is not None else '0'))
    except (InvalidOperation, ValueError):
        return Decimal('0')
    return parsed if parsed.is_finite() else Decimal('0')


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _required_datetime(value: object, *, field_name: str) -> datetime:
    parsed = _parse_datetime(value)
    if parsed is None:
        raise ValueError(f'{field_name}_invalid')
    return parsed


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace('Z', '+00:00')))
    except ValueError:
        return None


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return _utc(value).isoformat().replace('+00:00', 'Z')


def _decimal_text(value: Decimal | None) -> str:
    if value is None:
        return '0'
    text = format(value.normalize(), 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


__all__ = [
    'AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER',
    'AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER',
    'AUTHORITY_EVIDENCE_MISSING_BLOCKER',
    'AUTHORITY_EXPLICIT_COSTS_BLOCKER',
    'AUTHORITY_FILLED_NOTIONAL_BLOCKER',
    'AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER',
    'AUTHORITY_MEAN_PNL_BLOCKER',
    'AUTHORITY_MEDIAN_PNL_BLOCKER',
    'AUTHORITY_OPEN_POSITIONS_BLOCKER',
    'AUTHORITY_P10_PNL_BLOCKER',
    'AUTHORITY_READ_ERROR_BLOCKER',
    'AUTHORITY_TRADING_DAYS_BLOCKER',
    'AUTHORITY_WORST_DAY_BLOCKER',
    'DEFAULT_HPAIRS_ACCOUNT_LABEL',
    'DEFAULT_HPAIRS_CANDIDATE_ID',
    'DEFAULT_HPAIRS_HYPOTHESIS_ID',
    'DEFAULT_HPAIRS_RUNTIME_STRATEGY',
    'EXECUTION_ECONOMICS_MISSING_BLOCKER',
    'HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION',
    'ORDER_FEED_LIFECYCLE_MISSING_BLOCKER',
    'RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER',
    'RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER',
    'RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER',
    'RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER',
    'RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER',
    'RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER',
    'RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER',
    'RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER',
    'RuntimeAuthorityEvidenceRow',
    'build_runtime_authority_report',
    'load_runtime_authority_rows',
    'runtime_authority_report_json',
]
