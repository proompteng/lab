"""Observation-only recovery route for Hyperliquid CLOID submissions."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import cast

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..trading.broker_mutation_receipts import (
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
    fingerprint_broker_endpoint,
)
from ..trading.broker_mutation_recovery_worker import BrokerSubmitRecoveryRead
from .config import HyperliquidExecutionConfig
from .exchange import HyperliquidExecutionExchange
from .models import OrderIntent, OrderResult, OrderSide, OrderStatus
from .order_policy import CloidIdentity, deterministic_cloid
from .repository import HyperliquidExecutionRepository


HYPERLIQUID_SUBMIT_RECOVERY_READ_SCHEMA_VERSION = (
    "torghut.hyperliquid-submit-recovery-read.v1"
)


class HyperliquidSubmitRecoveryRoute:
    broker_route = "hyperliquid"

    def __init__(
        self,
        *,
        config: HyperliquidExecutionConfig,
        exchange: HyperliquidExecutionExchange,
    ) -> None:
        self._config = config
        self._exchange = exchange

    @property
    def account_label(self) -> str:
        return self._config.account_label

    @property
    def endpoint_fingerprint(self) -> str:
        return fingerprint_broker_endpoint(self._config.exchange_api_url)

    def observe(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        observed_at: datetime,
    ) -> BrokerSubmitRecoveryRead:
        started_at = receipt.lifecycle.broker_io_started_at
        if started_at is None:
            return BrokerSubmitRecoveryRead(
                outcome="indeterminate",
                evidence=self._evidence(
                    {
                        "reason": "broker_io_started_at_missing",
                        "absence_proof_complete": False,
                    }
                ),
            )
        lookup = self._exchange.recover_order_by_cloid(
            receipt.intent.client_request_id,
            after=started_at,
            until=observed_at,
        )
        evidence = self._evidence(lookup.evidence)
        if lookup.outcome != "found":
            return BrokerSubmitRecoveryRead(
                outcome=lookup.outcome,
                evidence=evidence,
            )
        if lookup.order is None:
            return BrokerSubmitRecoveryRead(
                outcome="indeterminate",
                evidence={
                    **evidence,
                    "reason": "found_order_payload_missing",
                    "absence_proof_complete": False,
                },
            )
        try:
            normalized = _validated_hyperliquid_order(receipt, lookup.order)
        except ValueError as exc:
            return BrokerSubmitRecoveryRead(
                outcome="indeterminate",
                evidence={
                    **evidence,
                    "reason": str(exc),
                    "broker_order_found": True,
                    "absence_proof_complete": False,
                },
            )
        return BrokerSubmitRecoveryRead(
            outcome="found",
            evidence={
                **evidence,
                "broker_order_found": True,
                "broker_status": normalized["status"],
            },
            broker_order=lookup.order,
        )

    def independent_activity(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> tuple[str, ...]:
        count = session.execute(
            text(
                """
                SELECT count(*)
                FROM hyperliquid_execution_orders
                WHERE execution_network = 'testnet'
                  AND cloid = :cloid
                """
            ),
            {"cloid": receipt.intent.client_request_id},
        ).scalar_one()
        return ("execution_order",) if int(count) > 0 else ()

    def build_found_settlement(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
        read: BrokerSubmitRecoveryRead,
    ) -> BrokerMutationSettlement:
        if read.broker_order is None:
            raise ValueError("hyperliquid_recovery_found_order_required")
        intent = _order_intent(
            session,
            receipt,
            order_ttl_seconds=self._config.order_ttl_seconds,
        )
        result = _order_result(receipt, read.broker_order)
        HyperliquidExecutionRepository(session).insert_order(intent, result)
        rejected = result.status == "rejected"
        return build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="recovery",
                outcome="rejected" if rejected else "reconciled",
                broker_reference=result.exchange_order_id,
                execution_id=None,
                evidence_payload={
                    "schema_version": HYPERLIQUID_SUBMIT_RECOVERY_READ_SCHEMA_VERSION,
                    "route": self.broker_route,
                    "client_order_id": intent.cloid,
                    "status": result.status,
                    "rejection_reason": result.rejection_reason,
                    "resolution_state": "rejected" if rejected else "acknowledged",
                    "observation": dict(read.evidence),
                    "automatic_resubmission_attempted": False,
                },
            )
        )

    @staticmethod
    def _evidence(payload: Mapping[str, object]) -> dict[str, object]:
        return {
            "schema_version": HYPERLIQUID_SUBMIT_RECOVERY_READ_SCHEMA_VERSION,
            "route": "hyperliquid",
            **dict(payload),
        }


def _order_intent(
    session: Session,
    receipt: BrokerMutationReceiptSnapshot,
    *,
    order_ttl_seconds: int,
) -> OrderIntent:
    request = _request_payload(receipt)
    signal_id, expires_at = _order_metadata(
        session,
        receipt,
        request,
        order_ttl_seconds=order_ttl_seconds,
    )
    return OrderIntent(
        market_id=_required_text(request.get("market_id"), "market_id"),
        coin=_required_text(request.get("coin"), "coin"),
        dex=str(request.get("dex") or "").strip(),
        side=cast(OrderSide, _side(request.get("side"))),
        size=_decimal(request.get("size"), "size"),
        limit_price=_decimal(request.get("limit_price"), "limit_price"),
        notional_usd=_decimal(request.get("notional_usd"), "notional_usd"),
        cloid=receipt.intent.client_request_id,
        tif=_required_text(request.get("tif"), "tif"),
        reduce_only=bool(request.get("reduce_only")),
        signal_id=signal_id,
        expires_at=expires_at,
    )


def _order_metadata(
    session: Session,
    receipt: BrokerMutationReceiptSnapshot,
    request: Mapping[str, object],
    *,
    order_ttl_seconds: int,
) -> tuple[str, datetime]:
    raw_signal_id = request.get("signal_id")
    raw_expires_at = request.get("expires_at")
    if raw_signal_id is not None and raw_expires_at is not None:
        return (
            _required_text(raw_signal_id, "signal_id"),
            _datetime(raw_expires_at, "expires_at"),
        )
    if raw_signal_id is not None or raw_expires_at is not None:
        raise ValueError("hyperliquid_recovery_order_metadata_incomplete")
    return _legacy_order_metadata(
        session,
        receipt,
        request,
        order_ttl_seconds=order_ttl_seconds,
    )


def _legacy_order_metadata(
    session: Session,
    receipt: BrokerMutationReceiptSnapshot,
    request: Mapping[str, object],
    *,
    order_ttl_seconds: int,
) -> tuple[str, datetime]:
    identity = CloidIdentity(
        market_id=_required_text(request.get("market_id"), "market_id"),
        side=_side(request.get("side")),
        source_event_ts=receipt.created_at,
        size=_decimal(request.get("size"), "size"),
        limit_price=_decimal(request.get("limit_price"), "limit_price"),
        tif=_required_text(request.get("tif"), "tif"),
        reduce_only=bool(request.get("reduce_only")),
    )
    rows = session.execute(
        text(
            """
            SELECT id::text AS signal_id, generated_at, feature_event_ts
            FROM hyperliquid_execution_signals
            WHERE market_data_network = 'mainnet'
              AND execution_network = 'testnet'
              AND market_id = :market_id
              AND coin = :coin
              AND action = :action
              AND generated_at <= :receipt_created_at + interval '5 seconds'
            ORDER BY generated_at DESC
            LIMIT 100
            """
        ),
        {
            "market_id": identity.market_id,
            "coin": _required_text(request.get("coin"), "coin"),
            "action": identity.side,
            "receipt_created_at": receipt.created_at,
        },
    ).mappings()
    matches: list[tuple[str, datetime]] = []
    for row in rows:
        generated_at = _datetime(row["generated_at"], "signal_generated_at")
        candidate = deterministic_cloid(
            replace(
                identity,
                source_event_ts=_datetime(
                    row["feature_event_ts"],
                    "signal_feature_event_ts",
                ),
            )
        )
        if candidate == receipt.intent.client_request_id:
            matches.append(
                (
                    _required_text(row["signal_id"], "signal_id"),
                    generated_at + timedelta(seconds=order_ttl_seconds),
                )
            )
    if len(matches) != 1:
        reason = "not_found" if not matches else "ambiguous"
        raise ValueError(f"hyperliquid_recovery_legacy_signal_{reason}")
    return matches[0]


def _order_result(
    receipt: BrokerMutationReceiptSnapshot,
    order: Mapping[str, object],
) -> OrderResult:
    normalized = _validated_hyperliquid_order(receipt, order)
    status = cast(str, normalized["status"])
    return OrderResult(
        status=cast(OrderStatus, status),
        exchange_order_id=cast(str | None, normalized["exchange_order_id"]),
        raw_response={str(key): value for key, value in order.items()},
        rejection_reason=(
            _optional_text(order.get("rejection_reason") or order.get("reason"))
            if status == "rejected"
            else None
        ),
    )


def _validated_hyperliquid_order(
    receipt: BrokerMutationReceiptSnapshot,
    payload: Mapping[str, object],
) -> dict[str, object]:
    nested = payload.get("order")
    order = cast(Mapping[str, object], nested) if isinstance(nested, dict) else payload
    request = _request_payload(receipt)
    cloid = _required_text(
        order.get("cloid") or order.get("client_order_id"),
        "cloid",
    )
    if cloid != receipt.intent.client_request_id:
        raise ValueError("hyperliquid_recovery_cloid_mismatch")
    if _required_text(order.get("coin"), "coin") != _required_text(
        request.get("coin"), "request_coin"
    ):
        raise ValueError("hyperliquid_recovery_coin_mismatch")
    if _side(order.get("side")) != _side(request.get("side")):
        raise ValueError("hyperliquid_recovery_side_mismatch")
    requested_size = _decimal(request.get("size"), "request_size")
    observed_size = _decimal(
        order.get("origSz") or order.get("sz") or order.get("size"),
        "order_size",
    )
    fill_only = str(order.get("source") or "") == "user_fills_by_time"
    if (not fill_only and observed_size != requested_size) or (
        fill_only and (observed_size <= 0 or observed_size > requested_size)
    ):
        raise ValueError("hyperliquid_recovery_size_mismatch")
    requested_limit = _decimal(request.get("limit_price"), "request_limit_price")
    observed_limit = _decimal(
        order.get("limitPx") or order.get("limit_price") or order.get("px"),
        "order_limit_price",
    )
    side = _side(request.get("side"))
    if (not fill_only and observed_limit != requested_limit) or (
        fill_only
        and (
            (side == "buy" and observed_limit > requested_limit)
            or (side == "sell" and observed_limit < requested_limit)
        )
    ):
        raise ValueError("hyperliquid_recovery_limit_price_mismatch")
    observed_tif = _optional_text(order.get("tif"))
    if (
        observed_tif is not None
        and observed_tif.lower()
        != _required_text(request.get("tif"), "request_tif").lower()
    ):
        raise ValueError("hyperliquid_recovery_tif_mismatch")
    status = _order_status(payload, order)
    exchange_order_id = _optional_text(
        order.get("oid") or order.get("order_id") or order.get("exchange_order_id")
    )
    if status != "rejected" and exchange_order_id is None:
        raise ValueError("hyperliquid_recovery_exchange_order_id_missing")
    return {
        "status": status,
        "exchange_order_id": exchange_order_id,
    }


def _request_payload(receipt: BrokerMutationReceiptSnapshot) -> Mapping[str, object]:
    try:
        document = json.loads(receipt.intent.canonical_intent_json)
    except (TypeError, ValueError) as exc:  # pragma: no cover - receipt verifier
        raise ValueError("hyperliquid_recovery_intent_invalid") from exc
    if not isinstance(document, dict):
        raise ValueError("hyperliquid_recovery_request_invalid")
    payload = cast(dict[str, object], document)
    request = payload.get("request")
    if not isinstance(request, dict):
        raise ValueError("hyperliquid_recovery_request_invalid")
    return cast(dict[str, object], request)


def _order_status(
    outer: Mapping[str, object],
    order: Mapping[str, object],
) -> OrderStatus:
    raw = outer.get("status") or order.get("status")
    if raw is None:
        raise ValueError("hyperliquid_recovery_order_status_invalid")
    normalized = str(raw).strip()
    canonical = normalized.replace("-", "").replace("_", "").replace(" ", "").lower()
    if canonical in {"open", "triggered", "accepted"}:
        return "accepted"
    if canonical == "filled":
        return "filled"
    if canonical in {"canceled", "cancelled", "scheduledcancel"} or canonical.endswith(
        "canceled"
    ):
        return "cancelled"
    if canonical == "rejected" or canonical.endswith("rejected"):
        return "rejected"
    raise ValueError("hyperliquid_recovery_order_status_invalid")


def _side(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"b", "buy"}:
        return "buy"
    if normalized in {"a", "s", "sell"}:
        return "sell"
    raise ValueError("hyperliquid_recovery_side_invalid")


def _required_text(value: object, field: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"hyperliquid_recovery_{field}_required")
    return normalized


def _optional_text(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _decimal(value: object, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"hyperliquid_recovery_{field}_invalid") from exc
    if not parsed.is_finite():
        raise ValueError(f"hyperliquid_recovery_{field}_invalid")
    return parsed


def _datetime(value: object, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError(f"hyperliquid_recovery_{field}_invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"hyperliquid_recovery_{field}_timezone_required")
    return parsed


__all__ = [
    "HYPERLIQUID_SUBMIT_RECOVERY_READ_SCHEMA_VERSION",
    "HyperliquidSubmitRecoveryRoute",
]
