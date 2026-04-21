"""Oracle-style objective gate for doc 71 whitepaper autoresearch candidates."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping


PROFIT_TARGET_ORACLE_SCHEMA_VERSION = "torghut.profit-target-oracle.v1"


@dataclass(frozen=True)
class ProfitTargetOraclePolicy:
    min_active_day_ratio: Decimal = Decimal("0.90")
    min_positive_day_ratio: Decimal = Decimal("0.60")
    max_best_day_share: Decimal = Decimal("0.25")
    max_cluster_contribution_share: Decimal = Decimal("0.40")
    max_single_symbol_contribution_share: Decimal = Decimal("0.35")
    max_worst_day_loss: Decimal = Decimal("350")
    max_drawdown: Decimal = Decimal("900")
    min_avg_filled_notional_per_day: Decimal = Decimal("300000")
    min_regime_slice_pass_rate: Decimal = Decimal("0.45")
    min_posterior_edge_lower: Decimal = Decimal("0")
    require_shadow_parity_within_budget: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_active_day_ratio": str(self.min_active_day_ratio),
            "min_positive_day_ratio": str(self.min_positive_day_ratio),
            "max_best_day_share": str(self.max_best_day_share),
            "max_cluster_contribution_share": str(self.max_cluster_contribution_share),
            "max_single_symbol_contribution_share": str(
                self.max_single_symbol_contribution_share
            ),
            "max_worst_day_loss": str(self.max_worst_day_loss),
            "max_drawdown": str(self.max_drawdown),
            "min_avg_filled_notional_per_day": str(
                self.min_avg_filled_notional_per_day
            ),
            "min_regime_slice_pass_rate": str(self.min_regime_slice_pass_rate),
            "min_posterior_edge_lower": str(self.min_posterior_edge_lower),
            "require_shadow_parity_within_budget": self.require_shadow_parity_within_budget,
        }


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


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
    target_net_pnl_per_day: Decimal = Decimal("500"),
    policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Any]:
    """Evaluate the doc 71 production objective criteria against a scorecard."""

    policy = policy or ProfitTargetOraclePolicy()
    net_pnl = _decimal(
        scorecard.get("portfolio_post_cost_net_pnl_per_day")
        or scorecard.get("net_pnl_per_day")
    )
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
