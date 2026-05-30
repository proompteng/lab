"""Single source of truth for runtime-ledger proof thresholds."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation


@dataclass(frozen=True)
class RuntimeLedgerProofPolicy:
    min_net_pnl_after_costs: Decimal = Decimal("500")
    min_daily_net_pnl_after_costs: Decimal = Decimal("500")
    min_trading_days: int = 1
    max_drawdown_pct_equity: Decimal = Decimal("0.08")
    max_best_day_share: Decimal = Decimal("0.25")
    max_symbol_concentration_share: Decimal = Decimal("0.50")
    authority_min_trading_days: int = 20
    authority_min_mean_daily_net_pnl_after_costs: Decimal = Decimal("500")
    authority_min_median_daily_net_pnl_after_costs: Decimal = Decimal("250")
    authority_min_p10_daily_net_pnl_after_costs: Decimal = Decimal("-250")
    authority_min_worst_day_net_pnl_after_costs: Decimal = Decimal("-750")
    authority_max_intraday_drawdown: Decimal = Decimal("1500")
    authority_max_best_day_share: Decimal = Decimal("0.25")

    def target_payload(self) -> dict[str, object]:
        return {
            "min_runtime_ledger_net_pnl_after_costs": _decimal_text(
                self.min_net_pnl_after_costs
            ),
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                self.min_daily_net_pnl_after_costs
            ),
            "min_runtime_ledger_trading_days": self.min_trading_days,
        }


DEFAULT_RUNTIME_LEDGER_PROOF_POLICY = RuntimeLedgerProofPolicy()

_DECIMAL_ENV_FIELDS = {
    "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_NET_PNL_AFTER_COSTS": ("min_net_pnl_after_costs"),
    "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_DAILY_NET_PNL_AFTER_COSTS": (
        "min_daily_net_pnl_after_costs"
    ),
    "TORGHUT_RUNTIME_LEDGER_PROOF_MAX_DRAWDOWN_PCT_EQUITY": ("max_drawdown_pct_equity"),
    "TORGHUT_RUNTIME_LEDGER_PROOF_MAX_BEST_DAY_SHARE": "max_best_day_share",
    "TORGHUT_RUNTIME_LEDGER_PROOF_MAX_SYMBOL_CONCENTRATION_SHARE": (
        "max_symbol_concentration_share"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_MEAN_DAILY_NET_PNL_AFTER_COSTS": (
        "authority_min_mean_daily_net_pnl_after_costs"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_MEDIAN_DAILY_NET_PNL_AFTER_COSTS": (
        "authority_min_median_daily_net_pnl_after_costs"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_P10_DAILY_NET_PNL_AFTER_COSTS": (
        "authority_min_p10_daily_net_pnl_after_costs"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_WORST_DAY_NET_PNL_AFTER_COSTS": (
        "authority_min_worst_day_net_pnl_after_costs"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_INTRADAY_DRAWDOWN": (
        "authority_max_intraday_drawdown"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_BEST_DAY_SHARE": (
        "authority_max_best_day_share"
    ),
}
_INT_ENV_FIELDS = {
    "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_TRADING_DAYS": "min_trading_days",
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_TRADING_DAYS": ("authority_min_trading_days"),
}


def runtime_ledger_proof_policy_from_env(
    environ: Mapping[str, str] | None = None,
) -> RuntimeLedgerProofPolicy:
    source = os.environ if environ is None else environ
    values = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.__dict__.copy()
    for env_name, field_name in _DECIMAL_ENV_FIELDS.items():
        raw_value = source.get(env_name)
        if raw_value is None or not raw_value.strip():
            continue
        values[field_name] = _parse_decimal_env(env_name, raw_value)
    for env_name, field_name in _INT_ENV_FIELDS.items():
        raw_value = source.get(env_name)
        if raw_value is None or not raw_value.strip():
            continue
        values[field_name] = _parse_int_env(env_name, raw_value)
    return RuntimeLedgerProofPolicy(**values)


def _parse_decimal_env(name: str, value: str) -> Decimal:
    try:
        return Decimal(value.strip())
    except InvalidOperation as exc:
        raise ValueError(f"{name} must be a decimal: {value!r}") from exc


def _parse_int_env(name: str, value: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer: {value!r}") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be non-negative: {value!r}")
    return parsed


def _decimal_text(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


__all__ = [
    "DEFAULT_RUNTIME_LEDGER_PROOF_POLICY",
    "RuntimeLedgerProofPolicy",
    "runtime_ledger_proof_policy_from_env",
]
