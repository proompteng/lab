"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from importlib import import_module
from datetime import datetime
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any, Optional, Protocol, cast
from uuid import uuid4

from ...alpaca_client import TorghutAlpacaClient
from ..firewall import OrderFirewall
from ..simulation_progress import active_simulation_runtime_context
from ..time_source import trading_now

from .order_text import (
    decimal_to_order_text,
    float_to_order_text,
    optional_decimal,
    resolve_simulation_context_payload,
    signed_decimal_to_text,
    signed_position_market_value,
)
from .simulation_orders import (
    resolve_simulated_fill_price,
    resolve_simulated_filled_qty,
    resolve_simulation_event_ts,
    simulated_order_status,
    simulated_trade_update_event,
)


logger = logging.getLogger(__name__)


def _active_simulation_runtime_context() -> Mapping[str, Any] | None:
    provider: Callable[[], object] = active_simulation_runtime_context
    try:
        execution_adapters_api = import_module("app.trading.execution_adapters")
        patched_provider = getattr(
            execution_adapters_api,
            "active_simulation_runtime_context",
            provider,
        )
        if callable(patched_provider):
            provider = cast(Callable[[], object], patched_provider)
    except Exception:
        pass
    context = provider()
    if isinstance(context, Mapping):
        return cast(Mapping[str, Any], context)
    return None


@dataclass(frozen=True)
class OrderSubmission:
    symbol: str
    side: str
    qty: float
    order_type: str
    time_in_force: str
    limit_price: Optional[float]
    stop_price: Optional[float]
    extra_params: Optional[dict[str, Any]]


@dataclass(frozen=True)
class SimulationAdapterConfig:
    bootstrap_servers: str | None
    security_protocol: str | None
    sasl_mechanism: str | None
    sasl_username: str | None
    sasl_password: str | None
    topic: str
    account_label: str
    simulation_run_id: str | None
    dataset_id: str | None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> "SimulationAdapterConfig":
        return cls(
            bootstrap_servers=cast(str | None, values.get("bootstrap_servers")),
            security_protocol=cast(str | None, values.get("security_protocol")),
            sasl_mechanism=cast(str | None, values.get("sasl_mechanism")),
            sasl_username=cast(str | None, values.get("sasl_username")),
            sasl_password=cast(str | None, values.get("sasl_password")),
            topic=str(values.get("topic") or "torghut.sim.trade-updates.v1"),
            account_label=str(values.get("account_label") or "paper"),
            simulation_run_id=cast(str | None, values.get("simulation_run_id")),
            dataset_id=cast(str | None, values.get("dataset_id")),
        )


@dataclass(frozen=True)
class SimulationOrderDraft:
    request: OrderSubmission
    client_order_id: str
    correlation_id: str
    idempotency_key: str
    simulation_context: dict[str, Any]
    event_ts: datetime
    order_id: str
    fill_price: float
    requested_qty: float
    filled_qty: float
    order_status: str
    trade_update_event: str


@dataclass(frozen=True)
class PositionMarketValueUpdate:
    symbol: str
    current_qty: Decimal
    updated_qty: Decimal
    market_value_delta: Decimal
    fill_price: Decimal


class ExecutionAdapter(Protocol):
    """Contract used by order execution + reconciliation."""

    @property
    def name(self) -> str: ...

    def submit_order(
        self,
        request: OrderSubmission,
        /,
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
        request: OrderSubmission,
        /,
    ) -> dict[str, Any]:
        payload = self._firewall.submit_order(
            symbol=request.symbol,
            side=request.side,
            qty=request.qty,
            order_type=request.order_type,
            time_in_force=request.time_in_force,
            limit_price=request.limit_price,
            stop_price=request.stop_price,
            extra_params=request.extra_params,
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

    def __init__(self, **config_values: Any) -> None:
        config = SimulationAdapterConfig.from_kwargs(config_values)
        self.last_route = self.name
        self.last_correlation_id: str | None = None
        self.last_idempotency_key: str | None = None
        self._topic = config.topic.strip() or "torghut.sim.trade-updates.v1"
        self._account_label = config.account_label.strip() or "paper"
        self._simulation_run_id = (
            config.simulation_run_id or ""
        ).strip() or "simulation"
        self._dataset_id = (config.dataset_id or "").strip() or "unknown"
        self._seq = 0
        self._orders_by_id: dict[str, dict[str, Any]] = {}
        self._order_id_by_client_id: dict[str, str] = {}
        self._positions_by_symbol: dict[str, Decimal] = {}
        self._position_market_value_by_symbol: dict[str, Decimal] = {}
        self._seeded_from_snapshot = False
        self._producer: Any | None = None
        self._producer_init_error: str | None = None
        self._kafka_security_kwargs: dict[str, str] = {}
        if config.security_protocol:
            self._kafka_security_kwargs["security_protocol"] = config.security_protocol
        if config.sasl_mechanism:
            self._kafka_security_kwargs["sasl_mechanism"] = config.sasl_mechanism
        if config.sasl_username:
            self._kafka_security_kwargs["sasl_plain_username"] = config.sasl_username
        if config.sasl_password:
            self._kafka_security_kwargs["sasl_plain_password"] = config.sasl_password
        if config.bootstrap_servers and config.bootstrap_servers.strip():
            self._producer = self._build_producer(config.bootstrap_servers.strip())

    def _sync_runtime_context(self) -> None:
        runtime_context = _active_simulation_runtime_context()
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
            signed_market_value = signed_position_market_value(raw_position, side=side)
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
        signed_market_value = signed_position_market_value(position, side=side)
        if signed_market_value is not None:
            self._position_market_value_by_symbol[symbol] = signed_market_value
        return True

    def submit_order(
        self,
        request: OrderSubmission,
        /,
    ) -> dict[str, Any]:
        self._sync_runtime_context()
        draft = self._simulation_order_draft(request)
        order = self._simulation_order_payload(draft)
        self._store_simulation_order(draft, order)
        if draft.filled_qty > 0:
            self._apply_fill_to_positions(order)
        self._publish_trade_update(
            order, event_type=draft.trade_update_event, event_ts=draft.event_ts
        )
        return dict(order)

    def _simulation_order_draft(self, request: OrderSubmission) -> SimulationOrderDraft:
        payload = dict(request.extra_params or {})
        requested_client_order_id = payload.get("client_order_id")
        client_order_id = (
            str(requested_client_order_id).strip() if requested_client_order_id else ""
        )
        if not client_order_id:
            client_order_id = f"sim-client-{uuid4().hex[:20]}"
        simulation_context = resolve_simulation_context_payload(
            simulation_run_id=self._simulation_run_id,
            dataset_id=self._dataset_id,
            symbol=request.symbol,
            source=payload.get("simulation_context")
            if isinstance(payload.get("simulation_context"), Mapping)
            else None,
        )
        event_ts = resolve_simulation_event_ts(
            simulation_context=simulation_context,
            account_label=self._account_label,
        )
        requested_qty = max(float(request.qty), 0.0)
        filled_qty = resolve_simulated_filled_qty(
            requested_qty=requested_qty,
            simulation_context=simulation_context,
        )
        return SimulationOrderDraft(
            request=request,
            client_order_id=client_order_id,
            correlation_id=f"sim-{uuid4().hex[:20]}",
            idempotency_key=client_order_id,
            simulation_context=simulation_context,
            event_ts=event_ts,
            order_id=self._order_id_by_client_id.get(client_order_id)
            or f"sim-order-{uuid4().hex[:20]}",
            fill_price=resolve_simulated_fill_price(
                limit_price=request.limit_price,
                stop_price=request.stop_price,
                simulation_context=simulation_context,
            ),
            requested_qty=requested_qty,
            filled_qty=filled_qty,
            order_status=simulated_order_status(
                requested_qty=requested_qty,
                filled_qty=filled_qty,
            ),
            trade_update_event=simulated_trade_update_event(
                requested_qty=requested_qty,
                filled_qty=filled_qty,
            ),
        )

    def _simulation_order_payload(self, draft: SimulationOrderDraft) -> dict[str, Any]:
        request = draft.request
        order: dict[str, Any] = {
            "id": draft.order_id,
            "client_order_id": draft.client_order_id,
            "symbol": request.symbol,
            "side": request.side,
            "type": request.order_type,
            "time_in_force": request.time_in_force,
            "qty": float_to_order_text(draft.requested_qty),
            "filled_qty": float_to_order_text(draft.filled_qty),
            "filled_avg_price": float_to_order_text(draft.fill_price)
            if draft.filled_qty > 0
            else None,
            "status": draft.order_status,
            "submitted_at": draft.event_ts.isoformat(),
            "updated_at": draft.event_ts.isoformat(),
            "alpaca_account_label": self._account_label,
            "_execution_adapter": self.name,
            "_execution_route_expected": self.name,
            "_execution_route_actual": self.name,
            "_execution_correlation_id": draft.correlation_id,
            "_execution_idempotency_key": draft.idempotency_key,
        }
        order["_simulation_context"] = draft.simulation_context
        order["simulation_context"] = draft.simulation_context
        order["_execution_audit"] = {
            "adapter": self.name,
            "correlation_id": draft.correlation_id,
            "idempotency_key": draft.idempotency_key,
            "mode": "historical_simulation",
            "simulation_context": draft.simulation_context,
        }
        return order

    def _store_simulation_order(
        self, draft: SimulationOrderDraft, order: dict[str, Any]
    ) -> None:
        self.last_route = self.name
        self.last_correlation_id = draft.correlation_id
        self.last_idempotency_key = draft.idempotency_key
        self._orders_by_id[draft.order_id] = dict(order)
        self._order_id_by_client_id[draft.client_order_id] = draft.order_id

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
                "qty": decimal_to_order_text(abs(net_qty)),
                "side": side,
                "alpaca_account_label": self._account_label,
            }
            market_value = self._position_market_value_by_symbol.get(symbol)
            if market_value is not None:
                position["market_value"] = signed_decimal_to_text(market_value)
            positions.append(position)
        return positions

    def _apply_fill_to_positions(self, order: Mapping[str, Any]) -> None:
        parsed = self._filled_position_delta(order)
        if parsed is None:
            return
        symbol, delta, fill_price = parsed
        current_qty = self._positions_by_symbol.get(symbol, Decimal("0"))
        updated = current_qty + delta
        if updated == 0:
            self._positions_by_symbol.pop(symbol, None)
            self._position_market_value_by_symbol.pop(symbol, None)
        else:
            self._positions_by_symbol[symbol] = updated
            self._update_position_market_value(
                PositionMarketValueUpdate(
                    symbol=symbol,
                    current_qty=current_qty,
                    updated_qty=updated,
                    market_value_delta=delta * fill_price,
                    fill_price=fill_price,
                )
            )

    def _update_position_market_value(self, update: PositionMarketValueUpdate) -> None:
        current_market_value = self._position_market_value_by_symbol.get(update.symbol)
        if current_market_value is not None:
            self._position_market_value_by_symbol[update.symbol] = (
                current_market_value + update.market_value_delta
            )
        elif update.current_qty == 0:
            self._position_market_value_by_symbol[update.symbol] = (
                update.market_value_delta
            )
        elif (
            update.current_qty > 0 > update.updated_qty
            or update.current_qty < 0 < update.updated_qty
        ):
            self._position_market_value_by_symbol[update.symbol] = (
                update.updated_qty * update.fill_price
            )

    @staticmethod
    def _filled_position_delta(
        order: Mapping[str, Any],
    ) -> tuple[str, Decimal, Decimal] | None:
        symbol = str(order.get("symbol") or "").strip().upper()
        if not symbol:
            return None
        raw_qty = order.get("filled_qty") or order.get("qty")
        try:
            qty = Decimal(str(raw_qty or "0"))
        except Exception:
            return None
        if qty <= 0:
            return None
        side = str(order.get("side") or "").strip().lower()
        delta = qty if side == "buy" else -qty
        fill_price = optional_decimal(order.get("filled_avg_price"))
        if fill_price is None:
            return None
        return symbol, delta, fill_price

    def _build_producer(self, bootstrap_servers: str) -> Any | None:
        try:
            kafka_module = import_module("kafka")
            kafka_producer = getattr(kafka_module, "KafkaProducer")
        except Exception as exc:  # pragma: no cover - dependency/runtime error
            self._producer_init_error = f"kafka_import_failed:{exc}"
            logger.warning(
                "Simulation adapter cannot emit trade-updates topic=%s reason=%s",
                self._topic,
                self._producer_init_error,
            )
            return None

        try:
            return kafka_producer(
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
            else resolve_simulation_context_payload(
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


__all__ = [
    "AlpacaExecutionAdapter",
    "ExecutionAdapter",
    "SimulationExecutionAdapter",
    "logger",
]
