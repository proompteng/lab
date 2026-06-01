#!/usr/bin/env python3
"""Flatten the Torghut paper account so runtime proof windows start clean."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Protocol, cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.db import SessionLocal
from app.models import Execution, Strategy, TradeDecision, coerce_json_payload
from app.snapshots import snapshot_account_and_positions, sync_order_to_db
from app.trading.firewall import OrderFirewall
from app.trading.runtime_decision_authority import (
    source_decision_mode_is_profit_proof_eligible,
)

DEFAULT_ACCOUNT_LABEL = "TORGHUT_SIM"
DEFAULT_PAPER_BASE_URL = "https://paper-api.alpaca.markets"
DEFAULT_MAX_GROSS_MARKET_VALUE = Decimal("100000")
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


def _position_payload(position: FlattenPosition) -> dict[str, str | None]:
    return {
        "symbol": position.symbol,
        "qty": str(position.qty),
        "side": position.side,
        "market_value": str(position.market_value),
        "reference_price": str(position.reference_price)
        if position.reference_price is not None
        else None,
        "close_side": position.close_side,
        "close_qty": str(position.close_qty),
    }


def _quantize_price(price: Decimal) -> Decimal:
    quantum = Decimal("0.01") if price >= Decimal("1") else Decimal("0.0001")
    return price.quantize(quantum, rounding=ROUND_HALF_UP)


def _extended_hours_limit_price(
    position: FlattenPosition, limit_away_bps: Decimal
) -> Decimal | None:
    reference = position.reference_price
    if reference is None or reference <= 0:
        return None
    away = max(Decimal("0"), limit_away_bps) / Decimal("10000")
    if position.close_side == "sell":
        raw_price = reference * (Decimal("1") - away)
    else:
        raw_price = reference * (Decimal("1") + away)
    if raw_price <= 0:
        raw_price = Decimal("0.0001")
    return _quantize_price(raw_price)


def _coerce_text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _lineage_values(value: object) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        values = [str(item) for item in value]
    else:
        values = []
    return list(dict.fromkeys(item.strip() for item in values if item.strip()))


def _decision_mapping(decision: TradeDecision) -> Mapping[str, Any]:
    payload = decision.decision_json
    if isinstance(payload, Mapping):
        return cast(Mapping[str, Any], payload)
    return {}


def _decision_params(decision_payload: Mapping[str, Any]) -> Mapping[str, Any]:
    params = decision_payload.get("params")
    if isinstance(params, Mapping):
        return cast(Mapping[str, Any], params)
    return {}


def _first_lineage_values(
    decision_payload: Mapping[str, Any], params: Mapping[str, Any], key: str
) -> list[str]:
    return _lineage_values(decision_payload.get(key)) or _lineage_values(
        params.get(key)
    )


def _first_lineage_text(
    decision_payload: Mapping[str, Any], params: Mapping[str, Any], key: str
) -> str | None:
    return _coerce_text(decision_payload.get(key)) or _coerce_text(params.get(key))


def _first_lineage_bool(
    decision_payload: Mapping[str, Any], params: Mapping[str, Any], key: str
) -> bool | None:
    for value in (decision_payload.get(key), params.get(key)):
        if isinstance(value, bool):
            return value
    return None


@dataclass(frozen=True)
class FlattenSourceLineage:
    source_decision: TradeDecision | None
    source_execution: Execution | None
    strategy_id: Any
    source_candidate_ids: list[str]
    source_hypothesis_ids: list[str]
    source_strategy_names: list[str]
    source_decision_mode: str | None
    profit_proof_eligible: bool

    @property
    def has_source_lineage(self) -> bool:
        return any(
            (
                self.source_candidate_ids,
                self.source_hypothesis_ids,
                self.source_strategy_names,
                self.source_decision_mode,
            )
        )


def _is_flatten_close_decision(decision: TradeDecision) -> bool:
    payload = _decision_mapping(decision)
    return (
        payload.get("schema_version") == FLATTEN_CLOSE_DECISION_SCHEMA_VERSION
        or payload.get("flatten_lineage_role") == "close"
    )


def _latest_source_decision(
    session: Session, *, account_label: str, symbol: str
) -> TradeDecision | None:
    stmt = (
        select(TradeDecision)
        .where(
            TradeDecision.alpaca_account_label == account_label,
            TradeDecision.symbol == symbol,
        )
        .order_by(TradeDecision.created_at.desc())
        .limit(25)
    )
    for decision in session.execute(stmt).scalars():
        if not _is_flatten_close_decision(decision):
            return decision
    return None


def _latest_source_execution(
    session: Session, *, account_label: str, symbol: str, decision: TradeDecision | None
) -> Execution | None:
    if decision is not None:
        linked_stmt = (
            select(Execution)
            .where(
                Execution.trade_decision_id == decision.id,
                Execution.alpaca_account_label == account_label,
                Execution.symbol == symbol,
            )
            .order_by(Execution.created_at.desc())
            .limit(1)
        )
        linked = session.execute(linked_stmt).scalar_one_or_none()
        if linked is not None:
            return linked

    stmt = (
        select(Execution)
        .where(
            Execution.alpaca_account_label == account_label,
            Execution.symbol == symbol,
            Execution.trade_decision_id.is_not(None),
        )
        .order_by(Execution.created_at.desc())
        .limit(1)
    )
    return session.execute(stmt).scalar_one_or_none()


def _find_or_create_cleanup_strategy(session: Session) -> Strategy:
    stmt = select(Strategy).where(Strategy.name == FLATTEN_CLEANUP_STRATEGY_NAME)
    existing = session.execute(stmt).scalar_one_or_none()
    if existing is not None:
        return existing

    strategy = Strategy(
        name=FLATTEN_CLEANUP_STRATEGY_NAME,
        description=(
            "Operational paper-account risk cleanup strategy used only to give "
            "unlinked flatten close orders an auditable non-promotion decision row."
        ),
        enabled=False,
        base_timeframe="event",
        universe_type="runtime_cleanup",
        universe_symbols=[],
    )
    session.add(strategy)
    try:
        session.commit()
        session.refresh(strategy)
    except IntegrityError:
        session.rollback()
        existing = session.execute(stmt).scalar_one_or_none()
        if existing is None:
            raise
        return existing
    return strategy


def _source_lineage(
    session: Session, *, account_label: str, symbol: str
) -> FlattenSourceLineage:
    source_decision = _latest_source_decision(
        session, account_label=account_label, symbol=symbol
    )
    source_execution = _latest_source_execution(
        session,
        account_label=account_label,
        symbol=symbol,
        decision=source_decision,
    )
    if source_decision is None:
        strategy_id = _find_or_create_cleanup_strategy(session).id
        return FlattenSourceLineage(
            source_decision=None,
            source_execution=source_execution,
            strategy_id=strategy_id,
            source_candidate_ids=[],
            source_hypothesis_ids=[],
            source_strategy_names=[],
            source_decision_mode=None,
            profit_proof_eligible=False,
        )

    decision_payload = _decision_mapping(source_decision)
    params = _decision_params(decision_payload)
    source_decision_mode = _first_lineage_text(
        decision_payload, params, "source_decision_mode"
    )
    source_profit_proof = _first_lineage_bool(
        decision_payload, params, "profit_proof_eligible"
    )
    profit_proof_eligible = source_profit_proof is True or (
        source_profit_proof is not False
        and source_decision_mode_is_profit_proof_eligible(source_decision_mode)
    )
    return FlattenSourceLineage(
        source_decision=source_decision,
        source_execution=source_execution,
        strategy_id=source_decision.strategy_id,
        source_candidate_ids=_first_lineage_values(
            decision_payload, params, "source_candidate_ids"
        ),
        source_hypothesis_ids=_first_lineage_values(
            decision_payload, params, "source_hypothesis_ids"
        ),
        source_strategy_names=_first_lineage_values(
            decision_payload, params, "source_strategy_names"
        ),
        source_decision_mode=source_decision_mode,
        profit_proof_eligible=profit_proof_eligible,
    )


def _flatten_client_order_id(*, generated_at: datetime, symbol: str) -> str:
    normalized_symbol = "".join(
        char for char in symbol.lower() if char.isalnum() or char in {"-", "_"}
    )
    digest = hashlib.sha256(symbol.upper().encode("utf-8")).hexdigest()[:10]
    prefix = f"tgpf-{generated_at.strftime('%Y%m%d%H%M%S')}-"
    suffix = f"-{digest}"
    max_symbol_length = max(1, 64 - len(prefix) - len(suffix))
    return f"{prefix}{normalized_symbol[:max_symbol_length]}{suffix}"


def _close_decision_payload(
    *,
    position: FlattenPosition,
    client_order_id: str,
    order_type: str,
    limit_price: Decimal | None,
    lineage: FlattenSourceLineage,
) -> dict[str, Any]:
    lineage_status = (
        LINEAGE_LINKED_STATUS if lineage.has_source_lineage else LINEAGE_UNLINKED_STATUS
    )
    source_trade_decision_id = (
        str(lineage.source_decision.id) if lineage.source_decision is not None else None
    )
    source_execution_id = (
        str(lineage.source_execution.id)
        if lineage.source_execution is not None
        else None
    )
    params: dict[str, Any] = {
        "source_candidate_ids": list(lineage.source_candidate_ids),
        "source_hypothesis_ids": list(lineage.source_hypothesis_ids),
        "source_strategy_names": list(lineage.source_strategy_names),
        "source_decision_mode": lineage.source_decision_mode,
        "profit_proof_eligible": lineage.profit_proof_eligible,
        "flatten_lineage_status": lineage_status,
        "source_trade_decision_id": source_trade_decision_id,
        "source_execution_id": source_execution_id,
        "final_promotion_authorized": False,
    }
    return {
        "schema_version": FLATTEN_CLOSE_DECISION_SCHEMA_VERSION,
        "flatten_lineage_role": "close",
        "flatten_lineage_status": lineage_status,
        "source_candidate_ids": list(lineage.source_candidate_ids),
        "source_hypothesis_ids": list(lineage.source_hypothesis_ids),
        "source_strategy_names": list(lineage.source_strategy_names),
        "source_decision_mode": lineage.source_decision_mode,
        "profit_proof_eligible": lineage.profit_proof_eligible,
        "final_promotion_authorized": False,
        "source_trade_decision_id": source_trade_decision_id,
        "source_execution_id": source_execution_id,
        "client_order_id": client_order_id,
        "symbol": position.symbol,
        "action": position.close_side,
        "qty": str(position.close_qty),
        "order_type": order_type,
        "time_in_force": "day",
        "limit_price": str(limit_price) if limit_price is not None else None,
        "position": _position_payload(position),
        "params": params,
    }


def _persist_close_decision(
    session: Session,
    *,
    account_label: str,
    position: FlattenPosition,
    client_order_id: str,
    order_type: str,
    limit_price: Decimal | None,
) -> tuple[TradeDecision, FlattenSourceLineage]:
    lineage = _source_lineage(
        session, account_label=account_label, symbol=position.symbol
    )
    decision_payload = _close_decision_payload(
        position=position,
        client_order_id=client_order_id,
        order_type=order_type,
        limit_price=limit_price,
        lineage=lineage,
    )
    stmt = select(TradeDecision).where(
        TradeDecision.decision_hash == client_order_id,
        TradeDecision.alpaca_account_label == account_label,
    )
    existing = session.execute(stmt).scalar_one_or_none()
    if existing is not None:
        return existing, lineage

    decision = TradeDecision(
        strategy_id=lineage.strategy_id,
        alpaca_account_label=account_label,
        symbol=position.symbol,
        timeframe="event",
        decision_json=coerce_json_payload(decision_payload),
        rationale=(
            "Paper-account flatten close order; source lineage is preserved when "
            "available, but flatten lineage alone never authorizes promotion."
        ),
        decision_hash=client_order_id,
        status="planned",
    )
    session.add(decision)
    try:
        session.commit()
        session.refresh(decision)
    except IntegrityError:
        session.rollback()
        existing = session.execute(stmt).scalar_one_or_none()
        if existing is None:
            raise
        return existing, lineage
    return decision, lineage


def _lineage_payload(
    *,
    client_order_id: str,
    lineage_status: str,
    decision: TradeDecision | None,
    execution: Execution | None,
    lineage: FlattenSourceLineage | None,
    error: Exception | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "client_order_id": client_order_id,
        "flatten_lineage_status": lineage_status,
        "trade_decision_id": str(decision.id) if decision is not None else None,
        "execution_id": str(execution.id) if execution is not None else None,
        "source_trade_decision_id": (
            str(lineage.source_decision.id)
            if lineage is not None and lineage.source_decision is not None
            else None
        ),
        "source_execution_id": (
            str(lineage.source_execution.id)
            if lineage is not None and lineage.source_execution is not None
            else None
        ),
        "source_candidate_ids": list(lineage.source_candidate_ids)
        if lineage is not None
        else [],
        "source_hypothesis_ids": list(lineage.source_hypothesis_ids)
        if lineage is not None
        else [],
        "source_strategy_names": list(lineage.source_strategy_names)
        if lineage is not None
        else [],
        "source_decision_mode": lineage.source_decision_mode
        if lineage is not None
        else None,
        "profit_proof_eligible": lineage.profit_proof_eligible
        if lineage is not None
        else False,
        "final_promotion_authorized": False,
    }
    if error is not None:
        payload["error_type"] = type(error).__name__
        payload["error"] = str(error)
    return payload


def _wait_until_flat(
    *,
    client: PaperFlattenClient,
    deadline_seconds: float,
    poll_seconds: float,
) -> tuple[str, list[FlattenPosition]]:
    deadline = time.monotonic() + max(0.0, deadline_seconds)
    latest_positions = _normalize_positions(client.list_positions())
    while latest_positions:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "submitted_not_flat", latest_positions
        time.sleep(min(max(0.1, poll_seconds), remaining))
        latest_positions = _normalize_positions(client.list_positions())
    return "flattened", []


def flatten_paper_account_positions(
    *,
    client: PaperFlattenClient,
    account_label: str,
    expected_account_label: str,
    trading_mode: str,
    apply: bool,
    max_gross_market_value: Decimal,
    max_position_count: int,
    extended_hours_limit: bool = False,
    limit_away_bps: Decimal = DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS,
    wait_flat_seconds: float = DEFAULT_WAIT_FLAT_SECONDS,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    generated_at: datetime | None = None,
    persist_lineage: bool = False,
    lineage_session: Session | None = None,
) -> dict[str, Any]:
    generated_at = generated_at or datetime.now(timezone.utc)
    normalized_mode = trading_mode.strip().lower()
    normalized_label = account_label.strip()
    expected_label = expected_account_label.strip()
    blockers: list[str] = []

    if normalized_mode != "paper":
        blockers.append("paper_account_flatten_requires_paper_mode")
    if normalized_label != expected_label:
        blockers.append("paper_account_flatten_account_label_mismatch")

    raw_positions = client.list_positions()
    positions = _normalize_positions(raw_positions)
    gross_market_value = sum(
        (position.market_value for position in positions), Decimal("0")
    )
    if len(positions) > max(0, max_position_count):
        blockers.append("paper_account_flatten_position_count_above_limit")
    if gross_market_value > max_gross_market_value:
        blockers.append("paper_account_flatten_gross_market_value_above_limit")
    extended_limit_prices: dict[str, Decimal] = {}
    missing_limit_symbols: list[str] = []
    if extended_hours_limit:
        for position in positions:
            limit_price = _extended_hours_limit_price(position, limit_away_bps)
            if limit_price is None:
                missing_limit_symbols.append(position.symbol)
            else:
                extended_limit_prices[position.symbol] = limit_price
        if missing_limit_symbols:
            blockers.append("paper_account_flatten_extended_hours_limit_price_missing")

    status = "clean" if not positions and not blockers else "blocked"
    cancelled_orders: list[dict[str, Any]] = []
    submitted_orders: list[dict[str, Any]] = []
    rejected_close_orders: list[dict[str, Any]] = []
    lineage_results: list[dict[str, Any]] = []
    final_positions = positions
    if blockers:
        status = "blocked"
    elif not apply:
        status = "dry_run" if positions else "clean"
    elif positions:
        cancelled_orders = client.cancel_all_orders()
        for position in positions:
            order_type = "limit" if extended_hours_limit else "market"
            limit_price = extended_limit_prices.get(position.symbol)
            client_order_id = _flatten_client_order_id(
                generated_at=generated_at,
                symbol=position.symbol,
            )
            extra_params: dict[str, Any] = {"client_order_id": client_order_id}
            if extended_hours_limit:
                extra_params["extended_hours"] = True
            decision_row: TradeDecision | None = None
            source_lineage: FlattenSourceLineage | None = None
            lineage_persist_error: Exception | None = None
            if persist_lineage and lineage_session is not None:
                try:
                    decision_row, source_lineage = _persist_close_decision(
                        lineage_session,
                        account_label=normalized_label,
                        position=position,
                        client_order_id=client_order_id,
                        order_type=order_type,
                        limit_price=limit_price,
                    )
                except Exception as exc:
                    lineage_session.rollback()
                    lineage_persist_error = exc
            try:
                order_response = client.submit_order(
                    symbol=position.symbol,
                    side=position.close_side,
                    qty=float(position.close_qty),
                    order_type=order_type,
                    time_in_force="day",
                    limit_price=float(limit_price) if limit_price is not None else None,
                    extra_params=extra_params,
                )
                submitted_orders.append(order_response)
            except Exception as exc:
                if (
                    persist_lineage
                    and lineage_session is not None
                    and decision_row is not None
                ):
                    try:
                        decision_row.status = "rejected"
                        lineage_session.add(decision_row)
                        lineage_session.commit()
                    except Exception:
                        lineage_session.rollback()
                rejected_close_orders.append(
                    {
                        "symbol": position.symbol,
                        "side": position.close_side,
                        "qty": str(position.close_qty),
                        "order_type": order_type,
                        "reason": "paper_account_flatten_close_order_rejected",
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
                if persist_lineage:
                    lineage_results.append(
                        _lineage_payload(
                            client_order_id=client_order_id,
                            lineage_status=LINEAGE_PERSIST_FAILED_STATUS
                            if decision_row is None
                            else (
                                LINEAGE_LINKED_STATUS
                                if source_lineage is not None
                                and source_lineage.has_source_lineage
                                else LINEAGE_UNLINKED_STATUS
                            ),
                            decision=decision_row,
                            execution=None,
                            lineage=source_lineage,
                            error=exc,
                        )
                    )
                continue

            if not persist_lineage:
                continue
            if lineage_persist_error is not None or lineage_session is None:
                lineage_results.append(
                    _lineage_payload(
                        client_order_id=client_order_id,
                        lineage_status=LINEAGE_PERSIST_FAILED_STATUS,
                        decision=decision_row,
                        execution=None,
                        lineage=source_lineage,
                        error=lineage_persist_error,
                    )
                )
                continue
            decision_for_sync = cast(TradeDecision, decision_row)
            try:
                execution = sync_order_to_db(
                    lineage_session,
                    order_response,
                    trade_decision_id=str(decision_for_sync.id),
                    alpaca_account_label=normalized_label,
                    execution_expected_adapter="alpaca_paper",
                    execution_actual_adapter="alpaca_paper",
                )
                decision_for_sync.status = "submitted"
                decision_for_sync.executed_at = generated_at
                lineage_session.add(decision_for_sync)
                lineage_session.commit()
                lineage_session.refresh(decision_for_sync)
                lineage_status = (
                    LINEAGE_LINKED_STATUS
                    if source_lineage is not None and source_lineage.has_source_lineage
                    else LINEAGE_UNLINKED_STATUS
                )
                lineage_results.append(
                    _lineage_payload(
                        client_order_id=client_order_id,
                        lineage_status=lineage_status,
                        decision=decision_for_sync,
                        execution=execution,
                        lineage=source_lineage,
                    )
                )
            except Exception as exc:
                lineage_session.rollback()
                lineage_results.append(
                    _lineage_payload(
                        client_order_id=client_order_id,
                        lineage_status=LINEAGE_PERSIST_FAILED_STATUS,
                        decision=decision_for_sync,
                        execution=None,
                        lineage=source_lineage,
                        error=exc,
                    )
                )
        if rejected_close_orders:
            blockers.append("paper_account_flatten_close_order_rejected")
            status = "failed_close_orders"
        elif wait_flat_seconds > 0:
            status, final_positions = _wait_until_flat(
                client=client,
                deadline_seconds=wait_flat_seconds,
                poll_seconds=poll_seconds,
            )
        else:
            status = "submitted"

    return {
        "schema_version": "torghut.paper-account-flatten.v1",
        "status": status,
        "apply": apply,
        "extended_hours_limit": extended_hours_limit,
        "limit_away_bps": str(limit_away_bps),
        "wait_flat_seconds": wait_flat_seconds,
        "poll_seconds": poll_seconds,
        "generated_at": generated_at.isoformat(),
        "account_label": normalized_label,
        "expected_account_label": expected_label,
        "trading_mode": normalized_mode,
        "position_count": len(positions),
        "final_position_count": len(final_positions),
        "gross_market_value": str(gross_market_value),
        "max_gross_market_value": str(max_gross_market_value),
        "max_position_count": max_position_count,
        "blockers": blockers,
        "rejected_close_order_count": len(rejected_close_orders),
        "rejected_close_orders": rejected_close_orders,
        "persist_lineage": persist_lineage,
        "lineage_result_count": len(lineage_results),
        "lineage_results": lineage_results,
        "extended_hours_limit_missing_symbols": missing_limit_symbols,
        "positions": [_position_payload(position) for position in positions],
        "final_positions": [
            _position_payload(position) for position in final_positions
        ],
        "cancelled_order_count": len(cancelled_orders),
        "cancelled_orders": cancelled_orders,
        "submitted_order_count": len(submitted_orders),
        "submitted_orders": submitted_orders,
    }


def main() -> int:
    args = _parse_args()
    max_gross_market_value = _decimal(
        args.max_gross_market_value,
        default=DEFAULT_MAX_GROSS_MARKET_VALUE,
    )
    limit_away_bps = _decimal(
        args.limit_away_bps,
        default=DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS,
    )
    client = TorghutAlpacaClient(paper=True, base_url=str(args.paper_base_url or ""))
    firewall = OrderFirewall(client)
    lineage_context = SessionLocal() if args.persist_lineage else nullcontext(None)
    with lineage_context as lineage_session:
        payload = flatten_paper_account_positions(
            client=firewall,
            account_label=str(args.account_label or ""),
            expected_account_label=str(args.expected_account_label or ""),
            trading_mode=str(args.trading_mode or ""),
            apply=bool(args.apply),
            max_gross_market_value=max_gross_market_value,
            max_position_count=max(0, int(args.max_position_count)),
            extended_hours_limit=bool(args.extended_hours_limit),
            limit_away_bps=limit_away_bps,
            wait_flat_seconds=max(0.0, float(args.wait_flat_seconds or 0.0)),
            poll_seconds=max(0.1, float(args.poll_seconds or DEFAULT_POLL_SECONDS)),
            persist_lineage=bool(args.persist_lineage),
            lineage_session=cast(Session | None, lineage_session),
        )
    if args.persist_snapshot:
        if (
            payload["trading_mode"] == "paper"
            and payload["account_label"] == payload["expected_account_label"]
        ):
            with SessionLocal() as session:
                snapshot = snapshot_account_and_positions(
                    session,
                    cast(Any, firewall),
                    str(args.account_label or ""),
                )
            payload["position_snapshot_id"] = str(snapshot.id)
            payload["position_snapshot_as_of"] = snapshot.as_of.isoformat()
        else:
            payload["position_snapshot_skipped"] = (
                "paper_account_label_or_mode_guard_failed"
            )
    if args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        print(
            f"status={payload['status']} positions={payload['position_count']} "
            f"submitted={payload['submitted_order_count']} blockers={','.join(payload['blockers'])}"
        )
    return 0 if payload["status"] in TERMINAL_CLEAN_STATUSES else 2


if __name__ == "__main__":
    raise SystemExit(main())
