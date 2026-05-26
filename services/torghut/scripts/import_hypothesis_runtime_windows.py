#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
    RuntimeLedgerFill,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from app.trading.runtime_window_import import (
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
    resolve_hypothesis_manifest,
)

EXECUTION_ELIGIBLE_DECISION_STATUSES = (
    "submitted",
    "filled",
    "partially_filled",
)
POST_COST_BASIS_RUNTIME_LEDGER = POST_COST_PNL_BASIS
POST_COST_BASIS_EXECUTION_RECONSTRUCTION = (
    "execution_reconstructed_pnl_after_explicit_costs"
)
POST_COST_BASIS_SIMULATION_REPORT = "simulation_report_net_pnl"
POST_COST_BASIS_TCA_PROXY = "tca_shortfall_proxy"
RUNTIME_LEDGER_ARTIFACT_SCHEMAS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "torghut.exact_replay_ledger.rows.v1",
    }
)
RUNTIME_LEDGER_BUCKET_SCHEMAS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "torghut.runtime-ledger-bucket.v1",
    }
)
_RUNTIME_LEDGER_DECISION_EVENTS = frozenset(
    {"decision", "trade_decision", "signal_decision"}
)
_RUNTIME_LEDGER_FILL_EVENTS = frozenset(
    {"fill", "filled", "partial_fill", "partially_filled"}
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import observed runtime windows into strategy hypothesis governance tables.",
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--candidate-id", default="")
    parser.add_argument("--hypothesis-id", required=True)
    parser.add_argument("--observed-stage", required=True, choices=("paper", "live"))
    parser.add_argument("--strategy-family", default="")
    parser.add_argument("--source-dsn", default="")
    parser.add_argument("--source-dsn-env", default="DB_DSN")
    parser.add_argument("--strategy-name", required=True)
    parser.add_argument("--account-label", required=True)
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--bucket-minutes", type=int, default=30)
    parser.add_argument("--sample-minutes", type=int, default=5)
    parser.add_argument("--source-manifest-ref", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--dataset-snapshot-ref", default="")
    parser.add_argument("--artifact-ref", action="append", default=[])
    parser.add_argument(
        "--target-metadata-json",
        default="",
        help=(
            "JSON object copied from the candidate-board runtime-window target. "
            "Used for evidence-collection-only paper probation handoffs."
        ),
    )
    parser.add_argument("--delay-adjusted-depth-stress-report-ref", default="")
    parser.add_argument("--dependency-quorum-decision", default="")
    parser.add_argument("--continuity-ok", default="")
    parser.add_argument("--drift-ok", default="")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _flag(value: str) -> bool:
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


def _parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_dt_or_none(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _parse_dt(text)
    except Exception:
        return None


def _as_mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _parse_target_metadata(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception as exc:
        raise RuntimeError("target_metadata_json_invalid") from exc
    if not isinstance(payload, Mapping):
        raise RuntimeError("target_metadata_json_not_mapping")
    return {str(key): value for key, value in payload.items()}


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _text_or_none(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _row_payloads(row: Mapping[str, object]) -> list[Mapping[str, object]]:
    payloads: list[Mapping[str, object]] = []

    def append_payload(value: object, *, depth: int) -> None:
        if not isinstance(value, Mapping):
            return
        payload = {str(item_key): item for item_key, item in value.items()}
        payloads.append(payload)
        if depth <= 0:
            return
        for nested in payload.values():
            if isinstance(nested, Mapping):
                append_payload(nested, depth=depth - 1)

    append_payload(row, depth=4)
    return payloads


def _first_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None:
                return parsed
    return None


def _first_text(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            text = str(payload.get(key) or "").strip()
            if text:
                return text
    return None


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


def _stable_payload_digest(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    payload = {str(item_key): item for item_key, item in value.items()}
    if not payload:
        return None
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _first_payload_digest(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            if digest := _stable_payload_digest(payload.get(key)):
                return digest
    return None


_LINEAGE_CONTEXT_KEYS = (
    "simulation_run_id",
    "dataset_id",
    "dataset_snapshot_ref",
    "dataset_snapshot_hash",
    "replay_data_hash",
    "replay_tape_content_sha256",
    "source_query_digest",
    "source_topic",
    "source_partition",
)


def _first_lineage_digest(row: Mapping[str, object]) -> str | None:
    if digest := _first_payload_digest(
        row, "lineage", "candidate_lineage", "source_lineage"
    ):
        return digest
    for payload in _row_payloads(row):
        lineage_payload = {
            key: value
            for key in _LINEAGE_CONTEXT_KEYS
            if (value := payload.get(key)) is not None
        }
        if digest := _stable_payload_digest(lineage_payload):
            return digest
    return None


def _runtime_ledger_bucket_payload(bucket: RuntimeLedgerBucket) -> dict[str, object]:
    return {
        "bucket_started_at": bucket.bucket_started_at.isoformat(),
        "bucket_ended_at": bucket.bucket_ended_at.isoformat(),
        "account_label": bucket.account_label,
        "strategy_id": bucket.strategy_id,
        "symbol": bucket.symbol,
        "fill_count": bucket.fill_count,
        "decision_count": bucket.decision_count,
        "submitted_order_count": bucket.submitted_order_count,
        "cancelled_order_count": bucket.cancelled_order_count,
        "rejected_order_count": bucket.rejected_order_count,
        "unfilled_order_count": bucket.unfilled_order_count,
        "closed_trade_count": bucket.closed_trade_count,
        "open_position_count": bucket.open_position_count,
        "filled_notional": str(bucket.filled_notional),
        "gross_strategy_pnl": str(bucket.gross_strategy_pnl),
        "cost_amount": str(bucket.cost_amount),
        "net_strategy_pnl_after_costs": str(bucket.net_strategy_pnl_after_costs),
        "post_cost_expectancy_bps": (
            str(bucket.post_cost_expectancy_bps)
            if bucket.post_cost_expectancy_bps is not None
            else None
        ),
        "cost_basis_counts": bucket.cost_basis_counts,
        "execution_policy_hash_counts": bucket.execution_policy_hash_counts,
        "cost_model_hash_counts": bucket.cost_model_hash_counts,
        "lineage_hash_counts": bucket.lineage_hash_counts,
        "blockers": bucket.blockers,
        "ledger_schema_version": bucket.ledger_schema_version,
        "pnl_basis": bucket.pnl_basis,
    }


def _mapping_hash_count(value: object) -> int:
    if not isinstance(value, Mapping):
        return 0
    return sum(1 for key in value.keys() if str(key).strip())


def _runtime_ledger_bucket_profit_proof_present(
    bucket: Mapping[str, object],
) -> bool:
    filled_notional = _decimal_or_none(bucket.get("filled_notional"))
    cost_amount = _decimal_or_none(bucket.get("cost_amount"))
    post_cost_expectancy = _decimal_or_none(bucket.get("post_cost_expectancy_bps"))
    if bucket.get("pnl_basis") != POST_COST_BASIS_RUNTIME_LEDGER:
        return False
    if bucket.get("ledger_schema_version") not in RUNTIME_LEDGER_BUCKET_SCHEMAS:
        return False
    if bucket.get("blockers"):
        return False
    if _nonnegative_int(bucket.get("fill_count")) <= 0:
        return False
    if _nonnegative_int(bucket.get("decision_count")) <= 0:
        return False
    if _nonnegative_int(bucket.get("submitted_order_count")) <= 0:
        return False
    if _nonnegative_int(bucket.get("closed_trade_count")) <= 0:
        return False
    if bucket.get("open_position_count") is None:
        return False
    if _nonnegative_int(bucket.get("open_position_count")) > 0:
        return False
    if filled_notional is None or filled_notional <= 0:
        return False
    if cost_amount is None or cost_amount < 0:
        return False
    if post_cost_expectancy is None:
        return False
    if _mapping_hash_count(bucket.get("execution_policy_hash_counts")) <= 0:
        return False
    if _mapping_hash_count(bucket.get("cost_model_hash_counts")) <= 0:
        return False
    if _mapping_hash_count(bucket.get("lineage_hash_counts")) <= 0:
        return False
    return True


def _runtime_ledger_tca_row_from_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    computed_at: datetime | None = None,
) -> dict[str, object]:
    payload = _runtime_ledger_bucket_payload(bucket)
    promotion_eligible = _runtime_ledger_bucket_profit_proof_present(payload)
    return {
        "computed_at": computed_at
        or max(
            bucket.bucket_started_at,
            bucket.bucket_ended_at - timedelta(microseconds=1),
        ),
        "abs_slippage_bps": None,
        "explicit_cost_bps": (
            (bucket.cost_amount / bucket.filled_notional) * Decimal("10000")
            if bucket.filled_notional > 0
            else None
        ),
        "post_cost_expectancy_bps": bucket.post_cost_expectancy_bps,
        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
        "post_cost_promotion_eligible": promotion_eligible,
        "realized_gross_pnl": bucket.gross_strategy_pnl,
        "realized_net_pnl": bucket.net_strategy_pnl_after_costs,
        "turnover_notional": bucket.filled_notional,
        "runtime_ledger_blockers": bucket.blockers,
        "runtime_ledger_cost_basis_counts": bucket.cost_basis_counts,
        "runtime_ledger_pnl_basis": bucket.pnl_basis,
        "runtime_ledger_bucket": payload,
    }


def _append_runtime_ledger_tca_row_blocker(
    *,
    tca_rows: list[dict[str, object]],
    blocker: str,
) -> None:
    for row in tca_rows:
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        bucket_payload = {str(key): item for key, item in bucket.items()}
        blockers = _metadata_text_list(bucket_payload.get("blockers"))
        if blocker not in blockers:
            blockers.append(blocker)
        bucket_payload["blockers"] = blockers
        row["runtime_ledger_bucket"] = bucket_payload
        row["runtime_ledger_blockers"] = blockers
        row["post_cost_promotion_eligible"] = False


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def _metadata_text_list(value: Any) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if not isinstance(value, Sequence) or isinstance(value, (bytes, bytearray)):
        return []
    return [
        text for item in cast(Sequence[Any], value) if (text := str(item or "").strip())
    ]


def _metadata_symbol_list(value: Any) -> list[str]:
    symbols: list[str] = []
    for item in _metadata_text_list(value):
        symbol = item.strip().upper()
        if symbol:
            symbols.append(symbol)
    return list(dict.fromkeys(symbols))


def _target_metadata_source_symbols(target_metadata: Mapping[str, Any]) -> list[str]:
    return _metadata_symbol_list(target_metadata.get("paper_route_probe_symbols"))


def _runtime_ledger_target_metadata_artifact_refs(
    target_metadata: Mapping[str, Any],
) -> list[str]:
    refs: list[str] = []
    for key in (
        "runtime_ledger_artifact_refs",
        "exact_replay_ledger_artifact_refs",
    ):
        refs.extend(_metadata_text_list(target_metadata.get(key)))
    for key in (
        "runtime_ledger_artifact_ref",
        "exact_replay_ledger_artifact_ref",
    ):
        refs.extend(_metadata_text_list(target_metadata.get(key)))
    return list(dict.fromkeys(refs))


def _metadata_nonnegative_int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return _nonnegative_int(value)


def _runtime_ledger_target_metadata_blockers(
    *,
    target_metadata: Mapping[str, Any],
    runtime_ledger_artifact_metadata: Mapping[str, Any],
    window_start: datetime,
    window_end: datetime,
) -> list[str]:
    metadata = _as_mapping(target_metadata)
    if not metadata:
        return []

    blockers: list[str] = []
    planned_refs = _runtime_ledger_target_metadata_artifact_refs(metadata)
    if planned_refs:
        loaded_refs = _metadata_text_list(
            runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_refs")
        )
        if set(planned_refs) != set(loaded_refs):
            blockers.append("runtime_ledger_artifact_refs_mismatch")

    for key, blocker in (
        (
            "runtime_ledger_artifact_row_count",
            "runtime_ledger_artifact_row_count_mismatch",
        ),
        (
            "runtime_ledger_artifact_fill_count",
            "runtime_ledger_artifact_fill_count_mismatch",
        ),
    ):
        planned_count = _metadata_nonnegative_int_or_none(metadata.get(key))
        if planned_count is None:
            continue
        loaded_count = _nonnegative_int(runtime_ledger_artifact_metadata.get(key))
        if planned_count != loaded_count:
            blockers.append(blocker)

    for key, actual_bound in (
        ("window_start", window_start),
        ("window_end", window_end),
    ):
        expected_bound = _parse_dt_or_none(metadata.get(key))
        if metadata.get(key) is not None and expected_bound != actual_bound:
            blockers.append("runtime_ledger_window_bounds_mismatch")
            break

    expected_candidate_id = _text_or_none(metadata.get("candidate_id"))
    loaded_candidate_ids = _metadata_text_list(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_candidate_ids")
    )
    loaded_candidate_id = _text_or_none(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_candidate_id")
    )
    if expected_candidate_id is not None:
        if loaded_candidate_ids:
            if expected_candidate_id not in loaded_candidate_ids:
                blockers.append("runtime_ledger_artifact_candidate_id_mismatch")
            elif len(loaded_candidate_ids) > 1:
                blockers.append("runtime_ledger_artifact_candidate_id_ambiguous")
        elif loaded_candidate_id is None:
            blockers.append("runtime_ledger_artifact_candidate_id_missing")
        elif expected_candidate_id != loaded_candidate_id:
            blockers.append("runtime_ledger_artifact_candidate_id_mismatch")

    planned_window_weekdays = _metadata_nonnegative_int_or_none(
        metadata.get("replay_window_weekday_count")
    )
    loaded_window_weekdays = _metadata_nonnegative_int_or_none(
        runtime_ledger_artifact_metadata.get(
            "runtime_ledger_artifact_window_weekday_count"
        )
    )
    if planned_window_weekdays is not None:
        if loaded_window_weekdays is None:
            blockers.append("runtime_ledger_artifact_window_weekday_count_missing")
        elif planned_window_weekdays != loaded_window_weekdays:
            blockers.append("runtime_ledger_artifact_window_weekday_count_mismatch")

    min_window_weekdays = _metadata_nonnegative_int_or_none(
        metadata.get("replay_min_window_weekday_count")
    )
    if min_window_weekdays is not None:
        if loaded_window_weekdays is None:
            blockers.append("runtime_ledger_artifact_window_weekday_count_missing")
        elif loaded_window_weekdays < min_window_weekdays:
            blockers.append("runtime_ledger_artifact_window_weekday_count_below_min")

    return list(dict.fromkeys(blockers))


def _runtime_window_source_kind_is_informational(
    *,
    source_kind: str,
    target_metadata: Mapping[str, Any],
) -> bool:
    normalized = source_kind.strip().lower().replace("-", "_")
    if normalized.startswith("simulation_"):
        return True
    if any(
        marker in normalized
        for marker in (
            "informational",
            "non_authoritative",
            "offline_replay_triage",
            "selection_only",
        )
    ):
        return True
    scope = (
        str(
            target_metadata.get("paper_probation_authorization_scope")
            or target_metadata.get("evidence_scope")
            or ""
        )
        .strip()
        .lower()
        .replace("-", "_")
    )
    return scope == "evidence_collection_only"


def _runtime_window_import_proof_hygiene_blockers(
    *,
    source_kind: str,
    target_metadata: Mapping[str, Any],
    dependency_quorum_decision: str,
    continuity_ok: str,
    drift_ok: str,
) -> list[str]:
    blockers: list[str] = []
    if not target_metadata and not _runtime_window_source_kind_is_informational(
        source_kind=source_kind,
        target_metadata=target_metadata,
    ):
        blockers.append("runtime_window_target_metadata_missing")
    if not dependency_quorum_decision.strip():
        blockers.append("dependency_quorum_decision_missing")
    if not continuity_ok.strip():
        blockers.append("continuity_gate_missing")
    if not drift_ok.strip():
        blockers.append("drift_gate_missing")
    return blockers


def _runtime_ledger_profit_proof_present(
    tca_rows: list[dict[str, object]],
) -> bool:
    for row in tca_rows:
        if row.get("post_cost_expectancy_basis") != POST_COST_BASIS_RUNTIME_LEDGER:
            continue
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        if _runtime_ledger_bucket_profit_proof_present(bucket):
            return True
    return False


def _runtime_observation_authority_payload(
    *,
    source_kind: str,
    tca_rows: list[dict[str, object]],
) -> dict[str, object]:
    has_runtime_ledger_profit_proof = _runtime_ledger_profit_proof_present(tca_rows)
    if source_kind.startswith("simulation_"):
        return {
            "authoritative": False,
            "authority_reason": "simulation_source_replay_only",
            "promotion_authority": "blocked",
            "runtime_ledger_profit_proof_present": has_runtime_ledger_profit_proof,
        }
    if has_runtime_ledger_profit_proof:
        return {
            "authoritative": True,
            "authority_reason": "runtime_ledger_profit_proof",
            "promotion_authority": "runtime_ledger",
            "runtime_ledger_profit_proof_present": True,
        }
    return {
        "authoritative": False,
        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
        "promotion_authority": "blocked",
        "runtime_ledger_profit_proof_present": False,
    }


def _strategy_name_candidates(*values: str | None) -> list[str]:
    candidates: list[str] = []
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        variants = [
            raw,
            raw.split("@", 1)[0],
            raw.replace("_", "-"),
            raw.split("@", 1)[0].replace("_", "-"),
        ]
        for variant in variants:
            normalized = variant.strip()
            if normalized and normalized not in candidates:
                candidates.append(normalized)
    return candidates


def _execution_signed_qty(*, side: Any, qty: Any) -> Decimal:
    normalized_side = str(side or "").strip().lower()
    quantity = _decimal_or_none(qty)
    if quantity is None or quantity <= 0:
        return Decimal("0")
    if normalized_side == "buy":
        return quantity
    if normalized_side == "sell":
        return -quantity
    return Decimal("0")


def _build_realized_strategy_pnl_rows(
    execution_rows: list[dict[str, object]],
) -> list[dict[str, object]]:
    ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    event_times: list[datetime] = []
    for row in execution_rows:
        computed_at = row.get("computed_at")
        price = _decimal_or_none(row.get("avg_fill_price"))
        signed_qty = _execution_signed_qty(
            side=row.get("side"), qty=row.get("filled_qty")
        )
        symbol = str(row.get("symbol") or "").strip().upper()
        if not symbol or not isinstance(computed_at, datetime):
            continue
        event_times.append(computed_at)
        decision_id = _first_text(
            row, "decision_id", "trade_decision_id", "decision_hash"
        )
        order_id = _first_text(
            row,
            "order_id",
            "alpaca_order_id",
            "client_order_id",
            "execution_correlation_id",
        )
        common_ledger_fields = {
            "executed_at": computed_at,
            "account_label": str(row.get("account_label") or "") or None,
            "strategy_id": str(row.get("strategy_id") or "") or None,
            "symbol": symbol,
            "decision_id": decision_id,
            "order_id": order_id,
            "execution_policy_hash": _first_text(
                row,
                "execution_policy_hash",
                "execution_policy_sha256",
                "policy_hash",
                "execution_idempotency_key",
            )
            or _first_payload_digest(
                row,
                "execution_policy",
                "execution_policy_context",
                "execution_advisor",
                "_execution_advice_provenance",
            ),
            "cost_model_hash": _first_text(
                row, "cost_model_hash", "fee_model_hash", "cost_model_sha256"
            )
            or _first_payload_digest(
                row,
                "cost_model",
                "cost_model_config",
                "transaction_cost_model",
                "fee_model",
                "fees_model",
                "model",
            ),
            "lineage_hash": _first_text(
                row,
                "lineage_hash",
                "candidate_lineage_hash",
                "replay_lineage_hash",
                "candidate_evaluation_key",
            )
            or _first_lineage_digest(row),
            "replay_data_hash": _first_text(
                row,
                "replay_data_hash",
                "replay_tape_content_sha256",
                "dataset_snapshot_hash",
                "source_query_digest",
            ),
        }
        if decision_id is not None:
            ledger_rows.append({**common_ledger_fields, "event_type": "decision"})
        if order_id is not None:
            ledger_rows.append(
                {**common_ledger_fields, "event_type": "order_submitted"}
            )
        if price is None or price <= 0 or signed_qty == 0:
            continue
        cost_amount = _first_decimal(
            row,
            "cost_amount",
            "explicit_cost",
            "commission",
            "fees",
            "fee_amount",
            "broker_fee",
        )
        cost_basis = _first_text(
            row,
            "cost_basis",
            "cost_source",
            "fee_basis",
            "commission_basis",
            "broker_fee_basis",
        )
        ledger_rows.append(
            RuntimeLedgerFill(
                executed_at=computed_at,
                event_type="fill",
                decision_id=decision_id,
                order_id=order_id,
                execution_policy_hash=common_ledger_fields["execution_policy_hash"],
                cost_model_hash=common_ledger_fields["cost_model_hash"],
                lineage_hash=common_ledger_fields["lineage_hash"],
                replay_data_hash=common_ledger_fields["replay_data_hash"],
                side=str(row.get("side") or ""),
                filled_qty=abs(signed_qty),
                avg_fill_price=price,
                cost_amount=cost_amount,
                cost_basis=cost_basis,
                account_label=str(row.get("account_label") or "") or None,
                strategy_id=str(row.get("strategy_id") or "") or None,
                symbol=symbol,
            )
        )
    if not event_times:
        return []
    unique_times = sorted(set(event_times))
    bucket_ranges = [(unique_times[0], unique_times[-1] + timedelta(microseconds=1))]
    realized_rows: list[dict[str, object]] = []
    for bucket in build_runtime_ledger_buckets(
        ledger_rows,
        bucket_ranges=bucket_ranges,
        require_order_lifecycle=True,
    ):
        if bucket.closed_trade_count <= 0 and not bucket.blockers:
            continue
        row = _runtime_ledger_tca_row_from_bucket(
            bucket=bucket,
            computed_at=unique_times[-1],
        )
        row["post_cost_expectancy_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
        row["post_cost_promotion_eligible"] = False
        row["authoritative"] = False
        row["authority_reason"] = "execution_reconstruction_not_runtime_ledger_proof"
        row["pnl_derivation"] = "execution_reconstructed_from_execution_rows"
        row["promotion_blocker"] = "execution_reconstruction_not_runtime_ledger_proof"
        blockers = list(row.get("runtime_ledger_blockers") or [])
        if "execution_reconstruction_not_runtime_ledger_proof" not in blockers:
            blockers.append("execution_reconstruction_not_runtime_ledger_proof")
        row["runtime_ledger_blockers"] = blockers
        bucket_payload = row.get("runtime_ledger_bucket")
        if isinstance(bucket_payload, Mapping):
            bucket_payload = dict(bucket_payload)
            bucket_payload["blockers"] = blockers
            bucket_payload["pnl_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
            bucket_payload["authoritative"] = False
            bucket_payload["authority_reason"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            row["runtime_ledger_bucket"] = bucket_payload
        realized_rows.append(row)
    return realized_rows


def _load_report_post_cost_expectancy_bps(artifact_refs: list[str]) -> Decimal | None:
    for ref in artifact_refs:
        path = Path(ref)
        if (
            path.name not in {"simulation-report.json", "evaluation-report.json"}
            or not path.exists()
        ):
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        pnl_payload = _as_mapping(payload.get("pnl"))
        metrics_payload = _as_mapping(payload.get("metrics"))
        net_pnl = _decimal_or_none(
            pnl_payload.get("net_pnl_estimated") or metrics_payload.get("net_pnl")
        )
        execution_notional = _decimal_or_none(
            pnl_payload.get("execution_notional_total")
            or metrics_payload.get("turnover_notional")
        )
        if net_pnl is None or execution_notional is None or execution_notional <= 0:
            continue
        return (net_pnl / execution_notional) * Decimal("10000")
    return None


def _load_json_artifact(ref: str) -> dict[str, Any]:
    text = ref.strip()
    if not text:
        return {}
    path = Path(text)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _as_mapping(payload)


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


def _runtime_ledger_event_type(row: Mapping[str, Any]) -> str:
    raw = _text_or_none(
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
        "new_order": "order_submitted",
        "submitted": "order_submitted",
        "accepted": "order_submitted",
        "new": "order_submitted",
        "filled": "fill",
        "partially_filled": "partial_fill",
    }.get(normalized, normalized)


def _runtime_ledger_row_time(row: Mapping[str, Any]) -> datetime | None:
    for key in ("executed_at", "filled_at", "event_ts", "created_at", "computed_at"):
        if (parsed := _parse_dt_or_none(row.get(key))) is not None:
            return parsed
    return None


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


def _parse_artifact_window_datetime(
    value: Any,
    *,
    date_end: bool = False,
) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
            return parsed + timedelta(days=1) if date_end else parsed
        return _parse_dt(text)
    except Exception:
        return None


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


def _window_weekday_count(*, start: datetime, end: datetime) -> int:
    count = 0
    current = datetime.combine(start.date(), time.min, tzinfo=timezone.utc)
    while current < end:
        next_day = current + timedelta(days=1)
        if current.weekday() < 5 and next_day > start:
            count += 1
        current = next_day
    return count


def _runtime_ledger_artifact_candidate_ids(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> list[str]:
    candidates: list[str] = []
    for key in (
        "candidate_id",
        "candidateId",
        "strategy_candidate_id",
        "strategyCandidateId",
    ):
        if candidate_id := _text_or_none(payload.get(key)):
            candidates.append(candidate_id)
    for row in rows:
        for key in (
            "candidate_id",
            "candidateId",
            "strategy_candidate_id",
            "strategyCandidateId",
        ):
            if candidate_id := _text_or_none(row.get(key)):
                candidates.append(candidate_id)
    return sorted(dict.fromkeys(candidates))


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
    for ref in artifact_refs:
        payload = _load_json_artifact(ref)
        if not payload:
            continue
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
    return decision_times, execution_times, tca_rows, metadata


def _runtime_ledger_bucket_payload_from_row(
    row: StrategyRuntimeLedgerBucket,
) -> dict[str, object]:
    return {
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
        "runtime_ledger_blockers": payload.get("blockers") or [],
        "runtime_ledger_cost_basis_counts": payload.get("cost_basis_counts") or {},
        "runtime_ledger_pnl_basis": payload.get("pnl_basis"),
        "runtime_ledger_bucket": dict(payload),
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
    }
    if candidate_ids:
        metadata[f"runtime_ledger_{prefix}_bucket_candidate_ids"] = candidate_ids
    if len(candidate_ids) == 1:
        metadata[f"runtime_ledger_{prefix}_bucket_candidate_id"] = candidate_ids[0]
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


_SOURCE_RUNTIME_LEDGER_COLUMNS = (
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
)


def _source_runtime_ledger_payload_from_row(
    row: Sequence[object],
) -> dict[str, object]:
    payload = dict(zip(_SOURCE_RUNTIME_LEDGER_COLUMNS, row, strict=True))
    started_at = _parse_dt_or_none(payload.get("bucket_started_at"))
    ended_at = _parse_dt_or_none(payload.get("bucket_ended_at"))
    return {
        **payload,
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
    return tca_rows, _runtime_ledger_bucket_metadata(
        prefix="source",
        payloads=payloads,
        tca_rows=tca_rows,
    )


def _query_timestamps(
    *,
    dsn: str,
    strategy_names: list[str],
    account_label: str,
    window_start: datetime,
    window_end: datetime,
    symbols: Sequence[str] | None = None,
) -> tuple[list[datetime], list[datetime], list[dict[str, object]]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    execution_rows: list[dict[str, object]] = []
    symbol_filter = _metadata_symbol_list(symbols or ())
    decision_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)" if symbol_filter else ""
    )
    execution_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(e.symbol) = any(%s)"
        if symbol_filter
        else ""
    )
    decision_symbol_params: tuple[object, ...] = (
        (symbol_filter,) if symbol_filter else ()
    )
    execution_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                select d.created_at
                from trade_decisions d
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.status = any(%s)
                  and d.created_at >= %s
                  and d.created_at < %s
                  {decision_symbol_clause}
                order by d.created_at
                """,
                (
                    strategy_names,
                    account_label,
                    list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                    window_start,
                    window_end,
                    *decision_symbol_params,
                ),
            )
            decisions = [row[0] for row in cur.fetchall() if row[0] is not None]
            cur.execute(
                f"""
                select
                    d.created_at,
                    e.created_at,
                    e.symbol,
                    e.side,
                    e.filled_qty,
                    e.avg_fill_price,
                    t.shortfall_notional,
                    e.execution_audit_json,
                    e.raw_order,
                    e.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    e.alpaca_order_id,
                    e.client_order_id,
                    e.status
                from executions e
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                left join execution_tca_metrics t on t.execution_id = e.id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.created_at >= %s
                  and d.created_at < %s
                  {execution_symbol_clause}
                order by d.created_at
                """,
                (
                    strategy_names,
                    account_label,
                    window_start,
                    window_end,
                    *execution_symbol_params,
                ),
            )
            execution_rows = [
                {
                    "computed_at": row[0],
                    "execution_created_at": row[1],
                    "symbol": row[2],
                    "side": row[3],
                    "filled_qty": row[4],
                    "avg_fill_price": row[5],
                    "shortfall_notional": row[6],
                    "execution_audit_json": row[7],
                    "raw_order": row[8],
                    "account_label": row[9],
                    "strategy_id": row[10],
                    "decision_hash": row[11],
                    "alpaca_order_id": row[12],
                    "client_order_id": row[13],
                    "order_status": row[14],
                }
                for row in cur.fetchall()
                if row[0] is not None
            ]
            executions = []
            for row in execution_rows:
                computed_at = row.get("computed_at")
                if isinstance(computed_at, datetime):
                    executions.append(computed_at)
            cur.execute(
                f"""
                select
                    d.created_at,
                    abs(coalesce(t.realized_shortfall_bps, t.slippage_bps)) as abs_slippage_bps,
                    (-coalesce(t.realized_shortfall_bps, t.slippage_bps)) as post_cost_expectancy_bps
                from execution_tca_metrics t
                join executions e on e.id = t.execution_id
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.created_at >= %s
                  and d.created_at < %s
                  {execution_symbol_clause}
                order by d.created_at
                """,
                (
                    strategy_names,
                    account_label,
                    window_start,
                    window_end,
                    *execution_symbol_params,
                ),
            )
            tca_rows = [
                {
                    "computed_at": row[0],
                    "abs_slippage_bps": row[1] or Decimal("0"),
                    "post_cost_expectancy_bps": row[2] or Decimal("0"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_TCA_PROXY,
                    "post_cost_promotion_eligible": False,
                }
                for row in cur.fetchall()
                if row[0] is not None
            ]
    tca_rows.extend(_build_realized_strategy_pnl_rows(execution_rows))
    return decisions, executions, tca_rows


def _source_activity_missing_summary(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: list[str],
    account_label: str,
    window_start: datetime,
    window_end: datetime,
    source_manifest_ref: str,
    source_kind: str,
    dataset_snapshot_ref: str | None,
    source_activity_symbols: Sequence[str] | None = None,
    target_metadata: Mapping[str, Any] | None = None,
    proof_hygiene_blockers: Sequence[str] = (),
) -> dict[str, Any]:
    metadata = _as_mapping(target_metadata)
    symbol_filter = _metadata_symbol_list(source_activity_symbols or ())
    blocker = {
        "blocker": "runtime_window_source_activity_missing",
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_name": strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": account_label,
        "source_activity_symbol_filter": symbol_filter,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "remediation": (
            "Run live-paper replay or route/TCA repair until the source database contains "
            "execution-eligible trade_decisions, executions, or TCA rows for this target "
            "before importing promotion evidence."
        ),
    }
    proof_blockers = [blocker]
    for reason in proof_hygiene_blockers:
        proof_blockers.append(
            {
                "blocker": reason,
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id or None,
                "observed_stage": observed_stage,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "remediation": (
                    "Provide explicit runtime-window target metadata and health-gate "
                    "inputs before treating this import as proof-grade evidence."
                ),
            }
        )
    return {
        "status": "skipped",
        "proof_status": "blocked",
        "proof_blockers": proof_blockers,
        "run_id": run_id,
        "candidate_id": candidate_id or None,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "window_count": 0,
        "market_session_samples": 0,
        "decision_count": 0,
        "trade_count": 0,
        "order_count": 0,
        "avg_abs_slippage_bps": "0",
        "avg_post_cost_expectancy_bps": "0",
        "promotion_allowed": False,
        "promotion_blocking_reasons": ["runtime_window_source_activity_missing"],
        "runtime_observation": {
            "authoritative": False,
            "observed_stage": observed_stage,
            "evidence_provenance": (
                "paper_runtime_observed"
                if observed_stage == "paper"
                else "live_runtime_observed"
            ),
            "source_kind": source_kind
            or (
                "simulation_paper_runtime"
                if observed_stage == "paper"
                else "live_runtime"
            ),
            "source_manifest_ref": source_manifest_ref or None,
            "strategy_name": strategy_name,
            "strategy_name_candidates": strategy_names,
            "account_label": account_label,
            "source_activity_symbol_filter": symbol_filter,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "target_metadata": metadata,
            "skip_reason": "runtime_window_source_activity_missing",
        },
    }


def main() -> int:
    args = _parse_args()
    source_dsn = args.source_dsn.strip() or os.getenv(args.source_dsn_env, "").strip()
    artifact_refs = [
        str(item).strip()
        for item in getattr(args, "artifact_ref", [])
        if str(item).strip()
    ]
    window_start = _parse_dt(args.window_start)
    window_end = _parse_dt(args.window_end)
    _, manifest = resolve_hypothesis_manifest(
        hypothesis_id=args.hypothesis_id,
        strategy_family=args.strategy_family.strip() or None,
    )
    strategy_names = _strategy_name_candidates(
        args.strategy_name,
        getattr(manifest, "strategy_id", None),
    )
    target_metadata = _parse_target_metadata(
        str(getattr(args, "target_metadata_json", "") or "")
    )
    source_activity_symbols = _target_metadata_source_symbols(target_metadata)
    source_kind = args.source_kind.strip() or (
        "simulation_paper_runtime" if args.observed_stage == "paper" else "live_runtime"
    )
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    if source_dsn:
        decisions, executions, tca_rows = _query_timestamps(
            dsn=source_dsn,
            strategy_names=strategy_names,
            account_label=args.account_label,
            window_start=window_start,
            window_end=window_end,
            symbols=source_activity_symbols,
        )
    bucket_ranges: list[tuple[datetime, datetime, int]] = []
    runtime_ledger_artifact_metadata: dict[str, Any] = {
        "runtime_ledger_artifact_refs": [],
        "runtime_ledger_ignored_artifact_refs": [],
        "runtime_ledger_artifact_row_count": 0,
        "runtime_ledger_artifact_fill_count": 0,
        "runtime_ledger_artifact_tca_row_count": 0,
    }
    runtime_ledger_durable_metadata: dict[str, Any] = {
        "runtime_ledger_durable_bucket_count": 0,
        "runtime_ledger_durable_bucket_run_ids": [],
        "runtime_ledger_durable_bucket_fill_count": 0,
        "runtime_ledger_durable_bucket_tca_row_count": 0,
        "runtime_ledger_durable_bucket_profit_proof_count": 0,
    }
    runtime_ledger_source_metadata: dict[str, Any] = {
        "runtime_ledger_source_bucket_count": 0,
        "runtime_ledger_source_bucket_run_ids": [],
        "runtime_ledger_source_bucket_fill_count": 0,
        "runtime_ledger_source_bucket_tca_row_count": 0,
        "runtime_ledger_source_bucket_profit_proof_count": 0,
    }
    if source_dsn:
        source_runtime_ledger_tca_rows, runtime_ledger_source_metadata = (
            _runtime_ledger_tca_rows_from_source_dsn(
                dsn=source_dsn,
                candidate_id=args.candidate_id.strip() or None,
                hypothesis_id=args.hypothesis_id,
                observed_stage=args.observed_stage,
                strategy_names=strategy_names,
                account_label=args.account_label,
                window_start=window_start,
                window_end=window_end,
            )
        )
        tca_rows.extend(source_runtime_ledger_tca_rows)
    if artifact_refs:
        bucket_ranges = build_regular_session_buckets(
            window_start=window_start,
            window_end=window_end,
            bucket_minutes=args.bucket_minutes,
            sample_minutes=args.sample_minutes,
        )
        (
            runtime_ledger_decisions,
            runtime_ledger_executions,
            runtime_ledger_tca_rows,
            runtime_ledger_artifact_metadata,
        ) = _runtime_ledger_tca_rows_from_artifacts(
            artifact_refs=artifact_refs,
            bucket_ranges=bucket_ranges,
        )
        decisions.extend(runtime_ledger_decisions)
        executions.extend(runtime_ledger_executions)
        tca_rows.extend(runtime_ledger_tca_rows)
    if (
        not source_dsn
        and not runtime_ledger_artifact_metadata["runtime_ledger_artifact_refs"]
    ):
        with SessionLocal() as session:
            durable_runtime_ledger_tca_rows, runtime_ledger_durable_metadata = (
                _runtime_ledger_tca_rows_from_durable_buckets(
                    session=session,
                    candidate_id=args.candidate_id.strip() or None,
                    hypothesis_id=args.hypothesis_id,
                    observed_stage=args.observed_stage,
                    strategy_names=strategy_names,
                    account_label=args.account_label,
                    window_start=window_start,
                    window_end=window_end,
                )
            )
        tca_rows.extend(durable_runtime_ledger_tca_rows)
    if (
        not source_dsn
        and not runtime_ledger_artifact_metadata["runtime_ledger_artifact_refs"]
        and not runtime_ledger_durable_metadata["runtime_ledger_durable_bucket_count"]
    ):
        raise RuntimeError("source_dsn_not_configured")
    dataset_snapshot_ref = (
        str(getattr(args, "dataset_snapshot_ref", "") or "").strip() or None
    )
    runtime_ledger_target_metadata_blockers = list(
        dict.fromkeys(
            [
                *_runtime_ledger_target_metadata_blockers(
                    target_metadata=target_metadata,
                    runtime_ledger_artifact_metadata=runtime_ledger_artifact_metadata,
                    window_start=window_start,
                    window_end=window_end,
                ),
                *_runtime_window_import_proof_hygiene_blockers(
                    source_kind=source_kind,
                    target_metadata=target_metadata,
                    dependency_quorum_decision=args.dependency_quorum_decision,
                    continuity_ok=args.continuity_ok,
                    drift_ok=args.drift_ok,
                ),
            ]
        )
    )
    if not decisions and not executions and not tca_rows:
        summary = _source_activity_missing_summary(
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip(),
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_name=args.strategy_name,
            strategy_names=strategy_names,
            account_label=args.account_label,
            window_start=window_start,
            window_end=window_end,
            source_manifest_ref=args.source_manifest_ref.strip(),
            source_kind=args.source_kind.strip(),
            dataset_snapshot_ref=dataset_snapshot_ref,
            source_activity_symbols=source_activity_symbols,
            target_metadata=target_metadata,
            proof_hygiene_blockers=runtime_ledger_target_metadata_blockers,
        )
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(summary)
        return 0
    delay_depth_report_ref = str(
        getattr(args, "delay_adjusted_depth_stress_report_ref", "") or ""
    ).strip()
    delay_depth_report = _load_json_artifact(delay_depth_report_ref)
    if delay_depth_report_ref:
        artifact_refs.append(delay_depth_report_ref)
    report_post_cost_expectancy_bps = _load_report_post_cost_expectancy_bps(
        artifact_refs
    )
    if (
        report_post_cost_expectancy_bps is not None
        and args.source_kind.strip().startswith("simulation_")
    ):
        tca_rows.append(
            {
                "computed_at": executions[-1] if executions else window_end,
                "post_cost_expectancy_bps": report_post_cost_expectancy_bps,
                "post_cost_expectancy_basis": POST_COST_BASIS_SIMULATION_REPORT,
                "post_cost_promotion_eligible": False,
                "promotion_blocker": "simulation_report_not_runtime_ledger_proof",
            }
        )
    if not bucket_ranges:
        bucket_ranges = build_regular_session_buckets(
            window_start=window_start,
            window_end=window_end,
            bucket_minutes=args.bucket_minutes,
            sample_minutes=args.sample_minutes,
        )
    buckets = build_observed_runtime_buckets(
        bucket_ranges=bucket_ranges,
        decision_times=decisions,
        execution_times=executions,
        tca_rows=tca_rows,
        continuity_ok=_flag(args.continuity_ok),
        drift_ok=_flag(args.drift_ok),
        dependency_quorum_decision=args.dependency_quorum_decision.strip() or "missing",
    )
    evidence_provenance = (
        "paper_runtime_observed"
        if args.observed_stage == "paper"
        else "live_runtime_observed"
    )
    runtime_observation_payload = {
        **_runtime_observation_authority_payload(
            source_kind=source_kind,
            tca_rows=tca_rows,
        ),
        "observed_stage": args.observed_stage,
        "evidence_provenance": evidence_provenance,
        "source_kind": source_kind,
        "source_manifest_ref": args.source_manifest_ref.strip() or None,
        "strategy_name": args.strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": args.account_label,
        "source_activity_symbol_filter": source_activity_symbols,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "artifact_refs": artifact_refs,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "target_metadata": target_metadata,
        "runtime_ledger_target_metadata_blockers": runtime_ledger_target_metadata_blockers,
        **runtime_ledger_artifact_metadata,
        **runtime_ledger_durable_metadata,
        **runtime_ledger_source_metadata,
        "report_post_cost_expectancy_bps": (
            str(report_post_cost_expectancy_bps)
            if report_post_cost_expectancy_bps is not None
            else None
        ),
        "report_post_cost_expectancy_basis": (
            POST_COST_BASIS_SIMULATION_REPORT
            if report_post_cost_expectancy_bps is not None
            and source_kind.startswith("simulation_")
            else None
        ),
    }
    if delay_depth_report_ref:
        runtime_observation_payload.update(
            {
                "delay_adjusted_depth_stress_artifact_ref": delay_depth_report_ref,
                "delay_adjusted_depth_stress_report": delay_depth_report,
                "delay_adjusted_depth_stress_checks_total": max(
                    _nonnegative_int(delay_depth_report.get("stress_case_count")),
                    _nonnegative_int(delay_depth_report.get("case_count")),
                    _nonnegative_int(delay_depth_report.get("trading_day_count")),
                )
                if delay_depth_report
                else 0,
                "delay_adjusted_depth_stress_passed": delay_depth_report.get("passed")
                if delay_depth_report
                else False,
                "delay_adjusted_depth_stress_checked_at": (
                    delay_depth_report.get("generated_at")
                    or delay_depth_report.get("checked_at")
                )
                if delay_depth_report
                else None,
            }
        )
    with SessionLocal() as session:
        summary = persist_observed_runtime_windows(
            session=session,
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_family=args.strategy_family.strip() or manifest.strategy_family,
            source_manifest_ref=args.source_manifest_ref.strip() or None,
            buckets=buckets,
            slippage_budget_bps=manifest.max_allowed_slippage_bps,
            runtime_observation_payload=runtime_observation_payload,
        )
        session.commit()
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
