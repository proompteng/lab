"""Oracle-style objective gate for doc 71 whitepaper autoresearch candidates."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping


PROFIT_TARGET_ORACLE_SCHEMA_VERSION = "torghut.profit-target-oracle.v1"


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
) -> dict[str, Any]:
    """Evaluate the doc 71 production objective criteria against a scorecard."""

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
            threshold=Decimal("0.90"),
        ),
        _numeric_check(
            metric="positive_day_ratio",
            observed=_decimal(scorecard.get("positive_day_ratio")),
            operator="gte",
            threshold=Decimal("0.60"),
        ),
        _numeric_check(
            metric="best_day_share",
            observed=_decimal(scorecard.get("best_day_share")),
            operator="lte",
            threshold=Decimal("0.25"),
        ),
        _numeric_check(
            metric="max_single_day_contribution_share",
            observed=_decimal(
                scorecard.get("max_single_day_contribution_share")
                or scorecard.get("best_day_share")
            ),
            operator="lte",
            threshold=Decimal("0.25"),
        ),
        _numeric_check(
            metric="max_cluster_contribution_share",
            observed=_decimal(
                scorecard.get("max_cluster_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=Decimal("0.40"),
        ),
        _numeric_check(
            metric="max_single_symbol_contribution_share",
            observed=_decimal(
                scorecard.get("max_single_symbol_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=Decimal("0.35"),
        ),
        _numeric_check(
            metric="worst_day_loss",
            observed=_decimal(scorecard.get("worst_day_loss")),
            operator="lte",
            threshold=Decimal("350"),
        ),
        _numeric_check(
            metric="max_drawdown",
            observed=_decimal(scorecard.get("max_drawdown")),
            operator="lte",
            threshold=Decimal("900"),
        ),
        _numeric_check(
            metric="avg_filled_notional_per_day",
            observed=_decimal(scorecard.get("avg_filled_notional_per_day")),
            operator="gte",
            threshold=Decimal("300000"),
        ),
        _numeric_check(
            metric="regime_slice_pass_rate",
            observed=_decimal(scorecard.get("regime_slice_pass_rate")),
            operator="gte",
            threshold=Decimal("0.45"),
        ),
        _numeric_check(
            metric="posterior_edge_lower",
            observed=_decimal(scorecard.get("posterior_edge_lower")),
            operator="gt",
            threshold=Decimal("0"),
        ),
    ]
    shadow_parity_status = str(scorecard.get("shadow_parity_status") or "").strip()
    checks.append(
        {
            "metric": "shadow_parity_status",
            "observed": shadow_parity_status,
            "operator": "eq",
            "threshold": "within_budget",
            "passed": shadow_parity_status == "within_budget",
        }
    )
    blockers = [
        f"{item['metric']}_failed" for item in checks if not bool(item["passed"])
    ]
    return {
        "schema_version": PROFIT_TARGET_ORACLE_SCHEMA_VERSION,
        "passed": not blockers,
        "checks": checks,
        "blockers": blockers,
    }
