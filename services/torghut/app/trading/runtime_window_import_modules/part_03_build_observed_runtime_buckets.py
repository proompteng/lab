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


def build_observed_runtime_buckets(
    *,
    bucket_ranges: Sequence[tuple[datetime, datetime, int]],
    decision_times: Sequence[datetime],
    execution_times: Sequence[datetime],
    tca_rows: Sequence[Mapping[str, Any]],
    continuity_ok: bool,
    drift_ok: bool,
    dependency_quorum_decision: str,
) -> list[ObservedRuntimeBucket]:
    normalized_decisions = [_utc(item) for item in decision_times]
    normalized_executions = [_utc(item) for item in execution_times]
    normalized_tca_rows: list[_NormalizedTcaRow] = []
    for row in tca_rows:
        computed_at_raw = row.get("computed_at")
        if not isinstance(computed_at_raw, datetime):
            continue
        basis = _post_cost_expectancy_basis(
            row.get("post_cost_expectancy_basis") or row.get("post_cost_basis")
        )
        runtime_ledger_bucket = _runtime_ledger_bucket_payload(
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
        computed_at = _utc(computed_at_raw)
        normalized_tca_rows.append(
            _NormalizedTcaRow(
                computed_at=computed_at,
                bucketed_at=_runtime_ledger_payload_bucketed_at(
                    computed_at=computed_at,
                    payload=runtime_ledger_bucket,
                ),
                abs_slippage_bps=_optional_decimal(row.get("abs_slippage_bps")),
                post_cost_expectancy_bps=_optional_decimal(
                    row.get("post_cost_expectancy_bps")
                ),
                post_cost_expectancy_basis=basis,
                post_cost_promotion_eligible=_post_cost_basis_is_promotion_grade(
                    basis=basis,
                    explicit_value=row.get("post_cost_promotion_eligible"),
                )
                and source_decision_mode_eligible,
                runtime_ledger_bucket=runtime_ledger_bucket,
                source_decision_mode=source_decision_mode,
            )
        )

    def time_is_in_import_window(value: datetime) -> bool:
        return any(
            bucket_start <= value < bucket_end
            for bucket_start, bucket_end, _ in bucket_ranges
        )

    def row_import_bucketed_at(row: _NormalizedTcaRow) -> datetime:
        if time_is_in_import_window(row.computed_at):
            return row.computed_at
        if time_is_in_import_window(row.bucketed_at):
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

    buckets: list[ObservedRuntimeBucket] = []
    for bucket_start, bucket_end, market_session_count in bucket_ranges:
        decisions = [
            item for item in normalized_decisions if bucket_start <= item < bucket_end
        ]
        executions = [
            item for item in normalized_executions if bucket_start <= item < bucket_end
        ]
        bucket_tca = [
            row
            for row in normalized_tca_rows
            if bucket_start <= row_import_bucketed_at(row) < bucket_end
        ]
        runtime_ledger_decision_count = sum(
            _observation_int(row.runtime_ledger_bucket.get("decision_count"))
            for row in bucket_tca
            if row.runtime_ledger_bucket
        )
        runtime_ledger_trade_count = sum(
            _observation_int(row.runtime_ledger_bucket.get("fill_count"))
            for row in bucket_tca
            if row.runtime_ledger_bucket
        )
        runtime_ledger_order_count = sum(
            _observation_int(row.runtime_ledger_bucket.get("submitted_order_count"))
            for row in bucket_tca
            if row.runtime_ledger_bucket
        )
        decision_count = max(len(decisions), runtime_ledger_decision_count)
        trade_count = max(len(executions), runtime_ledger_trade_count)
        order_count = max(len(executions), runtime_ledger_order_count)
        if decision_count <= 0 and trade_count <= 0:
            decision_alignment_ratio = Decimal("1")
        elif decision_count <= 0:
            decision_alignment_ratio = Decimal("0")
        else:
            decision_alignment_ratio = Decimal(trade_count) / Decimal(decision_count)
        slippage_values = [
            row.abs_slippage_bps
            for row in bucket_tca
            if row.abs_slippage_bps is not None
        ]
        promotion_post_cost_rows = [
            row for row in bucket_tca if _runtime_ledger_row_is_promotion_grade(row)
        ]
        runtime_ledger_post_cost_bps: Decimal | None
        runtime_ledger_net: Decimal
        runtime_ledger_notional: Decimal
        runtime_ledger_sample_count: int
        (
            runtime_ledger_post_cost_bps,
            runtime_ledger_net,
            runtime_ledger_notional,
            runtime_ledger_sample_count,
        ) = _runtime_ledger_post_cost_from_rows(promotion_post_cost_rows)
        basis_counts = dict(
            sorted(
                Counter(row.post_cost_expectancy_basis for row in bucket_tca).items()
            )
        )
        runtime_ledger_buckets = [
            row.runtime_ledger_bucket for row in bucket_tca if row.runtime_ledger_bucket
        ]
        if slippage_values:
            avg_abs_slippage_bps = sum(slippage_values) / Decimal(len(slippage_values))
        else:
            avg_abs_slippage_bps = Decimal("0")
        if runtime_ledger_post_cost_bps is not None:
            post_cost_expectancy_bps = runtime_ledger_post_cost_bps
            post_cost_expectancy_aggregation = "runtime_ledger_notional_weighted"
        else:
            post_cost_expectancy_bps = Decimal("0")
            post_cost_expectancy_aggregation = "no_runtime_ledger_post_cost_rows"
        buckets.append(
            ObservedRuntimeBucket(
                window_started_at=bucket_start,
                window_ended_at=bucket_end,
                market_session_count=max(market_session_count, 1),
                decision_count=decision_count,
                trade_count=trade_count,
                order_count=order_count,
                decision_alignment_ratio=decision_alignment_ratio,
                avg_abs_slippage_bps=avg_abs_slippage_bps,
                post_cost_expectancy_bps=post_cost_expectancy_bps,
                post_cost_promotion_sample_count=len(promotion_post_cost_rows),
                post_cost_basis_counts=basis_counts,
                continuity_ok=continuity_ok,
                drift_ok=drift_ok,
                dependency_quorum_decision=dependency_quorum_decision,
                payload_json={
                    "bucket_start": bucket_start.isoformat(),
                    "bucket_end": bucket_end.isoformat(),
                    "market_session_count": market_session_count,
                    "decision_count": decision_count,
                    "trade_count": trade_count,
                    "order_count": order_count,
                    "tca_row_count": len(bucket_tca),
                    "slippage_sample_count": len(slippage_values),
                    "post_cost_promotion_sample_count": len(promotion_post_cost_rows),
                    "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
                    "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
                    "runtime_ledger_filled_notional": str(runtime_ledger_notional),
                    "runtime_ledger_net_strategy_pnl_after_costs": str(
                        runtime_ledger_net
                    ),
                    "post_cost_basis_counts": basis_counts,
                    "runtime_ledger_buckets": runtime_ledger_buckets,
                },
            )
        )
    return buckets


def _runtime_ledger_payload_interval(
    payload: Mapping[str, Any],
) -> tuple[datetime, datetime] | None:
    source_started_at = _parse_observation_datetime(payload.get("source_window_start"))
    source_ended_at = _parse_observation_datetime(payload.get("source_window_end"))
    if (
        source_started_at is not None
        and source_ended_at is not None
        and source_ended_at > source_started_at
    ):
        return source_started_at, source_ended_at
    bucket_started_at = _parse_observation_datetime(payload.get("bucket_started_at"))
    bucket_ended_at = _parse_observation_datetime(payload.get("bucket_ended_at"))
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
    return _text(payload.get("runtime_ledger_readback_source")) is not None


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
            values.extend(_string_list(raw_value))
            continue
        text = _text(raw_value)
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
        _text(payload.get("account_label")),
        _text(payload.get("strategy_id"))
        or _text(payload.get("runtime_strategy_name")),
        _text(payload.get("symbol")),
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
        _text(payload.get("source_decision_mode_partition"))
        or _text(payload.get("source_decision_mode")),
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
        left_value = _text(left.get(left_key))
        right_value = _text(right.get(right_key))
        if left_key == "strategy_id":
            left_value = left_value or _text(left.get("runtime_strategy_name"))
            right_value = right_value or _text(right.get("runtime_strategy_name"))
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
        _observation_int(payload.get("closed_trade_count")),
        -_observation_int(payload.get("open_position_count")),
        _observation_int(payload.get("fill_count"))
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
        _observation_decimal(payload.get("filled_notional")),
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


def _runtime_ledger_bucket_payloads(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_payloads = payload.get("runtime_ledger_buckets")
    if isinstance(raw_payloads, Sequence) and not isinstance(
        raw_payloads, (str, bytes, bytearray)
    ):
        payloads: list[dict[str, Any]] = []
        for item in cast(Sequence[object], raw_payloads):
            payload = _runtime_ledger_bucket_payload(item)
            if payload:
                payloads.append(payload)
        return _dedupe_runtime_ledger_bucket_payloads(payloads)
    single_payload = _runtime_ledger_bucket_payload(
        payload.get("runtime_ledger_bucket")
    )
    return [single_payload] if single_payload else []


def _row_ref(table_name: str, row_id: Any) -> str:
    return f"{table_name}:{row_id}"


def _runtime_window_import_readback_from_rows(
    *,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    window_start: datetime,
    window_end: datetime,
    metric_rows: Sequence[StrategyHypothesisMetricWindow],
    promotion_rows: Sequence[StrategyPromotionDecision],
    ledger_rows: Sequence[StrategyRuntimeLedgerBucket],
    runtime_ledger_daily_summary: Mapping[str, Any],
    proof_blocker_codes: Sequence[str],
) -> dict[str, Any]:
    evidence_grade_ledger_rows = [
        row
        for row in ledger_rows
        if _persisted_runtime_ledger_bucket_evidence_grade(row)
    ]
    source_refs: list[str] = []
    source_window_ids: list[str] = []
    execution_order_event_ids: list[str] = []
    execution_ids: list[str] = []
    execution_tca_metric_ids: list[str] = []
    trade_decision_ids: list[str] = []
    source_offsets: list[dict[str, Any]] = []
    source_offset_keys: set[tuple[str, str, str]] = set()
    authority_classes: list[str] = []
    authority_reasons: list[str] = []
    source_materializations: list[str] = []
    cost_basis_counts: Counter[str] = Counter()
    blockers: list[str] = []
    source_authority_blockers: list[str] = []
    source_authority_bucket_count = 0
    for row in ledger_rows:
        payload_json = _mapping(row.payload_json)
        row_source_blockers = runtime_ledger_promotion_source_authority_blockers(
            payload_json
        )
        if row_source_blockers:
            for blocker in row_source_blockers:
                if blocker not in source_authority_blockers:
                    source_authority_blockers.append(blocker)
        else:
            source_authority_bucket_count += 1
        for ref in _string_list(payload_json.get("source_refs")):
            if ref not in source_refs:
                source_refs.append(ref)
        for key, target in (
            ("source_window_ids", source_window_ids),
            ("source_window_refs", source_window_ids),
            ("runtime_ledger_source_window_ids", source_window_ids),
            ("runtime_ledger_source_window_refs", source_window_ids),
            ("source_window_id", source_window_ids),
            ("source_window_ref", source_window_ids),
            ("runtime_ledger_source_window_id", source_window_ids),
            ("runtime_ledger_source_window_ref", source_window_ids),
            ("execution_order_event_ids", execution_order_event_ids),
            ("execution_order_event_refs", execution_order_event_ids),
            ("runtime_ledger_execution_order_event_ids", execution_order_event_ids),
            ("execution_order_event_id", execution_order_event_ids),
            ("execution_order_event_ref", execution_order_event_ids),
            ("execution_ids", execution_ids),
            ("execution_refs", execution_ids),
            ("execution_id", execution_ids),
            ("execution_ref", execution_ids),
            ("execution_tca_metric_ids", execution_tca_metric_ids),
            ("execution_tca_metric_refs", execution_tca_metric_ids),
            ("execution_tca_metric_id", execution_tca_metric_ids),
            ("execution_tca_metric_ref", execution_tca_metric_ids),
            ("execution_tca_metrics", execution_tca_metric_ids),
            ("execution_tca_ids", execution_tca_metric_ids),
            ("execution_tca_id", execution_tca_metric_ids),
            ("trade_decision_ids", trade_decision_ids),
            ("trade_decision_refs", trade_decision_ids),
            ("trade_decision_id", trade_decision_ids),
            ("trade_decision_ref", trade_decision_ids),
            ("decision_ids", trade_decision_ids),
            ("decision_id", trade_decision_ids),
        ):
            for value in _string_list(payload_json.get(key)) or [
                item for item in [_text(payload_json.get(key))] if item is not None
            ]:
                if value not in target:
                    target.append(value)
        raw_source_offsets: object = payload_json.get("source_offsets")
        source_offset_items: Sequence[object]
        if isinstance(raw_source_offsets, Mapping):
            source_offset_items = [cast(object, raw_source_offsets)]
        elif isinstance(raw_source_offsets, Sequence) and not isinstance(
            raw_source_offsets,
            (str, bytes, bytearray),
        ):
            source_offset_items = cast(Sequence[object], raw_source_offsets)
        else:
            source_offset_items = ()
        for raw_offset in source_offset_items:
            if not isinstance(raw_offset, Mapping):
                continue
            typed_offset = cast(Mapping[str, Any], raw_offset)
            topic = _text(typed_offset.get("topic"))
            partition: Any = typed_offset.get("partition")
            source_offset: Any = typed_offset.get("offset")
            if topic is None or partition is None or source_offset is None:
                continue
            offset_key = (topic, str(partition), str(source_offset))
            if offset_key not in source_offset_keys:
                source_offsets.append(
                    {
                        "topic": topic,
                        "partition": partition,
                        "offset": source_offset,
                    }
                )
                source_offset_keys.add(offset_key)
        for key, value in _mapping(payload_json.get("cost_basis_counts")).items():
            cost_basis_counts[key] += _observation_int(value)
        if (authority_class := _text(payload_json.get("authority_class"))) is not None:
            if authority_class not in authority_classes:
                authority_classes.append(authority_class)
        if (
            authority_reason := _text(payload_json.get("authority_reason"))
        ) is not None:
            if authority_reason not in authority_reasons:
                authority_reasons.append(authority_reason)
        if (
            source_materialization := _text(payload_json.get("source_materialization"))
        ) is not None:
            if source_materialization not in source_materializations:
                source_materializations.append(source_materialization)
        for blocker in _string_list(row.blockers_json):
            if blocker not in blockers:
                blockers.append(blocker)
    return {
        "schema_version": "torghut.runtime-window-import-readback.v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "metric_window_count": len(metric_rows),
        "promotion_decision_count": len(promotion_rows),
        "runtime_ledger_bucket_count": len(ledger_rows),
        "evidence_grade_runtime_ledger_bucket_count": len(evidence_grade_ledger_rows),
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
            sum(
                (row.net_strategy_pnl_after_costs for row in ledger_rows),
                Decimal("0"),
            )
        ),
        "metric_window_refs": [
            _row_ref("strategy_hypothesis_metric_windows", row.id)
            for row in metric_rows
        ],
        "promotion_decision_refs": [
            _row_ref("strategy_promotion_decisions", row.id) for row in promotion_rows
        ],
        "runtime_ledger_bucket_refs": [
            _row_ref("strategy_runtime_ledger_buckets", row.id) for row in ledger_rows
        ],
        "evidence_grade_runtime_ledger_bucket_refs": [
            _row_ref("strategy_runtime_ledger_buckets", row.id)
            for row in evidence_grade_ledger_rows
        ],
        "source_refs": source_refs,
        "source_window_ids": source_window_ids,
        "source_window_refs": source_window_ids,
        "runtime_ledger_source_window_ids": source_window_ids,
        "runtime_ledger_source_window_refs": source_window_ids,
        "execution_order_event_ids": execution_order_event_ids,
        "execution_order_event_refs": execution_order_event_ids,
        "runtime_ledger_execution_order_event_ids": execution_order_event_ids,
        "runtime_ledger_execution_order_event_refs": execution_order_event_ids,
        "execution_ids": execution_ids,
        "execution_refs": execution_ids,
        "execution_tca_metric_ids": execution_tca_metric_ids,
        "execution_tca_metric_refs": execution_tca_metric_ids,
        "runtime_ledger_execution_tca_metric_ids": execution_tca_metric_ids,
        "runtime_ledger_execution_tca_metric_refs": execution_tca_metric_ids,
        "trade_decision_ids": trade_decision_ids,
        "trade_decision_refs": trade_decision_ids,
        "decision_ids": trade_decision_ids,
        "decision_refs": trade_decision_ids,
        "source_offsets": source_offsets,
        "authority_classes": authority_classes,
        "authority_reasons": authority_reasons,
        "source_materializations": source_materializations,
        "cost_basis_counts": dict(sorted(cost_basis_counts.items())),
        "runtime_ledger_blockers": blockers,
        "runtime_ledger_profit_distance_readback": build_runtime_ledger_profit_distance_readback(
            summary={
                **runtime_ledger_daily_summary,
                "runtime_ledger_filled_notional": str(
                    sum((row.filled_notional for row in ledger_rows), Decimal("0"))
                ),
            },
            candidate_id=candidate_id,
            observed_stage=observed_stage,
            runtime_ledger_bucket_count=len(ledger_rows),
            evidence_grade_runtime_ledger_bucket_count=len(evidence_grade_ledger_rows),
            source_authority_bucket_count=source_authority_bucket_count,
            source_authority_blockers=source_authority_blockers,
            blockers=[*blockers, *proof_blocker_codes],
            total_filled_notional=sum(
                (row.filled_notional for row in ledger_rows),
                Decimal("0"),
            ),
            total_closed_trade_count=sum(
                max(0, int(row.closed_trade_count or 0)) for row in ledger_rows
            ),
            open_position_count=sum(
                max(0, int(row.open_position_count or 0)) for row in ledger_rows
            ),
        ),
    }


__all__ = [name for name in globals() if not name.startswith("__")]
