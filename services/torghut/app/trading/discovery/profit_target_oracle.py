"""Oracle-style objective gate for doc 71 whitepaper autoresearch candidates."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast


PROFIT_TARGET_ORACLE_SCHEMA_VERSION = "torghut.profit-target-oracle.v1"


@dataclass(frozen=True)
class ProfitTargetOraclePolicy:
    min_active_day_ratio: Decimal = Decimal("0.90")
    min_positive_day_ratio: Decimal = Decimal("0.60")
    min_daily_net_pnl: Decimal = Decimal("0")
    max_best_day_share: Decimal = Decimal("0.25")
    max_cluster_contribution_share: Decimal = Decimal("0.40")
    max_single_symbol_contribution_share: Decimal = Decimal("0.35")
    max_worst_day_loss: Decimal = Decimal("350")
    max_drawdown: Decimal = Decimal("900")
    max_gross_exposure_pct_equity: Decimal = Decimal("1.0")
    min_cash: Decimal = Decimal("0")
    max_negative_cash_observation_count: int = 0
    min_avg_filled_notional_per_day: Decimal = Decimal("300000")
    min_regime_slice_pass_rate: Decimal = Decimal("0.45")
    min_posterior_edge_lower: Decimal = Decimal("0")
    require_shadow_parity_within_budget: bool = True
    require_executable_replay: bool = True
    min_executable_order_count: int = 1
    require_executable_replay_notional_within_buying_power: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_active_day_ratio": str(self.min_active_day_ratio),
            "min_positive_day_ratio": str(self.min_positive_day_ratio),
            "min_daily_net_pnl": str(self.min_daily_net_pnl),
            "max_best_day_share": str(self.max_best_day_share),
            "max_cluster_contribution_share": str(self.max_cluster_contribution_share),
            "max_single_symbol_contribution_share": str(
                self.max_single_symbol_contribution_share
            ),
            "max_worst_day_loss": str(self.max_worst_day_loss),
            "max_drawdown": str(self.max_drawdown),
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "min_cash": str(self.min_cash),
            "max_negative_cash_observation_count": self.max_negative_cash_observation_count,
            "min_avg_filled_notional_per_day": str(
                self.min_avg_filled_notional_per_day
            ),
            "min_regime_slice_pass_rate": str(self.min_regime_slice_pass_rate),
            "min_posterior_edge_lower": str(self.min_posterior_edge_lower),
            "require_shadow_parity_within_budget": self.require_shadow_parity_within_budget,
            "require_executable_replay": self.require_executable_replay,
            "min_executable_order_count": self.min_executable_order_count,
            "require_executable_replay_notional_within_buying_power": self.require_executable_replay_notional_within_buying_power,
        }


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _nonnegative_int(value: Any, *, default: int = 0) -> int:
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value if value is not None else "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
        "passed",
    }


def _numeric_check(
    *,
    metric: str,
    observed: Decimal,
    operator: str,
    threshold: Decimal,
) -> dict[str, Any]:
    if operator == "gte":
        passed = observed >= threshold
    elif operator == "lte":
        passed = observed <= threshold
    elif operator == "gt":
        passed = observed > threshold
    else:
        raise ValueError(f"oracle_operator_unsupported:{operator}")
    return {
        "metric": metric,
        "observed": str(observed),
        "operator": operator,
        "threshold": str(threshold),
        "passed": passed,
    }


def evaluate_profit_target_oracle(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: Decimal = Decimal("300"),
    policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Any]:
    """Evaluate the doc 71 production objective criteria against a scorecard."""

    policy = policy or ProfitTargetOraclePolicy()
    net_pnl = _decimal(
        scorecard.get("portfolio_post_cost_net_pnl_per_day")
        or scorecard.get("net_pnl_per_day")
    )
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        daily_net = cast(Mapping[str, Any], daily_net_payload)
        min_daily_net_pnl = min(_decimal(value) for value in daily_net.values())
        daily_net_observed_day_count = len(daily_net)
    else:
        min_daily_net_pnl = Decimal("0")
        daily_net_observed_day_count = 0
    trading_day_count = _nonnegative_int(
        scorecard.get("trading_day_count"),
        default=daily_net_observed_day_count,
    )
    if trading_day_count < daily_net_observed_day_count:
        trading_day_count = daily_net_observed_day_count
    if (
        policy.min_daily_net_pnl > 0
        and daily_net_observed_day_count < trading_day_count
    ):
        min_daily_net_pnl = min(min_daily_net_pnl, Decimal("0"))
    checks = [
        _numeric_check(
            metric="portfolio_post_cost_net_pnl_per_day",
            observed=net_pnl,
            operator="gte",
            threshold=target_net_pnl_per_day,
        ),
        _numeric_check(
            metric="active_day_ratio",
            observed=_decimal(scorecard.get("active_day_ratio")),
            operator="gte",
            threshold=policy.min_active_day_ratio,
        ),
        _numeric_check(
            metric="positive_day_ratio",
            observed=_decimal(scorecard.get("positive_day_ratio")),
            operator="gte",
            threshold=policy.min_positive_day_ratio,
        ),
        _numeric_check(
            metric="min_daily_net_pnl",
            observed=min_daily_net_pnl,
            operator="gte",
            threshold=policy.min_daily_net_pnl,
        ),
        _numeric_check(
            metric="daily_net_observed_day_count",
            observed=Decimal(daily_net_observed_day_count),
            operator="gte",
            threshold=Decimal(trading_day_count),
        ),
        _numeric_check(
            metric="best_day_share",
            observed=_decimal(scorecard.get("best_day_share")),
            operator="lte",
            threshold=policy.max_best_day_share,
        ),
        _numeric_check(
            metric="max_single_day_contribution_share",
            observed=_decimal(
                scorecard.get("max_single_day_contribution_share")
                or scorecard.get("best_day_share")
            ),
            operator="lte",
            threshold=policy.max_best_day_share,
        ),
        _numeric_check(
            metric="max_cluster_contribution_share",
            observed=_decimal(
                scorecard.get("max_cluster_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=policy.max_cluster_contribution_share,
        ),
        _numeric_check(
            metric="max_single_symbol_contribution_share",
            observed=_decimal(
                scorecard.get("max_single_symbol_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=policy.max_single_symbol_contribution_share,
        ),
        _numeric_check(
            metric="worst_day_loss",
            observed=_decimal(scorecard.get("worst_day_loss")),
            operator="lte",
            threshold=policy.max_worst_day_loss,
        ),
        _numeric_check(
            metric="max_drawdown",
            observed=_decimal(scorecard.get("max_drawdown")),
            operator="lte",
            threshold=policy.max_drawdown,
        ),
        _numeric_check(
            metric="max_gross_exposure_pct_equity",
            observed=_decimal(scorecard.get("max_gross_exposure_pct_equity")),
            operator="lte",
            threshold=policy.max_gross_exposure_pct_equity,
        ),
        _numeric_check(
            metric="min_cash",
            observed=_decimal(scorecard.get("min_cash"), default=str(policy.min_cash)),
            operator="gte",
            threshold=policy.min_cash,
        ),
        _numeric_check(
            metric="negative_cash_observation_count",
            observed=Decimal(
                _nonnegative_int(scorecard.get("negative_cash_observation_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_negative_cash_observation_count)),
        ),
        _numeric_check(
            metric="avg_filled_notional_per_day",
            observed=_decimal(scorecard.get("avg_filled_notional_per_day")),
            operator="gte",
            threshold=policy.min_avg_filled_notional_per_day,
        ),
        _numeric_check(
            metric="regime_slice_pass_rate",
            observed=_decimal(scorecard.get("regime_slice_pass_rate")),
            operator="gte",
            threshold=policy.min_regime_slice_pass_rate,
        ),
        _numeric_check(
            metric="posterior_edge_lower",
            observed=_decimal(scorecard.get("posterior_edge_lower")),
            operator="gt",
            threshold=policy.min_posterior_edge_lower,
        ),
    ]
    shadow_parity_status = str(scorecard.get("shadow_parity_status") or "").strip()
    checks.append(
        {
            "metric": "shadow_parity_status",
            "observed": shadow_parity_status,
            "operator": "eq",
            "threshold": "within_budget",
            "passed": (shadow_parity_status == "within_budget")
            if policy.require_shadow_parity_within_budget
            else True,
        }
    )
    raw_executable_artifact_refs = scorecard.get("executable_replay_artifact_refs")
    executable_artifact_refs: list[str] = []
    if isinstance(raw_executable_artifact_refs, list):
        for item in cast(list[Any], raw_executable_artifact_refs):
            normalized_ref = str(item).strip()
            if normalized_ref:
                executable_artifact_refs.append(normalized_ref)
    executable_artifact_ref = str(
        scorecard.get("executable_replay_artifact_ref") or ""
    ).strip()
    executable_artifact_present = bool(
        executable_artifact_ref or executable_artifact_refs
    )
    executable_passed = _boolish(scorecard.get("executable_replay_passed"))
    executable_order_count = _nonnegative_int(
        scorecard.get("executable_replay_order_count")
        or scorecard.get("executable_replay_submitted_order_count")
        or scorecard.get("executable_replay_orders_submitted_total")
    )
    executable_buying_power = _decimal(
        scorecard.get("executable_replay_account_buying_power")
        or scorecard.get("executable_replay_buying_power")
    )
    executable_max_notional = _decimal(
        scorecard.get("executable_replay_max_notional_per_trade")
        or scorecard.get("executable_replay_max_notional_per_order")
    )
    checks.append(
        {
            "metric": "executable_replay_passed",
            "observed": str(executable_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "passed": executable_passed if policy.require_executable_replay else True,
        }
    )
    checks.append(
        {
            "metric": "executable_replay_artifact_present",
            "observed": str(executable_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "passed": executable_artifact_present
            if policy.require_executable_replay
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="executable_replay_order_count",
            observed=Decimal(executable_order_count),
            operator="gte",
            threshold=Decimal(max(0, policy.min_executable_order_count))
            if policy.require_executable_replay
            else Decimal("0"),
        )
    )
    if policy.require_executable_replay_notional_within_buying_power:
        checks.append(
            _numeric_check(
                metric="executable_replay_account_buying_power",
                observed=executable_buying_power,
                operator="gt",
                threshold=Decimal("0"),
            )
        )
        checks.append(
            _numeric_check(
                metric="executable_replay_max_notional_per_trade",
                observed=executable_max_notional,
                operator="gt",
                threshold=Decimal("0"),
            )
        )
        checks.append(
            _numeric_check(
                metric="executable_replay_notional_within_buying_power",
                observed=executable_max_notional,
                operator="lte",
                threshold=executable_buying_power,
            )
        )
    blockers = [
        f"{item['metric']}_failed" for item in checks if not bool(item["passed"])
    ]
    return {
        "schema_version": PROFIT_TARGET_ORACLE_SCHEMA_VERSION,
        "policy": policy.to_payload(),
        "passed": not blockers,
        "checks": checks,
        "blockers": blockers,
    }
