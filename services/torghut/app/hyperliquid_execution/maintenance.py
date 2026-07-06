"""Explicit operator maintenance tools for Hyperliquid execution v2."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Mapping, Protocol, cast

from .config import HyperliquidExecutionConfig
from .exchange import HyperliquidSdkExecutionExchange
from .margin import gross_margin_over_budget, gross_margin_used_usd, over_budget_coins
from .models import AccountState, OrderResult, RiskState, symbol_key


class MaintenanceExchange(Protocol):
    """Exchange surface required by the reduce-only maintenance command."""

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        """Read the raw account state."""
        ...

    def close_position_reduce_only(
        self,
        coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
    ) -> OrderResult:
        """Close a position through a reduce-only exchange order."""
        ...


@dataclass(frozen=True)
class _OverBudgetState:
    gross_over_cap: bool
    symbol_over_cap_coins: set[str]

    @property
    def symbol_over_cap(self) -> bool:
        return bool(self.symbol_over_cap_coins)

    @property
    def over_cap(self) -> bool:
        return self.gross_over_cap or self.symbol_over_cap


@dataclass(frozen=True)
class _ReduceOnlyActionRequest:
    exchange: MaintenanceExchange
    execute: bool
    slippage: Decimal
    max_actions: int
    blockers: tuple[str, ...]


def close_excluded_positions(
    *,
    config: HyperliquidExecutionConfig,
    exchange: MaintenanceExchange,
    requested_coins: tuple[str, ...] = (),
    execute: bool = False,
    slippage: Decimal = Decimal("0.05"),
) -> dict[str, object]:
    """Close excluded/requested positions through the runtime account only."""

    requested_symbols = _requested_symbols(config, requested_coins)
    observed_at = datetime.now(timezone.utc)
    account = exchange.reconcile_account({})
    candidates = [
        position
        for position in _raw_position_rows(account)
        if symbol_key(str(position["coin"])) in requested_symbols
    ]
    blockers = _execution_blockers(config) if execute else []
    actions: list[dict[str, object]] = []
    for candidate in candidates:
        action = {
            "coin": candidate["coin"],
            "size": candidate["size"],
            "notional_usd": candidate["notional_usd"],
        }
        if blockers:
            action["status"] = "blocked"
            action["reason"] = ",".join(blockers)
        elif not execute:
            action["status"] = "dry_run"
        else:
            result = exchange.close_position_reduce_only(
                str(candidate["coin"]),
                size=abs(Decimal(str(candidate["size"]))),
                slippage=slippage,
            )
            action.update(
                {
                    "status": result.status,
                    "exchange_order_id": result.exchange_order_id,
                    "rejection_reason": result.rejection_reason,
                    "raw_response": result.raw_response,
                }
            )
        actions.append(action)
    return {
        "schema_version": "torghut.hyperliquid-execution-maintenance.v1",
        "observed_at": observed_at.isoformat(),
        "execute_requested": execute,
        "maintenance_reduce_only_close_enabled": config.maintenance_reduce_only_close_enabled,
        "market_data_network": config.market_data_network,
        "execution_network": config.execution_network,
        "requested_symbols": sorted(requested_symbols),
        "account_gross_exposure_usd": str(account.account.gross_exposure_usd),
        "candidates": candidates,
        "blockers": blockers,
        "actions": actions,
    }


def close_largest_positions_over_cap(
    *,
    config: HyperliquidExecutionConfig,
    exchange: MaintenanceExchange,
    execute: bool = False,
    slippage: Decimal = Decimal("0.05"),
    max_actions: int = 1,
) -> dict[str, object]:
    """Close the largest positions first when gross or symbol margin is over budget."""

    observed_at = datetime.now(timezone.utc)
    account = exchange.reconcile_account({})
    candidates = sorted(
        _raw_position_rows(account),
        key=lambda position: _decimal(position["notional_usd"]),
        reverse=True,
    )
    risk_state = _risk_state_from_account(
        account=account,
        candidates=candidates,
    )
    over_budget = _over_budget_state(risk_state, config)
    blockers = (
        tuple(_execution_blockers(config)) if execute and over_budget.over_cap else ()
    )
    actions = (
        _over_cap_actions(
            candidates,
            over_budget,
            _ReduceOnlyActionRequest(
                exchange=exchange,
                execute=execute,
                slippage=slippage,
                max_actions=max_actions,
                blockers=blockers,
            ),
        )
        if over_budget.over_cap
        else []
    )

    return {
        "schema_version": "torghut.hyperliquid-execution-over-cap-maintenance.v1",
        "observed_at": observed_at.isoformat(),
        "execute_requested": execute,
        "maintenance_reduce_only_close_enabled": config.maintenance_reduce_only_close_enabled,
        "market_data_network": config.market_data_network,
        "execution_network": config.execution_network,
        "account_gross_exposure_usd": str(account.account.gross_exposure_usd),
        "account_margin_used_usd": str(gross_margin_used_usd(risk_state)),
        "target_margin_utilization": str(config.target_margin_utilization),
        "max_symbol_margin_utilization": str(config.max_symbol_margin_utilization),
        "max_order_margin_utilization": str(config.max_order_margin_utilization),
        "over_cap": over_budget.over_cap,
        "gross_over_cap": over_budget.gross_over_cap,
        "symbol_over_cap": over_budget.symbol_over_cap,
        "symbol_over_cap_coins": sorted(over_budget.symbol_over_cap_coins),
        "candidates": candidates,
        "blockers": list(blockers),
        "actions": actions,
    }


def risk_state_over_cap(
    risk_state: RiskState,
    config: HyperliquidExecutionConfig,
) -> bool:
    """Return whether runtime risk state requires reduce-only maintenance."""

    if gross_margin_over_budget(state=risk_state, config=config):
        return True
    return bool(over_budget_coins(state=risk_state, config=config))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Dry-run or execute reduce-only closes for excluded Hyperliquid positions."
    )
    parser.add_argument(
        "--coin",
        action="append",
        default=[],
        help="Coin to close; defaults to configured excluded coins.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Submit reduce-only close orders when the maintenance env flag is enabled.",
    )
    parser.add_argument(
        "--slippage",
        default="0.05",
        help="SDK market_close slippage fraction for reduce-only IOC orders.",
    )
    args = parser.parse_args(argv)
    config = HyperliquidExecutionConfig.from_env()
    report = close_excluded_positions(
        config=config,
        exchange=HyperliquidSdkExecutionExchange(config),
        requested_coins=tuple(str(coin) for coin in args.coin),
        execute=bool(args.execute),
        slippage=Decimal(str(args.slippage)),
    )
    print(json.dumps(report, sort_keys=True))
    return 2 if args.execute and report["blockers"] else 0


def _execution_blockers(config: HyperliquidExecutionConfig) -> list[str]:
    blockers = config.validation_errors()
    if not config.maintenance_reduce_only_close_enabled:
        blockers.append("maintenance_reduce_only_close_disabled")
    if not config.account_address:
        blockers.append("account_address_required")
    if not config.api_wallet_private_key:
        blockers.append("api_wallet_private_key_required")
    return blockers


def _requested_symbols(
    config: HyperliquidExecutionConfig,
    requested_coins: tuple[str, ...],
) -> set[str]:
    source = requested_coins or config.excluded_coins
    return {symbol_key(coin) for coin in source if symbol_key(coin)}


def _raw_position_rows(account: AccountState) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    _append_raw_position_rows(rows, account.account.raw_payload)
    if not rows:
        rows.extend(_position_snapshot_rows(account))
    return sorted(rows, key=lambda row: str(row["coin"]))


def _append_raw_position_rows(
    rows: list[dict[str, object]],
    payload: Mapping[str, object],
) -> None:
    dex_states = payload.get("dexStates")
    if isinstance(dex_states, dict):
        for dex_payload in cast(Mapping[str, object], dex_states).values():
            if isinstance(dex_payload, dict):
                _append_raw_position_rows(rows, cast(Mapping[str, object], dex_payload))

    raw_positions = payload.get("assetPositions")
    if not isinstance(raw_positions, list):
        return
    for item in cast(list[object], raw_positions):
        if not isinstance(item, dict):
            continue
        item_map = cast(Mapping[str, object], item)
        position = item_map.get("position")
        if not isinstance(position, dict):
            continue
        position_map = cast(Mapping[str, object], position)
        coin = str(position_map.get("coin") or "").strip()
        size = _decimal(position_map.get("szi"))
        if not coin or size == Decimal("0"):
            continue
        rows.append(
            {
                "coin": coin,
                "size": str(size),
                "entry_price": _optional_text(position_map.get("entryPx")),
                "notional_usd": str(_position_exposure_usd(position_map)),
                "unrealized_pnl_usd": str(position_map.get("unrealizedPnl") or "0"),
                "max_leverage": _optional_text(
                    position_map.get("maxLeverage")
                    or _nested_leverage_value(position_map)
                ),
            }
        )


def _position_snapshot_rows(account: AccountState) -> list[dict[str, object]]:
    return [
        {
            "coin": position.sdk_coin or position.coin,
            "size": str(position.size),
            "entry_price": (
                str(position.entry_price) if position.entry_price is not None else None
            ),
            "notional_usd": str(abs(position.notional_usd)),
            "unrealized_pnl_usd": str(position.unrealized_pnl_usd),
            "max_leverage": _optional_text(
                position.raw_payload.get("maxLeverage")
                or _nested_leverage_value(position.raw_payload)
            ),
        }
        for position in account.positions
        if position.size != Decimal("0")
    ]


def _position_exposure_usd(position: Mapping[str, object]) -> Decimal:
    position_value = _optional_decimal(position.get("positionValue"))
    if position_value is not None:
        return abs(position_value)
    size = _decimal(position.get("szi"))
    entry_price = _optional_decimal(position.get("entryPx")) or Decimal("0")
    return abs(size * entry_price)


def _risk_state_from_account(
    *,
    account: AccountState,
    candidates: list[dict[str, object]],
) -> RiskState:
    exposure_by_coin = {
        str(candidate["coin"]): _decimal(candidate["notional_usd"])
        for candidate in candidates
    }
    leverage_by_coin = {
        coin: _candidate_max_leverage(candidate)
        for coin, candidate in {
            str(candidate["coin"]): candidate for candidate in candidates
        }.items()
    }
    return RiskState(
        trading_enabled=True,
        dependencies=(),
        gross_exposure_usd=account.account.gross_exposure_usd,
        daily_realized_pnl_usd=Decimal("0"),
        open_order_coins=frozenset(),
        symbol_exposure_usd_by_coin=exposure_by_coin,
        cooldown_reason_by_coin={},
        account_value_usd=account.account.account_value_usd,
        withdrawable_usd=account.account.withdrawable_usd,
        max_leverage_by_coin=leverage_by_coin,
    )


def _over_budget_state(
    risk_state: RiskState,
    config: HyperliquidExecutionConfig,
) -> _OverBudgetState:
    return _OverBudgetState(
        gross_over_cap=gross_margin_over_budget(state=risk_state, config=config),
        symbol_over_cap_coins=over_budget_coins(state=risk_state, config=config),
    )


def _over_cap_actions(
    candidates: list[dict[str, object]],
    over_budget: _OverBudgetState,
    request: _ReduceOnlyActionRequest,
) -> list[dict[str, object]]:
    actions: list[dict[str, object]] = []
    action_candidates = _over_cap_action_candidates(
        candidates,
        gross_over_cap=over_budget.gross_over_cap,
        symbol_over_cap_coins=over_budget.symbol_over_cap_coins,
        max_actions=request.max_actions,
    )
    for candidate in action_candidates:
        action = _over_cap_action(candidate, over_budget, request)
        actions.append(action)
    return actions


def _over_cap_action(
    candidate: Mapping[str, object],
    over_budget: _OverBudgetState,
    request: _ReduceOnlyActionRequest,
) -> dict[str, object]:
    action = {
        "coin": candidate["coin"],
        "size": candidate["size"],
        "notional_usd": candidate["notional_usd"],
        "reason": _over_cap_reason(
            candidate,
            gross_over_cap=over_budget.gross_over_cap,
            symbol_over_cap_coins=over_budget.symbol_over_cap_coins,
        ),
    }
    if request.blockers:
        action["status"] = "blocked"
        action["blockers"] = list(request.blockers)
    elif not request.execute:
        action["status"] = "dry_run"
    else:
        action.update(_reduce_only_close(candidate, request))
    return action


def _reduce_only_close(
    candidate: Mapping[str, object],
    request: _ReduceOnlyActionRequest,
) -> dict[str, object]:
    result = request.exchange.close_position_reduce_only(
        str(candidate["coin"]),
        size=abs(Decimal(str(candidate["size"]))),
        slippage=request.slippage,
    )
    return {
        "status": result.status,
        "exchange_order_id": result.exchange_order_id,
        "rejection_reason": result.rejection_reason,
        "raw_response": result.raw_response,
    }


def _over_cap_action_candidates(
    candidates: list[dict[str, object]],
    *,
    gross_over_cap: bool,
    symbol_over_cap_coins: set[str],
    max_actions: int,
) -> list[dict[str, object]]:
    limit = max(0, max_actions)
    if limit == 0:
        return []
    if gross_over_cap:
        return candidates[:limit]
    return [
        candidate
        for candidate in candidates
        if str(candidate["coin"]) in symbol_over_cap_coins
    ][:limit]


def _over_cap_reason(
    candidate: Mapping[str, object],
    *,
    gross_over_cap: bool,
    symbol_over_cap_coins: set[str],
) -> str:
    coin = str(candidate["coin"])
    if not gross_over_cap and coin in symbol_over_cap_coins:
        return "symbol_margin_budget_exhausted"
    return "gross_margin_budget_exhausted"


def _nested_leverage_value(position: Mapping[str, object]) -> object | None:
    raw_leverage = position.get("leverage")
    if not isinstance(raw_leverage, dict):
        return None
    return cast(Mapping[str, object], raw_leverage).get("value")


def _candidate_max_leverage(candidate: Mapping[str, object]) -> Decimal:
    max_leverage = _decimal(candidate.get("max_leverage"))
    return max_leverage if max_leverage > Decimal("0") else Decimal("1")


def _decimal(value: object) -> Decimal:
    if value is None or value == "":
        return Decimal("0")
    return Decimal(str(value))


def _optional_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


if __name__ == "__main__":
    raise SystemExit(main())
