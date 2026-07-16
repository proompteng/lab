"""Fresh broker reconciliation for immutable economic-ledger projections."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from typing import Protocol, cast

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from ...models import (
    BrokerEconomicLedgerInput,
    BrokerEconomicLedgerReconciliation,
)
from ..broker_account_activities import as_utc
from .persistence import (
    BrokerEconomicLedgerReplay,
    PublishedBrokerEconomicLedgerRuns,
    require_published_broker_economic_ledger_runs,
)
from .types import (
    LEDGER_DECIMAL_PRECISION,
    ZERO,
    EconomicLedgerError,
    EconomicProjection,
    LedgerScope,
    canonical_sha256,
    decimal_text,
    notional_multiplier_for_symbol,
    quantize_ledger_decimal,
)


DEFAULT_SOURCE_MAX_AGE_SECONDS = 300
DEFAULT_OBSERVATION_MAX_AGE_SECONDS = 7_200
_SCHEMA_VERSION = "torghut.broker-economic-ledger-reconciliation.v1"
_STATUS_SCHEMA_VERSION = "torghut.broker-economic-ledger-status.v1"
_SNAPSHOT_SCHEMA_VERSION = "torghut.broker-economic-snapshot.v1"
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40,64}$")
_IMAGE_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class ReadOnlyBrokerSnapshotClient(Protocol):
    def get_account(self) -> dict[str, object]: ...

    def list_positions(self) -> list[dict[str, object]]: ...

    def list_open_orders(self) -> list[dict[str, object]]: ...


@dataclass(frozen=True, slots=True)
class BrokerEconomicPosition:
    symbol: str
    quantity: Decimal
    average_entry_price: Decimal
    current_price: Decimal
    market_value: Decimal
    unrealized_pnl: Decimal

    def to_payload(self) -> dict[str, object]:
        return {
            "average_entry_price": decimal_text(self.average_entry_price),
            "current_price": decimal_text(self.current_price),
            "market_value": decimal_text(self.market_value),
            "quantity": decimal_text(self.quantity),
            "symbol": self.symbol,
            "unrealized_pnl": decimal_text(self.unrealized_pnl),
        }


@dataclass(frozen=True, slots=True)
class BrokerEconomicOpenOrder:
    order_id: str
    client_order_id: str | None
    symbol: str
    side: str
    quantity: Decimal
    filled_quantity: Decimal
    status: str
    order_type: str

    def to_payload(self) -> dict[str, object]:
        return {
            "client_order_id": self.client_order_id,
            "filled_quantity": decimal_text(self.filled_quantity),
            "order_id": self.order_id,
            "order_type": self.order_type,
            "quantity": decimal_text(self.quantity),
            "side": self.side,
            "status": self.status,
            "symbol": self.symbol,
        }


@dataclass(frozen=True, slots=True)
class BrokerEconomicSnapshot:
    observed_at: datetime
    account_status: str
    cash: Decimal
    equity: Decimal
    positions: tuple[BrokerEconomicPosition, ...]
    open_orders: tuple[BrokerEconomicOpenOrder, ...]
    payload: dict[str, object] = field(init=False, repr=False)
    sha256: str = field(init=False)

    def __post_init__(self) -> None:
        observed_at = as_utc(self.observed_at)
        object.__setattr__(self, "observed_at", observed_at)
        payload: dict[str, object] = {
            "schema_version": _SNAPSHOT_SCHEMA_VERSION,
            "observed_at": observed_at.isoformat(),
            "account": {
                "cash": decimal_text(self.cash),
                "equity": decimal_text(self.equity),
                "status": self.account_status,
            },
            "open_orders": [order.to_payload() for order in self.open_orders],
            "positions": [position.to_payload() for position in self.positions],
        }
        object.__setattr__(self, "payload", payload)
        object.__setattr__(self, "sha256", canonical_sha256(payload))


@dataclass(frozen=True, slots=True)
class BrokerEconomicResidual:
    path: str
    classification: str
    ledger: str | None
    broker: str | None
    difference: str | None

    def to_payload(self) -> dict[str, object]:
        return {
            "broker": self.broker,
            "classification": self.classification,
            "difference": self.difference,
            "ledger": self.ledger,
            "path": self.path,
        }


@dataclass(frozen=True, slots=True)
class BrokerEconomicReconciliationResult:
    payload: dict[str, object]
    reconciled: bool
    residual_count: int
    open_order_count: int
    source_age_seconds: int
    result_sha256: str = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "result_sha256", canonical_sha256(self.payload))


@dataclass(frozen=True, slots=True)
class PersistedBrokerEconomicReconciliation:
    observation_id: uuid.UUID
    runs: PublishedBrokerEconomicLedgerRuns
    result: BrokerEconomicReconciliationResult


@dataclass(frozen=True, slots=True)
class BrokerEconomicReconciliationBuild:
    source_commit: str
    image_digest: str

    def __post_init__(self) -> None:
        _require_build_identity(
            source_commit=self.source_commit,
            image_digest=self.image_digest,
        )


def capture_broker_economic_snapshot(
    client: ReadOnlyBrokerSnapshotClient,
    *,
    observed_at: datetime | None = None,
) -> BrokerEconomicSnapshot:
    """Read one compact broker snapshot without exposing account identity or secrets."""

    return normalize_broker_economic_snapshot(
        account=client.get_account(),
        positions=client.list_positions(),
        open_orders=client.list_open_orders(),
        observed_at=observed_at or datetime.now(timezone.utc),
    )


def normalize_broker_economic_snapshot(
    *,
    account: object,
    positions: object,
    open_orders: object,
    observed_at: datetime,
) -> BrokerEconomicSnapshot:
    account_row = _mapping(account, "economic_broker_account_invalid")
    account_status = _required_text(
        account_row.get("status"), "economic_broker_account_status_invalid"
    ).upper()
    if account_status != "ACTIVE":
        raise EconomicLedgerError("economic_broker_account_not_active")
    cash = _required_decimal(account_row.get("cash"), "economic_broker_cash_invalid")
    equity = _required_decimal(
        account_row.get("equity"), "economic_broker_equity_invalid"
    )
    position_rows = _sequence(positions, "economic_broker_positions_invalid")
    order_rows = _sequence(open_orders, "economic_broker_open_orders_invalid")
    normalized_positions = tuple(
        sorted(
            (_normalize_position(row) for row in position_rows),
            key=lambda item: item.symbol,
        )
    )
    if len({position.symbol for position in normalized_positions}) != len(
        normalized_positions
    ):
        raise EconomicLedgerError("economic_broker_position_duplicate_symbol")
    normalized_orders = tuple(
        sorted(
            (_normalize_open_order(row) for row in order_rows),
            key=lambda item: (item.order_id, item.client_order_id or ""),
        )
    )
    return BrokerEconomicSnapshot(
        observed_at=observed_at,
        account_status=account_status,
        cash=cash,
        equity=equity,
        positions=normalized_positions,
        open_orders=normalized_orders,
    )


def reconcile_broker_economic_ledger(
    replay: BrokerEconomicLedgerReplay,
    snapshot: BrokerEconomicSnapshot,
    *,
    runs: PublishedBrokerEconomicLedgerRuns,
    build: BrokerEconomicReconciliationBuild,
    max_source_age_seconds: int = DEFAULT_SOURCE_MAX_AGE_SECONDS,
) -> BrokerEconomicReconciliationResult:
    """Compare a published reducer pair with one fresh read-only broker snapshot."""

    if max_source_age_seconds <= 0:
        raise ValueError("economic_reconciliation_max_source_age_invalid")
    watermark = as_utc(replay.snapshot.source_watermark)
    if snapshot.observed_at < watermark:
        raise EconomicLedgerError("economic_reconciliation_snapshot_before_watermark")
    source_age_seconds = int((snapshot.observed_at - watermark).total_seconds())
    projection = replay.reduction.journal.projection
    residuals = _economic_residuals(
        projection,
        snapshot=snapshot,
        source_age_seconds=source_age_seconds,
        max_source_age_seconds=max_source_age_seconds,
    )
    reason_codes = {residual.classification for residual in residuals}
    if not replay.reduction.comparison.equivalent:
        reason_codes.add("economic_reducer_differential_present")
    if not replay.reduction.admissible:
        reason_codes.add("economic_projection_not_admissible")
    reconciled = not reason_codes
    ledger_values = _marked_ledger_values(projection, snapshot=snapshot)
    broker_unrealized = _sum_decimal(
        position.unrealized_pnl for position in snapshot.positions
    )
    payload: dict[str, object] = {
        "schema_version": _SCHEMA_VERSION,
        "reconciled": reconciled,
        "reason_codes": sorted(reason_codes),
        "residual_count": len(residuals),
        "open_order_count": len(snapshot.open_orders),
        "source_age_seconds": source_age_seconds,
        "max_source_age_seconds": max_source_age_seconds,
        "input_source_watermark": runs.source_watermark.isoformat(),
        "source_watermark": watermark.isoformat(),
        "observed_at": snapshot.observed_at.isoformat(),
        "source_commit": build.source_commit,
        "image_digest": build.image_digest,
        "input_id": str(runs.input_id),
        "journal_run_id": str(runs.journal_run_id),
        "state_run_id": str(runs.state_run_id),
        "input_manifest_sha256": replay.snapshot.prepared.manifest_digest,
        "comparison_sha256": replay.reduction.comparison.comparison_digest,
        "journal_sha256": replay.reduction.journal.journal_digest,
        "broker_snapshot_sha256": snapshot.sha256,
        "reducers": {
            "journal": projection.reducer_version,
            "state": replay.reduction.independent.reducer_version,
            "differential_equivalent": replay.reduction.comparison.equivalent,
            "admissible": replay.reduction.admissible,
        },
        "economics": {
            "broker": {
                "cash": decimal_text(snapshot.cash),
                "equity": decimal_text(snapshot.equity),
                "unrealized_pnl": decimal_text(broker_unrealized),
            },
            "ledger": {
                "cash": decimal_text(ledger_values.cash),
                "equity": (
                    decimal_text(ledger_values.equity)
                    if ledger_values.equity is not None
                    else None
                ),
                "unrealized_pnl": (
                    decimal_text(ledger_values.unrealized_pnl)
                    if ledger_values.unrealized_pnl is not None
                    else None
                ),
            },
        },
        "residuals": [residual.to_payload() for residual in residuals],
    }
    return BrokerEconomicReconciliationResult(
        payload=payload,
        reconciled=reconciled,
        residual_count=len(residuals),
        open_order_count=len(snapshot.open_orders),
        source_age_seconds=source_age_seconds,
    )


def persist_broker_economic_ledger_reconciliation(
    session: Session,
    replay: BrokerEconomicLedgerReplay,
    snapshot: BrokerEconomicSnapshot,
    *,
    build: BrokerEconomicReconciliationBuild,
    max_source_age_seconds: int = DEFAULT_SOURCE_MAX_AGE_SECONDS,
) -> PersistedBrokerEconomicReconciliation:
    """Append one observation only after resolving the exact published run pair."""

    runs = require_published_broker_economic_ledger_runs(session, replay)
    result = reconcile_broker_economic_ledger(
        replay,
        snapshot,
        runs=runs,
        build=build,
        max_source_age_seconds=max_source_age_seconds,
    )
    observation_id = uuid.uuid4()
    snapshot_canonical_json = _canonical_json(snapshot.payload)
    result_canonical_json = _canonical_json(result.payload)
    session.execute(
        insert(BrokerEconomicLedgerReconciliation),
        [
            {
                "id": observation_id,
                "input_id": runs.input_id,
                "journal_run_id": runs.journal_run_id,
                "state_run_id": runs.state_run_id,
                "input_source_watermark": runs.source_watermark,
                "source_watermark": replay.snapshot.source_watermark,
                "observed_at": snapshot.observed_at,
                "source_age_seconds": result.source_age_seconds,
                "max_source_age_seconds": max_source_age_seconds,
                "broker_snapshot": snapshot.payload,
                "broker_snapshot_canonical_json": snapshot_canonical_json,
                "broker_snapshot_sha256": _sha256(snapshot_canonical_json),
                "result": result.payload,
                "result_canonical_json": result_canonical_json,
                "result_sha256": _sha256(result_canonical_json),
                "comparison_sha256": replay.reduction.comparison.comparison_digest,
                "journal_sha256": replay.reduction.journal.journal_digest,
                "reconciled": result.reconciled,
                "residual_count": result.residual_count,
                "open_order_count": result.open_order_count,
                "source_commit": build.source_commit,
                "image_digest": build.image_digest,
            }
        ],
    )
    return PersistedBrokerEconomicReconciliation(
        observation_id=observation_id,
        runs=runs,
        result=result,
    )


def load_broker_economic_ledger_status(
    session: Session,
    *,
    scope: LedgerScope,
    observed_at: datetime,
    max_observation_age_seconds: int = DEFAULT_OBSERVATION_MAX_AGE_SECONDS,
) -> dict[str, object]:
    """Load the latest bounded Slice 8 observation; it has no capital authority."""

    if max_observation_age_seconds <= 0:
        raise ValueError("economic_status_max_observation_age_invalid")
    row = session.scalar(
        select(BrokerEconomicLedgerReconciliation)
        .join(
            BrokerEconomicLedgerInput,
            BrokerEconomicLedgerInput.id == BrokerEconomicLedgerReconciliation.input_id,
        )
        .where(
            BrokerEconomicLedgerInput.provider == scope.provider,
            BrokerEconomicLedgerInput.environment == scope.environment,
            BrokerEconomicLedgerInput.account_label == scope.account_label,
            BrokerEconomicLedgerInput.endpoint_fingerprint
            == scope.endpoint_fingerprint,
        )
        .order_by(BrokerEconomicLedgerReconciliation.observed_at.desc())
        .limit(1)
    )
    if row is None:
        return _missing_status(scope, max_observation_age_seconds)
    if (
        _sha256(row.broker_snapshot_canonical_json) != row.broker_snapshot_sha256
        or _sha256(row.result_canonical_json) != row.result_sha256
        or _canonical_json(row.broker_snapshot) != row.broker_snapshot_canonical_json
        or _canonical_json(row.result) != row.result_canonical_json
    ):
        raise EconomicLedgerError("economic_reconciliation_persisted_hash_mismatch")
    reducers = _mapping(
        row.result.get("reducers"),
        "economic_reconciliation_persisted_reducers_invalid",
    )
    admissible = reducers.get("admissible")
    if not isinstance(admissible, bool):
        raise EconomicLedgerError(
            "economic_reconciliation_persisted_admissibility_invalid"
        )
    input_manifest_sha256 = str(row.result.get("input_manifest_sha256") or "")
    if re.fullmatch(r"[0-9a-f]{64}", input_manifest_sha256) is None:
        raise EconomicLedgerError(
            "economic_reconciliation_persisted_manifest_digest_invalid"
        )
    now = as_utc(observed_at)
    age_seconds = max(0, int((now - as_utc(row.observed_at)).total_seconds()))
    stale = age_seconds > max_observation_age_seconds
    reason_codes = list(_string_sequence(row.result.get("reason_codes")))
    if stale:
        reason_codes.append("economic_reconciliation_observation_stale")
    return {
        "schema_version": _STATUS_SCHEMA_VERSION,
        "state": "stale" if stale else ("reconciled" if row.reconciled else "residual"),
        "current": not stale,
        "reconciled": row.reconciled and not stale,
        "diagnostic_only": True,
        "capital_authority": False,
        "reason_codes": sorted(set(reason_codes)),
        "observation_id": str(row.id),
        "observed_at": as_utc(row.observed_at).isoformat(),
        "age_seconds": age_seconds,
        "max_age_seconds": max_observation_age_seconds,
        "input_source_watermark": as_utc(row.input_source_watermark).isoformat(),
        "source_watermark": as_utc(row.source_watermark).isoformat(),
        "source_age_seconds": row.source_age_seconds,
        "max_source_age_seconds": row.max_source_age_seconds,
        "admissible": admissible,
        "input_id": str(row.input_id),
        "input_manifest_sha256": input_manifest_sha256,
        "journal_run_id": str(row.journal_run_id),
        "state_run_id": str(row.state_run_id),
        "reducers": dict(reducers),
        "comparison_sha256": row.comparison_sha256,
        "journal_sha256": row.journal_sha256,
        "broker_snapshot_sha256": row.broker_snapshot_sha256,
        "result_sha256": row.result_sha256,
        "source_commit": row.source_commit,
        "image_digest": row.image_digest,
        "residual_count": row.residual_count,
        "open_order_count": row.open_order_count,
        "residuals": row.result.get("residuals", []),
        "economics": row.result.get("economics", {}),
    }


@dataclass(frozen=True, slots=True)
class _MarkedLedgerValues:
    cash: Decimal
    equity: Decimal | None
    unrealized_pnl: Decimal | None


def _economic_residuals(
    projection: EconomicProjection,
    *,
    snapshot: BrokerEconomicSnapshot,
    source_age_seconds: int,
    max_source_age_seconds: int,
) -> tuple[BrokerEconomicResidual, ...]:
    residuals: list[BrokerEconomicResidual] = []
    _append_source_state_residuals(
        residuals,
        snapshot=snapshot,
        source_age_seconds=source_age_seconds,
        max_source_age_seconds=max_source_age_seconds,
    )
    _append_cash_residuals(residuals, projection=projection, snapshot=snapshot)
    _append_position_residuals(residuals, projection=projection, snapshot=snapshot)
    _append_mark_to_market_residuals(
        residuals,
        projection=projection,
        snapshot=snapshot,
    )
    return tuple(residuals)


def _append_source_state_residuals(
    residuals: list[BrokerEconomicResidual],
    *,
    snapshot: BrokerEconomicSnapshot,
    source_age_seconds: int,
    max_source_age_seconds: int,
) -> None:
    if source_age_seconds > max_source_age_seconds:
        residuals.append(
            BrokerEconomicResidual(
                path="source_watermark",
                classification="economic_source_watermark_stale",
                ledger=str(source_age_seconds),
                broker=str(max_source_age_seconds),
                difference=str(source_age_seconds - max_source_age_seconds),
            )
        )
    if snapshot.open_orders:
        residuals.append(
            BrokerEconomicResidual(
                path="open_orders",
                classification="broker_open_orders_present",
                ledger="0",
                broker=str(len(snapshot.open_orders)),
                difference=str(-len(snapshot.open_orders)),
            )
        )


def _append_cash_residuals(
    residuals: list[BrokerEconomicResidual],
    *,
    projection: EconomicProjection,
    snapshot: BrokerEconomicSnapshot,
) -> None:
    cash_by_commodity = {item.commodity: item.amount for item in projection.cash}
    quote_currency = projection.scope.quote_currency
    ledger_cash = cash_by_commodity.get(quote_currency, ZERO)
    _append_decimal_residual(
        residuals,
        path=f"cash.{quote_currency}",
        classification="broker_cash_mismatch",
        ledger=ledger_cash,
        broker=snapshot.cash,
    )
    for commodity, amount in sorted(cash_by_commodity.items()):
        if commodity != quote_currency and amount != ZERO:
            residuals.append(
                BrokerEconomicResidual(
                    path=f"cash.{commodity}",
                    classification="ledger_non_quote_cash_present",
                    ledger=decimal_text(amount),
                    broker=None,
                    difference=None,
                )
            )


def _append_position_residuals(
    residuals: list[BrokerEconomicResidual],
    *,
    projection: EconomicProjection,
    snapshot: BrokerEconomicSnapshot,
) -> None:
    ledger_positions = {position.symbol: position for position in projection.positions}
    broker_positions = {position.symbol: position for position in snapshot.positions}
    for symbol in sorted(set(ledger_positions) | set(broker_positions)):
        ledger_position = ledger_positions.get(symbol)
        broker_position = broker_positions.get(symbol)
        ledger_quantity = (
            ledger_position.quantity if ledger_position is not None else ZERO
        )
        broker_quantity = (
            broker_position.quantity if broker_position is not None else ZERO
        )
        if ledger_quantity != broker_quantity:
            if broker_quantity == ZERO:
                classification = "ledger_position_missing_from_broker"
            elif ledger_quantity == ZERO:
                classification = "broker_position_missing_from_ledger"
            else:
                classification = "broker_position_quantity_mismatch"
            _append_decimal_residual(
                residuals,
                path=f"positions.{symbol}.quantity",
                classification=classification,
                ledger=ledger_quantity,
                broker=broker_quantity,
            )
            continue
        if (
            ledger_position is None
            or broker_position is None
            or ledger_quantity == ZERO
        ):
            continue
        broker_signed_cost = _multiply(
            _multiply(
                broker_quantity,
                broker_position.average_entry_price,
                "broker_signed_cost",
            ),
            notional_multiplier_for_symbol(symbol),
            "broker_signed_cost",
        )
        _append_decimal_residual(
            residuals,
            path=f"positions.{symbol}.signed_cost",
            classification="broker_position_cost_basis_mismatch",
            ledger=ledger_position.signed_cost,
            broker=broker_signed_cost,
        )


def _append_mark_to_market_residuals(
    residuals: list[BrokerEconomicResidual],
    *,
    projection: EconomicProjection,
    snapshot: BrokerEconomicSnapshot,
) -> None:
    ledger_positions = {position.symbol: position for position in projection.positions}
    marked = _marked_ledger_values(projection, snapshot=snapshot)
    if marked.equity is None or marked.unrealized_pnl is None:
        marks = {position.symbol for position in snapshot.positions}
        for symbol in sorted(set(ledger_positions) - marks):
            residuals.append(
                BrokerEconomicResidual(
                    path=f"positions.{symbol}.current_price",
                    classification="ledger_position_fresh_mark_missing",
                    ledger=None,
                    broker=None,
                    difference=None,
                )
            )
    else:
        _append_decimal_residual(
            residuals,
            path="equity",
            classification="broker_equity_mismatch",
            ledger=marked.equity,
            broker=snapshot.equity,
        )
        broker_unrealized = _sum_decimal(
            position.unrealized_pnl for position in snapshot.positions
        )
        _append_decimal_residual(
            residuals,
            path="unrealized_pnl",
            classification="broker_unrealized_pnl_mismatch",
            ledger=marked.unrealized_pnl,
            broker=broker_unrealized,
        )


def _marked_ledger_values(
    projection: EconomicProjection,
    *,
    snapshot: BrokerEconomicSnapshot,
) -> _MarkedLedgerValues:
    cash_by_commodity = {item.commodity: item.amount for item in projection.cash}
    cash = cash_by_commodity.get(projection.scope.quote_currency, ZERO)
    marks = {position.symbol: position.current_price for position in snapshot.positions}
    if any(position.symbol not in marks for position in projection.positions):
        return _MarkedLedgerValues(cash=cash, equity=None, unrealized_pnl=None)
    market_value = _sum_decimal(
        _multiply(
            _multiply(
                position.quantity,
                marks[position.symbol],
                "ledger_market_value",
            ),
            notional_multiplier_for_symbol(position.symbol),
            "ledger_market_value",
        )
        for position in projection.positions
    )
    carrying_value = _sum_decimal(
        position.signed_cost for position in projection.positions
    )
    return _MarkedLedgerValues(
        cash=cash,
        equity=_add(cash, market_value, "ledger_equity"),
        unrealized_pnl=_add(market_value, -carrying_value, "ledger_unrealized_pnl"),
    )


def _normalize_position(value: object) -> BrokerEconomicPosition:
    row = _mapping(value, "economic_broker_position_invalid")
    symbol = _required_text(
        row.get("symbol"), "economic_broker_position_symbol_invalid"
    ).upper()
    side = _required_text(
        row.get("side"), "economic_broker_position_side_invalid"
    ).lower()
    if side not in {"long", "short"}:
        raise EconomicLedgerError("economic_broker_position_side_invalid")
    quantity = _required_decimal(
        row.get("qty") if row.get("qty") is not None else row.get("quantity"),
        "economic_broker_position_quantity_invalid",
    )
    if quantity <= ZERO:
        raise EconomicLedgerError("economic_broker_position_quantity_invalid")
    signed_quantity = quantity if side == "long" else -quantity
    average_entry_price = _positive_decimal(
        row.get("avg_entry_price"), "economic_broker_position_entry_price_invalid"
    )
    current_price = _positive_decimal(
        row.get("current_price"), "economic_broker_position_current_price_invalid"
    )
    market_value = _required_decimal(
        row.get("market_value"), "economic_broker_position_market_value_invalid"
    )
    if side == "long" and market_value < ZERO:
        raise EconomicLedgerError("economic_broker_position_market_value_invalid")
    if side == "short" and market_value > ZERO:
        market_value = -market_value
    unrealized_pnl = _required_decimal(
        row.get("unrealized_pl"), "economic_broker_position_unrealized_pnl_invalid"
    )
    return BrokerEconomicPosition(
        symbol=symbol,
        quantity=signed_quantity,
        average_entry_price=average_entry_price,
        current_price=current_price,
        market_value=market_value,
        unrealized_pnl=unrealized_pnl,
    )


def _normalize_open_order(value: object) -> BrokerEconomicOpenOrder:
    row = _mapping(value, "economic_broker_open_order_invalid")
    order_id = _required_text(row.get("id"), "economic_broker_order_id_invalid")
    raw_client_order_id = row.get("client_order_id")
    client_order_id = (
        _required_text(raw_client_order_id, "economic_broker_client_order_id_invalid")
        if raw_client_order_id is not None
        else None
    )
    symbol = _required_text(
        row.get("symbol"), "economic_broker_order_symbol_invalid"
    ).upper()
    side = _required_text(row.get("side"), "economic_broker_order_side_invalid").lower()
    if side not in {"buy", "sell"}:
        raise EconomicLedgerError("economic_broker_order_side_invalid")
    quantity = _positive_decimal(
        row.get("qty") if row.get("qty") is not None else row.get("quantity"),
        "economic_broker_order_quantity_invalid",
    )
    filled_quantity = _required_decimal(
        row.get("filled_qty") if row.get("filled_qty") is not None else ZERO,
        "economic_broker_order_filled_quantity_invalid",
    )
    if filled_quantity < ZERO or filled_quantity > quantity:
        raise EconomicLedgerError("economic_broker_order_filled_quantity_invalid")
    status = _required_text(
        row.get("status"), "economic_broker_order_status_invalid"
    ).lower()
    order_type = _required_text(
        row.get("type") or row.get("order_type"),
        "economic_broker_order_type_invalid",
    ).lower()
    return BrokerEconomicOpenOrder(
        order_id=order_id,
        client_order_id=client_order_id,
        symbol=symbol,
        side=side,
        quantity=quantity,
        filled_quantity=filled_quantity,
        status=status,
        order_type=order_type,
    )


def _append_decimal_residual(
    residuals: list[BrokerEconomicResidual],
    *,
    path: str,
    classification: str,
    ledger: Decimal,
    broker: Decimal,
) -> None:
    difference = _add(ledger, -broker, "economic_reconciliation_difference")
    if difference == ZERO:
        return
    residuals.append(
        BrokerEconomicResidual(
            path=path,
            classification=classification,
            ledger=decimal_text(ledger),
            broker=decimal_text(broker),
            difference=decimal_text(difference),
        )
    )


def _mapping(value: object, reason: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise EconomicLedgerError(reason)
    return cast(Mapping[str, object], value)


def _sequence(value: object, reason: str) -> Sequence[object]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise EconomicLedgerError(reason)
    return cast(Sequence[object], value)


def _required_text(value: object, reason: str) -> str:
    resolved = str(value or "").strip()
    if not resolved:
        raise EconomicLedgerError(reason)
    return resolved


def _required_decimal(value: object, reason: str) -> Decimal:
    try:
        resolved = Decimal(str(value))
    except (ArithmeticError, ValueError) as exc:
        raise EconomicLedgerError(reason) from exc
    if not resolved.is_finite():
        raise EconomicLedgerError(reason)
    return quantize_ledger_decimal(resolved, field_name=reason)


def _positive_decimal(value: object, reason: str) -> Decimal:
    resolved = _required_decimal(value, reason)
    if resolved <= ZERO:
        raise EconomicLedgerError(reason)
    return resolved


def _add(left: Decimal, right: Decimal, field_name: str) -> Decimal:
    with localcontext() as context:
        context.prec = LEDGER_DECIMAL_PRECISION
        return quantize_ledger_decimal(left + right, field_name=field_name)


def _multiply(left: Decimal, right: Decimal, field_name: str) -> Decimal:
    with localcontext() as context:
        context.prec = LEDGER_DECIMAL_PRECISION
        return quantize_ledger_decimal(left * right, field_name=field_name)


def _sum_decimal(values: Iterable[Decimal]) -> Decimal:
    total = ZERO
    for value in values:
        total = _add(total, value, "economic_reconciliation_sum")
    return total


def _require_build_identity(*, source_commit: str, image_digest: str) -> None:
    if _COMMIT_PATTERN.fullmatch(source_commit) is None:
        raise EconomicLedgerError("economic_reconciliation_source_commit_invalid")
    if _IMAGE_DIGEST_PATTERN.fullmatch(image_digest) is None:
        raise EconomicLedgerError("economic_reconciliation_image_digest_invalid")


def _missing_status(scope: LedgerScope, max_age_seconds: int) -> dict[str, object]:
    return {
        "schema_version": _STATUS_SCHEMA_VERSION,
        "state": "missing",
        "current": False,
        "reconciled": False,
        "diagnostic_only": True,
        "capital_authority": False,
        "reason_codes": ["economic_reconciliation_missing"],
        "account_label": scope.account_label,
        "environment": scope.environment,
        "max_age_seconds": max_age_seconds,
        "residual_count": None,
        "open_order_count": None,
    }


def _string_sequence(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise EconomicLedgerError("economic_reconciliation_reason_codes_invalid")
    result = tuple(str(item).strip() for item in cast(list[object], value))
    if any(not item for item in result):
        raise EconomicLedgerError("economic_reconciliation_reason_codes_invalid")
    return result


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise EconomicLedgerError("economic_reconciliation_json_invalid") from exc


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = (
    "DEFAULT_OBSERVATION_MAX_AGE_SECONDS",
    "DEFAULT_SOURCE_MAX_AGE_SECONDS",
    "BrokerEconomicReconciliationBuild",
    "BrokerEconomicReconciliationResult",
    "BrokerEconomicSnapshot",
    "PersistedBrokerEconomicReconciliation",
    "capture_broker_economic_snapshot",
    "load_broker_economic_ledger_status",
    "normalize_broker_economic_snapshot",
    "persist_broker_economic_ledger_reconciliation",
    "reconcile_broker_economic_ledger",
)
