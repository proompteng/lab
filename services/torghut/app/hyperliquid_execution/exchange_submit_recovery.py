"""Hyperliquid submission payload and observation-only recovery reads."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, Protocol, cast

from requests.exceptions import RequestException

from ..trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRouteError,
)
from .models import OrderIntent
from .sdk_submission import HYPERLIQUID_SDK_ERRORS

_HYPERLIQUID_HISTORY_LIMIT = 2000
_RECOVERY_READ_EXCEPTIONS = HYPERLIQUID_SDK_ERRORS + (
    RequestException,
    OSError,
    TimeoutError,
)


class HyperliquidRecoveryInfo(Protocol):
    def query_order_by_cloid(self, account_address: str, cloid: object) -> object: ...

    def historical_orders(self, account_address: str) -> object: ...

    def user_fills_by_time(
        self,
        account_address: str,
        _start_time: int,
        _end_time: int,
        _aggregate_by_time: bool,
    ) -> object: ...


@dataclass(frozen=True, slots=True)
class HyperliquidOrderRecoveryLookup:
    outcome: Literal["found", "not_found", "indeterminate"]
    evidence: Mapping[str, object]
    order: Mapping[str, object] | None = None


@dataclass(frozen=True, slots=True)
class HyperliquidOrderRecoveryRequest:
    account_address: str
    cloid: str
    sdk_cloid: object
    after: datetime
    until: datetime


@dataclass(frozen=True, slots=True)
class _HyperliquidRecoveryHistory:
    orders: tuple[Mapping[str, object], ...]
    fills: tuple[Mapping[str, object], ...]
    order_count: int
    fill_count: int


def hyperliquid_submit_request_payload(intent: OrderIntent) -> dict[str, object]:
    return {
        "market_id": intent.market_id,
        "coin": intent.coin,
        "dex": intent.dex,
        "side": intent.side,
        "size": intent.size,
        "limit_price": intent.limit_price,
        "notional_usd": intent.notional_usd,
        "cloid": intent.cloid,
        "tif": intent.tif,
        "reduce_only": intent.reduce_only,
        "slippage": Decimal("0"),
        "signal_id": intent.signal_id,
        "expires_at": intent.expires_at.isoformat(),
    }


def recover_hyperliquid_order(
    *,
    info: HyperliquidRecoveryInfo | None,
    request: HyperliquidOrderRecoveryRequest,
) -> HyperliquidOrderRecoveryLookup:
    """Observe one CLOID and bounded history without any exchange mutation."""

    try:
        return _recover_hyperliquid_order(
            info=info,
            request=request,
        )
    except _RECOVERY_READ_EXCEPTIONS as exc:
        raise BrokerMutationRecoveryRouteError(
            f"hyperliquid_submit_recovery_read_failed:{type(exc).__name__}"
        ) from exc


def _recover_hyperliquid_order(
    *,
    info: HyperliquidRecoveryInfo | None,
    request: HyperliquidOrderRecoveryRequest,
) -> HyperliquidOrderRecoveryLookup:
    if not request.account_address:
        return HyperliquidOrderRecoveryLookup(
            outcome="indeterminate",
            evidence={
                "exact_order_status": "not_checked",
                "history_count": 0,
                "fill_count": 0,
                "absence_proof_complete": False,
                "reason": "account_address_missing",
            },
        )
    if info is None:
        raise ValueError("hyperliquid_recovery_info_required")
    if (
        request.after.tzinfo is None
        or request.until.tzinfo is None
        or request.after >= request.until
    ):
        raise ValueError("hyperliquid_recovery_window_invalid")
    exact_raw = info.query_order_by_cloid(request.account_address, request.sdk_cloid)
    exact_status, exact_order = _hyperliquid_exact_order(exact_raw, request.cloid)
    if exact_order is not None:
        return HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={
                "exact_order_status": exact_status,
                "history_checked": False,
                "history_count": 0,
                "history_complete": False,
                "history_match_count": 0,
                "fill_checked": False,
                "fill_count": 0,
                "fill_complete": False,
                "fill_match_count": 0,
                "absence_proof_complete": False,
            },
            order=exact_order,
        )
    history = _load_hyperliquid_history(info, request)
    return _hyperliquid_history_lookup(
        history,
        cloid=request.cloid,
        exact_status=exact_status,
    )


def _load_hyperliquid_history(
    info: HyperliquidRecoveryInfo,
    request: HyperliquidOrderRecoveryRequest,
) -> _HyperliquidRecoveryHistory:
    history_raw = info.historical_orders(request.account_address)
    fills_raw = info.user_fills_by_time(
        request.account_address,
        int(request.after.timestamp() * 1000),
        int(request.until.timestamp() * 1000),
        False,
    )
    if not isinstance(history_raw, list) or not isinstance(fills_raw, list):
        raise ValueError("hyperliquid_recovery_history_payload_invalid")
    history_items = cast(list[object], history_raw)
    fill_items = cast(list[object], fills_raw)
    return _HyperliquidRecoveryHistory(
        orders=tuple(
            cast(Mapping[str, object], item)
            for item in history_items
            if isinstance(item, dict)
        ),
        fills=tuple(
            cast(Mapping[str, object], item)
            for item in fill_items
            if isinstance(item, dict)
        ),
        order_count=len(history_items),
        fill_count=len(fill_items),
    )


def _hyperliquid_history_lookup(
    history: _HyperliquidRecoveryHistory,
    *,
    cloid: str,
    exact_status: str,
) -> HyperliquidOrderRecoveryLookup:
    history_matches = tuple(
        item for item in history.orders if _hyperliquid_payload_cloid(item) == cloid
    )
    fill_matches = tuple(
        item for item in history.fills if _hyperliquid_payload_cloid(item) == cloid
    )
    matches: list[Mapping[str, object]] = list(history_matches)
    matches.extend(_hyperliquid_order_from_fill(item) for item in fill_matches)
    matches = _deduplicate_hyperliquid_matches(matches)
    broker_ids = {_hyperliquid_payload_oid(item) for item in matches}.difference({None})
    history_complete = history.order_count < _HYPERLIQUID_HISTORY_LIMIT
    fills_complete = history.fill_count < _HYPERLIQUID_HISTORY_LIMIT
    evidence = {
        "exact_order_status": exact_status,
        "history_checked": True,
        "history_count": history.order_count,
        "history_complete": history_complete,
        "history_match_count": len(history_matches),
        "fill_checked": True,
        "fill_count": history.fill_count,
        "fill_complete": fills_complete,
        "fill_match_count": len(fill_matches),
        "absence_proof_complete": (
            exact_status == "not_found"
            and not matches
            and history_complete
            and fills_complete
        ),
    }
    if len(broker_ids) > 1:
        return HyperliquidOrderRecoveryLookup(
            outcome="indeterminate",
            evidence={
                **evidence,
                "absence_proof_complete": False,
                "reason": "conflicting_exchange_order_ids",
            },
        )
    if matches:
        return HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence=evidence,
            order=matches[0],
        )
    if evidence["absence_proof_complete"] is True:
        return HyperliquidOrderRecoveryLookup(
            outcome="not_found",
            evidence=evidence,
        )
    return HyperliquidOrderRecoveryLookup(
        outcome="indeterminate",
        evidence={
            **evidence,
            "reason": "bounded_history_incomplete",
        },
    )


def _hyperliquid_exact_order(
    raw: object,
    cloid: str,
) -> tuple[str, Mapping[str, object] | None]:
    if not isinstance(raw, dict):
        raise ValueError("hyperliquid_recovery_exact_payload_invalid")
    payload = cast(Mapping[str, object], raw)
    status = str(payload.get("status") or "").strip()
    if status in {"unknownOid", "unknown_oid", "not_found"}:
        return "not_found", None
    if status != "order":
        return "indeterminate", None
    order = payload.get("order")
    if not isinstance(order, dict):
        raise ValueError("hyperliquid_recovery_exact_order_missing")
    order_map = cast(Mapping[str, object], order)
    if _hyperliquid_payload_cloid(order_map) != cloid:
        raise ValueError("hyperliquid_recovery_exact_cloid_mismatch")
    return "found", order_map


def _hyperliquid_payload_cloid(payload: Mapping[str, object]) -> str:
    nested = payload.get("order")
    source = cast(Mapping[str, object], nested) if isinstance(nested, dict) else payload
    return str(source.get("cloid") or source.get("client_order_id") or "").strip()


def _hyperliquid_payload_oid(payload: Mapping[str, object]) -> str | None:
    nested = payload.get("order")
    source = cast(Mapping[str, object], nested) if isinstance(nested, dict) else payload
    raw = source.get("oid") or source.get("order_id") or source.get("exchange_order_id")
    normalized = str(raw or "").strip()
    return normalized or None


def _hyperliquid_order_from_fill(fill: Mapping[str, object]) -> Mapping[str, object]:
    # A fill proves that the order reached the exchange, but one fill does not
    # prove that the entire requested size filled. Normal fill reconciliation
    # remains authoritative for terminal quantity and status.
    return {
        "cloid": _hyperliquid_payload_cloid(fill),
        "oid": _hyperliquid_payload_oid(fill),
        "coin": fill.get("coin"),
        "side": fill.get("side"),
        "sz": fill.get("sz") or fill.get("size"),
        "limitPx": fill.get("px") or fill.get("price"),
        "status": "accepted",
        "source": "user_fills_by_time",
    }


def _deduplicate_hyperliquid_matches(
    matches: list[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    unique: list[Mapping[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for match in matches:
        identity = (
            _hyperliquid_payload_cloid(match),
            _hyperliquid_payload_oid(match) or "",
            str(match.get("status") or "").strip(),
        )
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(match)
    return unique
