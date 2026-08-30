#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import (
    build_runtime_ledger_buckets,
)

from scripts.hypothesis_runtime_window_import.common import (
    _parse_dt_or_none,
    _as_mapping,
    _decimal_or_none,
    _text_or_none,
    _first_text,
    _nonnegative_int,
    _metadata_text_list,
    _runtime_ledger_event_type,
    _runtime_ledger_row_time,
    _parse_artifact_window_datetime,
    _window_weekday_count,
    _runtime_ledger_artifact_candidate_ids,
)
from scripts.hypothesis_runtime_window_import.constants import (
    POST_COST_BASIS_RUNTIME_LEDGER,
    RUNTIME_LEDGER_ARTIFACT_SCHEMAS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS,
    _RUNTIME_LEDGER_DECISION_EVENTS,
    _RUNTIME_LEDGER_FILL_EVENTS,
)
from scripts.hypothesis_runtime_window_import.runtime_ledger_authority import (
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_row_from_bucket,
    _append_runtime_ledger_tca_row_blocker,
)
from scripts.hypothesis_runtime_window_import.runtime_observation import (
    _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts,
)


from scripts.hypothesis_runtime_window_import.cli_parsing import (
    _load_json_artifact,
)

_SOURCE_RUNTIME_LEDGER_COLUMNS = (
    "id",
    "run_id",
    "candidate_id",
    "hypothesis_id",
    "observed_stage",
    "bucket_started_at",
    "bucket_ended_at",
    "account_label",
    "runtime_strategy_name",
    "strategy_family",
    "fill_count",
    "decision_count",
    "submitted_order_count",
    "cancelled_order_count",
    "rejected_order_count",
    "unfilled_order_count",
    "closed_trade_count",
    "open_position_count",
    "filled_notional",
    "gross_strategy_pnl",
    "cost_amount",
    "net_strategy_pnl_after_costs",
    "post_cost_expectancy_bps",
    "execution_policy_hash_counts",
    "cost_model_hash_counts",
    "lineage_hash_counts",
    "blockers_json",
    "ledger_schema_version",
    "pnl_basis",
    "payload_json",
)


def _runtime_ledger_artifact_schema(payload: Mapping[str, Any]) -> str | None:
    return _text_or_none(
        payload.get("schema_version") or payload.get("ledger_schema_version")
    )


def _runtime_ledger_artifact_rows(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    if _runtime_ledger_artifact_schema(payload) not in RUNTIME_LEDGER_ARTIFACT_SCHEMAS:
        return []
    defaults = {
        key: value
        for key in (
            "account_label",
            "strategy_id",
            "strategy_name",
            "execution_policy_hash",
            "execution_policy_sha256",
            "cost_model_hash",
            "cost_model_sha256",
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
        )
        if (value := payload.get(key)) is not None
    }
    for key in ("runtime_ledger_rows", "ledger_rows", "rows", "events"):
        raw_rows = payload.get(key)
        if not isinstance(raw_rows, list):
            continue
        rows: list[dict[str, Any]] = []
        for raw_row in raw_rows:
            row = _as_mapping(raw_row)
            if row:
                rows.append({**defaults, **row})
        if rows:
            return rows
    return []


def _runtime_ledger_activity_times(
    rows: list[dict[str, Any]],
) -> tuple[list[datetime], list[datetime]]:
    decision_times: list[datetime] = []
    execution_times: list[datetime] = []
    for row in rows:
        event_time = _runtime_ledger_row_time(row)
        if event_time is None:
            continue
        event_type = _runtime_ledger_event_type(row)
        if event_type in _RUNTIME_LEDGER_DECISION_EVENTS:
            decision_times.append(event_time)
        elif event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            execution_times.append(event_time)
    return decision_times, execution_times


def _runtime_ledger_artifact_window_metadata(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    full_window = _as_mapping(payload.get("full_window"))
    start = _parse_artifact_window_datetime(
        payload.get("window_start")
        or payload.get("bucket_started_at")
        or payload.get("started_at")
        or payload.get("start")
        or full_window.get("start_date")
    )
    end = _parse_artifact_window_datetime(
        payload.get("window_end")
        or payload.get("bucket_ended_at")
        or payload.get("ended_at")
        or payload.get("end")
        or full_window.get("end_date"),
        date_end=True,
    )
    if start is None or end is None:
        row_times = [
            row_time
            for row in rows
            if (row_time := _runtime_ledger_row_time(row)) is not None
        ]
        if row_times:
            start = min(row_times) if start is None else start
            end = max(row_times) + timedelta(microseconds=1) if end is None else end
    if start is None or end is None or end <= start:
        return {}
    return {
        "runtime_ledger_artifact_window_start": start.isoformat(),
        "runtime_ledger_artifact_window_end": end.isoformat(),
        "runtime_ledger_artifact_window_weekday_count": _window_weekday_count(
            start=start,
            end=end,
        ),
    }


def _runtime_ledger_tca_rows_from_artifacts(
    *,
    artifact_refs: list[str],
    bucket_ranges: list[tuple[datetime, datetime, int]],
) -> tuple[list[datetime], list[datetime], list[dict[str, object]], dict[str, Any]]:
    ledger_rows: list[dict[str, Any]] = []
    tca_rows: list[dict[str, object]] = []
    loaded_refs: list[str] = []
    ignored_refs: list[str] = []
    artifact_candidates: list[str] = []
    artifact_window_metadata: list[dict[str, Any]] = []
    artifact_schema_versions: list[str] = []
    for ref in artifact_refs:
        payload = _load_json_artifact(ref)
        if not payload:
            continue
        if schema_version := _runtime_ledger_artifact_schema(payload):
            artifact_schema_versions.append(schema_version)
        rows = _runtime_ledger_artifact_rows(payload)
        if not rows:
            if _runtime_ledger_artifact_schema(payload) is not None:
                ignored_refs.append(ref)
            continue
        loaded_refs.append(ref)
        ledger_rows.extend(rows)
        artifact_candidates.extend(
            _runtime_ledger_artifact_candidate_ids(payload=payload, rows=rows)
        )
        if metadata := _runtime_ledger_artifact_window_metadata(
            payload=payload,
            rows=rows,
        ):
            artifact_window_metadata.append(metadata)
    decision_times, execution_times = _runtime_ledger_activity_times(ledger_rows)
    runtime_bucket_ranges = [(start, end) for start, end, _ in bucket_ranges]
    if ledger_rows and runtime_bucket_ranges:
        for bucket in build_runtime_ledger_buckets(
            ledger_rows,
            bucket_ranges=runtime_bucket_ranges,
            require_order_lifecycle=True,
        ):
            if (
                bucket.fill_count <= 0
                and bucket.decision_count <= 0
                and bucket.submitted_order_count <= 0
                and bucket.cancelled_order_count <= 0
                and bucket.rejected_order_count <= 0
                and bucket.unfilled_order_count <= 0
            ):
                continue
            tca_rows.append(_runtime_ledger_tca_row_from_bucket(bucket=bucket))
    metadata = {
        "runtime_ledger_artifact_refs": loaded_refs,
        "runtime_ledger_ignored_artifact_refs": ignored_refs,
        "runtime_ledger_artifact_row_count": len(ledger_rows),
        "runtime_ledger_artifact_fill_count": sum(
            1
            for row in ledger_rows
            if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
        ),
        "runtime_ledger_artifact_tca_row_count": len(tca_rows),
    }
    unique_artifact_candidates = sorted(dict.fromkeys(artifact_candidates))
    if unique_artifact_candidates:
        metadata["runtime_ledger_artifact_candidate_ids"] = unique_artifact_candidates
    if len(unique_artifact_candidates) == 1:
        metadata["runtime_ledger_artifact_candidate_id"] = unique_artifact_candidates[0]
    elif loaded_refs:
        _append_runtime_ledger_tca_row_blocker(
            tca_rows=tca_rows,
            blocker=(
                "runtime_ledger_artifact_candidate_id_missing"
                if not unique_artifact_candidates
                else "runtime_ledger_artifact_candidate_id_ambiguous"
            ),
        )
    if len(artifact_window_metadata) == 1:
        metadata.update(artifact_window_metadata[0])
    if loaded_refs:
        _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts(tca_rows)
        metadata["runtime_ledger_artifact_schema_versions"] = sorted(
            dict.fromkeys(artifact_schema_versions)
        )
        metadata["runtime_ledger_artifact_authority_class"] = (
            EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS
        )
        metadata["runtime_ledger_artifact_authority_blockers"] = list(
            EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS
        )
    return decision_times, execution_times, tca_rows, metadata


def _runtime_ledger_bucket_payload_from_row(
    row: StrategyRuntimeLedgerBucket,
) -> dict[str, object]:
    payload_json = _as_mapping(row.payload_json)
    payload = {
        "run_id": row.run_id,
        "candidate_id": row.candidate_id,
        "hypothesis_id": row.hypothesis_id,
        "observed_stage": row.observed_stage,
        "bucket_started_at": row.bucket_started_at.isoformat(),
        "bucket_ended_at": row.bucket_ended_at.isoformat(),
        "account_label": row.account_label,
        "strategy_id": row.runtime_strategy_name,
        "runtime_strategy_name": row.runtime_strategy_name,
        "strategy_family": row.strategy_family,
        "fill_count": row.fill_count,
        "decision_count": row.decision_count,
        "submitted_order_count": row.submitted_order_count,
        "cancelled_order_count": row.cancelled_order_count,
        "rejected_order_count": row.rejected_order_count,
        "unfilled_order_count": row.unfilled_order_count,
        "closed_trade_count": row.closed_trade_count,
        "open_position_count": row.open_position_count,
        "filled_notional": str(row.filled_notional),
        "gross_strategy_pnl": str(row.gross_strategy_pnl),
        "cost_amount": str(row.cost_amount),
        "net_strategy_pnl_after_costs": str(row.net_strategy_pnl_after_costs),
        "post_cost_expectancy_bps": (
            str(row.post_cost_expectancy_bps)
            if row.post_cost_expectancy_bps is not None
            else None
        ),
        "execution_policy_hash_counts": row.execution_policy_hash_counts or {},
        "cost_model_hash_counts": row.cost_model_hash_counts or {},
        "lineage_hash_counts": row.lineage_hash_counts or {},
        "blockers": row.blockers_json or [],
        "ledger_schema_version": row.ledger_schema_version,
        "pnl_basis": row.pnl_basis,
    }
    return {**payload_json, **payload}


def _runtime_ledger_tca_row_from_payload(
    *,
    payload: Mapping[str, object],
) -> dict[str, object]:
    bucket_started_at = _parse_dt_or_none(payload.get("bucket_started_at"))
    bucket_ended_at = _parse_dt_or_none(payload.get("bucket_ended_at"))
    computed_at = (
        bucket_ended_at - timedelta(microseconds=1)
        if bucket_ended_at is not None
        else bucket_started_at
    )
    filled_notional = _decimal_or_none(payload.get("filled_notional"))
    cost_amount = _decimal_or_none(payload.get("cost_amount"))
    proof_blockers = _runtime_ledger_bucket_profit_proof_blockers(payload)
    runtime_ledger_blockers = list(
        dict.fromkeys(
            [
                *_metadata_text_list(payload.get("blockers")),
                *proof_blockers,
            ]
        )
    )
    bucket_payload = {
        **dict(payload),
        "runtime_ledger_readback_source": "strategy_runtime_ledger_buckets",
    }
    if proof_blockers:
        bucket_payload["runtime_ledger_profit_proof_blockers"] = proof_blockers
        bucket_payload["blockers"] = runtime_ledger_blockers
    return {
        "computed_at": computed_at or datetime.now(timezone.utc),
        "abs_slippage_bps": (
            (cost_amount / filled_notional) * Decimal("10000")
            if cost_amount is not None
            and filled_notional is not None
            and filled_notional > 0
            else None
        ),
        "post_cost_expectancy_bps": _decimal_or_none(
            payload.get("post_cost_expectancy_bps")
        ),
        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
        "post_cost_promotion_eligible": _runtime_ledger_bucket_profit_proof_present(
            payload
        ),
        "realized_gross_pnl": _decimal_or_none(payload.get("gross_strategy_pnl")),
        "realized_net_pnl": _decimal_or_none(
            payload.get("net_strategy_pnl_after_costs")
        ),
        "turnover_notional": filled_notional,
        "runtime_ledger_blockers": runtime_ledger_blockers,
        "runtime_ledger_cost_basis_counts": payload.get("cost_basis_counts") or {},
        "runtime_ledger_pnl_basis": payload.get("pnl_basis"),
        "runtime_ledger_bucket": bucket_payload,
    }


def _runtime_ledger_bucket_metadata(
    *,
    prefix: str,
    payloads: Sequence[Mapping[str, object]],
    tca_rows: Sequence[Mapping[str, object]],
) -> dict[str, Any]:
    candidate_ids = sorted(
        {
            candidate_id
            for payload in payloads
            if (candidate_id := _text_or_none(payload.get("candidate_id"))) is not None
        }
    )
    proof_blockers = sorted(
        dict.fromkeys(
            blocker
            for payload in payloads
            for blocker in _runtime_ledger_bucket_profit_proof_blockers(payload)
        )
    )
    source_bucket_ids = sorted(
        {
            bucket_id
            for payload in payloads
            if (
                bucket_id := _text_or_none(
                    payload.get("source_runtime_ledger_bucket_id") or payload.get("id")
                )
            )
            is not None
        }
    )
    metadata: dict[str, Any] = {
        f"runtime_ledger_{prefix}_bucket_count": len(payloads),
        f"runtime_ledger_{prefix}_bucket_run_ids": sorted(
            {
                run_id
                for payload in payloads
                if (run_id := _text_or_none(payload.get("run_id"))) is not None
            }
        ),
        f"runtime_ledger_{prefix}_bucket_fill_count": sum(
            _nonnegative_int(payload.get("fill_count")) for payload in payloads
        ),
        f"runtime_ledger_{prefix}_bucket_tca_row_count": len(tca_rows),
        f"runtime_ledger_{prefix}_bucket_profit_proof_count": sum(
            1
            for payload in payloads
            if _runtime_ledger_bucket_profit_proof_present(payload)
        ),
        f"runtime_ledger_{prefix}_bucket_profit_proof_blockers": proof_blockers,
    }
    if candidate_ids:
        metadata[f"runtime_ledger_{prefix}_bucket_candidate_ids"] = candidate_ids
    if len(candidate_ids) == 1:
        metadata[f"runtime_ledger_{prefix}_bucket_candidate_id"] = candidate_ids[0]
    if source_bucket_ids:
        metadata[f"runtime_ledger_{prefix}_bucket_ids"] = source_bucket_ids
        metadata[f"runtime_ledger_{prefix}_bucket_refs"] = [
            f"postgres:strategy_runtime_ledger_buckets:{bucket_id}"
            for bucket_id in source_bucket_ids
        ]
    return metadata


def _runtime_ledger_tca_rows_from_durable_buckets(
    *,
    session: Session,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_names: list[str],
    account_label: str,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[dict[str, object]], dict[str, Any]]:
    query = select(StrategyRuntimeLedgerBucket).where(
        StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id,
        StrategyRuntimeLedgerBucket.observed_stage == observed_stage,
        StrategyRuntimeLedgerBucket.bucket_started_at < window_end,
        StrategyRuntimeLedgerBucket.bucket_ended_at > window_start,
    )
    if candidate_id:
        query = query.where(StrategyRuntimeLedgerBucket.candidate_id == candidate_id)
    if account_label:
        query = query.where(StrategyRuntimeLedgerBucket.account_label == account_label)
    if strategy_names:
        query = query.where(
            StrategyRuntimeLedgerBucket.runtime_strategy_name.in_(strategy_names)
        )
    rows = list(
        session.execute(
            query.order_by(
                StrategyRuntimeLedgerBucket.bucket_ended_at.asc(),
                StrategyRuntimeLedgerBucket.created_at.asc(),
            ).limit(500)
        )
        .scalars()
        .all()
    )
    payloads = [_runtime_ledger_bucket_payload_from_row(row) for row in rows]
    tca_rows = [
        _runtime_ledger_tca_row_from_payload(payload=payload) for payload in payloads
    ]
    metadata = _runtime_ledger_bucket_metadata(
        prefix="durable",
        payloads=payloads,
        tca_rows=tca_rows,
    )
    return tca_rows, metadata


def _source_runtime_ledger_payload_from_row(
    row: Sequence[object],
) -> dict[str, object]:
    payload = dict(zip(_SOURCE_RUNTIME_LEDGER_COLUMNS, row, strict=True))
    payload_json = {
        key: value
        for key, value in _as_mapping(payload.get("payload_json")).items()
        if key != "payload_json"
    }
    if source_bucket_id := _text_or_none(payload.get("id")):
        source_bucket_ref = (
            f"postgres:strategy_runtime_ledger_buckets:{source_bucket_id}"
        )
        source_refs = _metadata_text_list(payload_json.get("source_refs"))
        if source_bucket_ref not in source_refs:
            source_refs.append(source_bucket_ref)
        source_row_counts = {
            str(key): _nonnegative_int(value)
            for key, value in _as_mapping(payload_json.get("source_row_counts")).items()
        }
        source_row_counts["strategy_runtime_ledger_buckets"] = max(
            1,
            source_row_counts.get("strategy_runtime_ledger_buckets", 0),
        )
        payload_json["source_refs"] = source_refs
        payload_json["source_row_counts"] = source_row_counts
        payload_json["source_runtime_ledger_bucket_id"] = source_bucket_id
        payload_json["source_runtime_ledger_bucket_ref"] = source_bucket_ref
    row_payload = {
        key: value for key, value in payload.items() if key != "payload_json"
    }
    started_at = _parse_dt_or_none(payload.get("bucket_started_at"))
    ended_at = _parse_dt_or_none(payload.get("bucket_ended_at"))
    return {
        **payload_json,
        **row_payload,
        "bucket_started_at": started_at.isoformat()
        if started_at is not None
        else payload.get("bucket_started_at"),
        "bucket_ended_at": ended_at.isoformat()
        if ended_at is not None
        else payload.get("bucket_ended_at"),
        "strategy_id": payload.get("runtime_strategy_name"),
        "execution_policy_hash_counts": _as_mapping(
            payload.get("execution_policy_hash_counts")
        ),
        "cost_model_hash_counts": _as_mapping(payload.get("cost_model_hash_counts")),
        "lineage_hash_counts": _as_mapping(payload.get("lineage_hash_counts")),
        "blockers": _metadata_text_list(payload.get("blockers_json")),
    }


def _runtime_ledger_tca_rows_from_source_dsn(
    *,
    dsn: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[dict[str, object]], dict[str, Any]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    where_clauses = [
        "hypothesis_id = %s",
        "observed_stage = %s",
        "bucket_started_at < %s",
        "bucket_ended_at > %s",
    ]
    params: list[object] = [hypothesis_id, observed_stage, window_end, window_start]
    if candidate_id:
        where_clauses.append("candidate_id = %s")
        params.append(candidate_id)
    if account_label:
        where_clauses.append("account_label = %s")
        params.append(account_label)
    where_clauses.append("runtime_strategy_name = any(%s)")
    params.append(strategy_names)
    empty_metadata = _runtime_ledger_bucket_metadata(
        prefix="source",
        payloads=[],
        tca_rows=[],
    )
    try:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    select {", ".join(_SOURCE_RUNTIME_LEDGER_COLUMNS)}
                    from strategy_runtime_ledger_buckets
                    where {" and ".join(where_clauses)}
                    order by bucket_ended_at asc, created_at asc
                    limit 500
                    """,
                    tuple(params),
                )
                rows = cur.fetchall()
    except (
        psycopg.OperationalError,
        psycopg.errors.UndefinedTable,
        psycopg.errors.UndefinedColumn,
    ) as exc:
        return [], {
            **empty_metadata,
            "runtime_ledger_source_bucket_unavailable": type(exc).__name__,
        }
    payloads = [_source_runtime_ledger_payload_from_row(row) for row in rows]
    tca_rows = [
        _runtime_ledger_tca_row_from_payload(payload=payload) for payload in payloads
    ]
    materialized_account_label = str(target_account_label or "").strip()
    if materialized_account_label and materialized_account_label != account_label:
        tca_rows = _retarget_runtime_ledger_tca_rows(
            tca_rows,
            target_account_label=materialized_account_label,
            source_account_label=account_label,
        )
    return tca_rows, _runtime_ledger_bucket_metadata(
        prefix="source",
        payloads=payloads,
        tca_rows=tca_rows,
    )


def _retarget_source_rows_for_materialization(
    rows: Sequence[Mapping[str, object]],
    *,
    target_account_label: str,
    source_account_label: str,
) -> list[dict[str, object]]:
    if not target_account_label or target_account_label == source_account_label:
        return [dict(row) for row in rows]
    retargeted: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        source_row_account_label = (
            _first_text(payload, "account_label", "alpaca_account_label")
            or source_account_label
        )
        payload.setdefault("source_row_account_label", source_row_account_label)
        payload["source_account_label"] = source_account_label
        payload["account_label"] = target_account_label
        retargeted.append(payload)
    return retargeted


def _retarget_runtime_ledger_tca_rows(
    rows: Sequence[Mapping[str, object]],
    *,
    target_account_label: str,
    source_account_label: str,
) -> list[dict[str, object]]:
    if not target_account_label or target_account_label == source_account_label:
        return [dict(row) for row in rows]
    retargeted: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        source_row_account_label = (
            _first_text(payload, "account_label", "alpaca_account_label")
            or source_account_label
        )
        payload.setdefault("source_row_account_label", source_row_account_label)
        payload["source_account_label"] = source_account_label
        if "account_label" in payload:
            payload["account_label"] = target_account_label
        bucket = _as_mapping(payload.get("runtime_ledger_bucket"))
        if bucket:
            source_bucket_label = (
                _text_or_none(bucket.get("source_account_label"))
                or source_account_label
            )
            payload["runtime_ledger_bucket"] = {
                **bucket,
                "account_label": target_account_label,
                "source_account_label": source_bucket_label,
            }
        retargeted.append(payload)
    return retargeted


__all__ = [
    "_runtime_ledger_artifact_schema",
    "_runtime_ledger_artifact_rows",
    "_runtime_ledger_activity_times",
    "_runtime_ledger_artifact_window_metadata",
    "_runtime_ledger_tca_rows_from_artifacts",
    "_runtime_ledger_bucket_payload_from_row",
    "_runtime_ledger_tca_row_from_payload",
    "_runtime_ledger_bucket_metadata",
    "_runtime_ledger_tca_rows_from_durable_buckets",
    "_source_runtime_ledger_payload_from_row",
    "_runtime_ledger_tca_rows_from_source_dsn",
    "_retarget_source_rows_for_materialization",
    "_retarget_runtime_ledger_tca_rows",
]
