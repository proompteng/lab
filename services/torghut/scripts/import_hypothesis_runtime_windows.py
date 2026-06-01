#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_CEILING, Decimal
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence, cast

import psycopg
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.db import SessionLocal
from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
    RuntimeLedgerFill,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from app.trading.runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_promotion_source_authority_present,
)
from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from app.trading.runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
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
EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS = "exact_replay_artifact_only_not_live"
EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS = (
    "exact_replay_artifact_not_runtime_proof",
    "runtime_ledger_source_window_missing",
    "runtime_ledger_source_refs_missing",
)
RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER = "runtime_ledger_source_window_missing"
RUNTIME_LEDGER_CARRY_IN_LOOKBACK = timedelta(days=5)
RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER = "runtime_ledger_source_refs_missing"
_RUNTIME_LEDGER_DECISION_EVENTS = frozenset(
    {"decision", "trade_decision", "signal_decision"}
)
_RUNTIME_LEDGER_FILL_EVENTS = frozenset(
    {"fill", "filled", "partial_fill", "partially_filled"}
)
_RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS = _RUNTIME_LEDGER_FILL_EVENTS | frozenset(
    {"order_submitted"}
)
ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER = "order_feed_fill_lifecycle_missing"
ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER = "order_feed_fill_lifecycle_incomplete"
ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER = (
    "order_feed_fill_lifecycle_order_id_missing"
)
ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER = (
    "order_feed_unlinked_fill_lifecycle_present"
)
ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER = "order_feed_fill_delta_basis_missing"
ORDER_FEED_FILL_DELTA_MISSING_BLOCKER = "order_feed_fill_delta_missing"
_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS = (
    "execution_id",
    "trade_decision_id",
    "decision_id",
    "decision_hash",
    "order_id",
    "alpaca_order_id",
    "client_order_id",
    "execution_correlation_id",
)
ALPACA_2026_EQUITY_SEC_FEE_RATE = Decimal("20.60") / Decimal("1000000")
ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE = Decimal("0.000195")
ALPACA_2026_EQUITY_TAF_CAP = Decimal("9.79")
ALPACA_2026_FEE_SCHEDULE_REVISED_ON = "2026-04-01"
_CENT = Decimal("0.01")
_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS = (
    "account_equity",
    "portfolio_equity",
    "start_equity",
    "starting_equity",
    "equity",
    "portfolio_value",
    "net_liquidation",
    "net_liquidation_value",
)
SOURCE_LINEAGE_CANDIDATE_KEYS = (
    "candidate_id",
    "candidate_ids",
    "strategy_candidate_id",
    "strategy_candidate_ids",
    "source_candidate_id",
    "source_candidate_ids",
)
SOURCE_LINEAGE_HYPOTHESIS_KEYS = (
    "hypothesis_id",
    "hypothesis_ids",
    "strategy_hypothesis_id",
    "strategy_hypothesis_ids",
    "source_hypothesis_id",
    "source_hypothesis_ids",
)
SOURCE_DECISION_MODE_MISSING_PARTITION = "source_decision_mode_missing"


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
    parser.add_argument("--target-dsn", default="")
    parser.add_argument(
        "--target-dsn-env",
        default="",
        help=(
            "Optional environment variable for the database where imported runtime "
            "governance rows are persisted. Defaults to DB_DSN via SessionLocal."
        ),
    )
    parser.add_argument("--strategy-name", required=True)
    parser.add_argument("--account-label", required=True)
    parser.add_argument("--source-account-label", default="")
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
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help=(
            "Run source, execution, TCA, and runtime-ledger proof diagnostics "
            "without writing imported governance rows."
        ),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _target_persistence_dsn(args: argparse.Namespace) -> str:
    direct_dsn = str(getattr(args, "target_dsn", "") or "").strip()
    if direct_dsn:
        return direct_dsn
    target_dsn_env = str(getattr(args, "target_dsn_env", "") or "").strip()
    if not target_dsn_env:
        return ""
    dsn = os.getenv(target_dsn_env, "").strip()
    if not dsn:
        raise RuntimeError(f"target_dsn_not_configured:{target_dsn_env}")
    return dsn


@contextmanager
def _persistence_session(args: argparse.Namespace) -> Iterator[Session]:
    target_dsn = _target_persistence_dsn(args)
    if not target_dsn:
        with SessionLocal() as session:
            yield session
        return
    engine = create_engine(
        _sqlalchemy_dsn(target_dsn),
        pool_pre_ping=True,
        future=True,
    )
    TargetSessionLocal = sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with TargetSessionLocal() as session:
            yield session
    finally:
        engine.dispose()


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


def _first_positive_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None and parsed > 0:
                return parsed
    return None


def _first_text(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            text = str(payload.get(key) or "").strip()
            if text:
                return text
    return None


def _direct_text(row: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        text = str(row.get(key) or "").strip()
        if text:
            return text
    return None


def _bool_value(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "pass", "passed", "ok"}:
        return True
    if text in {"0", "false", "no", "off", "fail", "failed", "blocked"}:
        return False
    return None


def _direct_bool(row: Mapping[str, object], *keys: str) -> bool | None:
    for key in keys:
        value = row.get(key)
        if (parsed := _bool_value(value)) is not None:
            return parsed
    return None


def _text_values(row: Mapping[str, object], *keys: str) -> set[str]:
    values: set[str] = set()
    for payload in _row_payloads(row):
        for key in keys:
            raw_value = payload.get(key)
            if isinstance(raw_value, Sequence) and not isinstance(
                raw_value, (str, bytes, bytearray)
            ):
                for item in raw_value:
                    text = str(item or "").strip()
                    if text:
                        values.add(text)
            else:
                text = str(raw_value or "").strip()
                if text:
                    values.add(text)
    return values


def _first_bool(row: Mapping[str, object], *keys: str) -> bool | None:
    for payload in _row_payloads(row):
        for key in keys:
            if (parsed := _bool_value(payload.get(key))) is not None:
                return parsed
    return None


def _source_decision_priority_payloads(
    row: Mapping[str, object],
) -> list[Mapping[str, object]]:
    payloads: list[Mapping[str, object]] = [row]
    decision_json = _as_mapping(row.get("decision_json"))
    if decision_json:
        payloads.append(decision_json)
        for key in (
            "strategy_signal_paper",
            "paper_route_target_plan",
            "paper_route_target",
        ):
            if nested := _as_mapping(decision_json.get(key)):
                payloads.append(nested)
        params = _as_mapping(decision_json.get("params"))
        if params:
            payloads.append(params)
            for key in (
                "strategy_signal_paper",
                "paper_route_target_plan",
                "paper_route_target",
            ):
                if nested := _as_mapping(params.get(key)):
                    payloads.append(nested)
    return payloads


def _source_decision_mode(row: Mapping[str, object]) -> str | None:
    for payload in _source_decision_priority_payloads(row):
        explicit = normalize_source_decision_mode(
            _direct_text(payload, "source_decision_mode")
        )
        if explicit is not None:
            return explicit
    explicit = normalize_source_decision_mode(_first_text(row, "source_decision_mode"))
    if explicit is not None:
        return explicit
    return normalize_source_decision_mode(row.get("mode"))


def _source_decision_profit_proof_flag(row: Mapping[str, object]) -> bool | None:
    for payload in _source_decision_priority_payloads(row):
        value = _direct_bool(
            payload,
            "profit_proof_eligible",
            "post_cost_promotion_eligible",
        )
        if value is not None:
            return value
    return _first_bool(row, "profit_proof_eligible", "post_cost_promotion_eligible")


def _source_decision_mode_counts(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        mode = _source_decision_mode(row)
        if mode is None:
            continue
        counts[mode] = counts.get(mode, 0) + 1
    return dict(sorted(counts.items()))


def _source_decision_identifier_values(row: Mapping[str, object]) -> set[str]:
    return _text_values(
        row,
        "trade_decision_id",
        "decision_id",
        "decision_hash",
    )


def _source_decision_mode_lookup(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    modes_by_identifier: dict[str, str] = {}
    conflicting_identifiers: set[str] = set()
    for row in rows:
        mode = _source_decision_mode(row)
        if mode is None:
            continue
        for identifier in _source_decision_identifier_values(row):
            existing = modes_by_identifier.get(identifier)
            if existing is not None and existing != mode:
                conflicting_identifiers.add(identifier)
                continue
            modes_by_identifier[identifier] = mode
    for identifier in conflicting_identifiers:
        modes_by_identifier.pop(identifier, None)
    return modes_by_identifier


def _source_decision_mode_partition_key(
    row: Mapping[str, object],
    *,
    modes_by_identifier: Mapping[str, str],
) -> str:
    explicit = _source_decision_mode(row)
    if explicit is not None:
        return explicit
    inferred_modes = {
        modes_by_identifier[identifier]
        for identifier in _source_decision_identifier_values(row)
        if identifier in modes_by_identifier
    }
    if len(inferred_modes) == 1:
        return next(iter(inferred_modes))
    return SOURCE_DECISION_MODE_MISSING_PARTITION


def _partition_runtime_source_rows_by_decision_mode(
    *,
    execution_rows: list[dict[str, object]],
    decision_lifecycle_rows: list[dict[str, object]] | None,
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> (
    list[
        tuple[
            str,
            list[dict[str, object]],
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
        ]
    ]
    | None
):
    source_rows: list[dict[str, object]] = [
        *execution_rows,
        *(decision_lifecycle_rows or []),
        *(order_lifecycle_rows or []),
        *(unlinked_order_lifecycle_rows or []),
        *(carry_in_execution_rows or []),
        *(carry_in_decision_lifecycle_rows or []),
        *(carry_in_order_lifecycle_rows or []),
    ]
    if not source_rows:
        return None
    modes_by_identifier = _source_decision_mode_lookup(source_rows)
    mode_keys = {
        _source_decision_mode_partition_key(
            row,
            modes_by_identifier=modes_by_identifier,
        )
        for row in source_rows
    }
    if len(mode_keys) <= 1:
        return None

    partitions: list[
        tuple[
            str,
            list[dict[str, object]],
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
        ]
    ] = []
    for mode_key in sorted(mode_keys):
        partition_execution_rows = [
            row
            for row in execution_rows
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_decision_rows = [
            row
            for row in decision_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_order_rows = [
            row
            for row in order_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_unlinked_order_rows = []
        for row in unlinked_order_lifecycle_rows or []:
            partition_key = _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            if partition_key == mode_key or (
                partition_key == SOURCE_DECISION_MODE_MISSING_PARTITION
                and mode_key != SOURCE_DECISION_MODE_MISSING_PARTITION
            ):
                partition_unlinked_order_rows.append(row)
        partition_carry_in_execution_rows = [
            row
            for row in carry_in_execution_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_carry_in_decision_rows = [
            row
            for row in carry_in_decision_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_carry_in_order_rows = [
            row
            for row in carry_in_order_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partitions.append(
            (
                mode_key,
                partition_execution_rows,
                partition_decision_rows or None,
                partition_order_rows or None,
                partition_unlinked_order_rows or None,
                partition_carry_in_execution_rows or None,
                partition_carry_in_decision_rows or None,
                partition_carry_in_order_rows or None,
            )
        )
    return partitions


def _source_decision_rows_profit_proof_eligible(
    rows: Sequence[Mapping[str, object]],
) -> bool:
    modes = _source_decision_mode_counts(rows)
    if source_decision_mode_counts_have_non_profit_proof_modes(modes):
        return False
    explicit: list[bool] = []
    for row in rows:
        value = _source_decision_profit_proof_flag(row)
        if value is not None:
            explicit.append(value)
    if any(value is False for value in explicit):
        return False
    return source_decision_mode_counts_have_profit_proof_modes(modes) or any(
        value is True for value in explicit
    )


def _source_row_matches_lineage(
    row: Mapping[str, object],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
    require_source_lineage: bool,
) -> bool:
    if not require_source_lineage:
        return True
    if candidate_id is not None and candidate_id not in _text_values(
        row, *SOURCE_LINEAGE_CANDIDATE_KEYS
    ):
        return False
    if hypothesis_id is not None and hypothesis_id not in _text_values(
        row, *SOURCE_LINEAGE_HYPOTHESIS_KEYS
    ):
        return False
    return True


def _runtime_ledger_equity_denominator_from_rows(
    rows: Sequence[Mapping[str, object]],
) -> tuple[Decimal, str] | None:
    denominators: list[tuple[Decimal, str]] = []
    for row in rows:
        for key in _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS:
            value = _first_decimal(row, key)
            if value is not None and value > 0:
                denominators.append((value, key))
                break
    if not denominators:
        return None
    return min(denominators, key=lambda item: item[0])


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


def _runtime_source_lineage_hash(
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> str | None:
    payload = {
        key: value
        for key, value in {
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "source": "runtime_window_lineage_filter",
        }.items()
        if value
    }
    return _stable_payload_digest(payload)


def _attach_source_lineage_context(
    rows: Sequence[Mapping[str, object]],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> list[dict[str, object]]:
    lineage_hash = _runtime_source_lineage_hash(
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
    )
    contextualized: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        if candidate_id:
            payload.setdefault("source_candidate_id", candidate_id)
        if hypothesis_id:
            payload.setdefault("source_hypothesis_id", hypothesis_id)
        if lineage_hash:
            payload["lineage_hash"] = lineage_hash
        contextualized.append(payload)
    return contextualized


def _decimal_ceil_cent(value: Decimal) -> Decimal:
    if value <= 0:
        return Decimal("0")
    return value.quantize(_CENT, rounding=ROUND_CEILING)


def _row_has_alpaca_us_equity_order_source(row: Mapping[str, object]) -> bool:
    alpaca_markers = {
        str(item or "").strip().lower()
        for item in (
            *_text_values(row, "feed", "source_topic", "channel", "submit_path"),
            *_text_values(row, "source"),
        )
    }
    if not any(
        "alpaca" in marker or marker == "trade_updates" for marker in alpaca_markers
    ):
        return False
    asset_classes = {
        value.strip().lower().replace("-", "_")
        for value in _text_values(row, "asset_class")
    }
    return not asset_classes or any(
        item in {"us_equity", "us_equities", "equity", "equities"}
        for item in asset_classes
    )


def _alpaca_2026_equity_fee_schedule_cost(
    row: Mapping[str, object],
    *,
    side: Any,
    filled_qty: Decimal | None,
    filled_notional: Decimal,
) -> tuple[Decimal, str] | None:
    if (
        filled_qty is None
        or filled_qty <= 0
        or filled_notional <= 0
        or not _row_has_alpaca_us_equity_order_source(row)
    ):
        return None
    normalized_side = str(side or "").strip().lower().replace("-", "_")
    if normalized_side in {"buy", "buy_to_cover", "cover"}:
        return Decimal("0"), "alpaca_2026_equity_zero_commission_and_cat_fee_schedule"
    if normalized_side not in {"sell", "sell_short", "short"}:
        return None
    sec_fee = _decimal_ceil_cent(filled_notional * ALPACA_2026_EQUITY_SEC_FEE_RATE)
    taf_fee = min(
        _decimal_ceil_cent(filled_qty * ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE),
        ALPACA_2026_EQUITY_TAF_CAP,
    )
    return (
        sec_fee + taf_fee,
        "alpaca_2026_equity_sec_taf_cat_fee_schedule",
    )


def _alpaca_2026_equity_fee_schedule_hash() -> str:
    digest = _stable_payload_digest(
        {
            "broker": "alpaca",
            "asset_class": "us_equity",
            "schedule": "alpaca_brokerage_fee_schedule",
            "revised_on": ALPACA_2026_FEE_SCHEDULE_REVISED_ON,
            "sec_fee_rate_per_notional": str(ALPACA_2026_EQUITY_SEC_FEE_RATE),
            "taf_rate_per_share": str(ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE),
            "taf_cap": str(ALPACA_2026_EQUITY_TAF_CAP),
            "cat_fee_equities": "0",
            "commission": "0",
        }
    )
    assert digest is not None
    return digest


def _cost_basis_is_alpaca_fee_schedule(value: object) -> bool:
    return str(value or "").strip().startswith("alpaca_2026_equity_")


def _first_payload_digest(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            if digest := _stable_payload_digest(payload.get(key)):
                return digest
    return None


_LINEAGE_CONTEXT_KEYS = (
    "strategy_id",
    "primary_declared_strategy_id",
    "source_declared_strategy_ids",
    "paper_route_target_plan_source",
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
        "diagnostic_closed_trade_expectancy_bps": (
            str(bucket.diagnostic_closed_trade_expectancy_bps)
            if bucket.diagnostic_closed_trade_expectancy_bps is not None
            else None
        ),
        "diagnostic_closed_trade_expectancy_basis": (
            "realized_closed_trips_after_explicit_costs_not_promotion_grade"
            if bucket.diagnostic_closed_trade_expectancy_bps is not None
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


def _runtime_ledger_bucket_profit_proof_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []

    def add(blocker: str) -> None:
        if blocker not in blockers:
            blockers.append(blocker)

    filled_notional = _decimal_or_none(bucket.get("filled_notional"))
    cost_amount = _decimal_or_none(bucket.get("cost_amount"))
    post_cost_expectancy = _decimal_or_none(bucket.get("post_cost_expectancy_bps"))
    diagnostic_closed_trade_expectancy = _decimal_or_none(
        bucket.get("diagnostic_closed_trade_expectancy_bps")
    )
    if bucket.get("pnl_basis") != POST_COST_BASIS_RUNTIME_LEDGER:
        add("runtime_ledger_pnl_basis_not_runtime_ledger")
    if bucket.get("ledger_schema_version") not in RUNTIME_LEDGER_BUCKET_SCHEMAS:
        add("runtime_ledger_schema_not_supported")
    for blocker in runtime_ledger_promotion_source_authority_blockers(bucket):
        add(blocker)
    for blocker in _metadata_text_list(bucket.get("blockers")):
        add(blocker)
    if _nonnegative_int(bucket.get("fill_count")) <= 0:
        add("runtime_fills_missing")
    if _nonnegative_int(bucket.get("decision_count")) <= 0:
        add("runtime_decision_lifecycle_missing")
    if _nonnegative_int(bucket.get("submitted_order_count")) <= 0:
        add("submitted_order_lifecycle_missing")
    if _nonnegative_int(bucket.get("closed_trade_count")) <= 0:
        add("closed_round_trip_missing")
    if bucket.get("open_position_count") is None:
        add("runtime_ledger_open_position_count_missing")
    if _nonnegative_int(bucket.get("open_position_count")) > 0:
        add("unclosed_position")
    if filled_notional is None or filled_notional <= 0:
        add("filled_notional_missing")
    if cost_amount is None or cost_amount < 0:
        add(
            "runtime_ledger_cost_amount_missing"
            if cost_amount is None
            else "runtime_ledger_cost_amount_negative"
        )
    if is_non_promotion_grade_runtime_cost_basis(bucket.get("cost_basis")):
        add("runtime_ledger_cost_basis_non_promotion_grade")
    if cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("cost_basis_counts")
    ):
        add("runtime_ledger_cost_basis_non_promotion_grade")
    source_decision_mode = normalize_source_decision_mode(
        bucket.get("source_decision_mode")
    )
    profit_proof_eligible = _first_bool(bucket, "profit_proof_eligible")
    source_decision_mode_counts = bucket.get("source_decision_mode_counts")
    if (
        source_decision_mode is None
        and not source_decision_mode_counts_have_profit_proof_modes(
            source_decision_mode_counts
        )
        and not source_decision_mode_counts_have_non_profit_proof_modes(
            source_decision_mode_counts
        )
        and profit_proof_eligible is not True
    ):
        add(SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER)
    if source_decision_mode and not source_decision_mode_is_profit_proof_eligible(
        source_decision_mode
    ):
        add(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if source_decision_mode_counts_have_non_profit_proof_modes(
        source_decision_mode_counts
    ):
        add(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if profit_proof_eligible is False:
        add(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if post_cost_expectancy is None:
        add(
            "runtime_ledger_post_cost_expectancy_not_promotion_grade"
            if diagnostic_closed_trade_expectancy is not None
            else "runtime_ledger_post_cost_expectancy_missing"
        )
    if _mapping_hash_count(bucket.get("execution_policy_hash_counts")) <= 0:
        add("runtime_ledger_execution_policy_hash_missing")
    if _mapping_hash_count(bucket.get("cost_model_hash_counts")) <= 0:
        add("runtime_ledger_cost_model_hash_missing")
    if _mapping_hash_count(bucket.get("lineage_hash_counts")) <= 0:
        add("runtime_ledger_lineage_hash_missing")
    return blockers


def _runtime_ledger_bucket_profit_proof_present(
    bucket: Mapping[str, object],
) -> bool:
    return not _runtime_ledger_bucket_profit_proof_blockers(bucket)


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
        "diagnostic_closed_trade_expectancy_bps": (
            bucket.diagnostic_closed_trade_expectancy_bps
        ),
        "diagnostic_closed_trade_expectancy_basis": (
            "realized_closed_trips_after_explicit_costs_not_promotion_grade"
            if bucket.diagnostic_closed_trade_expectancy_bps is not None
            else None
        ),
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


def _with_runtime_ledger_source_authority_context(
    bucket: Mapping[str, object],
    *,
    source_window_start: datetime,
    source_window_end: datetime,
    source_refs: Sequence[str],
    source_row_counts: Mapping[str, int],
    trade_decision_ids: Sequence[object] = (),
    execution_ids: Sequence[object] = (),
    execution_order_event_ids: Sequence[object] = (),
    source_window_ids: Sequence[object] = (),
    source_offsets: Sequence[Mapping[str, object]] = (),
    source_window_status_counts: Mapping[str, int] | None = None,
    source_window_classification_counts: Mapping[str, int] | None = None,
    source_window_gap_count: int = 0,
    source_window_gap_ranges: Sequence[Mapping[str, object]] = (),
    order_feed_lifecycle_complete: bool | None = None,
    execution_economics_complete: bool | None = None,
    source_materialization: str | None = None,
    authority_class: str | None = None,
) -> dict[str, object]:
    payload = dict(bucket)
    payload.setdefault("source_window_start", source_window_start.isoformat())
    payload.setdefault("source_window_end", source_window_end.isoformat())
    if source_refs:
        existing_refs = _metadata_text_list(payload.get("source_refs"))
        payload["source_refs"] = list(dict.fromkeys([*existing_refs, *source_refs]))
    for key, values in (
        ("trade_decision_ids", trade_decision_ids),
        ("execution_ids", execution_ids),
        ("execution_order_event_ids", execution_order_event_ids),
        ("source_window_ids", source_window_ids),
    ):
        merged_values = _metadata_text_list(payload.get(key))
        merged_values.extend(
            _text for value in values if (_text := _text_or_none(value))
        )
        if merged_values:
            payload[key] = list(dict.fromkeys(merged_values))
    if source_offsets:
        existing_offsets = [
            dict(item)
            for item in cast(Sequence[object], payload.get("source_offsets") or [])
            if isinstance(item, Mapping)
        ]
        seen_offsets = {
            (
                str(item.get("topic") or ""),
                str(item.get("partition") or ""),
                str(item.get("offset") or ""),
            )
            for item in existing_offsets
        }
        for item in source_offsets:
            offset = {
                "topic": item.get("topic"),
                "partition": item.get("partition"),
                "offset": item.get("offset"),
            }
            topic = offset.get("topic")
            partition = offset.get("partition")
            source_offset = offset.get("offset")
            key = (
                str(topic or ""),
                "" if partition is None else str(partition),
                "" if source_offset is None else str(source_offset),
            )
            if all(key) and key not in seen_offsets:
                existing_offsets.append(offset)
                seen_offsets.add(key)
        if existing_offsets:
            payload["source_offsets"] = existing_offsets
    if source_window_status_counts:
        payload["source_window_status_counts"] = _merge_count_mappings(
            _as_mapping(payload.get("source_window_status_counts")),
            source_window_status_counts,
        )
    if source_window_classification_counts:
        payload["source_window_classification_counts"] = _merge_count_mappings(
            _as_mapping(payload.get("source_window_classification_counts")),
            source_window_classification_counts,
        )
    if source_window_gap_count > 0:
        payload["source_window_gap_count"] = max(
            _nonnegative_int(payload.get("source_window_gap_count")),
            source_window_gap_count,
        )
    if source_window_gap_ranges:
        existing_gap_ranges = [
            dict(item)
            for item in cast(
                Sequence[object], payload.get("source_window_gap_ranges") or []
            )
            if isinstance(item, Mapping)
        ]
        existing_gap_ranges.extend(dict(item) for item in source_window_gap_ranges)
        if existing_gap_ranges:
            payload["source_window_gap_ranges"] = existing_gap_ranges
    if order_feed_lifecycle_complete is not None:
        payload["order_feed_lifecycle_complete"] = order_feed_lifecycle_complete
    if execution_economics_complete is not None:
        payload["execution_economics_complete"] = execution_economics_complete
    if source_materialization:
        payload.setdefault("source_materialization", source_materialization)
    if authority_class:
        payload.setdefault("authority_class", authority_class)
    existing_counts = _as_mapping(payload.get("source_row_counts"))
    merged_counts: dict[str, int] = {
        str(key): _nonnegative_int(value) for key, value in existing_counts.items()
    }
    for key, value in source_row_counts.items():
        table_name = str(key)
        merged_counts[table_name] = max(
            merged_counts.get(table_name, 0),
            max(0, int(value)),
        )
    if merged_counts:
        payload["source_row_counts"] = dict(sorted(merged_counts.items()))
    return payload


def _merge_count_mappings(
    existing: Mapping[object, object],
    incoming: Mapping[str, int],
) -> dict[str, int]:
    merged = {
        str(key): _nonnegative_int(value) for key, value in existing.items()
    }
    for key, value in incoming.items():
        merged[str(key)] = max(0, int(value)) + merged.get(str(key), 0)
    return dict(sorted((key, value) for key, value in merged.items() if value > 0))


def _source_identifier_values(
    rows: Sequence[Mapping[str, object]] | None,
    *keys: str,
) -> list[str]:
    values: list[str] = []
    for row in rows or ():
        for key in keys:
            value = _text_or_none(row.get(key))
            if value is not None:
                values.append(value)
                break
    return list(dict.fromkeys(values))


def _source_offset_values(
    rows: Sequence[Mapping[str, object]] | None,
) -> list[dict[str, object]]:
    offsets: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in rows or ():
        topic = _text_or_none(row.get("source_topic"))
        partition = row.get("source_partition")
        offset = row.get("source_offset")
        if topic is None or partition is None or offset is None:
            continue
        key = (topic, str(partition), str(offset))
        if key in seen:
            continue
        offsets.append({"topic": topic, "partition": partition, "offset": offset})
        seen.add(key)
    return offsets


def _unique_source_window_rows(
    rows: Sequence[Mapping[str, object]] | None,
) -> list[Mapping[str, object]]:
    unique_rows: list[Mapping[str, object]] = []
    seen: set[str] = set()
    for row in rows or ():
        source_window_id = _text_or_none(row.get("source_window_id"))
        if source_window_id is None:
            continue
        if source_window_id in seen:
            continue
        seen.add(source_window_id)
        unique_rows.append(row)
    return unique_rows


def _source_window_status_counts(
    rows: Sequence[Mapping[str, object]] | None,
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in _unique_source_window_rows(rows):
        status = _text_or_none(row.get("source_window_status"))
        if status is None:
            continue
        counts[status] = counts.get(status, 0) + 1
    return dict(sorted(counts.items()))


def _source_window_classification_counts(
    rows: Sequence[Mapping[str, object]] | None,
) -> dict[str, int]:
    field_names = {
        "inserted": "source_window_inserted_count",
        "duplicate": "source_window_duplicate_count",
        "malformed_json": "source_window_malformed_count",
        "missing_trade_update_payload": "source_window_missing_payload_count",
        "missing_order_identity": "source_window_missing_identity_count",
        "out_of_scope_account": "source_window_out_of_scope_account_count",
        "unlinked_execution": "source_window_unlinked_execution_count",
        "unlinked_decision": "source_window_unlinked_decision_count",
        "failed_unhandled": "source_window_failed_unhandled_count",
        "dropped": "source_window_dropped_count",
    }
    counts: dict[str, int] = {}
    for row in _unique_source_window_rows(rows):
        for classification, field_name in field_names.items():
            count = _nonnegative_int(row.get(field_name))
            if count > 0:
                counts[classification] = counts.get(classification, 0) + count
    return dict(sorted(counts.items()))


def _source_window_gap_count(
    rows: Sequence[Mapping[str, object]] | None,
) -> int:
    return sum(
        _nonnegative_int(row.get("source_window_gap_count"))
        for row in _unique_source_window_rows(rows)
    )


def _source_window_gap_ranges(
    rows: Sequence[Mapping[str, object]] | None,
) -> list[dict[str, object]]:
    ranges: list[dict[str, object]] = []
    for row in _unique_source_window_rows(rows):
        gap_ranges = row.get("source_window_gap_ranges")
        if not isinstance(gap_ranges, Sequence) or isinstance(
            gap_ranges, (str, bytes, bytearray)
        ):
            continue
        for item in cast(Sequence[object], gap_ranges):
            if isinstance(item, Mapping):
                ranges.append(dict(item))
    return ranges


def _decision_lifecycle_query_row(row: Sequence[object]) -> dict[str, object]:
    if len(row) >= 7:
        return {
            "trade_decision_id": str(row[0]),
            "computed_at": row[1],
            "event_type": "decision",
            "symbol": row[2],
            "account_label": row[3],
            "strategy_id": row[4],
            "decision_hash": row[5],
            "decision_json": row[6],
        }
    return {
        "trade_decision_id": str(row[4]),
        "computed_at": row[0],
        "event_type": "decision",
        "symbol": row[1],
        "account_label": row[2],
        "strategy_id": row[3],
        "decision_hash": row[4],
        "decision_json": row[5],
    }


def _decision_lifecycle_query_row_has_time(row: Sequence[object]) -> bool:
    return (row[1] if len(row) >= 7 else row[0]) is not None


def _execution_query_row(row: Sequence[object]) -> dict[str, object]:
    if len(row) >= 19:
        return {
            "execution_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "decision_created_at": row[2],
            "computed_at": row[3],
            "execution_event_at": row[3],
            "execution_created_at": row[4],
            "symbol": row[5],
            "side": row[6],
            "filled_qty": row[7],
            "avg_fill_price": row[8],
            "shortfall_notional": row[9],
            "execution_audit_json": row[10],
            "raw_order": row[11],
            "account_label": row[12],
            "strategy_id": row[13],
            "decision_hash": row[14],
            "decision_json": row[15],
            "alpaca_order_id": row[16],
            "client_order_id": row[17],
            "order_status": row[18],
        }
    return {
        "execution_id": None,
        "trade_decision_id": str(row[12]),
        "decision_created_at": row[0],
        "computed_at": row[1],
        "execution_event_at": row[1],
        "execution_created_at": row[2],
        "symbol": row[3],
        "side": row[4],
        "filled_qty": row[5],
        "avg_fill_price": row[6],
        "shortfall_notional": row[7],
        "execution_audit_json": row[8],
        "raw_order": row[9],
        "account_label": row[10],
        "strategy_id": row[11],
        "decision_hash": row[12],
        "decision_json": row[13],
        "alpaca_order_id": row[14],
        "client_order_id": row[15],
        "order_status": row[16],
    }


def _execution_query_row_has_time(row: Sequence[object]) -> bool:
    return (row[3] if len(row) >= 19 else row[1]) is not None


def _source_window_query_context(
    row: Sequence[object],
    *,
    start_index: int,
) -> dict[str, object]:
    if len(row) < start_index + 15:
        return {}
    return {
        "source_window_status": row[start_index],
        "source_window_status_reason": row[start_index + 1],
        "source_window_consumed_count": row[start_index + 2],
        "source_window_inserted_count": row[start_index + 3],
        "source_window_duplicate_count": row[start_index + 4],
        "source_window_malformed_count": row[start_index + 5],
        "source_window_missing_payload_count": row[start_index + 6],
        "source_window_missing_identity_count": row[start_index + 7],
        "source_window_out_of_scope_account_count": row[start_index + 8],
        "source_window_unlinked_execution_count": row[start_index + 9],
        "source_window_unlinked_decision_count": row[start_index + 10],
        "source_window_failed_unhandled_count": row[start_index + 11],
        "source_window_dropped_count": row[start_index + 12],
        "source_window_gap_count": row[start_index + 13],
        "source_window_gap_ranges": row[start_index + 14],
    }


def _order_lifecycle_query_row(row: Sequence[object]) -> dict[str, object]:
    if len(row) >= 28:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "side": row[13],
            "qty": row[14],
            "filled_qty": row[15],
            "filled_qty_delta": row[16],
            "avg_fill_price": row[17],
            "filled_notional_delta": row[18],
            "fill_quantity_basis": row[19],
            "event_fingerprint": row[20],
            "source_topic": row[21],
            "source_partition": row[22],
            "source_offset": row[23],
            "source_window_id": str(row[24]) if row[24] is not None else None,
            "raw_event": row[25],
            "execution_audit_json": row[26],
            "raw_order": row[27],
            **_source_window_query_context(row, start_index=28),
        }
    if len(row) >= 25:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "side": row[13],
            "qty": row[14],
            "filled_qty": row[15],
            "avg_fill_price": row[16],
            "event_fingerprint": row[17],
            "source_topic": row[18],
            "source_partition": row[19],
            "source_offset": row[20],
            "source_window_id": str(row[21]) if row[21] is not None else None,
            "raw_event": row[22],
            "execution_audit_json": row[23],
            "raw_order": row[24],
        }
    if len(row) >= 21:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "event_fingerprint": row[13],
            "source_topic": row[14],
            "source_partition": row[15],
            "source_offset": row[16],
            "source_window_id": str(row[17]) if row[17] is not None else None,
            "raw_event": row[18],
            "execution_audit_json": row[19],
            "raw_order": row[20],
        }
    if len(row) >= 20:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "event_fingerprint": row[13],
            "source_topic": row[14],
            "source_partition": row[15],
            "source_offset": row[16],
            "source_window_id": None,
            "raw_event": row[17],
            "execution_audit_json": row[18],
            "raw_order": row[19],
        }
    return {
        "execution_order_event_id": str(row[10]),
        "trade_decision_id": str(row[4]),
        "execution_id": None,
        "event_ts": row[0],
        "symbol": row[1],
        "account_label": row[2],
        "strategy_id": row[3],
        "decision_hash": row[4],
        "decision_json": row[5],
        "alpaca_order_id": row[6],
        "client_order_id": row[7],
        "event_type": row[8],
        "order_status": row[9],
        "event_fingerprint": row[10],
        "source_topic": row[11],
        "source_partition": row[12],
        "source_offset": row[13],
        "source_window_id": None,
        "raw_event": row[14],
        "execution_audit_json": row[15],
        "raw_order": row[16],
    }


def _order_lifecycle_query_row_has_time(row: Sequence[object]) -> bool:
    return (row[3] if len(row) >= 20 else row[0]) is not None


def _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts(
    tca_rows: list[dict[str, object]],
) -> None:
    for row in tca_rows:
        row["authoritative"] = False
        row["authority_reason"] = "exact_replay_artifact_not_runtime_proof"
        row["promotion_blocker"] = "exact_replay_artifact_not_runtime_proof"
        row["pnl_derivation"] = EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS
        row["post_cost_promotion_eligible"] = False
        blockers = _metadata_text_list(row.get("runtime_ledger_blockers"))
        for blocker in EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS:
            if blocker not in blockers:
                blockers.append(blocker)
        row["runtime_ledger_blockers"] = blockers
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        bucket_payload = {str(key): item for key, item in bucket.items()}
        bucket_blockers = _metadata_text_list(bucket_payload.get("blockers"))
        for blocker in EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS:
            if blocker not in bucket_blockers:
                bucket_blockers.append(blocker)
        bucket_payload["blockers"] = bucket_blockers
        bucket_payload["authoritative"] = False
        bucket_payload["authority_reason"] = "exact_replay_artifact_not_runtime_proof"
        bucket_payload["pnl_derivation"] = EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS
        bucket_payload["source_materialization"] = "exact_replay_artifact"
        row["runtime_ledger_bucket"] = bucket_payload


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
    loaded_refs = _metadata_text_list(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_refs")
    )
    if loaded_refs and not _text_or_none(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_authority_class")
    ):
        blockers.append("runtime_ledger_artifact_authority_class_missing")
    if planned_refs:
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
    return False


_AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS = frozenset(
    {
        "paper_route_probe_runtime_observed",
        "paper_runtime_observed",
        "runtime_ledger_source_collection_candidate",
        "live_runtime_observed",
    }
)


def _source_collection_target_authorization_blockers(
    target_metadata: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if target_metadata.get("source_collection_authorized") is not True:
        blockers.append("source_collection_authorization_missing")
    if (
        str(target_metadata.get("source_collection_authorization_scope") or "").strip()
        != "source_window_evidence_collection_only"
    ):
        blockers.append("source_collection_authorization_scope_invalid")
    return blockers


def _source_kind_allows_runtime_ledger_materialization(
    *,
    source_kind: str,
    target_metadata: Mapping[str, Any],
) -> bool:
    if _runtime_window_source_kind_is_informational(
        source_kind=source_kind,
        target_metadata=target_metadata,
    ):
        return False
    normalized = source_kind.strip().lower().replace("-", "_")
    if normalized == "runtime_ledger_source_collection_candidate":
        return not _source_collection_target_authorization_blockers(target_metadata)
    return normalized in _AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS


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
    if (
        source_kind.strip().lower().replace("-", "_")
        == "runtime_ledger_source_collection_candidate"
    ):
        blockers.extend(
            _source_collection_target_authorization_blockers(target_metadata)
        )
    if not dependency_quorum_decision.strip():
        blockers.append("dependency_quorum_decision_missing")
    if not continuity_ok.strip():
        blockers.append("continuity_gate_missing")
    if not drift_ok.strip():
        blockers.append("drift_gate_missing")
    for key in (
        "runtime_ledger_target_metadata_blockers",
        "runtime_window_import_health_gate_blockers",
        "runtime_window_import_promotion_blockers",
        "paper_route_session_import_blockers",
        "candidate_blockers",
        "runtime_window_import_audit_blockers",
        "runtime_window_import_audit_target_blockers",
    ):
        blockers.extend(_metadata_text_list(target_metadata.get(key)))
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
    exact_replay_artifact_only = any(
        "exact_replay_artifact_not_runtime_proof"
        in _metadata_text_list(row.get("runtime_ledger_blockers"))
        or row.get("authority_reason") == "exact_replay_artifact_not_runtime_proof"
        for row in tca_rows
    )
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
    if exact_replay_artifact_only:
        return {
            "authoritative": False,
            "authority_reason": "exact_replay_artifact_not_runtime_proof",
            "promotion_authority": "blocked",
            "runtime_ledger_profit_proof_present": False,
        }
    return {
        "authoritative": False,
        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
        "promotion_authority": "blocked",
        "runtime_ledger_profit_proof_present": False,
    }


def _runtime_ledger_tca_materialization_metadata(
    tca_rows: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    bucket_row_count = 0
    profit_proof_count = 0
    authoritative_bucket_count = 0
    source_execution_materialized_count = 0
    execution_reconstruction_count = 0
    authority_reasons: list[str] = []
    pnl_derivations: list[str] = []
    source_materializations: list[str] = []
    blockers: list[str] = []
    profit_proof_blockers: list[str] = []
    for row in tca_rows:
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        bucket_payload = {str(key): value for key, value in bucket.items()}
        bucket_row_count += 1
        if _runtime_ledger_bucket_profit_proof_present(bucket_payload):
            profit_proof_count += 1
        else:
            profit_proof_blockers.extend(
                _runtime_ledger_bucket_profit_proof_blockers(bucket_payload)
            )
        if bool(row.get("authoritative")) or bool(bucket_payload.get("authoritative")):
            authoritative_bucket_count += 1
        authority_reason = _text_or_none(
            row.get("authority_reason") or bucket_payload.get("authority_reason")
        )
        if authority_reason is not None:
            authority_reasons.append(authority_reason)
        pnl_derivation = _text_or_none(
            row.get("pnl_derivation") or bucket_payload.get("pnl_derivation")
        )
        if pnl_derivation is not None:
            pnl_derivations.append(pnl_derivation)
        source_materialization = _text_or_none(
            bucket_payload.get("source_materialization")
        )
        if source_materialization is not None:
            source_materializations.append(source_materialization)
        if runtime_ledger_promotion_source_authority_present(bucket_payload):
            source_execution_materialized_count += 1
        if authority_reason == "execution_reconstruction_not_runtime_ledger_proof":
            execution_reconstruction_count += 1
        for blocker_source in (
            row.get("runtime_ledger_blockers"),
            row.get("promotion_blocker"),
            bucket_payload.get("blockers"),
        ):
            blockers.extend(_metadata_text_list(blocker_source))
    blockers.extend(profit_proof_blockers)
    return {
        "runtime_ledger_tca_row_count": len(tca_rows),
        "runtime_ledger_tca_runtime_bucket_row_count": bucket_row_count,
        "runtime_ledger_tca_profit_proof_count": profit_proof_count,
        "runtime_ledger_tca_authoritative_bucket_count": authoritative_bucket_count,
        "runtime_ledger_source_execution_materialized_bucket_count": (
            source_execution_materialized_count
        ),
        "runtime_ledger_execution_reconstruction_bucket_count": (
            execution_reconstruction_count
        ),
        "runtime_ledger_materialization_authority_reasons": sorted(
            dict.fromkeys(authority_reasons)
        ),
        "runtime_ledger_materialization_pnl_derivations": sorted(
            dict.fromkeys(pnl_derivations)
        ),
        "runtime_ledger_source_materializations": sorted(
            dict.fromkeys(source_materializations)
        ),
        "runtime_ledger_materialization_blockers": sorted(dict.fromkeys(blockers)),
        "runtime_ledger_profit_proof_blockers": sorted(
            dict.fromkeys(profit_proof_blockers)
        ),
    }


def _runtime_window_import_audit_summary(
    *,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: Sequence[str],
    account_label: str,
    source_account_label: str,
    window_start: datetime,
    window_end: datetime,
    source_kind: str,
    source_manifest_ref: str | None,
    dataset_snapshot_ref: str | None,
    decisions: Sequence[datetime],
    executions: Sequence[datetime],
    tca_rows: Sequence[Mapping[str, object]],
    buckets: Sequence[object],
    runtime_observation_payload: Mapping[str, Any],
    runtime_ledger_target_metadata_blockers: Sequence[str],
) -> dict[str, Any]:
    ledger_payloads = [
        payload
        for row in tca_rows
        if (payload := _as_mapping(row.get("runtime_ledger_bucket")))
    ]
    ledger_profit_proof_blockers = sorted(
        {
            blocker
            for payload in ledger_payloads
            for blocker in _runtime_ledger_bucket_profit_proof_blockers(payload)
        }
    )
    observed_bucket_payloads = [
        _as_mapping(getattr(bucket, "payload_json", {})) for bucket in buckets
    ]
    observed_bucket_blockers = sorted(
        {
            blocker
            for payload in observed_bucket_payloads
            for blocker in _metadata_text_list(
                payload.get("runtime_ledger_profit_proof_blockers")
                or payload.get("promotion_blocking_reasons")
                or payload.get("blockers")
            )
        }
    )
    source_activity_diagnostics = _as_mapping(
        runtime_observation_payload.get("source_activity_diagnostics")
    )
    return {
        "schema_version": "torghut.runtime-window-import-source-audit.v1",
        "audit_only": True,
        "would_persist": False,
        "verdict": (
            "profit_proof_present"
            if _runtime_ledger_profit_proof_present(tca_rows)
            else "blocked"
        ),
        "run_id": run_id,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "strategy_name": strategy_name,
        "strategy_name_candidates": list(strategy_names),
        "account_label": account_label,
        "source_account_label": source_account_label,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "source_kind": source_kind,
        "source_manifest_ref": source_manifest_ref,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "decision_count": len(decisions),
        "execution_count": len(executions),
        "tca_row_count": len(tca_rows),
        "runtime_ledger_bucket_row_count": len(ledger_payloads),
        "observed_runtime_bucket_count": len(buckets),
        "observed_runtime_bucket_blockers": observed_bucket_blockers,
        "runtime_ledger_profit_proof_present": _runtime_ledger_profit_proof_present(
            tca_rows
        ),
        "runtime_ledger_profit_proof_blockers": ledger_profit_proof_blockers,
        "runtime_ledger_target_metadata_blockers": list(
            dict.fromkeys(runtime_ledger_target_metadata_blockers)
        ),
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": _metadata_text_list(
            runtime_observation_payload.get("source_activity_diagnostic_blockers")
        ),
        "promotion_authority": runtime_observation_payload.get("promotion_authority"),
        "authority_reason": runtime_observation_payload.get("authority_reason"),
        "runtime_observation": {
            "runtime_ledger_profit_proof_present": runtime_observation_payload.get(
                "runtime_ledger_profit_proof_present"
            ),
            "evidence_provenance": runtime_observation_payload.get(
                "evidence_provenance"
            ),
            "source_kind": runtime_observation_payload.get("source_kind"),
            "source_activity_symbol_filter": runtime_observation_payload.get(
                "source_activity_symbol_filter"
            ),
        },
        "runtime_ledger_materialization": _runtime_ledger_tca_materialization_metadata(
            tca_rows
        ),
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
    normalized_side = str(side or "").strip().lower().replace("-", "_")
    quantity = _decimal_or_none(qty)
    if quantity is None or quantity <= 0:
        return Decimal("0")
    if normalized_side in {"buy", "buy_to_cover", "cover"}:
        return quantity
    if normalized_side in {"sell", "sell_short", "short"}:
        return -quantity
    return Decimal("0")


def _runtime_execution_cost_amount(
    row: Mapping[str, object],
    *,
    filled_notional: Decimal,
    side: Any = None,
    filled_qty: Decimal | None = None,
) -> Decimal | None:
    explicit_cost = _first_decimal(
        row,
        "cost_amount",
        "explicit_cost",
        "commission",
        "fees",
        "fee_amount",
        "broker_fee",
    )
    if explicit_cost is not None:
        return explicit_cost
    fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
        row,
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if fee_schedule_cost is not None:
        return fee_schedule_cost[0]
    total_cost_bps = _first_decimal(
        row,
        "total_cost_bps",
        "estimated_total_cost_bps",
        "explicit_cost_bps",
        "execution_total_cost_bps",
    )
    if total_cost_bps is None or total_cost_bps < 0 or filled_notional <= 0:
        return None
    return filled_notional * total_cost_bps / Decimal("10000")


def _runtime_execution_cost_basis(
    row: Mapping[str, object],
    *,
    cost_amount: Decimal | None,
    side: Any = None,
    filled_qty: Decimal | None = None,
    filled_notional: Decimal | None = None,
) -> str | None:
    cost_basis = _first_text(
        row,
        "cost_basis",
        "cost_source",
        "fee_basis",
        "commission_basis",
        "broker_fee_basis",
    )
    if cost_basis is not None:
        return cost_basis
    if filled_notional is not None:
        fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
            row,
            side=side,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if fee_schedule_cost is not None and cost_amount == fee_schedule_cost[0]:
            return fee_schedule_cost[1]
    if (
        cost_amount is not None
        and _first_decimal(
            row,
            "total_cost_bps",
            "estimated_total_cost_bps",
            "explicit_cost_bps",
            "execution_total_cost_bps",
        )
        is not None
    ):
        return "decision_impact_assumptions_total_cost_bps"
    return None


def _runtime_lifecycle_ledger_row(
    row: Mapping[str, object],
    *,
    event_type: str,
    require_complete_fill: bool = False,
) -> dict[str, object] | None:
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    if event_time is None:
        return None
    symbol = _first_text(row, "symbol", "order_symbol")
    ledger_row: dict[str, object] = {
        "executed_at": event_time,
        "event_type": event_type,
        "account_label": _first_text(row, "account_label", "alpaca_account_label"),
        "strategy_id": _first_text(row, "strategy_id", "strategy_name"),
        "symbol": symbol.strip().upper() if symbol is not None else None,
        "decision_id": _first_text(
            row,
            "decision_id",
            "trade_decision_id",
            "decision_hash",
        ),
        "order_id": _first_text(
            row,
            "order_id",
            "alpaca_order_id",
            "client_order_id",
            "execution_correlation_id",
        ),
        "execution_policy_hash": _first_text(
            row,
            "execution_policy_hash",
            "execution_policy_sha256",
            "policy_hash",
        )
        or _first_payload_digest(
            row,
            "execution_policy",
            "execution_policy_context",
            "execution_advisor",
            "_execution_advice_provenance",
        ),
        "cost_model_hash": _first_text(
            row,
            "cost_model_hash",
            "fee_model_hash",
            "cost_model_sha256",
        )
        or _first_payload_digest(
            row,
            "cost_model",
            "cost_model_config",
            "transaction_cost_model",
            "fee_model",
            "fees_model",
        ),
        "lineage_hash": _first_text(
            row,
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_lineage_hash",
            "candidate_evaluation_key",
            "event_fingerprint",
        )
        or _first_lineage_digest(row),
        "replay_data_hash": _first_text(
            row,
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
            "source_offset",
        ),
    }
    if event_type in _RUNTIME_LEDGER_FILL_EVENTS:
        side = _first_text(row, "side", "action", "order_side")
        source_authority_order_event = _source_authority_order_event_row(row)
        fill_quantity_basis = _fill_quantity_basis(row)
        filled_qty_delta = _first_positive_decimal(
            row,
            "filled_qty_delta",
            "fill_qty_delta",
            "delta_filled_qty",
        )
        filled_qty = _first_positive_decimal(
            row,
            "filled_qty",
            "filled_quantity",
            "qty",
            "quantity",
        )
        avg_fill_price = _first_positive_decimal(
            row,
            "avg_fill_price",
            "filled_avg_price",
            "filled_average_price",
            "average_fill_price",
            "fill_price",
            "filled_price",
            "price",
        )
        source_order_feed_delta_fill = (
            _source_order_feed_payload_delta_fill(row, event_type=event_type)
            if source_authority_order_event and fill_quantity_basis is None
            else None
        )
        if (
            source_authority_order_event
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is not None
        ):
            filled_qty = filled_qty_delta
        filled_notional_delta = _first_positive_decimal(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
        )
        filled_notional = _first_positive_decimal(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
            "filled_notional",
            "notional",
            "fill_notional",
        )
        if source_order_feed_delta_fill is not None:
            delta_qty, delta_price, delta_side = source_order_feed_delta_fill
            side = side or delta_side
            fill_quantity_basis = "delta"
            filled_qty_delta = delta_qty
            filled_qty = delta_qty
            avg_fill_price = delta_price
            filled_notional_delta = delta_qty * delta_price
            filled_notional = filled_notional_delta
        elif source_authority_order_event and fill_quantity_basis not in {
            "delta",
            "cumulative_to_delta",
        }:
            filled_qty = None
            filled_notional = None
        elif (
            source_authority_order_event
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is None
        ):
            filled_qty = None
            filled_notional = None
        if (
            filled_notional is None
            and filled_qty is not None
            and avg_fill_price is not None
        ):
            filled_notional = filled_qty * avg_fill_price
        cost_amount = (
            _runtime_execution_cost_amount(
                row,
                filled_notional=filled_notional,
                side=side,
                filled_qty=filled_qty,
            )
            if filled_notional is not None
            else None
        )
        cost_basis = _runtime_execution_cost_basis(
            row,
            cost_amount=cost_amount,
            side=side,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if require_complete_fill and (
            side is None
            or filled_qty is None
            or filled_qty <= 0
            or avg_fill_price is None
            or avg_fill_price <= 0
            or filled_notional is None
            or filled_notional <= 0
            or cost_amount is None
            or cost_amount < 0
            or cost_basis is None
        ):
            return None
        if side is not None:
            ledger_row["side"] = side
        if filled_qty is not None:
            ledger_row["filled_qty"] = filled_qty
        if avg_fill_price is not None:
            ledger_row["avg_fill_price"] = avg_fill_price
        if filled_notional is not None:
            ledger_row["filled_notional"] = filled_notional
        if filled_qty_delta is not None:
            ledger_row["filled_qty_delta"] = filled_qty_delta
        if filled_notional_delta is not None:
            ledger_row["filled_notional_delta"] = filled_notional_delta
        if fill_quantity_basis is not None:
            ledger_row["fill_quantity_basis"] = fill_quantity_basis
        if cost_amount is not None:
            ledger_row["cost_amount"] = cost_amount
        if cost_basis is not None:
            ledger_row["cost_basis"] = cost_basis
        if _cost_basis_is_alpaca_fee_schedule(cost_basis):
            ledger_row["cost_model_hash"] = _alpaca_2026_equity_fee_schedule_hash()
        ledger_row["source"] = "execution_order_event"
    return ledger_row


def _runtime_order_id(row: Mapping[str, object]) -> str | None:
    return _first_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )


def _execution_row_has_fill(row: Mapping[str, object]) -> bool:
    filled_qty = _first_positive_decimal(
        row,
        "filled_qty",
        "filled_quantity",
        "qty",
        "quantity",
    )
    avg_fill_price = _first_positive_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    return (
        filled_qty is not None
        and filled_qty > 0
        and avg_fill_price is not None
        and avg_fill_price > 0
    )


def _runtime_lifecycle_identifier_values(row: Mapping[str, object]) -> set[str]:
    values = _text_values(row, *_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS)
    return {value for value in values if value}


def _runtime_lifecycle_strategy_identifier_values(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        identifiers.update(_runtime_lifecycle_identifier_values(row))
    return identifiers


def _strategy_relevant_unlinked_fill_lifecycle_rows(
    *,
    execution_rows: Sequence[Mapping[str, object]],
    order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    unlinked_order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
) -> list[dict[str, object]]:
    strategy_identifiers = _runtime_lifecycle_strategy_identifier_values(
        [
            *execution_rows,
            *(order_lifecycle_rows or ()),
        ]
    )
    lineage_filter_present = candidate_id is not None or hypothesis_id is not None
    relevant_rows: list[dict[str, object]] = []
    for row in unlinked_order_lifecycle_rows or ():
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if lineage_filter_present and _source_row_matches_lineage(
            normalized,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=True,
        ):
            relevant_rows.append(normalized)
            continue
        if (
            strategy_identifiers
            and _runtime_lifecycle_identifier_values(normalized) & strategy_identifiers
        ):
            relevant_rows.append(normalized)
    return relevant_rows


def _order_feed_fill_lifecycle_blockers(
    *,
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> list[str]:
    expected_order_ids: set[str] = set()
    missing_execution_order_id = False
    for row in execution_rows:
        if not _execution_row_has_fill(row):
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            missing_execution_order_id = True
            continue
        expected_order_ids.add(order_id)

    if not expected_order_ids and not missing_execution_order_id:
        return []

    observed_fill_order_ids: set[str] = set()
    for row in order_lifecycle_rows or []:
        normalized = {str(key): value for key, value in row.items()}
        event_type = _runtime_ledger_event_type(normalized)
        if event_type not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            continue
        observed_fill_order_ids.add(order_id)

    blockers: list[str] = []
    if _strategy_relevant_unlinked_fill_lifecycle_rows(
        execution_rows=execution_rows,
        order_lifecycle_rows=order_lifecycle_rows,
        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
    ):
        blockers.append(ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER)
    if missing_execution_order_id:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER)
    if not observed_fill_order_ids:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER)
    elif expected_order_ids - observed_fill_order_ids:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER)
    return blockers


def _source_authority_order_event_row(row: Mapping[str, object]) -> bool:
    return any(
        row.get(key) is not None
        for key in (
            "execution_order_event_id",
            "source_window_id",
            "source_offset",
        )
    )


def _fill_quantity_basis(row: Mapping[str, object]) -> str | None:
    raw = _first_text(row, "fill_quantity_basis", "quantity_basis")
    if raw is None:
        return None
    normalized = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"delta", "fill_delta", "filled_delta"}:
        return "delta"
    if normalized in {"cumulative_to_delta", "cumulative_delta", "cum_to_delta"}:
        return "cumulative_to_delta"
    if normalized in {"cumulative", "cum"}:
        return "cumulative"
    if normalized in {"unknown", "cumulative_non_increasing"}:
        return normalized
    return normalized or None


def _source_order_feed_payload_delta_fill(
    row: Mapping[str, object], *, event_type: str
) -> tuple[Decimal, Decimal, str | None] | None:
    if (
        _runtime_ledger_event_type({"event_type": event_type})
        not in _RUNTIME_LEDGER_FILL_EVENTS
    ):
        return None
    raw_event = _as_mapping(row.get("raw_event"))
    if not raw_event:
        return None

    payload_candidates: list[Mapping[str, object]] = []
    for key in ("payload", "data"):
        payload = _as_mapping(raw_event.get(key))
        if payload:
            payload_candidates.append(payload)
    if _as_mapping(raw_event.get("order")):
        payload_candidates.append(raw_event)

    for payload in payload_candidates:
        payload_event = _runtime_ledger_event_type(
            {
                "event_type": _direct_text(payload, "event", "event_type")
                or event_type,
                "status": _direct_text(payload, "status"),
            }
        )
        if payload_event not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        qty = _decimal_or_none(payload.get("qty"))
        price = _decimal_or_none(payload.get("price"))
        if qty is None or qty <= 0 or price is None or price <= 0:
            continue
        order = _as_mapping(payload.get("order"))
        side = _direct_text(payload, "side", "order_side") or _direct_text(
            order, "side"
        )
        return qty, price, side
    return None


def _order_feed_fill_delta_blockers(row: Mapping[str, object]) -> list[str]:
    if not _source_authority_order_event_row(row):
        return []
    if _source_order_feed_payload_delta_fill(
        row, event_type=_runtime_ledger_event_type(row)
    ):
        return []
    basis = _fill_quantity_basis(row)
    if basis not in {"delta", "cumulative_to_delta"}:
        return [ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER]
    if (
        _first_positive_decimal(
            row,
            "filled_qty_delta",
            "fill_qty_delta",
            "delta_filled_qty",
        )
        is None
    ):
        return [ORDER_FEED_FILL_DELTA_MISSING_BLOCKER]
    return []


def _runtime_source_row_symbol(row: Mapping[str, object]) -> str | None:
    symbol = _first_text(row, "symbol", "ticker")
    return symbol.upper() if symbol is not None else None


def _runtime_source_row_in_bucket(
    row: Mapping[str, object],
    *,
    bucket: RuntimeLedgerBucket,
) -> bool:
    row_symbol = _runtime_source_row_symbol(row)
    if (
        bucket.symbol is not None
        and row_symbol is not None
        and row_symbol != bucket.symbol
    ):
        return False
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    return (
        event_time is None
        or bucket.bucket_started_at <= event_time < bucket.bucket_ended_at
    )


def _runtime_source_row_before_bucket(
    row: Mapping[str, object],
    *,
    bucket: RuntimeLedgerBucket,
) -> bool:
    row_symbol = _runtime_source_row_symbol(row)
    if (
        bucket.symbol is not None
        and row_symbol is not None
        and row_symbol != bucket.symbol
    ):
        return False
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    return event_time is not None and event_time < bucket.bucket_started_at


def _runtime_source_decision_ids(rows: Sequence[Mapping[str, object]]) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        for key in ("trade_decision_id", "decision_id", "decision_hash"):
            value = _text_or_none(row.get(key))
            if value is not None:
                identifiers.add(value)
    return identifiers


def _runtime_order_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    bucket_execution_order_ids = {
        order_id
        for row in execution_rows
        if _runtime_source_row_in_bucket(row, bucket=bucket)
        and _execution_row_has_fill(row)
        and (order_id := _runtime_order_id(row)) is not None
    }
    bucket_fill_order_ids = {
        order_id
        for row in order_lifecycle_rows or []
        if _runtime_source_row_in_bucket(row, bucket=bucket)
        and _runtime_ledger_event_type({str(key): value for key, value in row.items()})
        in _RUNTIME_LEDGER_FILL_EVENTS
        and (order_id := _runtime_order_id(row)) is not None
    }
    bucket_order_ids = bucket_execution_order_ids | bucket_fill_order_ids
    rows: list[dict[str, object]] = []
    for row in order_lifecycle_rows or []:
        if not _runtime_source_row_in_bucket(row, bucket=bucket):
            continue
        order_id = _runtime_order_id(row)
        if bucket_order_ids and order_id not in bucket_order_ids:
            continue
        rows.append(dict(row))
    return rows


def _runtime_decision_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    decision_lifecycle_rows: list[dict[str, object]] | None,
    source_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    decision_ids = _runtime_source_decision_ids(source_rows)
    rows: list[dict[str, object]] = []
    for row in decision_lifecycle_rows or []:
        if not _runtime_source_row_in_bucket(row, bucket=bucket):
            continue
        row_ids = _runtime_source_decision_ids([row])
        if decision_ids and not (row_ids & decision_ids):
            continue
        rows.append(dict(row))
    return rows


def _runtime_decision_rows_before_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    decision_lifecycle_rows: list[dict[str, object]] | None,
    source_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    decision_ids = _runtime_source_decision_ids(source_rows)
    rows: list[dict[str, object]] = []
    for row in decision_lifecycle_rows or []:
        if not _runtime_source_row_before_bucket(row, bucket=bucket):
            continue
        row_ids = _runtime_source_decision_ids([row])
        if decision_ids and not (row_ids & decision_ids):
            continue
        rows.append(dict(row))
    return rows


def _runtime_unlinked_order_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None,
    bucket_order_ids: set[str],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for row in unlinked_order_lifecycle_rows or []:
        if _runtime_source_row_in_bucket(row, bucket=bucket):
            rows.append(dict(row))
            continue
        row_symbol = _runtime_source_row_symbol(row)
        if (
            bucket.symbol is not None
            and row_symbol is not None
            and row_symbol != bucket.symbol
        ):
            continue
        order_id = _runtime_order_id(row)
        if order_id is not None and order_id in bucket_order_ids:
            rows.append(dict(row))
    return rows


def _event_sourced_fill_economics_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if (
            _runtime_lifecycle_ledger_row(
                normalized,
                event_type=_runtime_ledger_event_type(normalized),
                require_complete_fill=True,
            )
            is None
        ):
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids


def _source_backed_fill_lifecycle_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    source_backed_rows: list[dict[str, object]] = []
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if _runtime_order_id(normalized) is None:
            continue
        if not _source_identifier_values([normalized], "execution_order_event_id"):
            continue
        if not _source_identifier_values([normalized], "source_window_id"):
            continue
        if not _source_offset_values([normalized]):
            continue
        source_backed_rows.append(dict(normalized))
    return source_backed_rows


def _source_backed_order_lifecycle_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    source_backed_rows: list[dict[str, object]] = []
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if (
            _runtime_ledger_event_type(normalized)
            not in _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS
        ):
            continue
        if _runtime_order_id(normalized) is None:
            continue
        if not _source_identifier_values([normalized], "execution_order_event_id"):
            continue
        if not _source_identifier_values([normalized], "source_window_id"):
            continue
        if not _source_offset_values([normalized]):
            continue
        source_backed_rows.append(dict(normalized))
    return source_backed_rows


def _required_order_lifecycle_source_row_count(
    rows: Sequence[Mapping[str, object]],
    *,
    expected_order_ids: set[str],
) -> int:
    if not expected_order_ids:
        return 0
    count = 0
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if (
            _runtime_ledger_event_type(normalized)
            not in _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS
        ):
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is None or order_id not in expected_order_ids:
            continue
        count += 1
    return max(count, len(expected_order_ids))


def _source_backed_fill_lifecycle_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    return {
        order_id
        for row in _source_backed_fill_lifecycle_rows(rows)
        if (order_id := _runtime_order_id(row)) is not None
    }


def _execution_fill_economics_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        if not _execution_row_has_fill(row):
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            continue
        filled_notional = _first_positive_decimal(
            row, "filled_notional", "notional", "turnover_notional"
        ) or Decimal("0")
        if filled_notional <= 0:
            price = _first_positive_decimal(
                row,
                "avg_fill_price",
                "filled_avg_price",
                "filled_average_price",
                "average_fill_price",
                "fill_price",
                "filled_price",
            )
            qty = _first_positive_decimal(
                row, "filled_qty", "filled_quantity", "qty", "quantity"
            )
            if price is None or qty is None or price <= 0 or qty <= 0:
                continue
            filled_notional = price * qty
        cost_amount = _runtime_execution_cost_amount(
            row,
            filled_notional=filled_notional,
            side=_first_text(row, "side", "order_side") or "",
            filled_qty=(
                _first_positive_decimal(
                    row, "filled_qty", "filled_quantity", "qty", "quantity"
                )
                or Decimal("0")
            ),
        )
        cost_basis = _runtime_execution_cost_basis(
            row,
            cost_amount=cost_amount,
            side=_first_text(row, "side", "order_side") or "",
            filled_qty=(
                _first_positive_decimal(
                    row, "filled_qty", "filled_quantity", "qty", "quantity"
                )
                or Decimal("0")
            ),
            filled_notional=filled_notional,
        )
        if cost_amount is not None and cost_amount >= 0 and cost_basis is not None:
            order_ids.add(order_id)
    return order_ids


def _runtime_source_context_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    execution_rows: list[dict[str, object]],
    decision_lifecycle_rows: list[dict[str, object]] | None,
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    target_order_rows = _runtime_order_rows_for_bucket(
        bucket=bucket,
        execution_rows=execution_rows,
        order_lifecycle_rows=order_lifecycle_rows,
    )
    bucket_carry_in_order_rows = [
        dict(row)
        for row in carry_in_order_lifecycle_rows or []
        if _runtime_source_row_before_bucket(row, bucket=bucket)
    ]
    bucket_order_rows = [*bucket_carry_in_order_rows, *target_order_rows]
    bucket_order_ids = {
        order_id
        for row in bucket_order_rows
        if (order_id := _runtime_order_id(row)) is not None
    }
    target_execution_rows = [
        dict(row)
        for row in execution_rows
        if _execution_row_has_fill(row)
        and (
            _runtime_source_row_in_bucket(row, bucket=bucket)
            or (
                (order_id := _runtime_order_id(row)) is not None
                and order_id in bucket_order_ids
            )
        )
    ]
    bucket_carry_in_execution_rows = [
        dict(row)
        for row in carry_in_execution_rows or []
        if _execution_row_has_fill(row)
        and _runtime_source_row_before_bucket(row, bucket=bucket)
    ]
    bucket_execution_rows = [*bucket_carry_in_execution_rows, *target_execution_rows]
    target_decision_rows = _runtime_decision_rows_for_bucket(
        bucket=bucket,
        decision_lifecycle_rows=decision_lifecycle_rows,
        source_rows=[*bucket_execution_rows, *bucket_order_rows],
    )
    carry_in_decision_rows = _runtime_decision_rows_before_bucket(
        bucket=bucket,
        decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
        source_rows=[*bucket_execution_rows, *bucket_order_rows],
    )
    bucket_decision_rows = [*carry_in_decision_rows, *target_decision_rows]
    bucket_unlinked_order_rows = _runtime_unlinked_order_rows_for_bucket(
        bucket=bucket,
        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
        bucket_order_ids=bucket_order_ids,
    )
    source_rows = [*bucket_execution_rows, *bucket_decision_rows, *bucket_order_rows]
    source_backed_fill_lifecycle_rows = _source_backed_fill_lifecycle_rows(
        bucket_order_rows
    )
    source_backed_order_lifecycle_rows = _source_backed_order_lifecycle_rows(
        bucket_order_rows
    )
    expected_execution_fill_order_ids = set()
    for row in bucket_execution_rows:
        if (
            _execution_row_has_fill(row)
            and (order_id := _runtime_order_id(row)) is not None
        ):
            expected_execution_fill_order_ids.add(order_id)
    for row in bucket_order_rows:
        if (order_id := _runtime_order_id(row)) is not None:
            expected_execution_fill_order_ids.add(order_id)
    source_backed_fill_lifecycle_order_ids = _source_backed_fill_lifecycle_order_ids(
        source_backed_fill_lifecycle_rows
    )
    event_sourced_fill_order_ids = _event_sourced_fill_economics_order_ids(
        source_backed_fill_lifecycle_rows
    )
    execution_fill_order_ids = _execution_fill_economics_order_ids(
        bucket_execution_rows
    )
    order_feed_fill_economics_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(event_sourced_fill_order_ids)
    execution_fill_economics_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(execution_fill_order_ids)
    source_backed_fill_lifecycle_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(
        source_backed_fill_lifecycle_order_ids
    )
    source_authority_lifecycle_rows = (
        source_backed_order_lifecycle_rows
        if source_backed_fill_lifecycle_complete
        else source_backed_fill_lifecycle_rows
    )
    source_authority_lifecycle_times = [
        event_time
        for row in source_authority_lifecycle_rows
        if (
            event_time := _runtime_ledger_row_time(
                {str(key): value for key, value in row.items()}
            )
        )
        is not None
    ]
    source_window_ids = _source_identifier_values(
        source_authority_lifecycle_rows,
        "source_window_id",
    )
    required_order_lifecycle_source_row_count = (
        _required_order_lifecycle_source_row_count(
            bucket_order_rows,
            expected_order_ids=expected_execution_fill_order_ids,
        )
    )
    source_row_counts = {
        "trade_decisions": len(bucket_decision_rows),
        "executions": len(bucket_execution_rows),
        "execution_order_events": required_order_lifecycle_source_row_count,
    }
    if source_window_ids:
        source_row_counts["order_feed_source_windows"] = len(source_window_ids)
    elif required_order_lifecycle_source_row_count > 0:
        source_row_counts["order_feed_source_windows"] = 1
    source_refs = [
        ref
        for table, ref in (
            ("trade_decisions", "postgres:trade_decisions"),
            ("executions", "postgres:executions"),
            ("execution_order_events", "postgres:execution_order_events"),
            ("order_feed_source_windows", "postgres:order_feed_source_windows"),
        )
        if source_row_counts.get(table, 0) > 0
    ]
    source_materialization = None
    authority_class = None
    source_offsets = _source_offset_values(source_authority_lifecycle_rows)
    source_window_status_counts = _source_window_status_counts(
        source_authority_lifecycle_rows
    )
    source_window_classification_counts = _source_window_classification_counts(
        source_authority_lifecycle_rows
    )
    source_window_gap_count = _source_window_gap_count(source_authority_lifecycle_rows)
    source_window_gap_ranges = _source_window_gap_ranges(
        source_authority_lifecycle_rows
    )
    execution_order_event_ids = _source_identifier_values(
        source_authority_lifecycle_rows,
        "execution_order_event_id",
    )
    if source_offsets and execution_order_event_ids:
        if order_feed_fill_economics_complete:
            source_materialization = "execution_order_events"
            authority_class = "runtime_order_feed_execution_source"
        elif (
            execution_fill_economics_complete and source_backed_fill_lifecycle_complete
        ):
            source_materialization = "source_execution_lifecycle"
            authority_class = "source_execution_lifecycle_materialized_runtime_ledger"
    return {
        "execution_rows": bucket_execution_rows,
        "decision_rows": bucket_decision_rows,
        "order_rows": bucket_order_rows,
        "unlinked_order_rows": bucket_unlinked_order_rows,
        "source_rows": source_rows,
        "source_window_ids": source_window_ids,
        "source_window_start": (
            min(source_authority_lifecycle_times)
            if source_authority_lifecycle_times
            else bucket.bucket_started_at
        ),
        "source_window_end": (
            max(source_authority_lifecycle_times) + timedelta(microseconds=1)
            if source_authority_lifecycle_times
            else bucket.bucket_ended_at
        ),
        "source_row_counts": source_row_counts,
        "source_refs": source_refs,
        "trade_decision_ids": _source_identifier_values(
            source_rows,
            "trade_decision_id",
            "decision_id",
            "decision_hash",
        ),
        "execution_ids": _source_identifier_values(
            [*bucket_execution_rows, *bucket_order_rows],
            "execution_id",
        ),
        "execution_order_event_ids": execution_order_event_ids,
        "source_window_status_counts": source_window_status_counts,
        "source_window_classification_counts": source_window_classification_counts,
        "source_window_gap_count": source_window_gap_count,
        "source_window_gap_ranges": source_window_gap_ranges,
        "source_offsets": source_offsets,
        "source_materialization": source_materialization,
        "authority_class": authority_class,
        "order_feed_lifecycle_complete": source_backed_fill_lifecycle_complete,
        "fill_economics_complete": (
            order_feed_fill_economics_complete or execution_fill_economics_complete
        ),
        "order_feed_fill_lifecycle_blockers": _order_feed_fill_lifecycle_blockers(
            execution_rows=bucket_execution_rows,
            order_lifecycle_rows=bucket_order_rows,
            unlinked_order_lifecycle_rows=bucket_unlinked_order_rows,
        ),
        "source_account_labels": sorted(
            {
                str(row.get("source_account_label") or "").strip()
                for row in source_rows
                if str(row.get("source_account_label") or "").strip()
            }
        ),
        "source_decision_mode_counts": _source_decision_mode_counts(source_rows),
        "source_decision_profit_proof_eligible": (
            _source_decision_rows_profit_proof_eligible(source_rows)
        ),
        "equity_denominator": _runtime_ledger_equity_denominator_from_rows(source_rows),
    }


def _source_activity_diagnostics_blockers(
    diagnostics: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []

    def add(blocker: str) -> None:
        if blocker not in blockers:
            blockers.append(blocker)

    if _text_or_none(diagnostics.get("runtime_ledger_source_bucket_unavailable")):
        add("runtime_ledger_source_bucket_unavailable")

    decision_query_count = _nonnegative_int(
        diagnostics.get("decision_rows_before_lineage_filter")
    )
    execution_query_count = _nonnegative_int(
        diagnostics.get("execution_rows_before_lineage_filter")
    )
    order_query_count = _nonnegative_int(
        diagnostics.get("order_lifecycle_rows_before_lineage_filter")
    )
    tca_query_count = _nonnegative_int(
        diagnostics.get("tca_rows_before_lineage_filter")
    )
    decision_lineage_count = _nonnegative_int(
        diagnostics.get("decision_rows_after_lineage_filter")
    )
    execution_lineage_count = _nonnegative_int(
        diagnostics.get("execution_rows_after_lineage_filter")
    )
    tca_lineage_count = _nonnegative_int(
        diagnostics.get("tca_rows_after_lineage_filter")
    )
    source_bucket_count = _nonnegative_int(
        diagnostics.get("runtime_ledger_source_bucket_count")
    )
    source_bucket_profit_proof_count = _nonnegative_int(
        diagnostics.get("runtime_ledger_source_bucket_profit_proof_count")
    )
    unlinked_fill_lifecycle_count = _nonnegative_int(
        diagnostics.get("order_feed_unlinked_fill_lifecycle_count")
    )
    if "order_feed_unlinked_strategy_fill_lifecycle_count" in diagnostics:
        strategy_unlinked_fill_lifecycle_count = _nonnegative_int(
            diagnostics.get("order_feed_unlinked_strategy_fill_lifecycle_count")
        )
    else:
        strategy_unlinked_fill_lifecycle_count = unlinked_fill_lifecycle_count

    if (
        decision_query_count
        or execution_query_count
        or order_query_count
        or tca_query_count
    ) and not (decision_lineage_count or execution_lineage_count or tca_lineage_count):
        add("source_lineage_filter_excluded_activity")
    elif not (
        decision_query_count
        or execution_query_count
        or order_query_count
        or tca_query_count
        or source_bucket_count
    ):
        add("strategy_account_symbol_window_source_activity_missing")

    if decision_lineage_count > 0 and execution_lineage_count <= 0:
        add("execution_rows_missing_for_matched_decisions")
    if execution_lineage_count > 0 and order_query_count <= 0:
        add(ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER)
    if execution_lineage_count > 0 and tca_lineage_count <= 0:
        add("execution_tca_rows_missing")
    if strategy_unlinked_fill_lifecycle_count > 0:
        add(ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER)
    if source_bucket_count <= 0:
        add("runtime_ledger_source_bucket_missing")
    elif source_bucket_profit_proof_count <= 0:
        add("runtime_ledger_source_bucket_profit_proof_missing")

    for blocker in _metadata_text_list(
        diagnostics.get("runtime_ledger_source_bucket_profit_proof_blockers")
    ):
        add(blocker)

    for blocker in _metadata_text_list(
        diagnostics.get("order_feed_fill_lifecycle_blockers")
    ):
        add(blocker)

    return blockers


def _runtime_execution_ledger_fill_from_row(
    row: Mapping[str, object],
    *,
    order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
) -> tuple[RuntimeLedgerFill | None, list[datetime]]:
    computed_at = row.get("computed_at")
    execution_event_at = row.get("execution_event_at")
    execution_created_at = row.get("execution_created_at")
    fill_event_at = (
        execution_created_at
        if isinstance(execution_created_at, datetime)
        else computed_at
    )
    if isinstance(execution_event_at, datetime):
        fill_event_at = execution_event_at
    ledger_computed_at = (
        fill_event_at if isinstance(fill_event_at, datetime) else computed_at
    )
    price = _first_positive_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    side = _first_text(row, "side", "order_side") or ""
    signed_qty = _execution_signed_qty(
        side=side,
        qty=_first_positive_decimal(
            row,
            "filled_qty",
            "filled_quantity",
            "qty",
            "quantity",
        ),
    )
    symbol = str(row.get("symbol") or "").strip().upper()
    if not symbol or not isinstance(ledger_computed_at, datetime):
        return None, []
    decision_id = _first_text(row, "decision_id", "trade_decision_id", "decision_hash")
    order_id = _first_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )
    execution_policy_hash = _first_text(
        row,
        "execution_policy_hash",
        "execution_policy_sha256",
        "policy_hash",
    ) or _first_payload_digest(
        row,
        "execution_policy",
        "execution_policy_context",
        "execution_advisor",
        "_execution_advice_provenance",
    )
    cost_model_hash = _first_text(
        row, "cost_model_hash", "fee_model_hash", "cost_model_sha256"
    ) or _first_payload_digest(
        row,
        "cost_model",
        "cost_model_config",
        "transaction_cost_model",
        "fee_model",
        "fees_model",
        "model",
    )
    lineage_hash = _first_text(
        row,
        "lineage_hash",
        "candidate_lineage_hash",
        "replay_lineage_hash",
        "candidate_evaluation_key",
    ) or _first_lineage_digest(row)
    replay_data_hash = _first_text(
        row,
        "replay_data_hash",
        "replay_tape_content_sha256",
        "dataset_snapshot_hash",
        "source_query_digest",
    )
    if price is None or price <= 0 or signed_qty == 0:
        return None, []
    if order_id is not None and order_id in _event_sourced_fill_economics_order_ids(
        order_lifecycle_rows or []
    ):
        return None, []
    event_times = [ledger_computed_at]
    if isinstance(fill_event_at, datetime):
        event_times.append(fill_event_at)
    filled_qty = abs(signed_qty)
    filled_notional = filled_qty * price
    cost_amount = _runtime_execution_cost_amount(
        row,
        filled_notional=filled_notional,
        side=side,
        filled_qty=filled_qty,
    )
    cost_basis = _runtime_execution_cost_basis(
        row,
        cost_amount=cost_amount,
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if _cost_basis_is_alpaca_fee_schedule(cost_basis):
        cost_model_hash = _alpaca_2026_equity_fee_schedule_hash()
    return (
        RuntimeLedgerFill(
            executed_at=fill_event_at
            if isinstance(fill_event_at, datetime)
            else ledger_computed_at,
            event_type="fill",
            decision_id=decision_id,
            order_id=order_id,
            execution_policy_hash=execution_policy_hash,
            cost_model_hash=cost_model_hash,
            lineage_hash=lineage_hash,
            replay_data_hash=replay_data_hash,
            side=side,
            filled_qty=filled_qty,
            avg_fill_price=price,
            filled_notional=filled_notional,
            cost_amount=cost_amount,
            cost_basis=cost_basis,
            account_label=str(row.get("account_label") or "") or None,
            strategy_id=str(row.get("strategy_id") or "") or None,
            symbol=symbol,
        ),
        event_times,
    )


def _build_realized_strategy_pnl_rows(
    execution_rows: list[dict[str, object]],
    *,
    decision_lifecycle_rows: list[dict[str, object]] | None = None,
    order_lifecycle_rows: list[dict[str, object]] | None = None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
    allow_authoritative_runtime_ledger_materialization: bool = False,
    split_mixed_source_decision_modes: bool = True,
) -> list[dict[str, object]]:
    if split_mixed_source_decision_modes:
        partitions = _partition_runtime_source_rows_by_decision_mode(
            execution_rows=execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
        )
        if partitions is not None:
            partition_rows: list[dict[str, object]] = []
            for (
                mode_key,
                partition_execution_rows,
                partition_decision_rows,
                partition_order_rows,
                partition_unlinked_order_rows,
                partition_carry_in_execution_rows,
                partition_carry_in_decision_rows,
                partition_carry_in_order_rows,
            ) in partitions:
                for row in _build_realized_strategy_pnl_rows(
                    partition_execution_rows,
                    decision_lifecycle_rows=partition_decision_rows,
                    order_lifecycle_rows=partition_order_rows,
                    unlinked_order_lifecycle_rows=partition_unlinked_order_rows,
                    carry_in_execution_rows=partition_carry_in_execution_rows,
                    carry_in_decision_lifecycle_rows=partition_carry_in_decision_rows,
                    carry_in_order_lifecycle_rows=partition_carry_in_order_rows,
                    allow_authoritative_runtime_ledger_materialization=(
                        allow_authoritative_runtime_ledger_materialization
                    ),
                    split_mixed_source_decision_modes=False,
                ):
                    row["source_decision_mode_partition"] = mode_key
                    bucket = row.get("runtime_ledger_bucket")
                    if isinstance(bucket, Mapping):
                        row["runtime_ledger_bucket"] = {
                            **dict(bucket),
                            "source_decision_mode_partition": mode_key,
                        }
                    partition_rows.append(row)
            return partition_rows

    ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    carry_in_ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    event_times: list[datetime] = []
    execution_order_ids = {
        order_id for row in execution_rows if (order_id := _runtime_order_id(row))
    }
    execution_ids = {
        execution_id
        for row in execution_rows
        if (execution_id := _first_text(row, "execution_id"))
    }
    carry_in_execution_order_ids = {
        order_id
        for row in carry_in_execution_rows or []
        if (order_id := _runtime_order_id(row))
    }
    carry_in_execution_ids = {
        execution_id
        for row in carry_in_execution_rows or []
        if (execution_id := _first_text(row, "execution_id"))
    }
    for row in decision_lifecycle_rows or []:
        lifecycle_row = _runtime_lifecycle_ledger_row(row, event_type="decision")
        if lifecycle_row is None:
            continue
        ledger_rows.append(lifecycle_row)
        event_time = lifecycle_row.get("executed_at")
        if isinstance(event_time, datetime):
            event_times.append(event_time)
    for row in order_lifecycle_rows or []:
        event_type = _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
        if event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            lifecycle_row = _runtime_lifecycle_ledger_row(
                row,
                event_type=event_type,
                require_complete_fill=True,
            )
            if lifecycle_row is None:
                row_order_id = _runtime_order_id(row)
                row_execution_id = _first_text(row, "execution_id")
                if (
                    row_order_id in execution_order_ids
                    or row_execution_id in execution_ids
                ):
                    lifecycle_row = _runtime_lifecycle_ledger_row(
                        row,
                        event_type=event_type,
                    )
                    if lifecycle_row is not None:
                        lifecycle_row["source"] = "order_feed_lifecycle"
            if lifecycle_row is not None:
                ledger_rows.append(lifecycle_row)
                event_time = lifecycle_row.get("executed_at")
                if isinstance(event_time, datetime):
                    event_times.append(event_time)
                continue
            event_time = _runtime_ledger_row_time(row)
            if isinstance(event_time, datetime):
                event_times.append(event_time)
            continue
        lifecycle_row = _runtime_lifecycle_ledger_row(
            row,
            event_type=event_type,
        )
        if lifecycle_row is None:
            continue
        ledger_rows.append(lifecycle_row)
        event_time = lifecycle_row.get("executed_at")
        if isinstance(event_time, datetime):
            event_times.append(event_time)
    for row in execution_rows:
        ledger_fill, ledger_event_times = _runtime_execution_ledger_fill_from_row(
            row,
            order_lifecycle_rows=order_lifecycle_rows,
        )
        if ledger_fill is None:
            continue
        ledger_rows.append(ledger_fill)
        event_times.extend(ledger_event_times)

    for row in carry_in_decision_lifecycle_rows or []:
        lifecycle_row = _runtime_lifecycle_ledger_row(row, event_type="decision")
        if lifecycle_row is not None:
            carry_in_ledger_rows.append(lifecycle_row)
    for row in carry_in_order_lifecycle_rows or []:
        event_type = _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
        lifecycle_row = _runtime_lifecycle_ledger_row(
            row,
            event_type=event_type,
            require_complete_fill=event_type in _RUNTIME_LEDGER_FILL_EVENTS,
        )
        if lifecycle_row is None and event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            row_order_id = _runtime_order_id(row)
            row_execution_id = _first_text(row, "execution_id")
            if (
                row_order_id in carry_in_execution_order_ids
                or row_execution_id in carry_in_execution_ids
            ):
                lifecycle_row = _runtime_lifecycle_ledger_row(
                    row,
                    event_type=event_type,
                )
                if lifecycle_row is not None:
                    lifecycle_row["source"] = "order_feed_lifecycle"
        if lifecycle_row is not None:
            carry_in_ledger_rows.append(lifecycle_row)
    combined_order_lifecycle_rows = [
        *(carry_in_order_lifecycle_rows or []),
        *(order_lifecycle_rows or []),
    ]
    for row in carry_in_execution_rows or []:
        ledger_fill, _ledger_event_times = _runtime_execution_ledger_fill_from_row(
            row,
            order_lifecycle_rows=combined_order_lifecycle_rows,
        )
        if ledger_fill is not None:
            carry_in_ledger_rows.append(ledger_fill)
    if not event_times:
        return []
    unique_times = sorted(set(event_times))
    bucket_ranges = [(unique_times[0], unique_times[-1] + timedelta(microseconds=1))]
    realized_rows: list[dict[str, object]] = []
    for bucket in build_runtime_ledger_buckets(
        ledger_rows,
        bucket_ranges=bucket_ranges,
        group_by=("symbol",),
        require_order_lifecycle=True,
        carry_in_rows=carry_in_ledger_rows,
    ):
        if bucket.closed_trade_count <= 0 and not bucket.blockers:
            continue
        row = _runtime_ledger_tca_row_from_bucket(
            bucket=bucket,
            computed_at=unique_times[-1],
        )
        bucket_payload = row.get("runtime_ledger_bucket")
        source_context = _runtime_source_context_for_bucket(
            bucket=bucket,
            execution_rows=execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
        )
        source_account_labels = cast(list[str], source_context["source_account_labels"])
        source_decision_mode_counts = cast(
            dict[str, int], source_context["source_decision_mode_counts"]
        )
        source_decision_profit_proof_eligible = bool(
            source_context["source_decision_profit_proof_eligible"]
        )
        source_refs = cast(list[str], source_context["source_refs"])
        source_row_counts = cast(dict[str, int], source_context["source_row_counts"])
        trade_decision_ids = cast(list[str], source_context["trade_decision_ids"])
        execution_ids = cast(list[str], source_context["execution_ids"])
        execution_order_event_ids = cast(
            list[str], source_context["execution_order_event_ids"]
        )
        source_window_ids = cast(list[str], source_context["source_window_ids"])
        source_window_status_counts = cast(
            dict[str, int], source_context["source_window_status_counts"]
        )
        source_window_classification_counts = cast(
            dict[str, int], source_context["source_window_classification_counts"]
        )
        source_window_gap_count = int(source_context["source_window_gap_count"] or 0)
        source_window_gap_ranges = cast(
            list[Mapping[str, object]], source_context["source_window_gap_ranges"]
        )
        source_window_start = cast(datetime, source_context["source_window_start"])
        source_window_end = cast(datetime, source_context["source_window_end"])
        source_offsets = cast(
            list[Mapping[str, object]], source_context["source_offsets"]
        )
        source_materialization = cast(
            str | None, source_context["source_materialization"]
        )
        authority_class = cast(str | None, source_context["authority_class"])
        order_feed_lifecycle_complete = bool(
            source_context["order_feed_lifecycle_complete"]
        )
        fill_economics_complete = bool(source_context["fill_economics_complete"])
        bucket_order_feed_fill_lifecycle_blockers = cast(
            list[str], source_context["order_feed_fill_lifecycle_blockers"]
        )
        equity_denominator = cast(
            tuple[Decimal, str] | None, source_context["equity_denominator"]
        )
        if source_account_labels and isinstance(bucket_payload, Mapping):
            bucket_payload = {
                **dict(bucket_payload),
                "source_account_labels": source_account_labels,
            }
            if len(source_account_labels) == 1:
                bucket_payload["source_account_label"] = source_account_labels[0]
            row["runtime_ledger_bucket"] = bucket_payload
        if source_decision_mode_counts:
            row["source_decision_mode_counts"] = source_decision_mode_counts
            row["profit_proof_eligible"] = source_decision_profit_proof_eligible
            if isinstance(bucket_payload, Mapping):
                source_decision_mode = next(
                    iter(source_decision_mode_counts),
                    None,
                )
                bucket_payload = {
                    **dict(bucket_payload),
                    "source_decision_mode_counts": source_decision_mode_counts,
                    "profit_proof_eligible": source_decision_profit_proof_eligible,
                }
                if len(source_decision_mode_counts) == 1:
                    row["source_decision_mode"] = source_decision_mode
                    bucket_payload["source_decision_mode"] = source_decision_mode
                if not source_decision_profit_proof_eligible:
                    blockers = list(bucket_payload.get("blockers") or [])
                    if (
                        SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                        not in blockers
                    ):
                        blockers.append(
                            SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                        )
                    bucket_payload["blockers"] = blockers
                    row["runtime_ledger_blockers"] = blockers
                    row["post_cost_promotion_eligible"] = False
                    row["promotion_blocker"] = (
                        SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                    )
                row["runtime_ledger_bucket"] = bucket_payload
        if isinstance(bucket_payload, Mapping):
            bucket_payload = _with_runtime_ledger_source_authority_context(
                bucket_payload,
                source_window_start=source_window_start,
                source_window_end=source_window_end,
                source_refs=source_refs,
                source_row_counts=source_row_counts,
                trade_decision_ids=trade_decision_ids,
                execution_ids=execution_ids,
                execution_order_event_ids=execution_order_event_ids,
                source_window_ids=source_window_ids,
                source_offsets=source_offsets,
                source_window_status_counts=source_window_status_counts,
                source_window_classification_counts=source_window_classification_counts,
                source_window_gap_count=source_window_gap_count,
                source_window_gap_ranges=source_window_gap_ranges,
                order_feed_lifecycle_complete=order_feed_lifecycle_complete,
                execution_economics_complete=fill_economics_complete,
                source_materialization=source_materialization,
                authority_class=authority_class,
            )
            row["runtime_ledger_bucket"] = bucket_payload
        source_backed_runtime_ledger = (
            allow_authoritative_runtime_ledger_materialization
            and fill_economics_complete
            and not bucket_order_feed_fill_lifecycle_blockers
            and isinstance(bucket_payload, Mapping)
            and not runtime_ledger_promotion_source_authority_blockers(bucket_payload)
        )
        event_sourced_runtime_ledger = (
            source_backed_runtime_ledger
            and isinstance(bucket_payload, Mapping)
            and _runtime_ledger_bucket_profit_proof_present(bucket_payload)
        )
        if event_sourced_runtime_ledger:
            row["authoritative"] = True
            row["authority_reason"] = "event_sourced_runtime_ledger_profit_proof"
            row["pnl_derivation"] = "execution_order_events_runtime_ledger"
            row["post_cost_promotion_eligible"] = True
            row["runtime_ledger_blockers"] = []
            row.pop("promotion_blocker", None)
            if isinstance(bucket_payload, Mapping):
                runtime_bucket = {
                    **dict(bucket_payload),
                    "authoritative": True,
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "pnl_derivation": "execution_order_events_runtime_ledger",
                    "source_materialization": (
                        source_materialization or "source_execution_lifecycle"
                    ),
                }
                if equity_denominator is not None:
                    runtime_bucket["account_equity"] = str(equity_denominator[0])
                    runtime_bucket["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = runtime_bucket
        elif source_backed_runtime_ledger:
            row["post_cost_expectancy_basis"] = POST_COST_BASIS_RUNTIME_LEDGER
            row["post_cost_promotion_eligible"] = False
            row["authoritative"] = False
            row["authority_reason"] = (
                "source_execution_lifecycle_materialized_runtime_ledger"
            )
            row["pnl_derivation"] = "execution_order_events_runtime_ledger"
            blockers = list(row.get("runtime_ledger_blockers") or [])
            row["runtime_ledger_blockers"] = blockers
            if blockers:
                row["promotion_blocker"] = blockers[0]
            else:
                row.pop("promotion_blocker", None)
            if isinstance(bucket_payload, Mapping):
                runtime_bucket = {
                    **dict(bucket_payload),
                    "blockers": blockers,
                    "pnl_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "authoritative": False,
                    "authority_reason": (
                        "source_execution_lifecycle_materialized_runtime_ledger"
                    ),
                    "pnl_derivation": "execution_order_events_runtime_ledger",
                    "source_materialization": (
                        source_materialization or "source_execution_lifecycle"
                    ),
                }
                if equity_denominator is not None:
                    runtime_bucket["account_equity"] = str(equity_denominator[0])
                    runtime_bucket["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = runtime_bucket
        else:
            row["post_cost_expectancy_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
            row["post_cost_promotion_eligible"] = False
            row["authoritative"] = False
            row["authority_reason"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            row["pnl_derivation"] = "execution_reconstructed_from_execution_rows"
            row["promotion_blocker"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            blockers = list(row.get("runtime_ledger_blockers") or [])
            for blocker in bucket_order_feed_fill_lifecycle_blockers:
                if blocker not in blockers:
                    blockers.append(blocker)
            if isinstance(bucket_payload, Mapping):
                for blocker in runtime_ledger_promotion_source_authority_blockers(
                    bucket_payload
                ):
                    if blocker not in blockers:
                        blockers.append(blocker)
            if "execution_reconstruction_not_runtime_ledger_proof" not in blockers:
                blockers.append("execution_reconstruction_not_runtime_ledger_proof")
            row["runtime_ledger_blockers"] = blockers
            if isinstance(bucket_payload, Mapping):
                bucket_payload = dict(bucket_payload)
                bucket_payload["blockers"] = blockers
                bucket_payload["pnl_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
                bucket_payload["authoritative"] = False
                bucket_payload["authority_reason"] = (
                    "execution_reconstruction_not_runtime_ledger_proof"
                )
                if equity_denominator is not None:
                    bucket_payload["account_equity"] = str(equity_denominator[0])
                    bucket_payload["account_equity_source"] = equity_denominator[1]
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
    bucket_payload = dict(payload)
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
    "payload_json",
)


def _source_runtime_ledger_payload_from_row(
    row: Sequence[object],
) -> dict[str, object]:
    payload = dict(zip(_SOURCE_RUNTIME_LEDGER_COLUMNS, row, strict=True))
    payload_json = _as_mapping(payload.get("payload_json"))
    started_at = _parse_dt_or_none(payload.get("bucket_started_at"))
    ended_at = _parse_dt_or_none(payload.get("bucket_ended_at"))
    return {
        **payload_json,
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
        payload.setdefault(
            "source_account_label",
            _first_text(payload, "account_label", "alpaca_account_label")
            or source_account_label,
        )
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
        payload.setdefault(
            "source_account_label",
            _first_text(payload, "account_label", "alpaca_account_label")
            or source_account_label,
        )
        if "account_label" in payload:
            payload["account_label"] = target_account_label
        bucket = _as_mapping(payload.get("runtime_ledger_bucket"))
        if bucket:
            source_bucket_label = (
                _text_or_none(bucket.get("account_label")) or source_account_label
            )
            payload["runtime_ledger_bucket"] = {
                **bucket,
                "account_label": target_account_label,
                "source_account_label": source_bucket_label,
            }
        retargeted.append(payload)
    return retargeted


def _query_timestamps(
    *,
    dsn: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
    symbols: Sequence[str] | None = None,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
    require_source_lineage: bool = False,
    allow_authoritative_runtime_ledger_materialization: bool = False,
    source_activity_diagnostics: dict[str, Any] | None = None,
) -> tuple[list[datetime], list[datetime], list[dict[str, object]]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    source_account_label = account_label
    materialized_account_label = (
        str(target_account_label or "").strip() or source_account_label
    )
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    execution_rows: list[dict[str, object]] = []
    decision_lifecycle_rows: list[dict[str, object]] = []
    order_lifecycle_rows: list[dict[str, object]] = []
    unlinked_order_lifecycle_rows: list[dict[str, object]] = []
    carry_in_execution_rows: list[dict[str, object]] = []
    carry_in_decision_lifecycle_rows: list[dict[str, object]] = []
    carry_in_order_lifecycle_rows: list[dict[str, object]] = []
    carry_in_window_start = window_start - RUNTIME_LEDGER_CARRY_IN_LOOKBACK
    symbol_filter = _metadata_symbol_list(symbols or ())
    if source_activity_diagnostics is not None:
        source_activity_diagnostics.update(
            {
                "strategy_name_candidates": strategy_names,
                "account_label": materialized_account_label,
                "source_account_label": source_account_label,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "carry_in_window_start": carry_in_window_start.isoformat(),
                "carry_in_window_end": window_start.isoformat(),
                "source_activity_symbol_filter": symbol_filter,
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "source_lineage_required": require_source_lineage,
                "authoritative_runtime_ledger_materialization_allowed": (
                    allow_authoritative_runtime_ledger_materialization
                ),
            }
        )
    decision_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)" if symbol_filter else ""
    )
    execution_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(e.symbol) = any(%s)"
        if symbol_filter
        else ""
    )
    order_event_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(coalesce(oe.symbol, e.symbol, d.symbol)) = any(%s)"
        if symbol_filter
        else ""
    )
    unlinked_order_event_symbol_clause = (
        "\n                  and upper(oe.symbol) = any(%s)" if symbol_filter else ""
    )
    decision_symbol_params: tuple[object, ...] = (
        (symbol_filter,) if symbol_filter else ()
    )
    execution_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    order_event_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                select
                    d.id,
                    d.created_at,
                    d.symbol,
                    d.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    d.decision_json
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
            decision_lifecycle_rows = [
                _decision_lifecycle_query_row(row)
                for row in cur.fetchall()
                if _decision_lifecycle_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["decision_rows_before_lineage_filter"] = (
                    len(decision_lifecycle_rows)
                )
            decision_lifecycle_rows = [
                row
                for row in decision_lifecycle_rows
                if _source_row_matches_lineage(
                    row,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    require_source_lineage=require_source_lineage,
                )
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["decision_rows_after_lineage_filter"] = len(
                    decision_lifecycle_rows
                )
            decision_lifecycle_rows = _attach_source_lineage_context(
                decision_lifecycle_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            decisions = []
            for row in decision_lifecycle_rows:
                computed_at = row.get("computed_at")
                if isinstance(computed_at, datetime):
                    decisions.append(computed_at)
            cur.execute(
                f"""
                select
                    e.id,
                    d.id,
                    d.created_at,
                    coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                    ) as execution_event_at,
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
                    d.decision_json,
                    e.alpaca_order_id,
                    e.client_order_id,
                    e.status
                from executions e
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                left join execution_tca_metrics t on t.execution_id = e.id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and e.alpaca_account_label = %s
                  and coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                      ) >= %s
                  and coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                      ) < %s
                  {execution_symbol_clause}
                order by coalesce(
                    e.order_feed_last_event_ts,
                    e.last_update_at,
                    e.updated_at,
                    e.created_at
                )
                """,
                (
                    strategy_names,
                    account_label,
                    account_label,
                    window_start,
                    window_end,
                    *execution_symbol_params,
                ),
            )
            execution_rows = [
                _execution_query_row(row)
                for row in cur.fetchall()
                if _execution_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["execution_rows_before_lineage_filter"] = (
                    len(execution_rows)
                )
                source_activity_diagnostics[
                    "fill_execution_rows_before_lineage_filter"
                ] = sum(1 for row in execution_rows if _execution_row_has_fill(row))
            execution_rows = [
                row
                for row in execution_rows
                if _source_row_matches_lineage(
                    row,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    require_source_lineage=require_source_lineage,
                )
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["execution_rows_after_lineage_filter"] = (
                    len(execution_rows)
                )
                source_activity_diagnostics[
                    "fill_execution_rows_after_lineage_filter"
                ] = sum(1 for row in execution_rows if _execution_row_has_fill(row))
            execution_rows = _attach_source_lineage_context(
                execution_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            executions = []
            for row in execution_rows:
                execution_event_at = row.get("execution_event_at")
                if isinstance(execution_event_at, datetime):
                    executions.append(execution_event_at)
            cur.execute(
                f"""
                select
                    oe.id,
                    coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
                    e.id,
                    coalesce(oe.event_ts, oe.created_at),
                    oe.symbol,
                    oe.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    d.decision_json,
                    oe.alpaca_order_id,
                    oe.client_order_id,
                    oe.event_type,
                    oe.status,
                    e.side,
                    oe.qty,
                    oe.filled_qty,
                    oe.filled_qty_delta,
                    oe.avg_fill_price,
                    oe.filled_notional_delta,
                    oe.fill_quantity_basis,
                    oe.event_fingerprint,
                    oe.source_topic,
                    oe.source_partition,
                    oe.source_offset,
                    oe.source_window_id,
                    oe.raw_event,
                    e.execution_audit_json,
                    e.raw_order,
                    sw.status,
                    sw.status_reason,
                    sw.consumed_count,
                    sw.inserted_count,
                    sw.duplicate_count,
                    sw.malformed_count,
                    sw.missing_payload_count,
                    sw.missing_identity_count,
                    sw.out_of_scope_account_count,
                    sw.unlinked_execution_count,
                    sw.unlinked_decision_count,
                    sw.failed_unhandled_count,
                    sw.dropped_count,
                    sw.gap_count,
                    sw.gap_ranges
                from execution_order_events oe
                left join order_feed_source_windows sw on sw.id = oe.source_window_id
                left join lateral (
                    select matched.*
                    from (
                        select
                            array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
                            count(*) as match_count
                        from executions e_match
                        where coalesce(e_match.alpaca_account_label, oe.alpaca_account_label)
                              = oe.alpaca_account_label
                          and (
                                (
                                    oe.execution_id is not null
                                    and e_match.id = oe.execution_id
                                )
                                or (
                                    nullif(oe.alpaca_order_id, '') is not null
                                    and e_match.alpaca_order_id = oe.alpaca_order_id
                                )
                                or (
                                    nullif(oe.client_order_id, '') is not null
                                    and e_match.client_order_id = oe.client_order_id
                                )
                              )
                    ) exact_match
                    join executions matched on matched.id = exact_match.ids[1]
                    where exact_match.match_count = 1
                ) e on true
                left join lateral (
                    select matched.*
                    from (
                        select
                            array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
                            count(*) as match_count
                        from trade_decisions d_match
                        where d_match.alpaca_account_label = oe.alpaca_account_label
                          and nullif(oe.client_order_id, '') is not null
                          and d_match.decision_hash = oe.client_order_id
                    ) exact_decision_match
                    join trade_decisions matched on matched.id = exact_decision_match.ids[1]
                    where exact_decision_match.match_count = 1
                ) d_by_client on true
                join trade_decisions d
                  on d.id = coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id)
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and oe.alpaca_account_label = %s
                  and coalesce(oe.event_ts, oe.created_at) >= %s
                  and coalesce(oe.event_ts, oe.created_at) < %s
                  {order_event_symbol_clause}
                order by coalesce(oe.event_ts, oe.created_at), oe.created_at
                """,
                (
                    strategy_names,
                    account_label,
                    account_label,
                    window_start,
                    window_end,
                    *order_event_symbol_params,
                ),
            )
            order_lifecycle_rows = [
                _order_lifecycle_query_row(row)
                for row in cur.fetchall()
                if _order_lifecycle_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics[
                    "order_lifecycle_rows_before_lineage_filter"
                ] = len(order_lifecycle_rows)
                source_activity_diagnostics[
                    "fill_order_lifecycle_rows_before_lineage_filter"
                ] = sum(
                    1
                    for row in order_lifecycle_rows
                    if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
                )
            order_lifecycle_rows = [
                row
                for row in order_lifecycle_rows
                if _source_row_matches_lineage(
                    row,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    require_source_lineage=require_source_lineage,
                )
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics[
                    "order_lifecycle_rows_after_lineage_filter"
                ] = len(order_lifecycle_rows)
                source_activity_diagnostics[
                    "fill_order_lifecycle_rows_after_lineage_filter"
                ] = sum(
                    1
                    for row in order_lifecycle_rows
                    if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
                )
            order_lifecycle_rows = _attach_source_lineage_context(
                order_lifecycle_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            if allow_authoritative_runtime_ledger_materialization:
                cur.execute(
                    f"""
                    select
                        d.id,
                        d.created_at,
                        d.symbol,
                        d.alpaca_account_label,
                        s.name,
                        d.decision_hash,
                        d.decision_json
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
                        carry_in_window_start,
                        window_start,
                        *decision_symbol_params,
                    ),
                )
                carry_in_decision_lifecycle_rows = [
                    _decision_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _decision_lifecycle_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_decision_rows_before_lineage_filter"
                    ] = len(carry_in_decision_lifecycle_rows)
                carry_in_decision_lifecycle_rows = [
                    row
                    for row in carry_in_decision_lifecycle_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_decision_rows_after_lineage_filter"
                    ] = len(carry_in_decision_lifecycle_rows)
                carry_in_decision_lifecycle_rows = _attach_source_lineage_context(
                    carry_in_decision_lifecycle_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
                cur.execute(
                    f"""
                    select
                        e.id,
                        d.id,
                        d.created_at,
                        coalesce(
                            e.order_feed_last_event_ts,
                            e.last_update_at,
                            e.updated_at,
                            e.created_at
                        ) as execution_event_at,
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
                        d.decision_json,
                        e.alpaca_order_id,
                        e.client_order_id,
                        e.status
                    from executions e
                    join trade_decisions d on d.id = e.trade_decision_id
                    join strategies s on s.id = d.strategy_id
                    left join execution_tca_metrics t on t.execution_id = e.id
                    where s.name = any(%s)
                      and d.alpaca_account_label = %s
                      and e.alpaca_account_label = %s
                      and coalesce(
                            e.order_feed_last_event_ts,
                            e.last_update_at,
                            e.updated_at,
                            e.created_at
                          ) >= %s
                      and coalesce(
                            e.order_feed_last_event_ts,
                            e.last_update_at,
                            e.updated_at,
                            e.created_at
                          ) < %s
                      {execution_symbol_clause}
                    order by coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                    )
                    """,
                    (
                        strategy_names,
                        account_label,
                        account_label,
                        carry_in_window_start,
                        window_start,
                        *execution_symbol_params,
                    ),
                )
                carry_in_execution_rows = [
                    _execution_query_row(row)
                    for row in cur.fetchall()
                    if _execution_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_execution_rows_before_lineage_filter"
                    ] = len(carry_in_execution_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_execution_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_row_has_fill(row)
                    )
                carry_in_execution_rows = [
                    row
                    for row in carry_in_execution_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_execution_rows_after_lineage_filter"
                    ] = len(carry_in_execution_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_execution_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_row_has_fill(row)
                    )
                carry_in_execution_rows = _attach_source_lineage_context(
                    carry_in_execution_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
                cur.execute(
                    f"""
                    select
                        oe.id,
                        coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
                        e.id,
                        coalesce(oe.event_ts, oe.created_at),
                        oe.symbol,
                        oe.alpaca_account_label,
                        s.name,
                        d.decision_hash,
                        d.decision_json,
                        oe.alpaca_order_id,
                        oe.client_order_id,
                        oe.event_type,
                        oe.status,
                        e.side,
                        oe.qty,
                        oe.filled_qty,
                        oe.filled_qty_delta,
                        oe.avg_fill_price,
                        oe.filled_notional_delta,
                        oe.fill_quantity_basis,
                        oe.event_fingerprint,
                        oe.source_topic,
                        oe.source_partition,
                        oe.source_offset,
                        oe.source_window_id,
                        oe.raw_event,
                        e.execution_audit_json,
                        e.raw_order,
                        sw.status,
                        sw.status_reason,
                        sw.consumed_count,
                        sw.inserted_count,
                        sw.duplicate_count,
                        sw.malformed_count,
                        sw.missing_payload_count,
                        sw.missing_identity_count,
                        sw.out_of_scope_account_count,
                        sw.unlinked_execution_count,
                        sw.unlinked_decision_count,
                        sw.failed_unhandled_count,
                        sw.dropped_count,
                        sw.gap_count,
                        sw.gap_ranges
                    from execution_order_events oe
                    left join order_feed_source_windows sw on sw.id = oe.source_window_id
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
                                count(*) as match_count
                            from executions e_match
                            where coalesce(e_match.alpaca_account_label, oe.alpaca_account_label)
                                  = oe.alpaca_account_label
                              and (
                                    (
                                        oe.execution_id is not null
                                        and e_match.id = oe.execution_id
                                    )
                                    or (
                                        nullif(oe.alpaca_order_id, '') is not null
                                        and e_match.alpaca_order_id = oe.alpaca_order_id
                                    )
                                    or (
                                        nullif(oe.client_order_id, '') is not null
                                        and e_match.client_order_id = oe.client_order_id
                                    )
                                  )
                        ) exact_match
                        join executions matched on matched.id = exact_match.ids[1]
                        where exact_match.match_count = 1
                    ) e on true
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
                                count(*) as match_count
                            from trade_decisions d_match
                            where d_match.alpaca_account_label = oe.alpaca_account_label
                              and nullif(oe.client_order_id, '') is not null
                              and d_match.decision_hash = oe.client_order_id
                        ) exact_decision_match
                        join trade_decisions matched on matched.id = exact_decision_match.ids[1]
                        where exact_decision_match.match_count = 1
                    ) d_by_client on true
                    join trade_decisions d
                      on d.id = coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id)
                    join strategies s on s.id = d.strategy_id
                    where s.name = any(%s)
                      and d.alpaca_account_label = %s
                      and oe.alpaca_account_label = %s
                      and coalesce(oe.event_ts, oe.created_at) >= %s
                      and coalesce(oe.event_ts, oe.created_at) < %s
                      {order_event_symbol_clause}
                    order by coalesce(oe.event_ts, oe.created_at), oe.created_at
                    """,
                    (
                        strategy_names,
                        account_label,
                        account_label,
                        carry_in_window_start,
                        window_start,
                        *order_event_symbol_params,
                    ),
                )
                carry_in_order_lifecycle_rows = [
                    _order_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _order_lifecycle_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_order_lifecycle_rows_before_lineage_filter"
                    ] = len(carry_in_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_order_lifecycle_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_order_lifecycle_rows
                        if _runtime_ledger_event_type(row)
                        in _RUNTIME_LEDGER_FILL_EVENTS
                    )
                carry_in_order_lifecycle_rows = [
                    row
                    for row in carry_in_order_lifecycle_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_order_lifecycle_rows_after_lineage_filter"
                    ] = len(carry_in_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_order_lifecycle_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_order_lifecycle_rows
                        if _runtime_ledger_event_type(row)
                        in _RUNTIME_LEDGER_FILL_EVENTS
                    )
                carry_in_order_lifecycle_rows = _attach_source_lineage_context(
                    carry_in_order_lifecycle_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
            if symbol_filter:
                cur.execute(
                    f"""
                    select
                        oe.id,
                        coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
                        e.id,
                        coalesce(oe.event_ts, oe.created_at),
                        oe.symbol,
                        oe.alpaca_account_label,
                        null,
                        null,
                        null,
                        oe.alpaca_order_id,
                        oe.client_order_id,
                        oe.event_type,
                        oe.status,
                        e.side,
                        oe.qty,
                        oe.filled_qty,
                        oe.filled_qty_delta,
                        oe.avg_fill_price,
                        oe.filled_notional_delta,
                        oe.fill_quantity_basis,
                        oe.event_fingerprint,
                        oe.source_topic,
                        oe.source_partition,
                        oe.source_offset,
                        oe.source_window_id,
                        oe.raw_event,
                        e.execution_audit_json,
                        e.raw_order,
                        sw.status,
                        sw.status_reason,
                        sw.consumed_count,
                        sw.inserted_count,
                        sw.duplicate_count,
                        sw.malformed_count,
                        sw.missing_payload_count,
                        sw.missing_identity_count,
                        sw.out_of_scope_account_count,
                        sw.unlinked_execution_count,
                        sw.unlinked_decision_count,
                        sw.failed_unhandled_count,
                        sw.dropped_count,
                        sw.gap_count,
                        sw.gap_ranges
                    from execution_order_events oe
                    left join order_feed_source_windows sw on sw.id = oe.source_window_id
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
                                count(*) as match_count
                            from executions e_match
                            where coalesce(e_match.alpaca_account_label, oe.alpaca_account_label)
                                  = oe.alpaca_account_label
                              and (
                                    (
                                        oe.execution_id is not null
                                        and e_match.id = oe.execution_id
                                    )
                                    or (
                                        nullif(oe.alpaca_order_id, '') is not null
                                        and e_match.alpaca_order_id = oe.alpaca_order_id
                                    )
                                    or (
                                        nullif(oe.client_order_id, '') is not null
                                        and e_match.client_order_id = oe.client_order_id
                                    )
                                  )
                        ) exact_match
                        join executions matched on matched.id = exact_match.ids[1]
                        where exact_match.match_count = 1
                    ) e on true
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
                                count(*) as match_count
                            from trade_decisions d_match
                            where d_match.alpaca_account_label = oe.alpaca_account_label
                              and nullif(oe.client_order_id, '') is not null
                              and d_match.decision_hash = oe.client_order_id
                        ) exact_decision_match
                        join trade_decisions matched on matched.id = exact_decision_match.ids[1]
                        where exact_decision_match.match_count = 1
                    ) d_by_client on true
                    where oe.alpaca_account_label = %s
                      and coalesce(oe.event_ts, oe.created_at) >= %s
                      and coalesce(oe.event_ts, oe.created_at) < %s
                      and (
                            e.id is null
                            or coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id) is null
                          )
                      and (
                            lower(coalesce(oe.event_type, oe.status, '')) in (
                                'fill', 'filled', 'partial_fill', 'partially_filled'
                            )
                            or coalesce(oe.filled_qty, 0) > 0
                          )
                      {unlinked_order_event_symbol_clause}
                    order by coalesce(oe.event_ts, oe.created_at), oe.created_at
                    """,
                    (
                        account_label,
                        window_start,
                        window_end,
                        *([symbol_filter] if symbol_filter else []),
                    ),
                )
                unlinked_order_lifecycle_rows = [
                    _order_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _order_lifecycle_query_row_has_time(row)
                ]
                strategy_unlinked_order_lifecycle_rows = (
                    _strategy_relevant_unlinked_fill_lifecycle_rows(
                        execution_rows=execution_rows,
                        order_lifecycle_rows=order_lifecycle_rows,
                        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                    )
                )
                strategy_unlinked_ids = set(
                    _source_identifier_values(
                        strategy_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                )
                unattributed_unlinked_order_lifecycle_rows = [
                    row
                    for row in unlinked_order_lifecycle_rows
                    if not (
                        set(
                            _source_identifier_values(
                                [row],
                                "execution_order_event_id",
                                "event_fingerprint",
                            )
                        )
                        & strategy_unlinked_ids
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "order_feed_unlinked_fill_lifecycle_count"
                    ] = len(unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unlinked_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                    source_activity_diagnostics[
                        "order_feed_unlinked_strategy_fill_lifecycle_count"
                    ] = len(strategy_unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unlinked_strategy_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        strategy_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                    source_activity_diagnostics[
                        "order_feed_unattributed_fill_lifecycle_count"
                    ] = len(unattributed_unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unattributed_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        unattributed_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                unlinked_order_lifecycle_rows = strategy_unlinked_order_lifecycle_rows
            cur.execute(
                f"""
                select
                    coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                    ) as execution_event_at,
                    t.computed_at as tca_computed_at,
                    abs(coalesce(t.realized_shortfall_bps, t.slippage_bps)) as abs_slippage_bps,
                    (-coalesce(t.realized_shortfall_bps, t.slippage_bps)) as post_cost_expectancy_bps,
                    d.decision_hash,
                    d.decision_json
                from execution_tca_metrics t
                join executions e on e.id = t.execution_id
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and coalesce(t.alpaca_account_label, e.alpaca_account_label, d.alpaca_account_label) = %s
                  and coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                      ) >= %s
                  and coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                      ) < %s
                  {execution_symbol_clause}
                order by coalesce(
                    e.order_feed_last_event_ts,
                    e.last_update_at,
                    e.updated_at,
                    e.created_at
                )
                """,
                (
                    strategy_names,
                    account_label,
                    account_label,
                    window_start,
                    window_end,
                    *execution_symbol_params,
                ),
            )
            tca_rows = [
                {
                    "computed_at": row[0],
                    "tca_computed_at": row[1],
                    "abs_slippage_bps": row[2] or Decimal("0"),
                    "post_cost_expectancy_bps": row[3] or Decimal("0"),
                    "decision_hash": row[4],
                    "decision_json": row[5],
                    "post_cost_expectancy_basis": POST_COST_BASIS_TCA_PROXY,
                    "post_cost_promotion_eligible": False,
                }
                for row in cur.fetchall()
                if row[0] is not None
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["tca_rows_before_lineage_filter"] = len(
                    tca_rows
                )
            tca_rows = [
                row
                for row in tca_rows
                if _source_row_matches_lineage(
                    row,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    require_source_lineage=require_source_lineage,
                )
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["tca_rows_after_lineage_filter"] = len(
                    tca_rows
                )
                lifecycle_blockers = _order_feed_fill_lifecycle_blockers(
                    execution_rows=execution_rows,
                    order_lifecycle_rows=order_lifecycle_rows,
                    unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
                )
                source_activity_diagnostics["order_feed_fill_lifecycle_blockers"] = (
                    lifecycle_blockers
                )
    decision_lifecycle_rows = _retarget_source_rows_for_materialization(
        decision_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    execution_rows = _retarget_source_rows_for_materialization(
        execution_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    order_lifecycle_rows = _retarget_source_rows_for_materialization(
        order_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_decision_lifecycle_rows = _retarget_source_rows_for_materialization(
        carry_in_decision_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_execution_rows = _retarget_source_rows_for_materialization(
        carry_in_execution_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_order_lifecycle_rows = _retarget_source_rows_for_materialization(
        carry_in_order_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    tca_rows = _retarget_runtime_ledger_tca_rows(
        tca_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    tca_rows.extend(
        _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
            allow_authoritative_runtime_ledger_materialization=(
                allow_authoritative_runtime_ledger_materialization
            ),
        )
    )
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
    source_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
    source_manifest_ref: str,
    source_kind: str,
    dataset_snapshot_ref: str | None,
    source_activity_symbols: Sequence[str] | None = None,
    target_metadata: Mapping[str, Any] | None = None,
    proof_hygiene_blockers: Sequence[str] = (),
    source_activity_diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = _as_mapping(target_metadata)
    symbol_filter = _metadata_symbol_list(source_activity_symbols or ())
    diagnostics = _as_mapping(source_activity_diagnostics)
    diagnostic_blockers = _source_activity_diagnostics_blockers(diagnostics)
    blocker = {
        "blocker": "runtime_window_source_activity_missing",
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_name": strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": account_label,
        "source_account_label": source_account_label or account_label,
        "source_activity_symbol_filter": symbol_filter,
        "diagnostic_blockers": diagnostic_blockers,
        "source_activity_diagnostics": diagnostics,
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
        "promotion_blocking_reasons": list(
            dict.fromkeys(
                [
                    "runtime_window_source_activity_missing",
                    *diagnostic_blockers,
                ]
            )
        ),
        "source_activity_diagnostics": diagnostics,
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
            "source_account_label": source_account_label or account_label,
            "source_activity_symbol_filter": symbol_filter,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "target_metadata": metadata,
            "source_activity_diagnostics": diagnostics,
            "source_activity_diagnostic_blockers": diagnostic_blockers,
            "skip_reason": "runtime_window_source_activity_missing",
        },
    }


def main() -> int:
    args = _parse_args()
    source_dsn = args.source_dsn.strip() or os.getenv(args.source_dsn_env, "").strip()
    source_account_label = (
        str(getattr(args, "source_account_label", "") or "").strip()
        or args.account_label
    )
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
    target_metadata = _parse_target_metadata(
        str(getattr(args, "target_metadata_json", "") or "")
    )
    strategy_names = _strategy_name_candidates(
        args.strategy_name,
        _text_or_none(target_metadata.get("runtime_strategy_name")),
        _text_or_none(target_metadata.get("strategy_name")),
        *_metadata_text_list(target_metadata.get("strategy_lookup_names")),
        getattr(manifest, "strategy_id", None),
    )
    source_activity_symbols = _target_metadata_source_symbols(target_metadata)
    source_kind = args.source_kind.strip() or (
        "simulation_paper_runtime" if args.observed_stage == "paper" else "live_runtime"
    )
    allow_authoritative_runtime_ledger_materialization = (
        _source_kind_allows_runtime_ledger_materialization(
            source_kind=source_kind,
            target_metadata=target_metadata,
        )
    )
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    source_activity_diagnostics: dict[str, Any] = {
        "strategy_name_candidates": strategy_names,
        "account_label": args.account_label,
        "source_account_label": source_account_label,
        "source_dsn_env": str(getattr(args, "source_dsn_env", "") or "").strip(),
        "target_dsn_env": str(getattr(args, "target_dsn_env", "") or "").strip(),
        "target_dsn_configured": bool(_target_persistence_dsn(args)),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "source_activity_symbol_filter": source_activity_symbols,
        "candidate_id": args.candidate_id.strip() or None,
        "hypothesis_id": args.hypothesis_id,
        "source_kind": source_kind,
    }
    if source_dsn:
        decisions, executions, tca_rows = _query_timestamps(
            dsn=source_dsn,
            strategy_names=strategy_names,
            account_label=source_account_label,
            target_account_label=args.account_label,
            window_start=window_start,
            window_end=window_end,
            symbols=source_activity_symbols,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            require_source_lineage=allow_authoritative_runtime_ledger_materialization,
            allow_authoritative_runtime_ledger_materialization=(
                allow_authoritative_runtime_ledger_materialization
            ),
            source_activity_diagnostics=source_activity_diagnostics,
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
                account_label=source_account_label,
                target_account_label=args.account_label,
                window_start=window_start,
                window_end=window_end,
            )
        )
        tca_rows.extend(source_runtime_ledger_tca_rows)
        source_activity_diagnostics.update(runtime_ledger_source_metadata)
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
        with _persistence_session(args) as session:
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
            source_account_label=source_account_label,
            window_start=window_start,
            window_end=window_end,
            source_manifest_ref=args.source_manifest_ref.strip(),
            source_kind=args.source_kind.strip(),
            dataset_snapshot_ref=dataset_snapshot_ref,
            source_activity_symbols=source_activity_symbols,
            target_metadata=target_metadata,
            proof_hygiene_blockers=runtime_ledger_target_metadata_blockers,
            source_activity_diagnostics={
                **source_activity_diagnostics,
                **runtime_ledger_artifact_metadata,
                **runtime_ledger_durable_metadata,
                **runtime_ledger_source_metadata,
            },
        )
        if getattr(args, "audit_only", False):
            summary = {**summary, "audit_only": True, "would_persist": False}
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
        **_runtime_ledger_tca_materialization_metadata(tca_rows),
        "observed_stage": args.observed_stage,
        "evidence_provenance": evidence_provenance,
        "source_kind": source_kind,
        "source_manifest_ref": args.source_manifest_ref.strip() or None,
        "strategy_name": args.strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": args.account_label,
        "source_account_label": source_account_label,
        "source_activity_symbol_filter": source_activity_symbols,
        "source_activity_diagnostics": {
            **source_activity_diagnostics,
            **runtime_ledger_artifact_metadata,
            **runtime_ledger_durable_metadata,
            **runtime_ledger_source_metadata,
        },
        "source_activity_diagnostic_blockers": _source_activity_diagnostics_blockers(
            {
                **source_activity_diagnostics,
                **runtime_ledger_artifact_metadata,
                **runtime_ledger_durable_metadata,
                **runtime_ledger_source_metadata,
            }
        ),
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
    if getattr(args, "audit_only", False):
        summary = _runtime_window_import_audit_summary(
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_name=args.strategy_name,
            strategy_names=strategy_names,
            account_label=args.account_label,
            source_account_label=source_account_label,
            window_start=window_start,
            window_end=window_end,
            source_kind=source_kind,
            source_manifest_ref=args.source_manifest_ref.strip() or None,
            dataset_snapshot_ref=dataset_snapshot_ref,
            decisions=decisions,
            executions=executions,
            tca_rows=tca_rows,
            buckets=buckets,
            runtime_observation_payload=runtime_observation_payload,
            runtime_ledger_target_metadata_blockers=runtime_ledger_target_metadata_blockers,
        )
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(summary)
        return 0
    with _persistence_session(args) as session:
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
