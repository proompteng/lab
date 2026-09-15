"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


from ...models import (
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
)
from ..runtime_decision_authority import (
    normalize_source_decision_mode,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
)

from .common import (
    ObservedRuntimeBucket,
    NormalizedTcaRow,
    mapping_payload,
    observation_decimal,
    observation_int,
    optional_decimal,
    parse_observation_datetime,
    persisted_runtime_ledger_bucket_evidence_grade,
    post_cost_basis_is_promotion_grade,
    post_cost_expectancy_basis,
    runtime_ledger_bucket_payload,
    runtime_ledger_post_cost_from_rows,
    runtime_ledger_row_is_promotion_grade,
    string_list,
    text_value,
    utc_datetime,
    runtime_ledger_promotion_source_authority_blockers,
)


@dataclass(frozen=True)
class BuildObservedRuntimeBucketsRequest:
    bucket_ranges: Sequence[tuple[datetime, datetime, int]]
    decision_times: Sequence[datetime]
    execution_times: Sequence[datetime]
    tca_rows: Sequence[Mapping[str, Any]]
    continuity_ok: bool
    drift_ok: bool
    dependency_quorum_decision: str


@dataclass(frozen=True)
class _RuntimeBucketSourceRows:
    decisions: list[datetime]
    executions: list[datetime]
    tca_rows: list[NormalizedTcaRow]


@dataclass(frozen=True)
class _ObservedBucketWindow:
    started_at: datetime
    ended_at: datetime
    market_session_count: int


@dataclass(frozen=True)
class _ObservedBucketLedgerTotals:
    decision_count: int
    trade_count: int
    order_count: int
    post_cost_bps: Decimal | None
    net_strategy_pnl_after_costs: Decimal
    filled_notional: Decimal
    notional_weighted_sample_count: int
    promotion_rows: list[NormalizedTcaRow]


@dataclass(frozen=True)
class _ObservedBucketPayloadInputs:
    bucket_tca: list[NormalizedTcaRow]
    slippage_values: list[Decimal]
    basis_counts: dict[str, int]
    runtime_ledger_buckets: list[dict[str, Any]]
    ledger_totals: _ObservedBucketLedgerTotals


@dataclass(frozen=True)
class _ObservedBucketPayloadCounts:
    decision_count: int
    trade_count: int
    order_count: int
    post_cost_expectancy_aggregation: str


def _build_observed_runtime_buckets_request(
    inputs: Mapping[str, Any],
) -> BuildObservedRuntimeBucketsRequest:
    return BuildObservedRuntimeBucketsRequest(
        bucket_ranges=cast(
            Sequence[tuple[datetime, datetime, int]],
            inputs["bucket_ranges"],
        ),
        decision_times=cast(Sequence[datetime], inputs["decision_times"]),
        execution_times=cast(Sequence[datetime], inputs["execution_times"]),
        tca_rows=cast(Sequence[Mapping[str, Any]], inputs["tca_rows"]),
        continuity_ok=cast(bool, inputs["continuity_ok"]),
        drift_ok=cast(bool, inputs["drift_ok"]),
        dependency_quorum_decision=cast(str, inputs["dependency_quorum_decision"]),
    )


def _normalize_tca_row(row: Mapping[str, Any]) -> NormalizedTcaRow | None:
    computed_at_raw = row.get("computed_at")
    if not isinstance(computed_at_raw, datetime):
        return None
    basis = post_cost_expectancy_basis(
        row.get("post_cost_expectancy_basis") or row.get("post_cost_basis")
    )
    runtime_ledger_bucket = runtime_ledger_bucket_payload(
        row.get("runtime_ledger_bucket")
    )
    source_decision_mode = normalize_source_decision_mode(
        row.get("source_decision_mode")
        or runtime_ledger_bucket.get("source_decision_mode")
    )
    source_decision_mode_eligible = (
        source_decision_mode is None
        or source_decision_mode_is_profit_proof_eligible(source_decision_mode)
    )
    computed_at = utc_datetime(computed_at_raw)
    return NormalizedTcaRow(
        computed_at=computed_at,
        bucketed_at=_runtime_ledger_payload_bucketed_at(
            computed_at=computed_at,
            payload=runtime_ledger_bucket,
        ),
        abs_slippage_bps=optional_decimal(row.get("abs_slippage_bps")),
        post_cost_expectancy_bps=optional_decimal(row.get("post_cost_expectancy_bps")),
        post_cost_expectancy_basis=basis,
        post_cost_promotion_eligible=post_cost_basis_is_promotion_grade(
            basis=basis,
            explicit_value=row.get("post_cost_promotion_eligible"),
        )
        and source_decision_mode_eligible,
        runtime_ledger_bucket=runtime_ledger_bucket,
        source_decision_mode=source_decision_mode,
    )


def _runtime_bucket_source_rows(
    request: BuildObservedRuntimeBucketsRequest,
) -> _RuntimeBucketSourceRows:
    normalized_tca_rows = [
        normalized_row
        for row in request.tca_rows
        if (normalized_row := _normalize_tca_row(row)) is not None
    ]
    return _RuntimeBucketSourceRows(
        decisions=[utc_datetime(item) for item in request.decision_times],
        executions=[utc_datetime(item) for item in request.execution_times],
        tca_rows=normalized_tca_rows,
    )


def _time_is_in_import_window(
    value: datetime,
    bucket_ranges: Sequence[tuple[datetime, datetime, int]],
) -> bool:
    return any(
        bucket_start <= value < bucket_end
        for bucket_start, bucket_end, _ in bucket_ranges
    )


def _row_import_bucketed_at(
    row: NormalizedTcaRow,
    bucket_ranges: Sequence[tuple[datetime, datetime, int]],
) -> datetime:
    if _time_is_in_import_window(row.computed_at, bucket_ranges):
        return row.computed_at
    if _time_is_in_import_window(row.bucketed_at, bucket_ranges):
        return row.bucketed_at
    interval = _runtime_ledger_payload_interval(row.runtime_ledger_bucket)
    if interval is None:
        return row.bucketed_at
    interval_start, interval_end = interval
    overlapping_ranges = [
        (bucket_start, bucket_end)
        for bucket_start, bucket_end, _ in bucket_ranges
        if interval_start < bucket_end and interval_end > bucket_start
    ]
    if not overlapping_ranges:
        return row.bucketed_at
    last_start, last_end = overlapping_ranges[-1]
    return max(last_start, last_end - timedelta(microseconds=1))


def _rows_for_window(
    request: BuildObservedRuntimeBucketsRequest,
    source_rows: _RuntimeBucketSourceRows,
    window: _ObservedBucketWindow,
) -> _RuntimeBucketSourceRows:
    return _RuntimeBucketSourceRows(
        decisions=[
            item
            for item in source_rows.decisions
            if window.started_at <= item < window.ended_at
        ],
        executions=[
            item
            for item in source_rows.executions
            if window.started_at <= item < window.ended_at
        ],
        tca_rows=[
            row
            for row in source_rows.tca_rows
            if window.started_at
            <= _row_import_bucketed_at(row, request.bucket_ranges)
            < window.ended_at
        ],
    )


def _decision_alignment_ratio(decision_count: int, trade_count: int) -> Decimal:
    if decision_count <= 0 and trade_count <= 0:
        return Decimal("1")
    if decision_count <= 0:
        return Decimal("0")
    return Decimal(trade_count) / Decimal(decision_count)


def _runtime_ledger_count(rows: Sequence[NormalizedTcaRow], key: str) -> int:
    return sum(
        observation_int(row.runtime_ledger_bucket.get(key))
        for row in rows
        if row.runtime_ledger_bucket
    )


def _observed_bucket_payload_inputs(
    rows: _RuntimeBucketSourceRows,
) -> _ObservedBucketPayloadInputs:
    promotion_rows = [
        row for row in rows.tca_rows if runtime_ledger_row_is_promotion_grade(row)
    ]
    post_cost_bps: Decimal | None
    net_strategy_pnl_after_costs: Decimal
    filled_notional: Decimal
    notional_weighted_sample_count: int
    (
        post_cost_bps,
        net_strategy_pnl_after_costs,
        filled_notional,
        notional_weighted_sample_count,
    ) = runtime_ledger_post_cost_from_rows(promotion_rows)
    return _ObservedBucketPayloadInputs(
        bucket_tca=rows.tca_rows,
        slippage_values=[
            row.abs_slippage_bps
            for row in rows.tca_rows
            if row.abs_slippage_bps is not None
        ],
        basis_counts=dict(
            sorted(
                Counter(row.post_cost_expectancy_basis for row in rows.tca_rows).items()
            )
        ),
        runtime_ledger_buckets=[
            row.runtime_ledger_bucket
            for row in rows.tca_rows
            if row.runtime_ledger_bucket
        ],
        ledger_totals=_ObservedBucketLedgerTotals(
            decision_count=_runtime_ledger_count(rows.tca_rows, "decision_count"),
            trade_count=_runtime_ledger_count(rows.tca_rows, "fill_count"),
            order_count=_runtime_ledger_count(rows.tca_rows, "submitted_order_count"),
            post_cost_bps=post_cost_bps,
            net_strategy_pnl_after_costs=net_strategy_pnl_after_costs,
            filled_notional=filled_notional,
            notional_weighted_sample_count=notional_weighted_sample_count,
            promotion_rows=promotion_rows,
        ),
    )


def _average_slippage_bps(slippage_values: Sequence[Decimal]) -> Decimal:
    if not slippage_values:
        return Decimal("0")
    return sum(slippage_values) / Decimal(len(slippage_values))


def _post_cost_expectancy(
    ledger_totals: _ObservedBucketLedgerTotals,
) -> tuple[Decimal, str]:
    if ledger_totals.post_cost_bps is not None:
        return ledger_totals.post_cost_bps, "runtime_ledger_notional_weighted"
    return Decimal("0"), "no_runtime_ledger_post_cost_rows"


def _observed_bucket_payload(
    *,
    window: _ObservedBucketWindow,
    counts: _ObservedBucketPayloadCounts,
    payload_inputs: _ObservedBucketPayloadInputs,
) -> dict[str, Any]:
    return {
        "bucket_start": window.started_at.isoformat(),
        "bucket_end": window.ended_at.isoformat(),
        "market_session_count": window.market_session_count,
        "decision_count": counts.decision_count,
        "trade_count": counts.trade_count,
        "order_count": counts.order_count,
        "tca_row_count": len(payload_inputs.bucket_tca),
        "slippage_sample_count": len(payload_inputs.slippage_values),
        "post_cost_promotion_sample_count": len(
            payload_inputs.ledger_totals.promotion_rows
        ),
        "post_cost_expectancy_aggregation": counts.post_cost_expectancy_aggregation,
        "runtime_ledger_notional_weighted_sample_count": (
            payload_inputs.ledger_totals.notional_weighted_sample_count
        ),
        "runtime_ledger_filled_notional": str(
            payload_inputs.ledger_totals.filled_notional
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            payload_inputs.ledger_totals.net_strategy_pnl_after_costs
        ),
        "post_cost_basis_counts": payload_inputs.basis_counts,
        "runtime_ledger_buckets": payload_inputs.runtime_ledger_buckets,
    }


def _build_observed_runtime_bucket(
    *,
    request: BuildObservedRuntimeBucketsRequest,
    window: _ObservedBucketWindow,
    rows: _RuntimeBucketSourceRows,
) -> ObservedRuntimeBucket:
    payload_inputs = _observed_bucket_payload_inputs(rows)
    decision_count = max(
        len(rows.decisions),
        payload_inputs.ledger_totals.decision_count,
    )
    trade_count = max(len(rows.executions), payload_inputs.ledger_totals.trade_count)
    order_count = max(len(rows.executions), payload_inputs.ledger_totals.order_count)
    post_cost_expectancy_bps, post_cost_expectancy_aggregation = _post_cost_expectancy(
        payload_inputs.ledger_totals
    )
    return ObservedRuntimeBucket(
        window_started_at=window.started_at,
        window_ended_at=window.ended_at,
        market_session_count=max(window.market_session_count, 1),
        decision_count=decision_count,
        trade_count=trade_count,
        order_count=order_count,
        decision_alignment_ratio=_decision_alignment_ratio(decision_count, trade_count),
        avg_abs_slippage_bps=_average_slippage_bps(payload_inputs.slippage_values),
        post_cost_expectancy_bps=post_cost_expectancy_bps,
        post_cost_promotion_sample_count=len(
            payload_inputs.ledger_totals.promotion_rows
        ),
        post_cost_basis_counts=payload_inputs.basis_counts,
        continuity_ok=request.continuity_ok,
        drift_ok=request.drift_ok,
        dependency_quorum_decision=request.dependency_quorum_decision,
        payload_json=_observed_bucket_payload(
            window=window,
            counts=_ObservedBucketPayloadCounts(
                decision_count=decision_count,
                trade_count=trade_count,
                order_count=order_count,
                post_cost_expectancy_aggregation=post_cost_expectancy_aggregation,
            ),
            payload_inputs=payload_inputs,
        ),
    )


def build_observed_runtime_buckets(**inputs: Any) -> list[ObservedRuntimeBucket]:
    request = _build_observed_runtime_buckets_request(inputs)
    source_rows = _runtime_bucket_source_rows(request)
    buckets: list[ObservedRuntimeBucket] = []
    for bucket_start, bucket_end, market_session_count in request.bucket_ranges:
        window = _ObservedBucketWindow(bucket_start, bucket_end, market_session_count)
        buckets.append(
            _build_observed_runtime_bucket(
                request=request,
                window=window,
                rows=_rows_for_window(request, source_rows, window),
            )
        )
    return buckets


def _runtime_ledger_payload_interval(
    payload: Mapping[str, Any],
) -> tuple[datetime, datetime] | None:
    source_started_at = parse_observation_datetime(payload.get("source_window_start"))
    source_ended_at = parse_observation_datetime(payload.get("source_window_end"))
    if (
        source_started_at is not None
        and source_ended_at is not None
        and source_ended_at > source_started_at
    ):
        return source_started_at, source_ended_at
    bucket_started_at = parse_observation_datetime(payload.get("bucket_started_at"))
    bucket_ended_at = parse_observation_datetime(payload.get("bucket_ended_at"))
    if (
        bucket_started_at is not None
        and bucket_ended_at is not None
        and bucket_ended_at > bucket_started_at
    ):
        return bucket_started_at, bucket_ended_at
    return None


def _runtime_ledger_payload_bucketed_at(
    *,
    computed_at: datetime,
    payload: Mapping[str, Any],
) -> datetime:
    interval = _runtime_ledger_payload_interval(payload)
    if interval is None:
        return computed_at
    started_at, ended_at = interval
    bucketed_at = ended_at - timedelta(microseconds=1)
    if bucketed_at < started_at:
        return started_at
    return bucketed_at


def _runtime_ledger_payload_is_readback(payload: Mapping[str, Any]) -> bool:
    return text_value(payload.get("runtime_ledger_readback_source")) is not None


def _runtime_ledger_payload_identity_values(
    payload: Mapping[str, Any],
    *keys: str,
) -> tuple[str, ...]:
    values: list[str] = []
    for key in keys:
        raw_value = payload.get(key)
        if isinstance(raw_value, Sequence) and not isinstance(
            raw_value, (str, bytes, bytearray)
        ):
            values.extend(string_list(raw_value))
            continue
        text = text_value(raw_value)
        if text is not None:
            values.append(text)
    return tuple(sorted(dict.fromkeys(values)))


def _runtime_ledger_payload_dedupe_key(
    payload: Mapping[str, Any],
) -> tuple[object, ...]:
    interval = _runtime_ledger_payload_interval(payload)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    if interval is not None:
        started_at, ended_at = interval
    return (
        text_value(payload.get("account_label")),
        text_value(payload.get("strategy_id"))
        or text_value(payload.get("runtime_strategy_name")),
        text_value(payload.get("symbol")),
        started_at,
        ended_at,
        _runtime_ledger_payload_identity_values(
            payload,
            "source_window_ids",
            "source_window_id",
        ),
        _runtime_ledger_payload_identity_values(
            payload,
            "execution_order_event_ids",
            "execution_order_event_id",
        ),
        _runtime_ledger_payload_identity_values(
            payload,
            "execution_ids",
            "execution_id",
        ),
        _runtime_ledger_payload_identity_values(
            payload,
            "trade_decision_ids",
            "trade_decision_id",
            "decision_ids",
            "decision_id",
        ),
        text_value(payload.get("source_decision_mode_partition"))
        or text_value(payload.get("source_decision_mode")),
    )


def _runtime_ledger_payloads_overlap(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
) -> bool:
    for left_key, right_key in (
        ("account_label", "account_label"),
        ("strategy_id", "strategy_id"),
        ("symbol", "symbol"),
    ):
        left_value = text_value(left.get(left_key))
        right_value = text_value(right.get(right_key))
        if left_key == "strategy_id":
            left_value = left_value or text_value(left.get("runtime_strategy_name"))
            right_value = right_value or text_value(right.get("runtime_strategy_name"))
        if (
            left_value is not None
            and right_value is not None
            and left_value != right_value
        ):
            return False
    left_interval = _runtime_ledger_payload_interval(left)
    right_interval = _runtime_ledger_payload_interval(right)
    if left_interval is None or right_interval is None:
        return False
    left_start, left_end = left_interval
    right_start, right_end = right_interval
    return left_start < right_end and left_end > right_start


def _runtime_ledger_payload_preference_key(
    payload: Mapping[str, Any],
) -> tuple[int, int, int, int, Decimal, datetime]:
    interval = _runtime_ledger_payload_interval(payload)
    ended_at = (
        interval[1]
        if interval is not None
        else datetime.min.replace(tzinfo=timezone.utc)
    )
    return (
        0 if _runtime_ledger_payload_is_readback(payload) else 1,
        observation_int(payload.get("closed_trade_count")),
        -observation_int(payload.get("open_position_count")),
        observation_int(payload.get("fill_count"))
        + len(
            _runtime_ledger_payload_identity_values(
                payload, "execution_order_event_ids", "execution_order_event_id"
            )
        )
        + len(
            _runtime_ledger_payload_identity_values(
                payload, "execution_ids", "execution_id"
            )
        )
        + len(
            _runtime_ledger_payload_identity_values(
                payload,
                "trade_decision_ids",
                "trade_decision_id",
                "decision_ids",
                "decision_id",
            )
        ),
        observation_decimal(payload.get("filled_notional")),
        ended_at,
    )


def _dedupe_runtime_ledger_bucket_payloads(
    payloads: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    fresh_payloads = [
        payload
        for payload in payloads
        if not _runtime_ledger_payload_is_readback(payload)
    ]
    candidates = [
        payload
        for payload in payloads
        if not (
            _runtime_ledger_payload_is_readback(payload)
            and any(
                _runtime_ledger_payloads_overlap(payload, fresh_payload)
                for fresh_payload in fresh_payloads
            )
        )
    ]
    indexed_by_key: dict[tuple[object, ...], tuple[int, dict[str, Any]]] = {}
    for index, payload in enumerate(candidates):
        key = _runtime_ledger_payload_dedupe_key(payload)
        existing = indexed_by_key.get(key)
        if existing is None or _runtime_ledger_payload_preference_key(
            payload
        ) > _runtime_ledger_payload_preference_key(existing[1]):
            indexed_by_key[key] = (index, payload)
    return [
        payload
        for _, payload in sorted(indexed_by_key.values(), key=lambda item: item[0])
    ]


def runtime_ledger_bucket_payloads(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_payloads = payload.get("runtime_ledger_buckets")
    if isinstance(raw_payloads, Sequence) and not isinstance(
        raw_payloads, (str, bytes, bytearray)
    ):
        payloads: list[dict[str, Any]] = []
        for item in cast(Sequence[object], raw_payloads):
            payload = runtime_ledger_bucket_payload(item)
            if payload:
                payloads.append(payload)
        return _dedupe_runtime_ledger_bucket_payloads(payloads)
    single_payload = runtime_ledger_bucket_payload(payload.get("runtime_ledger_bucket"))
    return [single_payload] if single_payload else []


def _row_ref(table_name: str, row_id: Any) -> str:
    return f"{table_name}:{row_id}"


def _empty_str_list() -> list[str]:
    return []


def _empty_source_offsets() -> list[dict[str, Any]]:
    return []


def _empty_source_offset_keys() -> set[tuple[str, str, str]]:
    return set()


def _empty_str_counter() -> Counter[str]:
    return Counter()


@dataclass(frozen=True)
class _RuntimeWindowReadbackRequest:
    run_id: str
    candidate_id: str | None
    hypothesis_id: str
    observed_stage: str
    window_start: datetime
    window_end: datetime
    metric_rows: Sequence[StrategyHypothesisMetricWindow]
    promotion_rows: Sequence[StrategyPromotionDecision]
    ledger_rows: Sequence[StrategyRuntimeLedgerBucket]
    runtime_ledger_daily_summary: Mapping[str, Any]
    proof_blocker_codes: Sequence[str]


@dataclass
class _ReadbackLedgerRefs:
    source_refs: list[str] = field(default_factory=_empty_str_list)
    source_window_ids: list[str] = field(default_factory=_empty_str_list)
    execution_order_event_ids: list[str] = field(default_factory=_empty_str_list)
    execution_ids: list[str] = field(default_factory=_empty_str_list)
    execution_tca_metric_ids: list[str] = field(default_factory=_empty_str_list)
    trade_decision_ids: list[str] = field(default_factory=_empty_str_list)
    source_offsets: list[dict[str, Any]] = field(default_factory=_empty_source_offsets)
    source_offset_keys: set[tuple[str, str, str]] = field(
        default_factory=_empty_source_offset_keys
    )
    authority_classes: list[str] = field(default_factory=_empty_str_list)
    authority_reasons: list[str] = field(default_factory=_empty_str_list)
    source_materializations: list[str] = field(default_factory=_empty_str_list)
    cost_basis_counts: Counter[str] = field(default_factory=_empty_str_counter)
    blockers: list[str] = field(default_factory=_empty_str_list)
    source_authority_blockers: list[str] = field(default_factory=_empty_str_list)
    source_authority_bucket_count: int = 0


_READBACK_ID_TARGETS = (
    ("source_window_ids", "source_window_ids"),
    ("source_window_refs", "source_window_ids"),
    ("runtime_ledger_source_window_ids", "source_window_ids"),
    ("runtime_ledger_source_window_refs", "source_window_ids"),
    ("source_window_id", "source_window_ids"),
    ("source_window_ref", "source_window_ids"),
    ("runtime_ledger_source_window_id", "source_window_ids"),
    ("runtime_ledger_source_window_ref", "source_window_ids"),
    ("execution_order_event_ids", "execution_order_event_ids"),
    ("execution_order_event_refs", "execution_order_event_ids"),
    ("runtime_ledger_execution_order_event_ids", "execution_order_event_ids"),
    ("execution_order_event_id", "execution_order_event_ids"),
    ("execution_order_event_ref", "execution_order_event_ids"),
    ("execution_ids", "execution_ids"),
    ("execution_refs", "execution_ids"),
    ("execution_id", "execution_ids"),
    ("execution_ref", "execution_ids"),
    ("execution_tca_metric_ids", "execution_tca_metric_ids"),
    ("execution_tca_metric_refs", "execution_tca_metric_ids"),
    ("execution_tca_metric_id", "execution_tca_metric_ids"),
    ("execution_tca_metric_ref", "execution_tca_metric_ids"),
    ("execution_tca_metrics", "execution_tca_metric_ids"),
    ("execution_tca_ids", "execution_tca_metric_ids"),
    ("execution_tca_id", "execution_tca_metric_ids"),
    ("trade_decision_ids", "trade_decision_ids"),
    ("trade_decision_refs", "trade_decision_ids"),
    ("trade_decision_id", "trade_decision_ids"),
    ("trade_decision_ref", "trade_decision_ids"),
    ("decision_ids", "trade_decision_ids"),
    ("decision_id", "trade_decision_ids"),
)


def _readback_request_from_kwargs(
    inputs: Mapping[str, Any],
) -> _RuntimeWindowReadbackRequest:
    return _RuntimeWindowReadbackRequest(
        run_id=cast(str, inputs["run_id"]),
        candidate_id=cast(str | None, inputs["candidate_id"]),
        hypothesis_id=cast(str, inputs["hypothesis_id"]),
        observed_stage=cast(str, inputs["observed_stage"]),
        window_start=cast(datetime, inputs["window_start"]),
        window_end=cast(datetime, inputs["window_end"]),
        metric_rows=cast(
            Sequence[StrategyHypothesisMetricWindow], inputs["metric_rows"]
        ),
        promotion_rows=cast(
            Sequence[StrategyPromotionDecision], inputs["promotion_rows"]
        ),
        ledger_rows=cast(Sequence[StrategyRuntimeLedgerBucket], inputs["ledger_rows"]),
        runtime_ledger_daily_summary=cast(
            Mapping[str, Any],
            inputs["runtime_ledger_daily_summary"],
        ),
        proof_blocker_codes=cast(Sequence[str], inputs["proof_blocker_codes"]),
    )


def _append_unique(target: list[str], values: Sequence[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)


def _payload_text_values(payload: Mapping[str, Any], key: str) -> list[str]:
    values = string_list(payload.get(key))
    if values:
        return values
    value = text_value(payload.get(key))
    return [value] if value is not None else []


def _source_offset_items(payload: Mapping[str, Any]) -> Sequence[object]:
    raw_source_offsets = payload.get("source_offsets")
    if isinstance(raw_source_offsets, Mapping):
        return [cast(object, raw_source_offsets)]
    if isinstance(raw_source_offsets, Sequence) and not isinstance(
        raw_source_offsets,
        (str, bytes, bytearray),
    ):
        return cast(Sequence[object], raw_source_offsets)
    return ()


def _record_source_offsets(
    refs: _ReadbackLedgerRefs,
    payload: Mapping[str, Any],
) -> None:
    for raw_offset in _source_offset_items(payload):
        if not isinstance(raw_offset, Mapping):
            continue
        typed_offset = cast(Mapping[str, Any], raw_offset)
        topic = text_value(typed_offset.get("topic"))
        partition: Any = typed_offset.get("partition")
        source_offset: Any = typed_offset.get("offset")
        if topic is None or partition is None or source_offset is None:
            continue
        offset_key = (topic, str(partition), str(source_offset))
        if offset_key in refs.source_offset_keys:
            continue
        refs.source_offsets.append(
            {"topic": topic, "partition": partition, "offset": source_offset}
        )
        refs.source_offset_keys.add(offset_key)


def _target_ref_list(refs: _ReadbackLedgerRefs, target_name: str) -> list[str]:
    return cast(list[str], getattr(refs, target_name))


def _record_payload_identity_refs(
    refs: _ReadbackLedgerRefs,
    payload: Mapping[str, Any],
) -> None:
    _append_unique(refs.source_refs, string_list(payload.get("source_refs")))
    for key, target_name in _READBACK_ID_TARGETS:
        _append_unique(
            _target_ref_list(refs, target_name), _payload_text_values(payload, key)
        )
    _record_source_offsets(refs, payload)


def _record_payload_metadata_refs(
    refs: _ReadbackLedgerRefs,
    payload: Mapping[str, Any],
) -> None:
    for key, value in mapping_payload(payload.get("cost_basis_counts")).items():
        refs.cost_basis_counts[key] += observation_int(value)
    for key, target in (
        ("authority_class", refs.authority_classes),
        ("authority_reason", refs.authority_reasons),
        ("source_materialization", refs.source_materializations),
    ):
        if (text := text_value(payload.get(key))) is not None and text not in target:
            target.append(text)


def _record_ledger_row_readback(
    refs: _ReadbackLedgerRefs,
    row: StrategyRuntimeLedgerBucket,
) -> None:
    payload_json = mapping_payload(row.payload_json)
    row_source_blockers = runtime_ledger_promotion_source_authority_blockers(
        payload_json
    )
    if row_source_blockers:
        _append_unique(refs.source_authority_blockers, row_source_blockers)
    else:
        refs.source_authority_bucket_count += 1
    _record_payload_identity_refs(refs, payload_json)
    _record_payload_metadata_refs(refs, payload_json)
    _append_unique(refs.blockers, string_list(row.blockers_json))


def _collect_readback_ledger_refs(
    ledger_rows: Sequence[StrategyRuntimeLedgerBucket],
) -> _ReadbackLedgerRefs:
    refs = _ReadbackLedgerRefs()
    for row in ledger_rows:
        _record_ledger_row_readback(refs, row)
    return refs


def _runtime_ledger_row_totals(
    ledger_rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    return {
        "runtime_ledger_fill_count": sum(
            max(0, int(row.fill_count or 0)) for row in ledger_rows
        ),
        "runtime_ledger_submitted_order_count": sum(
            max(0, int(row.submitted_order_count or 0)) for row in ledger_rows
        ),
        "runtime_ledger_closed_trade_count": sum(
            max(0, int(row.closed_trade_count or 0)) for row in ledger_rows
        ),
        "runtime_ledger_open_position_count": sum(
            max(0, int(row.open_position_count or 0)) for row in ledger_rows
        ),
        "runtime_ledger_filled_notional": str(
            sum((row.filled_notional for row in ledger_rows), Decimal("0"))
        ),
        "runtime_ledger_cost_amount": str(
            sum((row.cost_amount for row in ledger_rows), Decimal("0"))
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            sum((row.net_strategy_pnl_after_costs for row in ledger_rows), Decimal("0"))
        ),
    }


def _runtime_ledger_profit_distance_readback(
    request: _RuntimeWindowReadbackRequest,
    refs: _ReadbackLedgerRefs,
    evidence_grade_ledger_rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    total_filled_notional = sum(
        (row.filled_notional for row in request.ledger_rows),
        Decimal("0"),
    )
    return build_runtime_ledger_profit_distance_readback(
        summary={
            **request.runtime_ledger_daily_summary,
            "runtime_ledger_filled_notional": str(total_filled_notional),
        },
        candidate_id=request.candidate_id,
        observed_stage=request.observed_stage,
        runtime_ledger_bucket_count=len(request.ledger_rows),
        evidence_grade_runtime_ledger_bucket_count=len(evidence_grade_ledger_rows),
        source_authority_bucket_count=refs.source_authority_bucket_count,
        source_authority_blockers=refs.source_authority_blockers,
        blockers=[*refs.blockers, *request.proof_blocker_codes],
        total_filled_notional=total_filled_notional,
        total_closed_trade_count=sum(
            max(0, int(row.closed_trade_count or 0)) for row in request.ledger_rows
        ),
        open_position_count=sum(
            max(0, int(row.open_position_count or 0)) for row in request.ledger_rows
        ),
    )


def runtime_window_import_readback_from_rows(**inputs: Any) -> dict[str, Any]:
    request = _readback_request_from_kwargs(inputs)
    refs = _collect_readback_ledger_refs(request.ledger_rows)
    evidence_grade_ledger_rows = [
        row
        for row in request.ledger_rows
        if persisted_runtime_ledger_bucket_evidence_grade(row)
    ]
    return {
        "schema_version": "torghut.runtime-window-import-readback.v1",
        "run_id": request.run_id,
        "candidate_id": request.candidate_id,
        "hypothesis_id": request.hypothesis_id,
        "observed_stage": request.observed_stage,
        "window_start": request.window_start.isoformat(),
        "window_end": request.window_end.isoformat(),
        "metric_window_count": len(request.metric_rows),
        "promotion_decision_count": len(request.promotion_rows),
        "runtime_ledger_bucket_count": len(request.ledger_rows),
        "evidence_grade_runtime_ledger_bucket_count": len(evidence_grade_ledger_rows),
        **_runtime_ledger_row_totals(request.ledger_rows),
        "metric_window_refs": [
            _row_ref("strategy_hypothesis_metric_windows", row.id)
            for row in request.metric_rows
        ],
        "promotion_decision_refs": [
            _row_ref("strategy_promotion_decisions", row.id)
            for row in request.promotion_rows
        ],
        "runtime_ledger_bucket_refs": [
            _row_ref("strategy_runtime_ledger_buckets", row.id)
            for row in request.ledger_rows
        ],
        "evidence_grade_runtime_ledger_bucket_refs": [
            _row_ref("strategy_runtime_ledger_buckets", row.id)
            for row in evidence_grade_ledger_rows
        ],
        "source_refs": refs.source_refs,
        "source_window_ids": refs.source_window_ids,
        "source_window_refs": refs.source_window_ids,
        "runtime_ledger_source_window_ids": refs.source_window_ids,
        "runtime_ledger_source_window_refs": refs.source_window_ids,
        "execution_order_event_ids": refs.execution_order_event_ids,
        "execution_order_event_refs": refs.execution_order_event_ids,
        "runtime_ledger_execution_order_event_ids": refs.execution_order_event_ids,
        "runtime_ledger_execution_order_event_refs": refs.execution_order_event_ids,
        "execution_ids": refs.execution_ids,
        "execution_refs": refs.execution_ids,
        "execution_tca_metric_ids": refs.execution_tca_metric_ids,
        "execution_tca_metric_refs": refs.execution_tca_metric_ids,
        "runtime_ledger_execution_tca_metric_ids": refs.execution_tca_metric_ids,
        "runtime_ledger_execution_tca_metric_refs": refs.execution_tca_metric_ids,
        "trade_decision_ids": refs.trade_decision_ids,
        "trade_decision_refs": refs.trade_decision_ids,
        "decision_ids": refs.trade_decision_ids,
        "decision_refs": refs.trade_decision_ids,
        "source_offsets": refs.source_offsets,
        "authority_classes": refs.authority_classes,
        "authority_reasons": refs.authority_reasons,
        "source_materializations": refs.source_materializations,
        "cost_basis_counts": dict(sorted(refs.cost_basis_counts.items())),
        "runtime_ledger_blockers": refs.blockers,
        "runtime_ledger_profit_distance_readback": (
            _runtime_ledger_profit_distance_readback(
                request,
                refs,
                evidence_grade_ledger_rows,
            )
        ),
    }
