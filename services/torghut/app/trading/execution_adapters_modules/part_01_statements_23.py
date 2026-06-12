# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from collections.abc import Mapping
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Optional, Protocol, cast
from urllib.parse import quote, urlencode
from urllib.parse import urlsplit
from uuid import uuid4

from ...alpaca_client import TorghutAlpacaClient
from ...config import settings
from ..firewall import OrderFirewall
from ..simulation_progress import active_simulation_runtime_context
from ..time_source import trading_now

# ruff: noqa: F401,F403,F405,F811,F821


logger = logging.getLogger(__name__)


class ExecutionAdapter(Protocol):
    """Contract used by order execution + reconciliation."""

    @property
    def name(self) -> str: ...

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]: ...

    def cancel_order(self, order_id: str) -> bool: ...

    def cancel_all_orders(self) -> list[dict[str, Any]]: ...

    def get_order(self, order_id: str) -> dict[str, Any]: ...

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None: ...

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]: ...

    def list_positions(self) -> list[dict[str, Any]] | None: ...


class AlpacaExecutionAdapter:
    """Default adapter that mutates via OrderFirewall and reads via TorghutAlpacaClient."""

    name = "alpaca"

    def __init__(
        self, *, firewall: OrderFirewall, read_client: TorghutAlpacaClient
    ) -> None:
        self._firewall = firewall
        self._read_client = read_client
        self.last_route = self.name

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        payload = self._firewall.submit_order(
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
        )
        self.last_route = self.name
        return payload

    def cancel_order(self, order_id: str) -> bool:
        self.last_route = self.name
        return self._firewall.cancel_order(order_id)

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        self.last_route = self.name
        return self._firewall.cancel_all_orders()

    def get_order(self, order_id: str) -> dict[str, Any]:
        return self._read_client.get_order(order_id)

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None:
        try:
            return self._read_client.get_order_by_client_order_id(client_order_id)
        except Exception:
            return None

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]:
        return self._read_client.list_orders(status=status)

    def list_positions(self) -> list[dict[str, Any]]:
        return self._read_client.list_positions()


class SimulationExecutionAdapter:
    """Deterministic no-side-effect adapter for historical simulation runs."""

    name = "simulation"

    def __init__(
        self,
        *,
        bootstrap_servers: str | None,
        security_protocol: str | None,
        sasl_mechanism: str | None,
        sasl_username: str | None,
        sasl_password: str | None,
        topic: str,
        account_label: str,
        simulation_run_id: str | None,
        dataset_id: str | None,
    ) -> None:
        self.last_route = self.name
        self.last_correlation_id: str | None = None
        self.last_idempotency_key: str | None = None
        self._topic = topic.strip() or "torghut.sim.trade-updates.v1"
        self._account_label = account_label.strip() or "paper"
        self._simulation_run_id = (simulation_run_id or "").strip() or "simulation"
        self._dataset_id = (dataset_id or "").strip() or "unknown"
        self._seq = 0
        self._orders_by_id: dict[str, dict[str, Any]] = {}
        self._order_id_by_client_id: dict[str, str] = {}
        self._positions_by_symbol: dict[str, Decimal] = {}
        self._position_market_value_by_symbol: dict[str, Decimal] = {}
        self._seeded_from_snapshot = False
        self._producer: Any | None = None
        self._producer_init_error: str | None = None
        self._kafka_security_kwargs: dict[str, str] = {}
        if security_protocol:
            self._kafka_security_kwargs["security_protocol"] = security_protocol
        if sasl_mechanism:
            self._kafka_security_kwargs["sasl_mechanism"] = sasl_mechanism
        if sasl_username:
            self._kafka_security_kwargs["sasl_plain_username"] = sasl_username
        if sasl_password:
            self._kafka_security_kwargs["sasl_plain_password"] = sasl_password
        if bootstrap_servers and bootstrap_servers.strip():
            self._producer = self._build_producer(bootstrap_servers.strip())

    def _sync_runtime_context(self) -> None:
        runtime_context = active_simulation_runtime_context()
        run_id = (runtime_context or {}).get("run_id") or self._simulation_run_id
        dataset_id = (runtime_context or {}).get("dataset_id") or self._dataset_id
        if run_id == self._simulation_run_id and dataset_id == self._dataset_id:
            return
        self._simulation_run_id = run_id
        self._dataset_id = dataset_id
        self._seq = 0
        self._orders_by_id = {}
        self._order_id_by_client_id = {}
        self._positions_by_symbol = {}
        self._position_market_value_by_symbol = {}
        self._seeded_from_snapshot = False

    def seed_positions_snapshot(self, positions: list[dict[str, Any]] | None) -> None:
        """Seed the adapter once from the broker snapshot used by decisioning."""

        self._sync_runtime_context()
        if self._seeded_from_snapshot:
            return
        seeded_positions: dict[str, Decimal] = {}
        seeded_market_values: dict[str, Decimal] = {}
        for raw_position in positions or []:
            symbol = str(raw_position.get("symbol") or "").strip().upper()
            if not symbol:
                continue
            raw_qty = raw_position.get("qty") or raw_position.get("quantity")
            if raw_qty is None:
                continue
            try:
                qty = Decimal(str(raw_qty))
            except Exception:
                continue
            if qty == 0:
                continue
            side = str(raw_position.get("side") or "").strip().lower()
            signed_qty = -abs(qty) if side == "short" else qty
            net_qty = seeded_positions.get(symbol, Decimal("0")) + signed_qty
            if net_qty == 0:
                seeded_positions.pop(symbol, None)
                seeded_market_values.pop(symbol, None)
                continue
            seeded_positions[symbol] = net_qty
            signed_market_value = _signed_position_market_value(raw_position, side=side)
            if signed_market_value is not None:
                seeded_market_values[symbol] = (
                    seeded_market_values.get(symbol, Decimal("0")) + signed_market_value
                )
        self._positions_by_symbol = seeded_positions
        self._position_market_value_by_symbol = seeded_market_values
        self._seeded_from_snapshot = True

    def seed_missing_position_snapshot(self, position: Mapping[str, Any]) -> bool:
        """Restore a single missing simulation position from a durable runtime source."""

        self._sync_runtime_context()
        symbol = str(position.get("symbol") or "").strip().upper()
        if not symbol:
            return False
        if self._positions_by_symbol.get(symbol, Decimal("0")) != 0:
            return False
        raw_qty = position.get("qty") or position.get("quantity")
        if raw_qty is None:
            return False
        try:
            qty = Decimal(str(raw_qty))
        except Exception:
            return False
        if qty <= 0:
            return False
        side = str(position.get("side") or "").strip().lower()
        signed_qty = -abs(qty) if side == "short" else qty
        self._positions_by_symbol[symbol] = signed_qty
        signed_market_value = _signed_position_market_value(position, side=side)
        if signed_market_value is not None:
            self._position_market_value_by_symbol[symbol] = signed_market_value
        return True

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self._sync_runtime_context()
        payload = dict(extra_params or {})
        requested_client_order_id = payload.get("client_order_id")
        client_order_id = (
            str(requested_client_order_id).strip() if requested_client_order_id else ""
        )
        if not client_order_id:
            client_order_id = f"sim-client-{uuid4().hex[:20]}"
        correlation_id = f"sim-{uuid4().hex[:20]}"
        idempotency_key = client_order_id
        simulation_context = _resolve_simulation_context_payload(
            simulation_run_id=self._simulation_run_id,
            dataset_id=self._dataset_id,
            symbol=symbol,
            source=payload.get("simulation_context")
            if isinstance(payload.get("simulation_context"), Mapping)
            else None,
        )
        now = _resolve_simulation_event_ts(
            simulation_context=simulation_context,
            account_label=self._account_label,
        )
        order_id = self._order_id_by_client_id.get(client_order_id)
        if order_id is None:
            order_id = f"sim-order-{uuid4().hex[:20]}"
        fill_price = _resolve_simulated_fill_price(
            limit_price=limit_price,
            stop_price=stop_price,
            simulation_context=simulation_context,
        )
        qty_value = max(float(qty), 0.0)
        filled_qty_value = _resolve_simulated_filled_qty(
            requested_qty=qty_value,
            simulation_context=simulation_context,
        )
        order_status = _simulated_order_status(
            requested_qty=qty_value,
            filled_qty=filled_qty_value,
        )
        trade_update_event = _simulated_trade_update_event(
            requested_qty=qty_value,
            filled_qty=filled_qty_value,
        )
        order: dict[str, Any] = {
            "id": order_id,
            "client_order_id": client_order_id,
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
            "qty": _float_to_order_text(qty_value),
            "filled_qty": _float_to_order_text(filled_qty_value),
            "filled_avg_price": _float_to_order_text(fill_price)
            if filled_qty_value > 0
            else None,
            "status": order_status,
            "submitted_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "alpaca_account_label": self._account_label,
            "_execution_adapter": self.name,
            "_execution_route_expected": self.name,
            "_execution_route_actual": self.name,
            "_execution_correlation_id": correlation_id,
            "_execution_idempotency_key": idempotency_key,
        }
        order["_simulation_context"] = simulation_context
        order["simulation_context"] = simulation_context
        order["_execution_audit"] = {
            "adapter": self.name,
            "correlation_id": correlation_id,
            "idempotency_key": idempotency_key,
            "mode": "historical_simulation",
            "simulation_context": simulation_context,
        }
        self.last_route = self.name
        self.last_correlation_id = correlation_id
        self.last_idempotency_key = idempotency_key
        self._orders_by_id[order_id] = dict(order)
        self._order_id_by_client_id[client_order_id] = order_id
        if filled_qty_value > 0:
            self._apply_fill_to_positions(order)
        self._publish_trade_update(order, event_type=trade_update_event, event_ts=now)
        return dict(order)

    def cancel_order(self, order_id: str) -> bool:
        self._sync_runtime_context()
        order = self._orders_by_id.get(order_id)
        if order is None:
            return False
        current_status = str(order.get("status") or "").strip().lower()
        if current_status in {"filled", "canceled", "cancelled", "rejected", "expired"}:
            self.last_route = self.name
            return False
        now = trading_now(account_label=self._account_label)
        order["status"] = "canceled"
        order["updated_at"] = now.isoformat()
        order["filled_qty"] = order.get("filled_qty") or "0"
        self._publish_trade_update(order, event_type="canceled", event_ts=now)
        self.last_route = self.name
        return True

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        self._sync_runtime_context()
        canceled: list[dict[str, Any]] = []
        for order_id in list(self._orders_by_id):
            if self.cancel_order(order_id):
                canceled.append({"id": order_id})
        self.last_route = self.name
        return canceled

    def get_order(self, order_id: str) -> dict[str, Any]:
        self._sync_runtime_context()
        self.last_route = self.name
        existing = self._orders_by_id.get(order_id)
        if existing is None:
            return {
                "id": order_id,
                "status": "not_found",
                "_execution_adapter": self.name,
            }
        return dict(existing)

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None:
        self._sync_runtime_context()
        self.last_route = self.name
        order_id = self._order_id_by_client_id.get(client_order_id)
        if order_id is None:
            return None
        existing = self._orders_by_id.get(order_id)
        if existing is None:
            return None
        return dict(existing)

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]:
        self._sync_runtime_context()
        self.last_route = self.name
        normalized = status.strip().lower()
        values = list(self._orders_by_id.values())
        if normalized in {"all", ""}:
            return [dict(value) for value in values]
        return [
            dict(value)
            for value in values
            if str(value.get("status", "")).strip().lower() == normalized
        ]

    def list_positions(self) -> list[dict[str, Any]]:
        self._sync_runtime_context()
        self.last_route = self.name
        positions: list[dict[str, Any]] = []
        for symbol, net_qty in sorted(self._positions_by_symbol.items()):
            if net_qty == 0:
                continue
            side = "long" if net_qty > 0 else "short"
            position = {
                "symbol": symbol,
                "qty": _decimal_to_order_text(abs(net_qty)),
                "side": side,
                "alpaca_account_label": self._account_label,
            }
            market_value = self._position_market_value_by_symbol.get(symbol)
            if market_value is not None:
                position["market_value"] = _signed_decimal_to_text(market_value)
            positions.append(position)
        return positions

    def _apply_fill_to_positions(self, order: Mapping[str, Any]) -> None:
        symbol = str(order.get("symbol") or "").strip().upper()
        if not symbol:
            return
        raw_qty = order.get("filled_qty") or order.get("qty")
        try:
            qty = Decimal(str(raw_qty or "0"))
        except Exception:
            return
        if qty <= 0:
            return
        side = str(order.get("side") or "").strip().lower()
        delta = qty if side == "buy" else -qty
        current_qty = self._positions_by_symbol.get(symbol, Decimal("0"))
        updated = current_qty + delta
        if updated == 0:
            self._positions_by_symbol.pop(symbol, None)
            self._position_market_value_by_symbol.pop(symbol, None)
            return
        self._positions_by_symbol[symbol] = updated

        fill_price = _optional_decimal(order.get("filled_avg_price"))
        if fill_price is None:
            return
        market_value_delta = delta * fill_price
        current_market_value = self._position_market_value_by_symbol.get(symbol)
        if current_market_value is not None:
            self._position_market_value_by_symbol[symbol] = (
                current_market_value + market_value_delta
            )
            return
        if current_qty == 0:
            self._position_market_value_by_symbol[symbol] = market_value_delta
            return
        if current_qty > 0 > updated or current_qty < 0 < updated:
            self._position_market_value_by_symbol[symbol] = updated * fill_price

    def _build_producer(self, bootstrap_servers: str) -> Any | None:
        try:
            from kafka import KafkaProducer  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - dependency/runtime error
            self._producer_init_error = f"kafka_import_failed:{exc}"
            logger.warning(
                "Simulation adapter cannot emit trade-updates topic=%s reason=%s",
                self._topic,
                self._producer_init_error,
            )
            return None

        try:
            return cast(
                Any,
                KafkaProducer(
                    bootstrap_servers=[
                        item.strip()
                        for item in bootstrap_servers.split(",")
                        if item.strip()
                    ],
                    value_serializer=None,
                    key_serializer=None,
                    retries=1,
                    request_timeout_ms=2_000,
                    max_block_ms=2_000,
                    **self._kafka_security_kwargs,
                ),
            )
        except Exception as exc:  # pragma: no cover - environment-dependent
            self._producer_init_error = f"kafka_producer_init_failed:{exc}"
            logger.warning(
                "Simulation adapter cannot initialize Kafka producer topic=%s reason=%s",
                self._topic,
                self._producer_init_error,
            )
            return None

    def _publish_trade_update(
        self, order: Mapping[str, Any], *, event_type: str, event_ts: datetime
    ) -> None:
        self._seq += 1
        simulation_context = (
            dict(cast(Mapping[str, Any], order.get("simulation_context")))
            if isinstance(order.get("simulation_context"), Mapping)
            else _resolve_simulation_context_payload(
                simulation_run_id=self._simulation_run_id,
                dataset_id=self._dataset_id,
                symbol=str(order.get("symbol") or "").strip().upper(),
                source=None,
            )
        )
        envelope = {
            "channel": "trade_updates",
            "event_ts": event_ts.isoformat(),
            "seq": self._seq,
            "symbol": order.get("symbol"),
            "account_label": self._account_label,
            "accountLabel": self._account_label,
            "source": "simulation",
            "simulation_context": simulation_context,
            "payload": {
                "event": event_type,
                "timestamp": event_ts.isoformat(),
                "account_label": self._account_label,
                "order": {
                    "id": order.get("id"),
                    "client_order_id": order.get("client_order_id"),
                    "symbol": order.get("symbol"),
                    "status": order.get("status"),
                    "side": order.get("side"),
                    "type": order.get("type"),
                    "time_in_force": order.get("time_in_force"),
                    "qty": order.get("qty"),
                    "filled_qty": order.get("filled_qty"),
                    "filled_avg_price": order.get("filled_avg_price"),
                    "alpaca_account_label": self._account_label,
                },
            },
        }
        if self._producer is None:
            if self._producer_init_error is None:
                logger.debug(
                    "Simulation adapter producer disabled; skip trade-update publish topic=%s",
                    self._topic,
                )
            return

        try:
            payload = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
            key = str(order.get("symbol") or "").encode("utf-8")
            self._producer.send(
                self._topic,
                key=key,
                value=payload,
                timestamp_ms=int(event_ts.timestamp() * 1000),
            )
            self._producer.flush(timeout=1.5)
        except Exception:
            logger.warning(
                "Simulation adapter failed to publish trade-update topic=%s order_id=%s",
                self._topic,
                order.get("id"),
                exc_info=True,
            )


__all__ = [name for name in globals() if not name.startswith("__")]
