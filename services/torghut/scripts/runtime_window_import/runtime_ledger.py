"""Runtime ledger helpers for runtime window imports."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Sequence


from .parsers import (
    as_mapping,
    parse_dt_or_none,
    text_or_none,
)


def runtime_ledger_tca_rows_from_artifacts(
    artifact_refs: list[str],
    bucket_ranges: Sequence[tuple[Any, Any, int]] | None = None,
) -> tuple[list[Any], list[Any], list[dict[str, Any]], dict[str, Any]]:
    """Load TCA rows from artifacts."""
    runtime_ledger_decisions: list[Any] = []
    runtime_ledger_executions: list[Any] = []
    runtime_ledger_tca_rows: list[dict[str, Any]] = []
    runtime_ledger_artifact_metadata: dict[str, Any] = {
        "runtime_ledger_artifact_refs": [],
        "runtime_ledger_ignored_artifact_refs": [],
        "runtime_ledger_artifact_row_count": 0,
        "runtime_ledger_artifact_fill_count": 0,
        "runtime_ledger_artifact_tca_row_count": 0,
    }

    for ref in artifact_refs:
        artifact = load_json_artifact(ref)
        if not artifact:
            runtime_ledger_artifact_metadata[
                "runtime_ledger_ignored_artifact_refs"
            ].append(ref)
            continue

        runtime_ledger_artifact_metadata["runtime_ledger_artifact_refs"].append(ref)

        schema = runtime_ledger_artifact_schema(artifact)
        if schema not in frozenset(
            {
                "torghut.exact_replay_ledger.rows.v1",
                "torghut.runtime-ledger-bucket.v1",
            }
        ):
            continue

        artifact_rows = runtime_ledger_artifact_rows(artifact)
        runtime_ledger_artifact_metadata["runtime_ledger_artifact_row_count"] += len(
            artifact_rows
        )

        for row in artifact_rows:
            if runtime_ledger_event_type(row) == "decision":
                runtime_ledger_decisions.append(row)
            elif runtime_ledger_event_type(row) in (
                "fill",
                "filled",
                "partial_fill",
                "partially_filled",
            ):
                runtime_ledger_executions.append(row)
                runtime_ledger_artifact_metadata[
                    "runtime_ledger_artifact_fill_count"
                ] += 1

            tca_row = runtime_ledger_tca_row_from_payload(row)
            if tca_row:
                runtime_ledger_tca_rows.append(tca_row)
                runtime_ledger_artifact_metadata[
                    "runtime_ledger_artifact_tca_row_count"
                ] += 1

    return (
        runtime_ledger_decisions,
        runtime_ledger_executions,
        runtime_ledger_tca_rows,
        runtime_ledger_artifact_metadata,
    )


def runtime_ledger_tca_row_from_payload(row: dict[str, Any]) -> dict[str, Any]:
    """Create TCA row from runtime ledger payload."""
    return {
        "runtime_ledger_bucket": row,
        "authoritative": row.get("authoritative"),
        "authority_reason": row.get("authority_reason"),
        "pnl_derivation": row.get("pnl_derivation"),
        "runtime_ledger_blockers": row.get("blockers"),
        "post_cost_expectancy_basis": row.get("pnl_basis"),
        "paper_route_target_notional_sizing": row.get(
            "paper_route_target_notional_sizing"
        ),
    }


def runtime_ledger_artifact_schema(payload: dict[str, Any]) -> str | None:
    """Extract schema version from artifact payload."""
    return text_or_none(
        payload.get("schema_version") or payload.get("ledger_schema_version")
    )


def runtime_ledger_artifact_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract rows from artifact payload."""
    schema = runtime_ledger_artifact_schema(payload)
    if schema not in frozenset(
        {
            "torghut.exact_replay_ledger.rows.v1",
            "torghut.runtime-ledger-bucket.v1",
        }
    ):
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
            row = as_mapping(raw_row)
            if row:
                rows.append({**defaults, **row})
        if rows:
            return rows
    return []


def runtime_ledger_event_type(row: dict[str, Any]) -> str:
    """Normalize event type from runtime ledger row."""
    raw = text_or_none(
        row.get("ledger_event_type")
        or row.get("runtime_ledger_event_type")
        or row.get("lifecycle_event")
        or row.get("event_type")
        or row.get("order_event_type")
        or row.get("order_status")
        or row.get("status")
    )
    if raw is None:
        if any(row.get(key) is not None for key in ("filled_qty", "qty", "quantity")):
            return "fill"
        if any(row.get(key) is not None for key in ("order_id", "alpaca_order_id")):
            return "order_submitted"
        if any(
            row.get(key) is not None
            for key in ("decision_id", "trade_decision_id", "decision_hash")
        ):
            return "decision"
        return "diagnostic"

    normalized = raw.lower().replace("-", "_").replace(" ", "_")
    return {
        "trade_decision": "decision",
        "signal_decision": "decision",
        "partial_fill": "fill",
        "partially_filled": "fill",
    }.get(normalized, normalized)


def load_json_artifact(ref: str) -> dict[str, Any]:
    """Load a JSON artifact from file path."""
    text = ref.strip()
    if not text:
        return {}

    path = __import__("pathlib").Path(text)
    if not path.exists():
        return {}

    try:
        payload = __import__("json").loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    return as_mapping(payload)


def runtime_ledger_tca_rows_from_durable_buckets(
    *,
    session: Any,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_names: list[str],
    account_label: str,
    window_start: Any,
    window_end: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load TCA rows from durable buckets."""
    runtime_ledger_durable_metadata: dict[str, Any] = {
        "runtime_ledger_durable_bucket_count": 0,
        "runtime_ledger_durable_bucket_run_ids": [],
        "runtime_ledger_durable_bucket_fill_count": 0,
        "runtime_ledger_durable_bucket_tca_row_count": 0,
        "runtime_ledger_durable_bucket_profit_proof_count": 0,
    }
    tca_rows: list[dict[str, Any]] = []

    # Placeholder implementation - would query database
    return tca_rows, runtime_ledger_durable_metadata


def runtime_ledger_tca_rows_from_source_dsn(
    *,
    dsn: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str,
    window_start: Any,
    window_end: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load TCA rows from source DSN."""
    runtime_ledger_source_metadata: dict[str, Any] = {
        "runtime_ledger_source_bucket_count": 0,
        "runtime_ledger_source_bucket_run_ids": [],
        "runtime_ledger_source_bucket_fill_count": 0,
        "runtime_ledger_source_bucket_tca_row_count": 0,
        "runtime_ledger_source_bucket_profit_proof_count": 0,
    }
    tca_rows: list[dict[str, Any]] = []

    # Placeholder implementation - would query database
    return tca_rows, runtime_ledger_source_metadata


def runtime_ledger_row_time(row: dict[str, Any]) -> datetime | None:
    """Extract time from runtime ledger row."""
    raw = text_or_none(
        row.get("executed_at")
        or row.get("runtime_ledger_executed_at")
        or row.get("event_time")
        or row.get("event_ts")
        or row.get("execution_event_at")
        or row.get("execution_created_at")
        or row.get("computed_at")
        or row.get("event_fingerprint")
    )
    if raw is None:
        return None
    return parse_dt_or_none(raw)


def runtime_ledger_bucket_payload_from_row(
    row: dict[str, Any],
) -> dict[str, Any]:
    """Create bucket payload from row."""
    return {
        "bucket_started_at": row.get("bucket_started_at"),
        "bucket_ended_at": row.get("bucket_ended_at"),
        "account_label": row.get("account_label"),
        "strategy_id": row.get("strategy_id"),
        "symbol": row.get("symbol"),
        "fill_count": row.get("fill_count"),
        "decision_count": row.get("decision_count"),
        "submitted_order_count": row.get("submitted_order_count"),
        "cancelled_order_count": row.get("cancelled_order_count"),
        "rejected_order_count": row.get("rejected_order_count"),
        "unfilled_order_count": row.get("unfilled_order_count"),
        "closed_trade_count": row.get("closed_trade_count"),
        "open_position_count": row.get("open_position_count"),
        "filled_notional": row.get("filled_notional"),
        "gross_strategy_pnl": row.get("gross_strategy_pnl"),
        "cost_amount": row.get("cost_amount"),
        "net_strategy_pnl_after_costs": row.get("net_strategy_pnl_after_costs"),
        "post_cost_expectancy_bps": row.get("post_cost_expectancy_bps"),
        "diagnostic_closed_trade_expectancy_bps": row.get(
            "diagnostic_closed_trade_expectancy_bps"
        ),
        "cost_basis_counts": row.get("cost_basis_counts"),
        "execution_policy_hash_counts": row.get("execution_policy_hash_counts"),
        "cost_model_hash_counts": row.get("cost_model_hash_counts"),
        "lineage_hash_counts": row.get("lineage_hash_counts"),
        "blockers": row.get("blockers"),
        "ledger_schema_version": row.get("ledger_schema_version"),
        "pnl_basis": row.get("pnl_basis"),
    }


def runtime_ledger_tca_row_from_bucket(
    *,
    bucket: dict[str, Any],
    computed_at: datetime | None = None,
) -> dict[str, Any]:
    """Create TCA row from bucket."""
    from .summary import (
        runtime_ledger_bucket_profit_proof_present as summary_profit_proof,
    )

    payload = runtime_ledger_bucket_payload_from_row(bucket)
    promotion_eligible = summary_profit_proof(bucket)

    filled_notional = text_or_none(bucket.get("filled_notional"))
    cost_amount = text_or_none(bucket.get("cost_amount"))

    try:
        filled_notional_decimal = Decimal(filled_notional) if filled_notional else None
        cost_amount_decimal = Decimal(cost_amount) if cost_amount else None
    except Exception:
        filled_notional_decimal = None
        cost_amount_decimal = None

    return {
        "computed_at": computed_at,
        "abs_slippage_bps": None,
        "explicit_cost_bps": (
            (cost_amount_decimal / filled_notional_decimal) * Decimal("10000")
            if filled_notional_decimal
            and filled_notional_decimal > 0
            and cost_amount_decimal
            else None
        ),
        "post_cost_expectancy_bps": bucket.get("post_cost_expectancy_bps"),
        "post_cost_expectancy_basis": "runtime_ledger_post_cost_pnl_basis",
        "post_cost_promotion_eligible": promotion_eligible,
        "diagnostic_closed_trade_expectancy_bps": bucket.get(
            "diagnostic_closed_trade_expectancy_bps"
        ),
        "diagnostic_closed_trade_expectancy_basis": (
            "realized_closed_trips_after_explicit_costs_not_promotion_grade"
            if bucket.get("diagnostic_closed_trade_expectancy_bps")
            else None
        ),
        "realized_gross_pnl": bucket.get("gross_strategy_pnl"),
        "realized_net_pnl": bucket.get("net_strategy_pnl_after_costs"),
        "turnover_notional": filled_notional_decimal,
        "runtime_ledger_blockers": bucket.get("blockers"),
        "runtime_ledger_cost_basis_counts": bucket.get("cost_basis_counts"),
        "runtime_ledger_pnl_basis": bucket.get("pnl_basis"),
        "runtime_ledger_bucket": payload,
    }
