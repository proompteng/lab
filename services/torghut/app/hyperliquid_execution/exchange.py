"""Hyperliquid SDK adapter for execution v2."""

from __future__ import annotations

import importlib
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_UP
from typing import Any, Mapping, Protocol, cast

from ..trading.broker_mutation_receipts import (
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    consume_broker_mutation_io_permit,
    fingerprint_broker_endpoint,
)
from ..trading.risk_reduction import (
    BrokerOrderObservation,
    BrokerPositionObservation,
)
from ..trading.risk_reduction_mutation_authority import (
    RiskReductionMutationAuthority,
    RiskReductionMutationExpectation,
    consume_risk_reduction_mutation_authority,
)
from .config import HyperliquidExecutionConfig
from .exchange_submit_recovery import (
    HyperliquidOrderRecoveryLookup,
    HyperliquidOrderRecoveryRequest,
    hyperliquid_submit_request_payload,
    recover_hyperliquid_order,
)
from .exchange_reconciliation import (
    account_state_from_payloads as _account_state_from_payloads,
    decimal_value as _decimal,
    fill_coin as _fill_coin,
    fill_from_payload as _fill_from_payload,
    optional_decimal as _optional_decimal,
    position_exposure_usd as _position_exposure_usd,
)
from .exchange_order_observation import open_order_observation
from .market_names import sdk_dex as _sdk_dex, sdk_market_name as _sdk_market_name
from .sdk_aliases import register_sdk_market_alias as _register_sdk_market_alias
from .sdk_submission import (
    MarketOpenRequest,
    is_halted as _is_halted,
    parse_order_result as _order_result,
    submit_market_open,
)
from .slippage import sdk_mid_price, sdk_slippage_limit_price
from .models import (
    AccountSnapshot,
    AccountState,
    ExecutionMarket,
    Fill,
    OpenOrder,
    OrderIntent,
    OrderResult,
    RuntimeDependencyStatus,
)
from .universe import execution_universe_status


_METADATA_REFRESH_SECONDS = 300
_SUPPORTED_LIMIT_TIFS = {"Ioc"}
_BPS_DENOMINATOR = Decimal("10000")
_BOOK_UNAVAILABLE_EXCEPTIONS: tuple[type[BaseException], ...] = (
    AttributeError,
    InvalidOperation,
    LookupError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
)


class HyperliquidExecutionExchange(Protocol):
    """Exchange surface required by v2 service loop."""

    def filter_supported_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]: ...

    def filter_crossable_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]: ...

    def submit_order(
        self,
        intent: OrderIntent,
        *,
        mutation_permit: BrokerMutationIoPermit,
    ) -> OrderResult: ...

    def observe_open_order(self, order: OpenOrder) -> BrokerOrderObservation | None: ...

    def observe_reduction_positions(
        self,
    ) -> tuple[datetime, tuple[BrokerPositionObservation, ...]]: ...

    def cancel_order(
        self,
        order: OpenOrder,
        *,
        authority: RiskReductionMutationAuthority,
    ) -> OrderResult: ...

    def close_position_reduce_only(
        self,
        coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
        authority: RiskReductionMutationAuthority,
    ) -> OrderResult: ...

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]: ...

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState: ...

    def reconcile_open_order_coins(self, coins: frozenset[str]) -> frozenset[str]: ...

    def dependency_status(self) -> RuntimeDependencyStatus: ...

    def execution_metadata_details(self) -> dict[str, object]: ...

    def recover_order_by_cloid(
        self,
        cloid: str,
        *,
        after: datetime,
        until: datetime,
    ) -> HyperliquidOrderRecoveryLookup: ...


class HyperliquidSdkExecutionExchange:
    """Official SDK adapter. Orders are testnet-only by config validation."""

    def __init__(self, config: HyperliquidExecutionConfig) -> None:
        self._config = config
        self._sdk_exchange: Any | None = None
        self._sdk_info: Any | None = None
        self._sdk_recovery_info: Any | None = None
        self._sdk_recovery_info_perp_dexs: tuple[str, ...] | None = None
        self._sdk_info_perp_dexs: tuple[str, ...] | None = None
        self._sdk_exchange_perp_dexs: tuple[str, ...] | None = None
        self._last_read_at: datetime | None = None
        self._last_metadata_at: datetime | None = None
        self._active_by_dex: dict[str, frozenset[str]] = {}
        self._delisted_by_dex: dict[str, frozenset[str]] = {}
        self._halted_by_dex: dict[str, set[str]] = {}
        self._size_decimals_by_dex_coin: dict[str, dict[str, int]] = {}
        self._max_leverage_by_dex_coin: dict[str, dict[str, Decimal]] = {}
        self._latest_metadata_details: dict[str, object] = {}

    @property
    def account_label(self) -> str:
        return self._config.account_label

    @property
    def broker_endpoint_url(self) -> str:
        return self._config.exchange_api_url

    def filter_supported_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        if not markets:
            return (), RuntimeDependencyStatus(
                name="hyperliquid_execution_metadata",
                ready=False,
                reason="no_configured_feed_markets",
            )
        try:
            self._refresh_metadata(markets)
        except Exception as exc:
            if not self._metadata_fresh():
                return (), RuntimeDependencyStatus(
                    name="hyperliquid_execution_metadata",
                    ready=False,
                    reason=f"execution_metadata_unavailable:{type(exc).__name__}",
                )
        selected = tuple(
            self._market_with_execution_metadata(market)
            for market in markets
            if market.coin in self._active_symbols(_sdk_dex(market.dex))
        )
        delisted = [
            coin for coins in self._delisted_by_dex.values() for coin in sorted(coins)
        ]
        halted = [
            coin for coins in self._halted_by_dex.values() for coin in sorted(coins)
        ]
        status = execution_universe_status(
            requested=markets,
            selected=selected,
            delisted=delisted,
            halted=halted,
        )
        details = dict(self._latest_metadata_details)
        details.update(status.details)
        details["max_leverage_by_coin"] = {
            coin: str(leverage)
            for leverage_by_coin in self._max_leverage_by_dex_coin.values()
            for coin, leverage in sorted(leverage_by_coin.items())
        }
        self._latest_metadata_details = details
        return selected, replace(
            status, observed_at=self._last_metadata_at, details=details
        )

    def filter_crossable_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        if not markets:
            return (), RuntimeDependencyStatus(
                name="hyperliquid_testnet_liquidity",
                ready=False,
                reason="no_execution_markets",
                details={"slippage_bps": str(self._config.marketable_ioc_slippage_bps)},
            )
        selected: list[ExecutionMarket] = []
        skipped: dict[str, str] = {}
        for market in markets:
            try:
                reason = self._uncrossable_reason(market)
            except _BOOK_UNAVAILABLE_EXCEPTIONS as exc:
                reason = f"book_unavailable:{type(exc).__name__}"
            if reason is None:
                selected.append(market)
                continue
            skipped[market.coin] = reason
        ready = bool(selected)
        return tuple(selected), RuntimeDependencyStatus(
            name="hyperliquid_testnet_liquidity",
            ready=ready,
            observed_at=datetime.now(timezone.utc),
            reason=None if ready else "no_crossable_testnet_markets",
            details={
                "selected": [market.coin for market in selected],
                "skipped": skipped,
                "slippage_bps": str(self._config.marketable_ioc_slippage_bps),
            },
        )

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        return self._normalize_order_intent(intent)

    def validate_order_intent_crossability(self, intent: OrderIntent) -> None:
        try:
            info = self._info()
            sdk_name = _sdk_market_name(intent.coin, intent.dex)
            _register_sdk_market_alias(info, sdk_name, intent.coin)
            book = cast(dict[str, object], info.l2_snapshot(sdk_name))
            self._last_read_at = datetime.now(timezone.utc)
            best_bid = _best_level_price(book, 0)
            best_ask = _best_level_price(book, 1)
            book_empty = best_bid is None or best_ask is None
            rounded_limit_price = sdk_slippage_limit_price(
                info,
                sdk_name,
                intent.side == "buy",
                intent.limit_price,
                Decimal("0"),
            )
            buy_not_crossable = (
                not book_empty
                and intent.side == "buy"
                and rounded_limit_price < cast(Decimal, best_ask)
            )
            sell_not_crossable = (
                not book_empty
                and intent.side == "sell"
                and rounded_limit_price > cast(Decimal, best_bid)
            )
        except _BOOK_UNAVAILABLE_EXCEPTIONS as exc:
            raise ValueError(f"order_book_unavailable:{type(exc).__name__}") from exc
        if book_empty:
            raise ValueError("order_book_empty")
        if buy_not_crossable:
            raise ValueError("order_not_crossable:buy")
        if sell_not_crossable:
            raise ValueError("order_not_crossable:sell")

    def submit_order(
        self,
        intent: OrderIntent,
        *,
        mutation_permit: BrokerMutationIoPermit,
    ) -> OrderResult:
        normalized = self.normalize_order_intent(intent)
        consume_broker_mutation_io_permit(
            mutation_permit,
            expectation=BrokerMutationIoPermitExpectation(
                broker_route="hyperliquid",
                operation="submit_order",
                risk_class="risk_increasing",
                account_label=self._config.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self._config.exchange_api_url
                ),
                request_payload=hyperliquid_submit_request_payload(normalized),
            ),
        )
        if normalized.tif not in _SUPPORTED_LIMIT_TIFS:
            return OrderResult(
                status="rejected",
                exchange_order_id=None,
                raw_response={"error": "unsupported_limit_tif"},
                rejection_reason="unsupported_limit_tif",
            )
        if not self._config.api_wallet_private_key:
            return OrderResult(
                status="rejected",
                exchange_order_id=None,
                raw_response={"error": "api_wallet_private_key_missing"},
                rejection_reason="api_wallet_private_key_missing",
            )
        if normalized.reduce_only:
            return OrderResult(
                status="rejected",
                exchange_order_id=None,
                raw_response={"error": "reduce_only_entry_orders_unsupported"},
                rejection_reason="reduce_only_entry_orders_unsupported",
            )
        sdk_name = _sdk_market_name(normalized.coin, normalized.dex)
        exchange = self._exchange()
        _register_sdk_market_alias(exchange, sdk_name, normalized.coin)
        response = submit_market_open(
            exchange,
            MarketOpenRequest(
                market_name=sdk_name,
                is_buy=normalized.side == "buy",
                size=float(normalized.size),
                limit_price=float(normalized.limit_price),
                cloid=self._cloid(normalized.cloid),
            ),
        )
        self._last_read_at = datetime.now(timezone.utc)
        result = _order_result(response)
        if _is_halted(result):
            self._halted_by_dex.setdefault(_sdk_dex(intent.dex), set()).add(intent.coin)
        return result

    def recover_order_by_cloid(
        self,
        cloid: str,
        *,
        after: datetime,
        until: datetime,
    ) -> HyperliquidOrderRecoveryLookup:
        account_address = (self._config.account_address or "").strip()
        lookup = recover_hyperliquid_order(
            info=self._recovery_info() if account_address else None,
            request=HyperliquidOrderRecoveryRequest(
                account_address=account_address,
                cloid=cloid,
                sdk_cloid=self._cloid(cloid) if account_address else cloid,
                after=after,
                until=until,
            ),
        )
        if account_address:
            self._last_read_at = datetime.now(timezone.utc)
        return lookup

    def observe_open_order(self, order: OpenOrder) -> BrokerOrderObservation | None:
        account = self._config.account_address
        if account is None:
            raise ValueError("hyperliquid_account_address_required")
        info = self._info()
        if order.exchange_order_id is None:
            raw_status = info.query_order_by_cloid(account, self._cloid(order.cloid))
        else:
            try:
                exchange_order_id = int(order.exchange_order_id)
            except ValueError as exc:
                raise ValueError("hyperliquid_open_order_id_invalid") from exc
            raw_status = info.query_order_by_oid(account, exchange_order_id)
        self._last_read_at = datetime.now(timezone.utc)
        return open_order_observation(raw_status, order)

    def observe_reduction_positions(
        self,
    ) -> tuple[datetime, tuple[BrokerPositionObservation, ...]]:
        account = self._config.account_address
        observed_at = datetime.now(timezone.utc)
        if account is None:
            raise ValueError("hyperliquid_account_address_required")
        positions: list[BrokerPositionObservation] = []
        info = self._info()
        for dex in self._complete_perp_dexes(info):
            payload = cast(dict[str, object], info.user_state(account, dex=dex))
            raw_positions = payload.get("assetPositions")
            if not isinstance(raw_positions, list):
                raise ValueError("hyperliquid_asset_positions_invalid")
            for item in cast(list[object], raw_positions):
                if not isinstance(item, Mapping):
                    raise ValueError("hyperliquid_asset_position_row_invalid")
                item_map = cast(Mapping[str, object], item)
                position = item_map.get("position")
                if not isinstance(position, Mapping):
                    raise ValueError("hyperliquid_position_payload_invalid")
                position_map = cast(Mapping[str, object], position)
                size = _decimal(position_map.get("szi"))
                if size == 0:
                    continue
                unit_notional = _position_exposure_usd(position_map) / abs(size)
                positions.append(
                    BrokerPositionObservation(
                        symbol=str(position_map.get("coin") or ""),
                        signed_quantity=size,
                        unit_notional=unit_notional,
                        broker_symbol=str(position_map.get("coin") or ""),
                    )
                )
        self._last_read_at = observed_at
        return observed_at, tuple(positions)

    @staticmethod
    def _complete_perp_dexes(info: Any) -> tuple[str, ...]:
        raw_dexes = info.perp_dexs()
        if not isinstance(raw_dexes, list) or not raw_dexes or raw_dexes[0] is not None:
            raise ValueError("hyperliquid_perp_dex_catalog_invalid")
        names = [""]
        for item in cast(list[object], raw_dexes[1:]):
            if not isinstance(item, Mapping):
                raise ValueError("hyperliquid_perp_dex_catalog_invalid")
            item_map = cast(Mapping[str, object], item)
            name = str(item_map.get("name") or "").strip()
            if not name or name in names:
                raise ValueError("hyperliquid_perp_dex_catalog_invalid")
            names.append(name)
        return tuple(names)

    def cancel_order(
        self,
        order: OpenOrder,
        *,
        authority: RiskReductionMutationAuthority,
    ) -> OrderResult:
        request_payload = authority.request_payload
        if not order.exchange_order_id:
            raise ValueError("hyperliquid_cancel_exchange_order_id_required")
        if (
            str(request_payload.get("coin") or "").strip() != order.coin
            or str(request_payload.get("cloid") or "").strip() != order.cloid
            or str(request_payload.get("order_id") or "").strip()
            != order.exchange_order_id
        ):
            raise ValueError("hyperliquid_cancel_request_mismatch")
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="hyperliquid",
                account_label=self._config.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self._config.exchange_api_url
                ),
                operation="cancel_order",
                risk_class="risk_neutral",
                target_key=order.exchange_order_id,
            ),
        )
        sdk_name = _sdk_market_name(order.coin, order.dex)
        exchange = self._exchange()
        _register_sdk_market_alias(exchange, sdk_name, order.coin)
        response = cast(
            dict[str, object],
            exchange.cancel(sdk_name, int(order.exchange_order_id)),
        )
        self._last_read_at = datetime.now(timezone.utc)
        return OrderResult(
            status="cancelled",
            exchange_order_id=order.exchange_order_id,
            raw_response=response,
        )

    def close_position_reduce_only(
        self,
        coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
        authority: RiskReductionMutationAuthority,
    ) -> OrderResult:
        request_payload = authority.request_payload
        if str(request_payload.get("coin") or "").strip() != coin.strip():
            raise ValueError("hyperliquid_close_position_request_mismatch")
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="hyperliquid",
                account_label=self._config.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self._config.exchange_api_url
                ),
                operation="close_position",
                risk_class="risk_reducing",
                target_key=coin.strip().upper(),
            ),
        )
        if not self._config.api_wallet_private_key:
            return OrderResult(
                status="rejected",
                exchange_order_id=None,
                raw_response={"error": "api_wallet_private_key_missing"},
                rejection_reason="api_wallet_private_key_missing",
            )
        exchange = self._exchange()
        _register_sdk_market_alias(exchange, coin, coin.split(":", 1)[-1])
        response = exchange.market_close(
            coin,
            sz=float(size) if size is not None else None,
            slippage=float(slippage),
        )
        self._last_read_at = datetime.now(timezone.utc)
        if not isinstance(response, dict):
            return OrderResult(
                status="rejected",
                exchange_order_id=None,
                raw_response={"response": response},
                rejection_reason="no_position_found",
            )
        return _order_result(cast(dict[str, object], response))

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        account = self._config.account_address
        if account is None:
            return []
        raw_fills = cast(list[dict[str, object]], self._info().user_fills(account))
        self._last_read_at = datetime.now(timezone.utc)
        return [
            _fill_from_payload(fill, market_id_by_coin)
            for fill in raw_fills
            if _fill_coin(fill) in market_id_by_coin
        ]

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        account = self._config.account_address
        observed_at = datetime.now(timezone.utc)
        if account is None:
            return AccountState(
                account=AccountSnapshot(
                    observed_at=observed_at,
                    account_value_usd=Decimal("0"),
                    withdrawable_usd=Decimal("0"),
                    gross_exposure_usd=Decimal("0"),
                    raw_payload={"missing_account": True},
                ),
                positions=(),
            )
        info = self._info()
        raw_states = {
            dex: cast(dict[str, object], info.user_state(account, dex=dex))
            for dex in self._known_dexes()
        }
        try:
            spot_state = cast(dict[str, object], info.spot_user_state(account))
        except Exception:
            spot_state = {}
        self._last_read_at = observed_at
        return _account_state_from_payloads(
            raw_states,
            spot_state,
            market_id_by_coin,
            observed_at,
        )

    def reconcile_open_order_coins(self, coins: frozenset[str]) -> frozenset[str]:
        account = self._config.account_address
        if account is None:
            return frozenset()
        open_coins: set[str] = set()
        for dex in self._known_dexes():
            raw_orders = cast(
                list[dict[str, object]], self._info().open_orders(account, dex=dex)
            )
            for raw_order in raw_orders:
                coin = str(raw_order.get("coin") or "").strip()
                if coin in coins:
                    open_coins.add(coin)
        self._last_read_at = datetime.now(timezone.utc)
        return frozenset(open_coins)

    def dependency_status(self) -> RuntimeDependencyStatus:
        if self._last_read_at is None:
            return RuntimeDependencyStatus(
                "hyperliquid_exchange", False, reason="exchange_not_read"
            )
        lag_seconds = int(
            (datetime.now(timezone.utc) - self._last_read_at).total_seconds()
        )
        ready = lag_seconds <= self._config.exchange_staleness_seconds
        return RuntimeDependencyStatus(
            name="hyperliquid_exchange",
            ready=ready,
            observed_at=self._last_read_at,
            lag_seconds=lag_seconds,
            reason=None if ready else "exchange_stale",
        )

    def execution_metadata_details(self) -> dict[str, object]:
        return dict(self._latest_metadata_details)

    def _normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        dex = _sdk_dex(intent.dex)
        size_decimals = self._size_decimals_by_dex_coin.get(dex, {}).get(intent.coin)
        size = intent.size
        if size_decimals is not None:
            quant = Decimal("1").scaleb(-size_decimals)
            size = intent.size.quantize(quant, rounding=ROUND_DOWN)
        price = intent.limit_price
        if price <= Decimal("0"):
            raise ValueError("order_price_must_be_positive")
        notional_usd = (price * size).quantize(Decimal("0.000001"))
        if (
            notional_usd < self._config.min_order_notional_usd
            and size_decimals is not None
        ):
            quant = Decimal("1").scaleb(-size_decimals)
            size = (self._config.min_order_notional_usd / price).quantize(
                quant,
                rounding=ROUND_UP,
            )
            notional_usd = (price * size).quantize(Decimal("0.000001"))
        if size <= Decimal("0"):
            raise ValueError("order_size_below_exchange_precision")
        if notional_usd < self._config.min_order_notional_usd:
            raise ValueError("order_notional_below_minimum")
        return replace(intent, size=size, limit_price=price, notional_usd=notional_usd)

    def _uncrossable_reason(self, market: ExecutionMarket) -> str | None:
        try:
            info = self._info()
            sdk_name = _sdk_market_name(market.coin, market.dex)
            _register_sdk_market_alias(info, sdk_name, market.coin)
            book = cast(dict[str, object], info.l2_snapshot(sdk_name))
            self._last_read_at = datetime.now(timezone.utc)
        except _BOOK_UNAVAILABLE_EXCEPTIONS as exc:
            return f"book_unavailable:{type(exc).__name__}"
        best_bid = _best_level_price(book, 0)
        best_ask = _best_level_price(book, 1)
        if best_bid is None or best_ask is None:
            return "book_empty"
        try:
            mid_price = sdk_mid_price(info, market.coin, _sdk_dex(market.dex))
            if mid_price is None:
                return "book_empty"
            slippage = self._config.marketable_ioc_slippage_bps / _BPS_DENOMINATOR
            buy_limit = sdk_slippage_limit_price(
                info, sdk_name, True, mid_price, slippage
            )
            sell_limit = sdk_slippage_limit_price(
                info, sdk_name, False, mid_price, slippage
            )
        except _BOOK_UNAVAILABLE_EXCEPTIONS as exc:
            return f"book_unavailable:{type(exc).__name__}"
        buy_crossable = buy_limit >= best_ask
        sell_crossable = sell_limit <= best_bid
        if buy_crossable or (self._config.allow_short_entries and sell_crossable):
            return None
        expected_sides = "buy|sell" if self._config.allow_short_entries else "buy"
        return (
            f"book_not_crossable:sides={expected_sides}:"
            f"bid={best_bid}:ask={best_ask}:buy_limit={buy_limit}:sell_limit={sell_limit}"
        )

    def _refresh_metadata(self, markets: tuple[ExecutionMarket, ...]) -> None:
        if self._metadata_fresh():
            return
        active_by_dex: dict[str, frozenset[str]] = {}
        delisted_by_dex: dict[str, frozenset[str]] = {}
        size_decimals_by_dex_coin: dict[str, dict[str, int]] = {}
        max_leverage_by_dex_coin: dict[str, dict[str, Decimal]] = {}
        for dex in sorted({_sdk_dex(market.dex) for market in markets} | {""}):
            active, delisted, size_decimals, max_leverage = self._metadata_for_dex(dex)
            active_by_dex[dex] = active
            delisted_by_dex[dex] = delisted
            size_decimals_by_dex_coin[dex] = size_decimals
            max_leverage_by_dex_coin[dex] = max_leverage
        observed_at = datetime.now(timezone.utc)
        self._active_by_dex = active_by_dex
        self._delisted_by_dex = delisted_by_dex
        self._size_decimals_by_dex_coin = size_decimals_by_dex_coin
        self._max_leverage_by_dex_coin = max_leverage_by_dex_coin
        self._last_metadata_at = observed_at
        self._last_read_at = observed_at

    def _metadata_for_dex(
        self, dex: str
    ) -> tuple[frozenset[str], frozenset[str], dict[str, int], dict[str, Decimal]]:
        meta = cast(Mapping[str, object], self._info().meta(dex=dex))
        universe = meta.get("universe")
        if not isinstance(universe, list):
            return frozenset(), frozenset(), {}, {}
        active: set[str] = set()
        delisted: set[str] = set()
        size_decimals_by_coin: dict[str, int] = {}
        max_leverage_by_coin: dict[str, Decimal] = {}
        for asset in cast(list[object], universe):
            if not isinstance(asset, dict):
                continue
            name, is_delisted, size_decimals, max_leverage = _asset_metadata(
                cast(Mapping[str, object], asset)
            )
            if not name:
                continue
            if is_delisted:
                delisted.add(name)
                continue
            active.add(name)
            if size_decimals is not None:
                size_decimals_by_coin[name] = size_decimals
            if max_leverage is not None:
                max_leverage_by_coin[name] = max_leverage
        return (
            frozenset(active),
            frozenset(delisted),
            size_decimals_by_coin,
            max_leverage_by_coin,
        )

    def _market_with_execution_metadata(
        self, market: ExecutionMarket
    ) -> ExecutionMarket:
        dex = _sdk_dex(market.dex)
        max_leverage = self._max_leverage_by_dex_coin.get(dex, {}).get(market.coin)
        payload = dict(market.payload)
        if max_leverage is not None:
            payload["execution_max_leverage"] = str(max_leverage)
        return replace(market, max_leverage=max_leverage, payload=payload)

    def _metadata_fresh(self) -> bool:
        if self._last_metadata_at is None:
            return False
        age = (datetime.now(timezone.utc) - self._last_metadata_at).total_seconds()
        return age <= min(
            _METADATA_REFRESH_SECONDS, self._config.exchange_staleness_seconds
        )

    def _active_symbols(self, dex: str) -> frozenset[str]:
        halted = self._halted_by_dex.get(dex, set())
        active = self._active_by_dex.get(dex, frozenset())
        if not halted:
            return active
        return frozenset(coin for coin in active if coin not in halted)

    def _known_dexes(self) -> tuple[str, ...]:
        dexes = {""}
        dexes.update(self._active_by_dex)
        return tuple(sorted(dexes))

    def _exchange(self) -> Any:
        perp_dexs = self._known_dexes()
        if self._sdk_exchange is None or self._sdk_exchange_perp_dexs != perp_dexs:
            eth_account = importlib.import_module("eth_account")
            exchange_module = importlib.import_module("hyperliquid.exchange")
            wallet = eth_account.Account.from_key(self._config.api_wallet_private_key)
            exchange_cls = getattr(exchange_module, "Exchange")
            self._sdk_exchange = exchange_cls(
                wallet,
                base_url=self._config.exchange_api_url,
                account_address=self._config.account_address,
                perp_dexs=list(perp_dexs),
                timeout=float(self._config.exchange_staleness_seconds),
            )
            self._sdk_exchange_perp_dexs = perp_dexs
        return self._sdk_exchange

    def _info(self) -> Any:
        perp_dexs = self._known_dexes()
        if self._sdk_info is None or self._sdk_info_perp_dexs != perp_dexs:
            info_module = importlib.import_module("hyperliquid.info")
            info_cls = getattr(info_module, "Info")
            self._sdk_info = info_cls(
                self._config.exchange_api_url,
                skip_ws=True,
                perp_dexs=list(perp_dexs),
                timeout=float(self._config.exchange_staleness_seconds),
            )
            self._sdk_info_perp_dexs = perp_dexs
        return self._sdk_info

    def _recovery_info(self) -> Any:
        perp_dexs = self._known_dexes()
        if (
            self._sdk_recovery_info is None
            or self._sdk_recovery_info_perp_dexs != perp_dexs
        ):
            info_module = importlib.import_module("hyperliquid.info")
            info_cls = getattr(info_module, "Info")
            self._sdk_recovery_info = info_cls(
                self._config.exchange_api_url,
                skip_ws=True,
                perp_dexs=list(perp_dexs),
                timeout=float(
                    self._config.broker_mutation_recovery_request_timeout_seconds
                ),
            )
            self._sdk_recovery_info_perp_dexs = perp_dexs
        return self._sdk_recovery_info

    def _cloid(self, raw: str) -> Any:
        types_module = importlib.import_module("hyperliquid.utils.types")
        cloid_cls = getattr(types_module, "Cloid", None)
        if cloid_cls is None:
            return raw
        from_str = getattr(cloid_cls, "from_str", None)
        if from_str is None:
            return raw
        return from_str(raw)


def exchange_from_config(
    config: HyperliquidExecutionConfig,
) -> HyperliquidExecutionExchange:
    """Return the production SDK adapter."""

    return HyperliquidSdkExecutionExchange(config)


def _best_level_price(book: Mapping[str, object], side_index: int) -> Decimal | None:
    raw_levels = book.get("levels")
    if not isinstance(raw_levels, list):
        return None
    levels = cast(list[object], raw_levels)
    if len(levels) <= side_index:
        return None
    side = levels[side_index]
    if not isinstance(side, list) or not side:
        return None
    side_levels = cast(list[object], side)
    level = side_levels[0]
    if not isinstance(level, Mapping):
        return None
    return _optional_decimal(cast(Mapping[str, object], level).get("px"))


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    return int(str(value))


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def _asset_metadata(
    asset: Mapping[str, object],
) -> tuple[str, bool, int | None, Decimal | None]:
    name = str(asset.get("name") or "").strip()
    return (
        name,
        _truthy(asset.get("isDelisted")),
        _optional_int(asset.get("szDecimals")),
        _optional_decimal(asset.get("maxLeverage")),
    )
