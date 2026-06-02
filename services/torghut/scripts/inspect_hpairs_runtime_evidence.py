#!/usr/bin/env python
"""Read-only H-PAIRS runtime/live-paper evidence census.

The command measures durable runtime DB rows and optional status-service state for
H-PAIRS without submitting orders, uploading proof packets, or mutating the DB.
It deliberately separates configuration, route/submission evidence,
runtime-ledger source authority, and final profitability proof so blockers are
reported as machine-readable facts rather than collapsed into one green status.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import cast

from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.db import SessionLocal
from app.trading.runtime_authority_verifier import (
    AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
    AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_BLOCKER,
    AUTHORITY_MEAN_PNL_BLOCKER,
    AUTHORITY_MEDIAN_PNL_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_P10_PNL_BLOCKER,
    AUTHORITY_READ_ERROR_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    AUTHORITY_TRADING_DAYS_BLOCKER,
    AUTHORITY_WORST_DAY_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
)
from app.trading.runtime_ledger_source_authority import (
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
)
from scripts import audit_hpairs_source_proof_census as source_census

SCHEMA_VERSION = "torghut.hpairs-runtime-live-paper-evidence-census.v1"
SUBMITTED_ORDERS_MISSING_BLOCKER = source_census.SUBMITTED_ORDERS_MISSING_BLOCKER
STATUS_SERVICE_NOT_PROVIDED_BLOCKER = "status_service_not_provided"
STATUS_SERVICE_READ_ERROR_BLOCKER = "status_service_read_error"
CONFIGURED_CANDIDATE_MISSING_BLOCKER = "configured_candidate_missing"
CONFIGURED_CANDIDATE_MISMATCH_BLOCKER = "configured_candidate_mismatch"
AGGREGATE_ONLY_RUNTIME_LEDGER_BLOCKER = (
    "runtime_ledger_aggregate_only_buckets_not_authority"
)
RUNTIME_LEDGER_BUCKETS_MISSING_BLOCKER = AUTHORITY_EVIDENCE_MISSING_BLOCKER

_ROUTE_BLOCKERS = frozenset(
    {
        AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
        AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
        SUBMITTED_ORDERS_MISSING_BLOCKER,
        ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    }
)
_SOURCE_AUTHORITY_BLOCKERS = frozenset(
    {
        AUTHORITY_EVIDENCE_MISSING_BLOCKER,
        AUTHORITY_READ_ERROR_BLOCKER,
        RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
        AGGREGATE_ONLY_RUNTIME_LEDGER_BLOCKER,
    }
)
_FINAL_PROOF_BLOCKERS = frozenset(
    {
        AUTHORITY_TRADING_DAYS_BLOCKER,
        AUTHORITY_MEAN_PNL_BLOCKER,
        AUTHORITY_MEDIAN_PNL_BLOCKER,
        AUTHORITY_P10_PNL_BLOCKER,
        AUTHORITY_WORST_DAY_BLOCKER,
        AUTHORITY_FILLED_NOTIONAL_BLOCKER,
        AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
        AUTHORITY_OPEN_POSITIONS_BLOCKER,
        AUTHORITY_EXPLICIT_COSTS_BLOCKER,
        AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    }
)
_ROUTE_FLAG_KEYS = (
    "route_enabled",
    "route_eligible",
    "paper_route_enabled",
    "paper_route_eligible",
    "order_route_enabled",
    "order_route_eligible",
    "submit_enabled",
    "simple_submit_enabled",
    "trading_simple_submit_enabled",
)


@dataclass(frozen=True)
class RuntimeEvidenceIdentity:
    hypothesis_id: str
    candidate_id: str
    runtime_strategy_name: str
    account_label: str
    observed_stage: str | None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--dsn", help="SQLAlchemy DSN to read with one bounded read-only session"
    )
    source.add_argument(
        "--fixture-json",
        type=Path,
        help="Fixture JSON containing source row arrays for tests",
    )
    parser.add_argument("--hypothesis-id", default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument("--candidate-id", default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument(
        "--runtime-strategy-name", default=DEFAULT_HPAIRS_RUNTIME_STRATEGY
    )
    parser.add_argument("--account-label", default=DEFAULT_HPAIRS_ACCOUNT_LABEL)
    parser.add_argument("--observed-stage", default="paper")
    parser.add_argument("--start", dest="started_at")
    parser.add_argument("--end", dest="ended_at")
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit stable JSON (the default and only output format)",
    )
    parser.add_argument(
        "--output-json", type=Path, help="write JSON to this path instead of stdout"
    )
    parser.add_argument(
        "--status-service-url",
        help="optional bounded HTTP GET for live service/config status JSON",
    )
    parser.add_argument(
        "--status-fixture-json",
        type=Path,
        help="fixture JSON for status-service payloads; intended for tests and local dry-runs",
    )
    parser.add_argument("--status-timeout-seconds", type=float, default=5.0)
    return parser.parse_args(argv)


def stable_json(report: Mapping[str, object]) -> str:
    return json.dumps(report, default=_json_default, indent=2, sort_keys=True) + "\n"


def build_runtime_evidence_census(
    rows: source_census.CensusSourceRows,
    *,
    identity: RuntimeEvidenceIdentity,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
    source_kind: str = "fixture_json",
    read_error: str | None = None,
    status_payload: Mapping[str, object] | None = None,
    status_source: str | None = None,
    status_read_error: str | None = None,
) -> dict[str, object]:
    source_report = source_census.build_source_proof_census(
        rows,
        identity=source_census.CensusIdentity(
            hypothesis_id=identity.hypothesis_id,
            candidate_id=identity.candidate_id,
            runtime_strategy_name=identity.runtime_strategy_name,
            account_label=identity.account_label,
            observed_stage=identity.observed_stage,
        ),
        started_at=started_at,
        ended_at=ended_at,
        read_error=read_error,
        source_kind=source_kind,
    )
    totals = _mapping(source_report.get("totals"))
    runtime_authority = _mapping(source_report.get("runtime_authority"))
    runtime_aggregate = _mapping(runtime_authority.get("aggregate"))
    daily_rows = _daily_rows(source_report)
    identifier_counts = _identifier_counts(rows, runtime_authority)
    aggregate_summary = _aggregate_summary(
        totals,
        runtime_aggregate,
        identifier_counts=identifier_counts,
    )
    all_source_blockers = _text_list(source_report.get("blockers"))
    status = status_payload or {}
    configured = _configured_candidate_truth(
        status,
        totals=totals,
        identity=identity,
        status_source=status_source,
        status_read_error=status_read_error,
    )
    routeability = _routeability_truth(
        status,
        totals=totals,
        blockers=all_source_blockers,
        identifier_counts=identifier_counts,
    )
    source_authority = _source_authority_truth(
        totals,
        runtime_authority=runtime_authority,
        blockers=all_source_blockers,
        identifier_counts=identifier_counts,
    )
    final_proof = _final_profitability_truth(runtime_authority, runtime_aggregate)
    blockers = _top_level_blockers(
        configured=configured,
        routeability=routeability,
        source_authority=source_authority,
        final_proof=final_proof,
        source_blockers=all_source_blockers,
    )
    aggregate_summary["blockers"] = blockers
    return {
        "schema_version": SCHEMA_VERSION,
        "read_only": True,
        "writes_performed": False,
        "submits_orders": False,
        "uploads_proof_packets": False,
        "mutates_database": False,
        "profitability_claimed": False,
        "identity": {
            "hypothesis_id": identity.hypothesis_id,
            "candidate_id": identity.candidate_id,
            "runtime_strategy_name": identity.runtime_strategy_name,
            "account_label": identity.account_label,
            "observed_stage": identity.observed_stage,
        },
        "window": {
            "started_at": _isoformat(started_at) if started_at is not None else None,
            "ended_at": _isoformat(ended_at) if ended_at is not None else None,
        },
        "sources": {
            "runtime_db": {
                "kind": source_kind,
                "read_only": True,
                "read_error": read_error,
            },
            "status_service": {
                "source": status_source,
                "provided": bool(status_source),
                "read_error": status_read_error,
            },
        },
        "truths": {
            "merged_configured_candidate": configured,
            "routeability_submission_evidence": routeability,
            "runtime_ledger_source_authority_evidence": source_authority,
            "final_500_day_profitability_proof": final_proof,
        },
        "aggregate_summary": aggregate_summary,
        "daily_rows": daily_rows,
        "blockers": blockers,
        "upstream_source_proof_census": {
            "schema_version": source_report.get("schema_version"),
            "verdict": source_report.get("verdict"),
            "blocker_ladder": source_report.get("blocker_ladder"),
        },
    }


def load_dsn_rows(
    dsn: str,
    *,
    identity: RuntimeEvidenceIdentity,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> source_census.CensusSourceRows:
    engine = create_engine(dsn)
    session_factory = sessionmaker(bind=engine)
    with session_factory() as session:
        return source_census._load_session_rows(  # noqa: SLF001 - existing script helper is the repo's bounded reader.
            cast(Session, session),
            identity=source_census.CensusIdentity(
                hypothesis_id=identity.hypothesis_id,
                candidate_id=identity.candidate_id,
                runtime_strategy_name=identity.runtime_strategy_name,
                account_label=identity.account_label,
                observed_stage=identity.observed_stage,
            ),
            started_at=started_at,
            ended_at=ended_at,
        )


def load_default_session_rows(
    *,
    identity: RuntimeEvidenceIdentity,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> source_census.CensusSourceRows:
    with SessionLocal() as session:
        return source_census._load_session_rows(  # noqa: SLF001 - existing script helper is the repo's bounded reader.
            cast(Session, session),
            identity=source_census.CensusIdentity(
                hypothesis_id=identity.hypothesis_id,
                candidate_id=identity.candidate_id,
                runtime_strategy_name=identity.runtime_strategy_name,
                account_label=identity.account_label,
                observed_stage=identity.observed_stage,
            ),
            started_at=started_at,
            ended_at=ended_at,
        )


def load_status_payload(
    *,
    status_fixture_json: Path | None,
    status_service_url: str | None,
    timeout_seconds: float,
) -> tuple[Mapping[str, object], str | None, str | None]:
    if status_fixture_json is not None:
        loaded = json.loads(status_fixture_json.read_text())
        if not isinstance(loaded, Mapping):
            return (
                {},
                f"fixture_json:{status_fixture_json}",
                "status_fixture_json_not_object",
            )
        return (
            cast(Mapping[str, object], loaded),
            f"fixture_json:{status_fixture_json}",
            None,
        )
    if status_service_url is None:
        return {}, None, None
    try:
        request = urllib.request.Request(status_service_url, method="GET")
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - explicit read-only URL supplied by operator.
            loaded = json.loads(response.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError, urllib.error.URLError) as exc:
        return {}, status_service_url, str(exc)
    if not isinstance(loaded, Mapping):
        return {}, status_service_url, "status_service_payload_not_object"
    return cast(Mapping[str, object], loaded), status_service_url, None


def _configured_candidate_truth(
    status_payload: Mapping[str, object],
    *,
    totals: Mapping[str, object],
    identity: RuntimeEvidenceIdentity,
    status_source: str | None,
    status_read_error: str | None,
) -> dict[str, object]:
    target = _target_from_status(status_payload, identity)
    observed_runtime_rows = any(
        _int(totals.get(key)) > 0
        for key in (
            "trade_decision_count",
            "execution_count",
            "execution_order_event_count",
            "runtime_ledger_bucket_count",
        )
    )
    blockers: list[str] = []
    if status_source is None:
        blockers.append(STATUS_SERVICE_NOT_PROVIDED_BLOCKER)
    if status_read_error is not None:
        blockers.append(STATUS_SERVICE_READ_ERROR_BLOCKER)
    if status_payload and not target:
        blockers.append(CONFIGURED_CANDIDATE_MISSING_BLOCKER)
    if target and not _target_matches(target, identity):
        blockers.append(CONFIGURED_CANDIDATE_MISMATCH_BLOCKER)
    configured_or_observed = (
        bool(target and _target_matches(target, identity)) or observed_runtime_rows
    )
    return {
        "configured_or_observed": configured_or_observed,
        "status_service_target_found": bool(target),
        "observed_in_runtime_rows": observed_runtime_rows,
        "expected": {
            "hypothesis_id": identity.hypothesis_id,
            "candidate_id": identity.candidate_id,
            "runtime_strategy_name": identity.runtime_strategy_name,
            "account_label": identity.account_label,
        },
        "matched_status_target": dict(target) if target else None,
        "blockers": sorted(dict.fromkeys(blockers)),
    }


def _routeability_truth(
    status_payload: Mapping[str, object],
    *,
    totals: Mapping[str, object],
    blockers: Sequence[str],
    identifier_counts: Mapping[str, int],
) -> dict[str, object]:
    route_flags = _route_flags(status_payload)
    disabled_flags = [key for key, value in route_flags.items() if value is False]
    route_blockers = [code for code in blockers if code in _ROUTE_BLOCKERS]
    if disabled_flags:
        route_blockers.append("routeability_flags_disabled")
    return {
        "source_backed_decisions_present": _int(totals.get("trade_decision_count")) > 0,
        "submitted_order_lifecycle_present": _int(
            totals.get("runtime_submitted_order_count")
        )
        > 0,
        "fill_lifecycle_present": _int(totals.get("fill_lifecycle_event_count")) > 0,
        "executions_present": _int(totals.get("execution_count")) > 0,
        "trade_decision_ids_count": identifier_counts["trade_decision_ids_count"],
        "execution_ids_count": identifier_counts["execution_ids_count"],
        "execution_order_event_ids_count": identifier_counts[
            "execution_order_event_ids_count"
        ],
        "fill_lifecycle_count": _int(totals.get("fill_lifecycle_event_count")),
        "runtime_submitted_order_count": _int(
            totals.get("runtime_submitted_order_count")
        ),
        "route_flags": route_flags,
        "disabled_route_flags": disabled_flags,
        "blockers": sorted(dict.fromkeys(route_blockers)),
    }


def _source_authority_truth(
    totals: Mapping[str, object],
    *,
    runtime_authority: Mapping[str, object],
    blockers: Sequence[str],
    identifier_counts: Mapping[str, int],
) -> dict[str, object]:
    aggregate = _mapping(runtime_authority.get("aggregate"))
    bucket_count = _int(totals.get("runtime_ledger_bucket_count"))
    source_authority_bucket_count = _int(
        totals.get("blocker_free_runtime_ledger_bucket_count")
    )
    aggregate_only_bucket_count = max(0, bucket_count - source_authority_bucket_count)
    source_blockers = [code for code in blockers if code in _SOURCE_AUTHORITY_BLOCKERS]
    if bucket_count <= 0:
        source_blockers.append(RUNTIME_LEDGER_BUCKETS_MISSING_BLOCKER)
    if aggregate_only_bucket_count > 0:
        source_blockers.append(AGGREGATE_ONLY_RUNTIME_LEDGER_BLOCKER)
    return {
        "runtime_ledger_bucket_count": bucket_count,
        "source_authority_bucket_count": source_authority_bucket_count,
        "clean_authority_bucket_count": _int(
            aggregate.get("clean_authority_bucket_count")
        ),
        "aggregate_only_bucket_count": aggregate_only_bucket_count,
        "aggregate_only_buckets_count_as_authority": False,
        "source_window_ids_count": identifier_counts["source_window_ids_count"],
        "execution_order_event_ids_count": identifier_counts[
            "execution_order_event_ids_count"
        ],
        "execution_ids_count": identifier_counts["execution_ids_count"],
        "trade_decision_ids_count": identifier_counts["trade_decision_ids_count"],
        "runtime_ledger_source_materialization_count": _int(
            totals.get("runtime_ledger_source_materialization_count")
        ),
        "explicit_cost_runtime_ledger_bucket_count": _int(
            totals.get("explicit_cost_runtime_ledger_bucket_count")
        ),
        "blockers": sorted(dict.fromkeys(source_blockers)),
    }


def _final_profitability_truth(
    runtime_authority: Mapping[str, object], runtime_aggregate: Mapping[str, object]
) -> dict[str, object]:
    blockers = _text_list(runtime_authority.get("blockers"))
    final_blockers = [
        code
        for code in blockers
        if code in _FINAL_PROOF_BLOCKERS or code.startswith("runtime_")
    ]
    return {
        "authority_proof_passed": runtime_authority.get("final_authority_ok") is True,
        "profitability_claimed_by_census": False,
        "measurement_only": True,
        "daily_post_cost_pnl_threshold": "500",
        "trading_days": _int(
            runtime_aggregate.get("clean_authority_trading_day_count")
        ),
        "mean_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("clean_authority_mean_daily_net_pnl_after_costs"),
            default="0",
        ),
        "median_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("clean_authority_median_daily_net_pnl_after_costs"),
            default="0",
        ),
        "p10_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("clean_authority_p10_daily_net_pnl_after_costs"),
            default="0",
        ),
        "worst_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("clean_authority_worst_day_net_pnl_after_costs"),
            default="0",
        ),
        "filled_notional": _text(
            runtime_aggregate.get("clean_authority_total_filled_notional"), default="0"
        ),
        "closed_trade_count": _int(
            runtime_aggregate.get("clean_authority_closed_round_trips")
        ),
        "open_position_count": _int(runtime_aggregate.get("open_position_count")),
        "blockers": sorted(dict.fromkeys(final_blockers)),
    }


def _aggregate_summary(
    totals: Mapping[str, object],
    runtime_aggregate: Mapping[str, object],
    *,
    identifier_counts: Mapping[str, int],
) -> dict[str, object]:
    bucket_count = _int(totals.get("runtime_ledger_bucket_count"))
    explicit_bucket_count = _int(
        totals.get("explicit_cost_runtime_ledger_bucket_count")
    )
    return {
        "trading_days": _int(runtime_aggregate.get("trading_day_count")),
        "clean_authority_trading_days": _int(
            runtime_aggregate.get("clean_authority_trading_day_count")
        ),
        "mean_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("mean_daily_net_pnl_after_costs"), default="0"
        ),
        "median_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("median_daily_net_pnl_after_costs"), default="0"
        ),
        "p10_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("p10_daily_net_pnl_after_costs"), default="0"
        ),
        "worst_daily_net_pnl_after_costs": _text(
            runtime_aggregate.get("worst_day_net_pnl_after_costs"), default="0"
        ),
        "max_drawdown": runtime_aggregate.get("max_drawdown"),
        "filled_notional": _text(
            runtime_aggregate.get("total_filled_notional"), default="0"
        ),
        "closed_trade_count": _int(runtime_aggregate.get("closed_round_trips")),
        "open_position_count": _int(runtime_aggregate.get("open_position_count")),
        "source_window_ids_count": identifier_counts["source_window_ids_count"],
        "execution_order_event_ids_count": identifier_counts[
            "execution_order_event_ids_count"
        ],
        "execution_ids_count": identifier_counts["execution_ids_count"],
        "trade_decision_ids_count": identifier_counts["trade_decision_ids_count"],
        "fill_lifecycle_count": _int(totals.get("fill_lifecycle_event_count")),
        "runtime_ledger_bucket_count": bucket_count,
        "runtime_ledger_source_bucket_count": _int(
            totals.get("blocker_free_runtime_ledger_bucket_count")
        ),
        "explicit_cost_coverage": {
            "runtime_ledger_buckets_with_explicit_cost_count": explicit_bucket_count,
            "runtime_ledger_bucket_count": bucket_count,
            "coverage_ratio": _ratio_text(explicit_bucket_count, bucket_count),
        },
        "blockers": [],
    }


def _daily_rows(source_report: Mapping[str, object]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for item in _sequence(source_report.get("daily")):
        row = _mapping(item)
        rows.append(
            {
                "trading_day": _text(row.get("trading_day"), default=""),
                "net_pnl_after_costs": _text(row.get("post_cost_pnl"), default="0"),
                "filled_notional": _text(row.get("filled_notional"), default="0"),
                "closed_trade_count": _int(row.get("closed_trade_count")),
                "open_position_count": _int(row.get("open_position_count")),
                "source_window_count": _int(row.get("source_window_count")),
                "execution_order_event_count": _int(
                    row.get("execution_order_event_count")
                ),
                "execution_count": _int(row.get("execution_count")),
                "trade_decision_count": _int(row.get("trade_decision_count")),
                "fill_lifecycle_count": _int(row.get("fill_lifecycle_event_count")),
                "runtime_ledger_bucket_count": _int(
                    row.get("runtime_ledger_bucket_count")
                ),
                "explicit_cost_runtime_ledger_bucket_count": _int(
                    row.get("explicit_cost_runtime_ledger_bucket_count")
                ),
                "blockers": _text_list(row.get("blockers")),
            }
        )
    return rows


def _identifier_counts(
    rows: source_census.CensusSourceRows, runtime_authority: Mapping[str, object]
) -> dict[str, int]:
    source_window_ids = _unique_ids(
        [
            *(row.get("id") for row in rows.order_feed_source_windows),
            *(row.get("source_window_id") for row in rows.execution_order_events),
            *_ledger_payload_values(
                runtime_authority,
                "source_window_ids",
                "source_window_id",
                "runtime_ledger_source_window_ids",
            ),
        ]
    )
    execution_order_event_ids = _unique_ids(
        [
            *(row.get("id") for row in rows.execution_order_events),
            *_ledger_payload_values(
                runtime_authority,
                "execution_order_event_ids",
                "execution_order_event_id",
            ),
        ]
    )
    execution_ids = _unique_ids(
        [
            *(row.get("id") for row in rows.executions),
            *(row.get("execution_id") for row in rows.execution_order_events),
            *(row.get("execution_id") for row in rows.execution_tca_metrics),
            *_ledger_payload_values(runtime_authority, "execution_ids", "execution_id"),
        ]
    )
    trade_decision_ids = _unique_ids(
        [
            *(row.get("id") for row in rows.trade_decisions),
            *(row.get("trade_decision_id") for row in rows.executions),
            *(row.get("trade_decision_id") for row in rows.execution_order_events),
            *(row.get("trade_decision_id") for row in rows.execution_tca_metrics),
            *_ledger_payload_values(
                runtime_authority,
                "trade_decision_ids",
                "trade_decision_id",
                "decision_ids",
            ),
        ]
    )
    ledger_daily = [
        _mapping(item) for item in _sequence(runtime_authority.get("trading_days"))
    ]
    return {
        "source_window_ids_count": max(
            len(source_window_ids), _sum_int(ledger_daily, "source_window_id_count")
        ),
        "execution_order_event_ids_count": max(
            len(execution_order_event_ids),
            _sum_int(ledger_daily, "execution_order_event_ref_count"),
        ),
        "execution_ids_count": max(
            len(execution_ids), _sum_int(ledger_daily, "execution_ref_count")
        ),
        "trade_decision_ids_count": max(
            len(trade_decision_ids), _sum_int(ledger_daily, "trade_decision_ref_count")
        ),
    }


def _ledger_payload_values(
    runtime_authority: Mapping[str, object], *keys: str
) -> list[object]:
    values: list[object] = []
    # The runtime-authority daily report intentionally exposes counts and row refs, not the original payload values.
    # Source-row IDs above provide exact live DB identifiers; keep this hook for forward-compatible payloads.
    for bucket in _sequence(runtime_authority.get("runtime_ledger_buckets")):
        payload = _mapping(_mapping(bucket).get("payload"))
        for key in keys:
            values.extend(_as_values(payload.get(key)))
    return values


def _sum_int(rows: Sequence[Mapping[str, object]], key: str) -> int:
    return sum(_int(row.get(key)) for row in rows)


def _top_level_blockers(
    *,
    configured: Mapping[str, object],
    routeability: Mapping[str, object],
    source_authority: Mapping[str, object],
    final_proof: Mapping[str, object],
    source_blockers: Sequence[str],
) -> list[str]:
    blockers: list[str] = []
    blockers.extend(_text_list(configured.get("blockers")))
    blockers.extend(_text_list(routeability.get("blockers")))
    blockers.extend(_text_list(source_authority.get("blockers")))
    blockers.extend(_text_list(final_proof.get("blockers")))
    blockers.extend(source_blockers)
    return sorted(dict.fromkeys(blockers))


def _target_from_status(
    source: Mapping[str, object], identity: RuntimeEvidenceIdentity
) -> Mapping[str, object]:
    for key in (
        "target",
        "target_candidate",
        "target_candidate_identity",
        "configured_candidate",
        "hpairs_candidate",
    ):
        candidate = _mapping(source.get(key))
        if candidate:
            return candidate
    for key in (
        "targets",
        "planned_targets",
        "target_candidates",
        "configured_candidates",
    ):
        candidates = [_mapping(item) for item in _sequence(source.get(key))]
        for candidate in candidates:
            if candidate and _target_matches(candidate, identity):
                return candidate
        for candidate in candidates:
            if candidate:
                return candidate
    return {}


def _target_matches(
    candidate: Mapping[str, object], identity: RuntimeEvidenceIdentity
) -> bool:
    candidate_id = _text(
        candidate.get("candidate_id") or candidate.get("target_candidate_id")
    )
    hypothesis_id = _text(candidate.get("hypothesis_id") or candidate.get("hypothesis"))
    account_label = _text(
        candidate.get("account_label") or candidate.get("alpaca_account_label")
    )
    runtime_strategy = _text(
        candidate.get("runtime_strategy_name")
        or candidate.get("runtime_strategy")
        or candidate.get("strategy_name")
        or candidate.get("strategy")
    )
    if candidate_id is not None and candidate_id != identity.candidate_id:
        return False
    if hypothesis_id is not None and hypothesis_id != identity.hypothesis_id:
        return False
    if account_label is not None and account_label != identity.account_label:
        return False
    if (
        runtime_strategy is not None
        and runtime_strategy != identity.runtime_strategy_name
    ):
        return False
    return (
        candidate_id == identity.candidate_id or hypothesis_id == identity.hypothesis_id
    )


def _route_flags(status_payload: Mapping[str, object]) -> dict[str, bool]:
    flags: dict[str, bool] = {}
    sources = [
        status_payload,
        _mapping(status_payload.get("target")),
        _mapping(status_payload.get("route")),
        _mapping(status_payload.get("status")),
        _mapping(status_payload.get("routing")),
    ]
    for source in sources:
        for key in _ROUTE_FLAG_KEYS:
            parsed = _bool_or_none(source.get(key))
            if parsed is not None and key not in flags:
                flags[key] = parsed
    return flags


def _parse_cli_timestamp(value: str | None) -> datetime | None:
    if value is None or not value.strip():
        return None
    parsed = _parse_timestamp(value)
    if parsed is None:
        raise ValueError(f"invalid timestamp: {value}")
    return parsed


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return {
            str(key): raw for key, raw in cast(Mapping[object, object], value).items()
        }
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _as_values(value: object) -> list[object]:
    if isinstance(value, Mapping):
        return list(value.values())
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(cast(Sequence[object], value))
    if value is None:
        return []
    return [value]


def _unique_ids(values: Iterable[object]) -> set[str]:
    ids: set[str] = set()
    for value in values:
        for item in _as_values(value):
            text = _text(item)
            if text is not None:
                ids.add(text)
    return ids


def _text_list(value: object) -> list[str]:
    items = _as_values(value)
    return sorted(
        dict.fromkeys(text for item in items if (text := _text(item)) is not None)
    )


def _text(value: object, *, default: str | None = None) -> str | None:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _int(value: object) -> int:
    try:
        return int(str(value if value is not None else "0"))
    except (TypeError, ValueError):
        return 0


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")
    return parsed if parsed.is_finite() else Decimal("0")


def _ratio_text(numerator: int, denominator: int) -> str:
    if denominator <= 0:
        return "0"
    return _decimal_text(Decimal(numerator) / Decimal(denominator))


def _decimal_text(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _bool_or_none(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "y", "enabled", "ready", "ok"}:
            return True
        if normalized in {"0", "false", "f", "no", "n", "disabled", "blocked"}:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    return None


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _json_default(value: object) -> str:
    if isinstance(value, Decimal):
        return _decimal_text(value)
    if isinstance(value, datetime):
        return _isoformat(value)
    return str(value)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    started_at = _parse_cli_timestamp(args.started_at)
    ended_at = _parse_cli_timestamp(args.ended_at)
    identity = RuntimeEvidenceIdentity(
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        runtime_strategy_name=args.runtime_strategy_name,
        account_label=args.account_label,
        observed_stage=args.observed_stage,
    )
    read_error = None
    try:
        if args.fixture_json is not None:
            rows = source_census.load_fixture_rows(args.fixture_json)
            source_kind = "fixture_json"
        elif args.dsn:
            rows = load_dsn_rows(
                args.dsn, identity=identity, started_at=started_at, ended_at=ended_at
            )
            source_kind = "sqlalchemy_dsn"
        else:
            rows = load_default_session_rows(
                identity=identity, started_at=started_at, ended_at=ended_at
            )
            source_kind = "app_db_session"
    except (SQLAlchemyError, OSError, ValueError) as exc:
        rows = source_census.CensusSourceRows()
        read_error = str(exc)
        source_kind = (
            "fixture_json"
            if args.fixture_json is not None
            else "sqlalchemy_dsn"
            if args.dsn
            else "app_db_session"
        )
    status_payload, status_source, status_read_error = load_status_payload(
        status_fixture_json=args.status_fixture_json,
        status_service_url=args.status_service_url,
        timeout_seconds=args.status_timeout_seconds,
    )
    report = build_runtime_evidence_census(
        rows,
        identity=identity,
        started_at=started_at,
        ended_at=ended_at,
        source_kind=source_kind,
        read_error=read_error,
        status_payload=status_payload,
        status_source=status_source,
        status_read_error=status_read_error,
    )
    payload = stable_json(report)
    if args.output_json is not None:
        args.output_json.write_text(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
