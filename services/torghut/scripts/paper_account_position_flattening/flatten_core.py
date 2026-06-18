#!/usr/bin/env python3
"""Flatten the Torghut paper account so runtime proof windows start clean."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db import SessionLocal

DEFAULT_ACCOUNT_LABEL = "TORGHUT_SIM"

DEFAULT_PAPER_BASE_URL = "https://paper-api.alpaca.markets"

DEFAULT_MAX_GROSS_MARKET_VALUE = Decimal("1000000")

DEFAULT_MAX_POSITION_COUNT = 25

DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS = Decimal("200")

DEFAULT_WAIT_FLAT_SECONDS = 0.0

DEFAULT_POLL_SECONDS = 5.0

TERMINAL_CLEAN_STATUSES = frozenset({"clean", "dry_run", "submitted", "flattened"})

FLATTEN_CLEANUP_STRATEGY_NAME = "paper-account-flatten-runtime-cleanup"

FLATTEN_CLOSE_DECISION_SCHEMA_VERSION = (
    "torghut.paper-account-flatten-close-decision.v1"
)

LINEAGE_LINKED_STATUS = "linked_source_lineage"

LINEAGE_UNLINKED_STATUS = "unlinked_no_source_lineage"

LINEAGE_PERSIST_FAILED_STATUS = "lineage_persist_failed"

TARGET_PLAN_READBACK_SCHEMA_VERSION = (
    "torghut.paper-account-flatten-target-plan-readback.v1"
)


class PaperFlattenClient(Protocol):
    def list_positions(self) -> list[dict[str, Any]] | None: ...

    def cancel_all_orders(self) -> list[dict[str, Any]]: ...

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


@dataclass(frozen=True)
class FlattenPosition:
    symbol: str
    qty: Decimal
    side: str
    market_value: Decimal
    reference_price: Decimal | None

    @property
    def close_side(self) -> str:
        return "buy" if self.side == "short" or self.qty < 0 else "sell"

    @property
    def close_qty(self) -> Decimal:
        return abs(self.qty)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Cancel paper open orders and submit opposing market orders for open "
            "paper positions. Defaults to dry-run and refuses live/non-TORGHUT_SIM use."
        ),
    )
    parser.add_argument("--account-label", default=settings.trading_account_label)
    parser.add_argument("--expected-account-label", default=DEFAULT_ACCOUNT_LABEL)
    parser.add_argument("--trading-mode", default=settings.trading_mode)
    parser.add_argument(
        "--paper-base-url",
        default=DEFAULT_PAPER_BASE_URL,
        help="Alpaca paper endpoint to use; kept explicit to avoid inheriting live URLs.",
    )
    parser.add_argument(
        "--database-dsn-env",
        default="DB_DSN",
        help=(
            "Environment variable containing the database DSN for persisted "
            "flatten lineage and position snapshots. Defaults to DB_DSN."
        ),
    )
    parser.add_argument(
        "--max-gross-market-value",
        default=str(DEFAULT_MAX_GROSS_MARKET_VALUE),
        help="Refuse to submit flatten orders above this absolute market value.",
    )
    parser.add_argument(
        "--max-position-count",
        type=int,
        default=DEFAULT_MAX_POSITION_COUNT,
        help="Refuse to submit flatten orders above this number of open positions.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Submit flatten orders. Without this flag, only report the plan.",
    )
    parser.add_argument(
        "--extended-hours-limit",
        action="store_true",
        help=(
            "Use aggressive extended-hours limit orders instead of regular-session "
            "market orders. Still paper-only and account-label guarded."
        ),
    )
    parser.add_argument(
        "--limit-away-bps",
        default=str(DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS),
        help=(
            "Basis points away from the position reference price for extended-hours "
            "limit closes: sells below reference, buys above reference."
        ),
    )
    parser.add_argument(
        "--wait-flat-seconds",
        type=float,
        default=DEFAULT_WAIT_FLAT_SECONDS,
        help="Poll the account after submitting close orders and fail if positions remain after this many seconds.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=DEFAULT_POLL_SECONDS,
        help="Polling interval used with --wait-flat-seconds.",
    )
    parser.add_argument(
        "--persist-snapshot",
        action="store_true",
        help="Persist a fresh PositionSnapshot after the flatten attempt for runtime-window readiness gates.",
    )
    parser.add_argument(
        "--target-plan-readback-url",
        default="",
        help=(
            "Optional /trading/proofs URL to read after snapshot "
            "persistence so the job output proves whether the clean-window baseline "
            "gate sees the snapshot."
        ),
    )
    parser.add_argument(
        "--target-plan-readback-timeout-seconds",
        type=float,
        default=10.0,
        help="HTTP timeout for --target-plan-readback-url.",
    )
    parser.add_argument(
        "--require-target-plan-readback-clean",
        action="store_true",
        help=(
            "Return non-zero when target-plan readback is requested but the matching "
            "paper-route clean-window baseline is not clean and source-auditable."
        ),
    )
    parser.add_argument(
        "--allow-pending-clean-window-baseline-readback",
        action="store_true",
        help=(
            "Allow the explicit pre-session pending clean-window baseline state when "
            "this cleanup job runs before the baseline window can be evaluated. Dirty, "
            "missing, stale, or unreadable readbacks still fail when clean readback is required."
        ),
    )
    parser.add_argument(
        "--persist-lineage",
        action="store_true",
        help=(
            "Persist source-backed TradeDecision and Execution rows for submitted "
            "flatten close orders so order-feed lifecycle events can link by "
            "client_order_id. Orders without source lineage are tagged "
            "unlinked_no_source_lineage and remain non-promotion proof."
        ),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _decimal(value: object, *, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, str | bytes):
        return []
    return value if isinstance(value, Sequence) else []


def _safe_text(value: object) -> str:
    return str(value or "").strip()


def _readback_blockers(value: object) -> list[str]:
    blockers: list[str] = []
    for item in _as_sequence(value):
        text = _safe_text(item)
        if text and text not in blockers:
            blockers.append(text)
    return blockers


def _target_plan_readback_plans(
    payload: Mapping[str, Any],
) -> list[tuple[str, Mapping[str, Any]]]:
    plans: list[tuple[str, Mapping[str, Any]]] = [("top_level", payload)]
    if payload.get("schema_version") == "torghut.proofs.v1":
        proof_targets = _target_plan_targets_from_proofs(payload)
        if proof_targets:
            plans.append(("proofs", {"targets": proof_targets}))
    for key in (
        "next_paper_route_runtime_window_targets",
        "runtime_window_import_plan",
        "next_clean_paper_route_runtime_window_targets_after_discard",
    ):
        plan = _as_mapping(payload.get(key))
        if plan:
            plans.append((key, plan))
    return plans


def _target_plan_targets_from_proofs(
    payload: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    targets: list[Mapping[str, Any]] = []
    for raw_proof in _as_sequence(payload.get("proofs")):
        proof = _as_mapping(raw_proof)
        identity = _as_mapping(proof.get("identity"))
        window = _as_mapping(proof.get("window"))
        account_state = _as_mapping(proof.get("account_state"))
        account_blockers = [
            _safe_text(blocker)
            for blocker in _as_sequence(account_state.get("blockers"))
            if _safe_text(blocker)
        ]
        baseline_clean = (
            account_state.get("clean_baseline") is not False and not account_blockers
        )
        target = {
            "hypothesis_id": identity.get("hypothesis_id"),
            "candidate_id": identity.get("candidate_id"),
            "strategy_family": identity.get("strategy_family"),
            "strategy_name": identity.get("strategy_name")
            or identity.get("runtime_strategy_name"),
            "runtime_strategy_name": identity.get("runtime_strategy_name")
            or identity.get("strategy_name"),
            "account_label": identity.get("account_label"),
            "source_account_label": identity.get("source_account_label"),
            "source_kind": identity.get("source_kind"),
            "source_plan_ref": identity.get("source_plan_ref"),
            "source_decision_mode": identity.get("source_decision_mode"),
            "target_notional": identity.get("target_notional"),
            "window_start": window.get("start"),
            "window_end": window.get("end"),
            "paper_route_clean_window_state": "clean_window_collection_ready"
            if baseline_clean
            else "blocked",
            "paper_route_clean_window_baseline_state": {
                "state": "clean" if baseline_clean else "blocked",
                "blockers": account_blockers,
            },
            "paper_route_clean_window_baseline_blockers": account_blockers,
            "paper_route_probe_symbols": [
                _safe_text(symbol).upper()
                for symbol in _as_sequence(proof.get("symbols"))
                if _safe_text(symbol)
            ],
            "paper_route_probe_symbol_actions": _as_mapping(
                identity.get("target_symbol_actions")
            ),
            "paper_route_probe_symbol_quantities": _as_mapping(
                identity.get("target_symbol_quantities")
            ),
        }
        if target:
            targets.append(target)
    return targets


def _target_plan_readback_targets(
    payload: Mapping[str, Any],
) -> tuple[str, Mapping[str, Any], list[Mapping[str, Any]]]:
    fallback_plan_name = "top_level"
    fallback_plan = payload
    for plan_name, plan in _target_plan_readback_plans(payload):
        targets = [
            item
            for item in (_as_mapping(raw) for raw in _as_sequence(plan.get("targets")))
            if item
        ]
        if targets:
            return plan_name, plan, targets
        fallback_plan_name = plan_name
        fallback_plan = plan
    return fallback_plan_name, fallback_plan, []


def _target_plan_target_account_label(target: Mapping[str, Any]) -> str:
    for key in (
        "account_label",
        "source_account_label",
        "paper_route_account_label",
        "runtime_account_label",
    ):
        text = _safe_text(target.get(key))
        if text:
            return text
    return ""


def _target_plan_target_matches_account(
    target: Mapping[str, Any],
    account_label: str,
) -> bool:
    normalized_account = account_label.strip().upper()
    if not normalized_account:
        return True
    return _target_plan_target_account_label(target).upper() == normalized_account


def _target_plan_baseline_readback(
    target: Mapping[str, Any],
) -> dict[str, object]:
    baseline = _as_mapping(target.get("paper_route_clean_window_baseline_state"))
    blockers = _readback_blockers(
        target.get("paper_route_clean_window_baseline_blockers")
    )
    if not blockers:
        blockers = _readback_blockers(baseline.get("blockers"))
    state = _safe_text(baseline.get("state")) or _safe_text(
        target.get("paper_route_clean_window_state")
    )
    return {
        "candidate_id": _safe_text(target.get("candidate_id")),
        "account_label": _target_plan_target_account_label(target),
        "window_start": _safe_text(target.get("window_start")),
        "window_end": _safe_text(target.get("window_end")),
        "state": state or "unknown",
        "snapshot_id": _safe_text(baseline.get("snapshot_id")),
        "snapshot_as_of": _safe_text(baseline.get("snapshot_as_of")),
        "source_auditable": bool(baseline.get("source_auditable")),
        "blockers": blockers,
    }


def _target_plan_readback_pending_clean_window_baseline_only(
    readback: Mapping[str, object],
) -> bool:
    if _safe_text(readback.get("state")) != "blocked":
        return False
    if int(readback.get("matching_target_count") or 0) <= 0:
        return False
    targets = [_as_mapping(target) for target in _as_sequence(readback.get("targets"))]
    if not targets:
        return False
    allowed_readback_blockers = {
        "paper_route_clean_window_baseline_snapshot_pending",
        "paper_route_target_plan_clean_window_baseline_not_clean",
        "paper_route_target_plan_readback_snapshot_id_mismatch",
    }
    if set(_readback_blockers(readback.get("blockers"))) - allowed_readback_blockers:
        return False
    for target in targets:
        if _safe_text(target.get("state")) != "pending_until_clean_window_baseline":
            return False
        if set(_readback_blockers(target.get("blockers"))) != {
            "paper_route_clean_window_baseline_snapshot_pending"
        }:
            return False
    return True


def _readback_datetime(value: object) -> datetime | None:
    text = _safe_text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _snapshot_after_matching_target_windows(
    *,
    snapshot_as_of: str | None,
    readback_targets: Sequence[Mapping[str, object]],
) -> bool:
    snapshot_time = _readback_datetime(snapshot_as_of)
    if snapshot_time is None or not readback_targets:
        return False
    saw_window_end = False
    for target in readback_targets:
        window_end = _readback_datetime(target.get("window_end"))
        if window_end is None:
            return False
        saw_window_end = True
        if snapshot_time <= window_end:
            return False
    return saw_window_end


def read_target_plan_clean_window_readback(
    *,
    url: str,
    account_label: str,
    snapshot_id: str | None,
    snapshot_as_of: str | None = None,
    timeout_seconds: float,
) -> dict[str, object]:
    normalized_url = url.strip()
    base_payload: dict[str, object] = {
        "schema_version": TARGET_PLAN_READBACK_SCHEMA_VERSION,
        "url": normalized_url,
        "account_label": account_label,
        "position_snapshot_id": snapshot_id,
        "position_snapshot_as_of": snapshot_as_of,
        "state": "not_requested",
        "http_status": None,
        "plan_source": None,
        "target_count": 0,
        "matching_target_count": 0,
        "clean_matching_target_count": 0,
        "persisted_snapshot_seen": False,
        "persisted_snapshot_after_target_window": False,
        "clean_window_baseline_readiness": {},
        "targets": [],
        "blockers": [],
    }
    if not normalized_url:
        return base_payload

    try:
        request = urllib.request.Request(
            normalized_url,
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(
            request,
            timeout=max(0.1, float(timeout_seconds or 0.1)),
        ) as response:
            http_status = int(getattr(response, "status", 200))
            body = response.read()
    except urllib.error.HTTPError as exc:
        return {
            **base_payload,
            "state": "blocked",
            "http_status": int(exc.code),
            "error": str(exc.reason or exc),
            "blockers": ["paper_route_target_plan_readback_http_error"],
        }
    except (OSError, TimeoutError, ValueError, urllib.error.URLError) as exc:
        return {
            **base_payload,
            "state": "blocked",
            "error": str(exc),
            "blockers": ["paper_route_target_plan_readback_failed"],
        }

    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {
            **base_payload,
            "state": "blocked",
            "http_status": http_status,
            "error": str(exc),
            "blockers": ["paper_route_target_plan_readback_json_invalid"],
        }
    if not isinstance(decoded, Mapping):
        return {
            **base_payload,
            "state": "blocked",
            "http_status": http_status,
            "blockers": ["paper_route_target_plan_readback_payload_invalid"],
        }

    plan_source, plan, targets = _target_plan_readback_targets(decoded)
    matching_targets = [
        target
        for target in targets
        if _target_plan_target_matches_account(target, account_label)
    ]
    readback_targets = [
        _target_plan_baseline_readback(target) for target in matching_targets
    ]
    clean_targets = [
        target
        for target in readback_targets
        if target.get("state") == "clean" and not target.get("blockers")
    ]
    persisted_snapshot_seen = bool(
        snapshot_id
        and any(target.get("snapshot_id") == snapshot_id for target in readback_targets)
    )
    persisted_snapshot_after_target_window = _snapshot_after_matching_target_windows(
        snapshot_as_of=snapshot_as_of,
        readback_targets=readback_targets,
    )
    summary = _as_mapping(plan.get("clean_window_baseline_readiness"))
    blockers = _readback_blockers(summary.get("blockers"))
    for target in readback_targets:
        for blocker in _readback_blockers(target.get("blockers")):
            if blocker not in blockers:
                blockers.append(blocker)
    if not matching_targets:
        blockers.append("paper_route_target_plan_readback_target_missing")
    if matching_targets and len(clean_targets) != len(matching_targets):
        blockers.append("paper_route_target_plan_clean_window_baseline_not_clean")
    if (
        snapshot_id
        and matching_targets
        and not persisted_snapshot_seen
        and not persisted_snapshot_after_target_window
    ):
        blockers.append("paper_route_target_plan_readback_snapshot_id_mismatch")
    blockers = sorted(dict.fromkeys(blockers))
    return {
        **base_payload,
        "state": "clean" if matching_targets and not blockers else "blocked",
        "http_status": http_status,
        "plan_source": plan_source,
        "target_count": len(targets),
        "matching_target_count": len(matching_targets),
        "clean_matching_target_count": len(clean_targets),
        "persisted_snapshot_seen": persisted_snapshot_seen,
        "persisted_snapshot_after_target_window": persisted_snapshot_after_target_window,
        "clean_window_baseline_readiness": dict(summary),
        "targets": readback_targets,
        "blockers": blockers,
    }


def _session_factory_from_env(
    dsn_env: str,
) -> tuple[sessionmaker[Session], Engine | None, str]:
    resolved_env = dsn_env.strip() or "DB_DSN"
    if resolved_env == "DB_DSN":
        facade = sys.modules.get("scripts.flatten_paper_account_positions")
        session_local = getattr(facade, "SessionLocal", SessionLocal)
        return session_local, None, resolved_env
    dsn = os.getenv(resolved_env)
    if not dsn:
        raise RuntimeError(
            f"paper_account_flatten_database_dsn_env_missing:{resolved_env}"
        )
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    return (
        sessionmaker(
            bind=engine,
            autoflush=False,
            expire_on_commit=False,
            future=True,
        ),
        engine,
        resolved_env,
    )


def _position_qty(position: Mapping[str, Any]) -> Decimal:
    qty = _decimal(position.get("qty", position.get("quantity")))
    side = str(position.get("side") or "").strip().lower()
    if side == "short" and qty > 0:
        return -qty
    return qty


def _position_market_value(position: Mapping[str, Any], qty: Decimal) -> Decimal:
    raw_value = position.get("market_value", position.get("marketValue"))
    value = _decimal(raw_value)
    if value != 0:
        return abs(value)
    price = _decimal(
        position.get("current_price", position.get("currentPrice")),
        default=Decimal("0"),
    )
    return abs(qty) * abs(price)


def _position_reference_price(
    position: Mapping[str, Any], qty: Decimal, market_value: Decimal
) -> Decimal | None:
    for key in (
        "current_price",
        "currentPrice",
        "lastday_price",
        "lastdayPrice",
        "avg_entry_price",
        "avgEntryPrice",
    ):
        price = _decimal(position.get(key))
        if price > 0:
            return price
    abs_qty = abs(qty)
    if abs_qty > 0 and market_value > 0:
        return market_value / abs_qty
    return None


def _normalize_positions(
    raw_positions: Sequence[Mapping[str, Any]] | None,
) -> list[FlattenPosition]:
    normalized: list[FlattenPosition] = []
    for raw in raw_positions or []:
        symbol = str(raw.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = _position_qty(raw)
        if qty == 0:
            continue
        side = str(raw.get("side") or "").strip().lower()
        if side not in {"long", "short"}:
            side = "short" if qty < 0 else "long"
        market_value = _position_market_value(raw, qty)
        normalized.append(
            FlattenPosition(
                symbol=symbol,
                qty=qty,
                side=side,
                market_value=market_value,
                reference_price=_position_reference_price(raw, qty, market_value),
            )
        )
    return sorted(normalized, key=lambda item: item.symbol)
