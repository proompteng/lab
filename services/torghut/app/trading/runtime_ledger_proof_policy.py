"""Single source of truth for runtime-ledger proof thresholds."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal


RuntimeLedgerProofMode = Literal["smoke", "probation", "authority"]
RUNTIME_LEDGER_PROOF_MODES: tuple[RuntimeLedgerProofMode, ...] = (
    "smoke",
    "probation",
    "authority",
)
DEFAULT_RUNTIME_LEDGER_PROOF_MODE: RuntimeLedgerProofMode = "smoke"


@dataclass(frozen=True)
class RuntimeLedgerProofPolicy:
    proof_mode: RuntimeLedgerProofMode = DEFAULT_RUNTIME_LEDGER_PROOF_MODE
    min_net_pnl_after_costs: Decimal = Decimal("500")
    min_daily_net_pnl_after_costs: Decimal = Decimal("500")
    min_trading_days: int = 1
    probation_min_trading_days: int = 5
    max_drawdown_pct_equity: Decimal = Decimal("0.08")
    max_best_day_share: Decimal = Decimal("0.25")
    max_symbol_concentration_share: Decimal = Decimal("0.50")
    authority_min_trading_days: int = 20
    authority_min_mean_daily_net_pnl_after_costs: Decimal = Decimal("500")
    authority_min_median_daily_net_pnl_after_costs: Decimal = Decimal("250")
    authority_min_p10_daily_net_pnl_after_costs: Decimal = Decimal("-250")
    authority_min_worst_day_net_pnl_after_costs: Decimal = Decimal("-750")
    authority_max_intraday_drawdown: Decimal = Decimal("1500")
    authority_max_drawdown_pct_equity: Decimal = Decimal("0.03")
    authority_max_best_day_share: Decimal = Decimal("0.25")
    authority_max_symbol_concentration_share: Decimal = Decimal("0.35")
    authority_min_closed_round_trips: int = 300
    authority_min_filled_notional: Decimal = Decimal("10000000")

    def target_payload(
        self,
        proof_mode: str | None = None,
    ) -> dict[str, object]:
        targets = self.targets_for_mode(proof_mode or self.proof_mode)
        return {
            "proof_mode": targets["proof_mode"],
            "final_authority": targets["final_authority"],
            "evidence_collection_only": targets["evidence_collection_only"],
            "evidence_collection_ok": targets["evidence_collection_ok"],
            "canary_collection_authorized": targets["canary_collection_authorized"],
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "min_runtime_ledger_net_pnl_after_costs": _decimal_text(
                _target_decimal(targets, "min_net_pnl_after_costs")
            ),
            "min_runtime_ledger_daily_net_pnl_after_costs": _decimal_text(
                _target_decimal(targets, "min_daily_net_pnl_after_costs")
            ),
            "min_runtime_ledger_trading_days": targets["min_trading_days"],
            "max_runtime_ledger_drawdown_pct_equity": _decimal_text(
                _target_decimal(targets, "max_drawdown_pct_equity")
            ),
            "max_runtime_ledger_best_day_share": _decimal_text(
                _target_decimal(targets, "max_best_day_share")
            ),
            "max_runtime_ledger_symbol_concentration_share": _decimal_text(
                _target_decimal(targets, "max_symbol_concentration_share")
            ),
            "min_runtime_ledger_closed_round_trips": targets[
                "min_closed_round_trips"
            ],
            "min_runtime_ledger_filled_notional": _decimal_text(
                _target_decimal(targets, "min_filled_notional")
            ),
        }

    def targets_for_mode(self, proof_mode: str) -> dict[str, object]:
        mode = normalize_runtime_ledger_proof_mode(proof_mode)
        min_days = self.min_trading_days
        min_daily = self.min_daily_net_pnl_after_costs
        min_net = self.min_net_pnl_after_costs
        max_drawdown_pct_equity = self.max_drawdown_pct_equity
        max_best_day_share = self.max_best_day_share
        max_symbol_concentration_share = self.max_symbol_concentration_share
        min_closed_round_trips = 1
        min_filled_notional = Decimal("0")
        if mode == "probation":
            min_days = max(min_days, self.probation_min_trading_days)
            min_net = max(min_net, min_daily * Decimal(min_days))
        elif mode == "authority":
            min_days = max(min_days, self.authority_min_trading_days)
            min_daily = max(
                min_daily,
                self.authority_min_mean_daily_net_pnl_after_costs,
            )
            min_net = max(min_net, min_daily * Decimal(min_days))
            max_drawdown_pct_equity = min(
                max_drawdown_pct_equity,
                self.authority_max_drawdown_pct_equity,
            )
            max_best_day_share = min(
                max_best_day_share,
                self.authority_max_best_day_share,
            )
            max_symbol_concentration_share = min(
                max_symbol_concentration_share,
                self.authority_max_symbol_concentration_share,
            )
            min_closed_round_trips = self.authority_min_closed_round_trips
            min_filled_notional = self.authority_min_filled_notional
        return {
            "proof_mode": mode,
            "final_authority": mode == "authority",
            "evidence_collection_only": mode != "authority",
            "evidence_collection_ok": mode != "authority",
            "canary_collection_authorized": mode == "probation",
            "min_net_pnl_after_costs": min_net,
            "min_daily_net_pnl_after_costs": min_daily,
            "min_trading_days": min_days,
            "max_drawdown_pct_equity": max_drawdown_pct_equity,
            "max_best_day_share": max_best_day_share,
            "max_symbol_concentration_share": max_symbol_concentration_share,
            "min_closed_round_trips": min_closed_round_trips,
            "min_filled_notional": min_filled_notional,
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
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_DRAWDOWN_PCT_EQUITY": (
        "authority_max_drawdown_pct_equity"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_BEST_DAY_SHARE": (
        "authority_max_best_day_share"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MAX_SYMBOL_CONCENTRATION_SHARE": (
        "authority_max_symbol_concentration_share"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_FILLED_NOTIONAL": (
        "authority_min_filled_notional"
    ),
}
_INT_ENV_FIELDS = {
    "TORGHUT_RUNTIME_LEDGER_PROOF_MIN_TRADING_DAYS": "min_trading_days",
    "TORGHUT_RUNTIME_LEDGER_PROOF_PROBATION_MIN_TRADING_DAYS": (
        "probation_min_trading_days"
    ),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_TRADING_DAYS": ("authority_min_trading_days"),
    "TORGHUT_RUNTIME_LEDGER_AUTHORITY_MIN_CLOSED_ROUND_TRIPS": (
        "authority_min_closed_round_trips"
    ),
}


def runtime_ledger_proof_policy_from_env(
    environ: Mapping[str, str] | None = None,
) -> RuntimeLedgerProofPolicy:
    source = os.environ if environ is None else environ
    values = DEFAULT_RUNTIME_LEDGER_PROOF_POLICY.__dict__.copy()
    raw_mode = source.get("TORGHUT_RUNTIME_LEDGER_PROOF_MODE")
    if raw_mode is not None and raw_mode.strip():
        values["proof_mode"] = normalize_runtime_ledger_proof_mode(raw_mode)
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


def normalize_runtime_ledger_proof_mode(value: str) -> RuntimeLedgerProofMode:
    mode = value.strip().lower().replace("_", "-")
    if mode in {"paper-probation", "paper"}:
        mode = "probation"
    if mode not in RUNTIME_LEDGER_PROOF_MODES:
        allowed = ", ".join(RUNTIME_LEDGER_PROOF_MODES)
        raise ValueError(
            f"TORGHUT_RUNTIME_LEDGER_PROOF_MODE must be one of {allowed}: {value!r}"
        )
    return mode


def _target_decimal(targets: Mapping[str, object], key: str) -> Decimal:
    value = targets[key]
    if isinstance(value, Decimal):
        return value
    raise TypeError(f"{key} must be Decimal")


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
    "DEFAULT_RUNTIME_LEDGER_PROOF_MODE",
    "DEFAULT_RUNTIME_LEDGER_PROOF_POLICY",
    "RUNTIME_LEDGER_PROOF_MODES",
    "RuntimeLedgerProofPolicy",
    "RuntimeLedgerProofMode",
    "normalize_runtime_ledger_proof_mode",
    "runtime_ledger_proof_policy_from_env",
]
