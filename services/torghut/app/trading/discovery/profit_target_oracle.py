"""Oracle-style objective gate for doc 71 whitepaper autoresearch candidates."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


PROFIT_TARGET_ORACLE_SCHEMA_VERSION = "torghut.profit-target-oracle.v1"
_ACCEPTED_MARKET_IMPACT_STRESS_MODELS = frozenset(
    {
        "almgren_chriss",
        "almgren-chriss",
        "square_root",
        "square-root",
        "power_law",
        "power-law",
        "portfolio_square_root_impact",
        "portfolio_power_law_impact",
    }
)
_ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS = frozenset(
    {
        "latency_depth_haircut",
        "delay_depth_haircut",
        "portfolio_latency_depth_haircut",
    }
)


@dataclass(frozen=True)
class ProfitTargetOraclePolicy:
    min_active_day_ratio: Decimal = Decimal("0.90")
    min_positive_day_ratio: Decimal = Decimal("0.60")
    min_profit_factor: Decimal = Decimal("1.50")
    min_daily_net_pnl: Decimal = Decimal("-999999999")
    max_best_day_share: Decimal = Decimal("0.25")
    max_cluster_contribution_share: Decimal = Decimal("0.40")
    max_single_symbol_contribution_share: Decimal = Decimal("0.35")
    max_worst_day_loss: Decimal = Decimal("999999999")
    max_drawdown: Decimal = Decimal("999999999")
    default_start_equity: Decimal = Decimal("31590.02")
    max_worst_day_loss_pct_equity: Decimal = Decimal("0.05")
    max_drawdown_pct_equity: Decimal = Decimal("0.08")
    extended_max_worst_day_loss_pct_equity: Decimal = Decimal("0.08")
    extended_max_drawdown_pct_equity: Decimal = Decimal("0.12")
    min_total_net_pnl_to_drawdown_ratio: Decimal = Decimal("3.00")
    max_gross_exposure_pct_equity: Decimal = Decimal("1.0")
    min_cash: Decimal = Decimal("0")
    max_negative_cash_observation_count: int = 0
    min_avg_filled_notional_per_day: Decimal = Decimal("300000")
    min_observed_trading_days: int = 20
    min_regime_slice_pass_rate: Decimal = Decimal("0.45")
    min_posterior_edge_lower: Decimal = Decimal("0")
    require_shadow_parity_within_budget: bool = True
    require_executable_replay: bool = True
    min_executable_order_count: int = 1
    require_executable_replay_notional_within_buying_power: bool = True
    require_market_impact_stress: bool = True
    min_market_impact_stress_cost_bps: Decimal = Decimal("1")
    require_market_impact_liquidity_evidence: bool = True
    require_delay_adjusted_depth_stress: bool = True
    require_delay_adjusted_depth_liquidity_evidence: bool = True
    require_delay_adjusted_depth_latency_grid: bool = True
    require_delay_adjusted_depth_tail_coverage: bool = True
    min_delay_adjusted_depth_stress_ms: Decimal = Decimal("50")
    min_delay_adjusted_depth_grid_max_stress_ms: Decimal = Decimal("250")
    min_delay_adjusted_depth_fillable_notional_per_day: Decimal = Decimal("300000")
    min_delay_adjusted_depth_tail_fillable_notional: Decimal = Decimal("300000")
    require_double_oos: bool = True
    min_double_oos_independent_window_count: int = 2
    min_double_oos_pass_rate: Decimal = Decimal("1.00")
    max_missing_sleeve_daily_net_count: int = 0

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_active_day_ratio": str(self.min_active_day_ratio),
            "min_positive_day_ratio": str(self.min_positive_day_ratio),
            "min_profit_factor": str(self.min_profit_factor),
            "min_daily_net_pnl": str(self.min_daily_net_pnl),
            "max_best_day_share": str(self.max_best_day_share),
            "max_cluster_contribution_share": str(self.max_cluster_contribution_share),
            "max_single_symbol_contribution_share": str(
                self.max_single_symbol_contribution_share
            ),
            "max_worst_day_loss": str(self.max_worst_day_loss),
            "max_drawdown": str(self.max_drawdown),
            "default_start_equity": str(self.default_start_equity),
            "max_worst_day_loss_pct_equity": str(self.max_worst_day_loss_pct_equity),
            "max_drawdown_pct_equity": str(self.max_drawdown_pct_equity),
            "extended_max_worst_day_loss_pct_equity": str(
                self.extended_max_worst_day_loss_pct_equity
            ),
            "extended_max_drawdown_pct_equity": str(
                self.extended_max_drawdown_pct_equity
            ),
            "min_total_net_pnl_to_drawdown_ratio": str(
                self.min_total_net_pnl_to_drawdown_ratio
            ),
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "min_cash": str(self.min_cash),
            "max_negative_cash_observation_count": self.max_negative_cash_observation_count,
            "min_avg_filled_notional_per_day": str(
                self.min_avg_filled_notional_per_day
            ),
            "min_observed_trading_days": self.min_observed_trading_days,
            "min_regime_slice_pass_rate": str(self.min_regime_slice_pass_rate),
            "min_posterior_edge_lower": str(self.min_posterior_edge_lower),
            "require_shadow_parity_within_budget": self.require_shadow_parity_within_budget,
            "require_executable_replay": self.require_executable_replay,
            "min_executable_order_count": self.min_executable_order_count,
            "require_executable_replay_notional_within_buying_power": self.require_executable_replay_notional_within_buying_power,
            "require_market_impact_stress": self.require_market_impact_stress,
            "min_market_impact_stress_cost_bps": str(
                self.min_market_impact_stress_cost_bps
            ),
            "require_market_impact_liquidity_evidence": self.require_market_impact_liquidity_evidence,
            "accepted_market_impact_stress_models": sorted(
                _ACCEPTED_MARKET_IMPACT_STRESS_MODELS
            ),
            "require_delay_adjusted_depth_stress": self.require_delay_adjusted_depth_stress,
            "require_delay_adjusted_depth_liquidity_evidence": self.require_delay_adjusted_depth_liquidity_evidence,
            "require_delay_adjusted_depth_latency_grid": self.require_delay_adjusted_depth_latency_grid,
            "require_delay_adjusted_depth_tail_coverage": self.require_delay_adjusted_depth_tail_coverage,
            "min_delay_adjusted_depth_stress_ms": str(
                self.min_delay_adjusted_depth_stress_ms
            ),
            "min_delay_adjusted_depth_grid_max_stress_ms": str(
                self.min_delay_adjusted_depth_grid_max_stress_ms
            ),
            "min_delay_adjusted_depth_fillable_notional_per_day": str(
                self.min_delay_adjusted_depth_fillable_notional_per_day
            ),
            "min_delay_adjusted_depth_tail_fillable_notional": str(
                self.min_delay_adjusted_depth_tail_fillable_notional
            ),
            "accepted_delay_adjusted_depth_stress_models": sorted(
                _ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS
            ),
            "require_double_oos": self.require_double_oos,
            "min_double_oos_independent_window_count": self.min_double_oos_independent_window_count,
            "min_double_oos_pass_rate": str(self.min_double_oos_pass_rate),
            "max_missing_sleeve_daily_net_count": self.max_missing_sleeve_daily_net_count,
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


def _string(value: Any) -> str:
    return str(value if value is not None else "").strip()


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


def _artifact_refs(scorecard: Mapping[str, Any], *keys: str) -> list[str]:
    refs: list[str] = []
    for key in keys:
        raw_value = scorecard.get(key)
        if isinstance(raw_value, list):
            for item in cast(list[Any], raw_value):
                normalized = _string(item)
                if normalized:
                    refs.append(normalized)
            continue
        normalized = _string(raw_value)
        if normalized:
            refs.append(normalized)
    return refs


def _string_sequence(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [
            normalized
            for item in cast(Sequence[Any], value)
            if (normalized := _string(item))
        ]
    raw_value = _string(value)
    if not raw_value:
        return []
    if "," in raw_value:
        return [item.strip() for item in raw_value.split(",") if item.strip()]
    return [raw_value]


def _start_equity(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> Decimal:
    for key in (
        "start_equity",
        "account_start_equity",
        "execution_start_equity",
        "executable_replay_start_equity",
        "runtime_start_equity",
    ):
        value = _decimal(scorecard.get(key))
        if value > 0:
            return value
    return policy.default_start_equity


def _total_net_pnl(
    *,
    daily_net: Mapping[str, Any] | None,
    net_pnl_per_day: Decimal,
    trading_day_count: int,
) -> Decimal:
    if daily_net:
        return sum((_decimal(value) for value in daily_net.values()), Decimal("0"))
    return net_pnl_per_day * Decimal(max(1, trading_day_count))


def _profit_factor(
    scorecard: Mapping[str, Any],
    *,
    daily_net: Mapping[str, Any] | None,
    total_net_pnl: Decimal,
    worst_day_loss: Decimal,
) -> Decimal:
    explicit = scorecard.get("profit_factor")
    if explicit is not None:
        return _decimal(explicit)
    if daily_net:
        positive_total = sum(
            (_decimal(value) for value in daily_net.values() if _decimal(value) > 0),
            Decimal("0"),
        )
        negative_total = sum(
            (-_decimal(value) for value in daily_net.values() if _decimal(value) < 0),
            Decimal("0"),
        )
        if negative_total > 0:
            return positive_total / negative_total
        return Decimal("999999999") if positive_total > 0 else Decimal("0")
    if worst_day_loss <= 0 and total_net_pnl > 0:
        return Decimal("999999999")
    return Decimal("0")


def _risk_adjusted_drawdown_check(
    *,
    metric: str,
    observed: Decimal,
    start_equity: Decimal,
    normal_pct: Decimal,
    extended_pct: Decimal,
    total_net_pnl: Decimal,
    min_total_net_pnl_to_drawdown_ratio: Decimal,
    absolute_cap: Decimal,
) -> dict[str, Any]:
    normal_limit = max(Decimal("0"), start_equity * normal_pct)
    extended_limit = max(normal_limit, start_equity * extended_pct)
    absolute_limit = (
        extended_limit if absolute_cap <= 0 else min(absolute_cap, extended_limit)
    )
    ratio = Decimal("999999999") if observed <= 0 else total_net_pnl / observed
    if observed <= normal_limit:
        passed = True
        mode = "normal_pct"
    elif observed <= absolute_limit and observed > 0:
        passed = ratio >= min_total_net_pnl_to_drawdown_ratio
        mode = "return_adjusted"
    else:
        passed = observed <= absolute_limit
        mode = "hard_cap"
    return {
        "metric": metric,
        "observed": str(observed),
        "operator": "risk_adjusted_lte",
        "threshold": str(normal_limit),
        "extended_threshold": str(absolute_limit),
        "start_equity": str(start_equity),
        "normal_pct_equity": str(normal_pct),
        "extended_pct_equity": str(extended_pct),
        "total_net_pnl_to_drawdown_ratio": str(ratio),
        "min_total_net_pnl_to_drawdown_ratio": str(min_total_net_pnl_to_drawdown_ratio),
        "mode": mode,
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
        daily_net = None
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
    start_equity = _start_equity(scorecard, policy)
    total_net_pnl = _total_net_pnl(
        daily_net=daily_net,
        net_pnl_per_day=net_pnl,
        trading_day_count=trading_day_count,
    )
    worst_day_loss = _decimal(scorecard.get("worst_day_loss"))
    profit_factor = _profit_factor(
        scorecard,
        daily_net=daily_net,
        total_net_pnl=total_net_pnl,
        worst_day_loss=worst_day_loss,
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
            metric="profit_factor",
            observed=profit_factor,
            operator="gte",
            threshold=policy.min_profit_factor,
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
            metric="min_observed_trading_days",
            observed=Decimal(daily_net_observed_day_count),
            operator="gte",
            threshold=Decimal(max(0, policy.min_observed_trading_days)),
        ),
        _numeric_check(
            metric="missing_sleeve_daily_net_count",
            observed=Decimal(
                _nonnegative_int(scorecard.get("missing_sleeve_daily_net_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_missing_sleeve_daily_net_count)),
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
        _risk_adjusted_drawdown_check(
            metric="worst_day_loss",
            observed=worst_day_loss,
            start_equity=start_equity,
            normal_pct=policy.max_worst_day_loss_pct_equity,
            extended_pct=policy.extended_max_worst_day_loss_pct_equity,
            total_net_pnl=total_net_pnl,
            min_total_net_pnl_to_drawdown_ratio=policy.min_total_net_pnl_to_drawdown_ratio,
            absolute_cap=policy.max_worst_day_loss,
        ),
        _risk_adjusted_drawdown_check(
            metric="max_drawdown",
            observed=_decimal(scorecard.get("max_drawdown")),
            start_equity=start_equity,
            normal_pct=policy.max_drawdown_pct_equity,
            extended_pct=policy.extended_max_drawdown_pct_equity,
            total_net_pnl=total_net_pnl,
            min_total_net_pnl_to_drawdown_ratio=policy.min_total_net_pnl_to_drawdown_ratio,
            absolute_cap=policy.max_drawdown,
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
    market_impact_artifact_refs = _artifact_refs(
        scorecard,
        "market_impact_stress_artifact_ref",
        "market_impact_stress_artifact_refs",
        "impact_stress_artifact_ref",
        "cost_shock_artifact_ref",
    )
    market_impact_artifact_present = bool(market_impact_artifact_refs)
    market_impact_passed = _boolish(
        scorecard.get("market_impact_stress_passed")
        or scorecard.get("cost_shock_stress_passed")
        or scorecard.get("nonlinear_market_impact_stress_passed")
    )
    market_impact_model = _string(
        scorecard.get("market_impact_stress_model")
        or scorecard.get("market_impact_cost_model")
        or scorecard.get("cost_shock_model")
    ).lower()
    checks.append(
        {
            "metric": "market_impact_stress_passed",
            "observed": str(market_impact_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "passed": market_impact_passed
            if policy.require_market_impact_stress
            else True,
        }
    )
    checks.append(
        {
            "metric": "market_impact_stress_artifact_present",
            "observed": str(market_impact_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "passed": market_impact_artifact_present
            if policy.require_market_impact_stress
            else True,
        }
    )
    market_impact_liquidity_evidence_present = _boolish(
        scorecard.get("market_impact_liquidity_evidence_present")
        or scorecard.get("liquidity_evidence_present")
    )
    checks.append(
        {
            "metric": "market_impact_liquidity_evidence_present",
            "observed": str(market_impact_liquidity_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "passed": market_impact_liquidity_evidence_present
            if (
                policy.require_market_impact_stress
                and policy.require_market_impact_liquidity_evidence
            )
            else True,
        }
    )
    checks.append(
        {
            "metric": "market_impact_stress_model",
            "observed": market_impact_model,
            "operator": "in",
            "threshold": sorted(_ACCEPTED_MARKET_IMPACT_STRESS_MODELS),
            "source_marker": "order_flow_market_impact_arxiv_2601_23172_2026",
            "passed": (market_impact_model in _ACCEPTED_MARKET_IMPACT_STRESS_MODELS)
            if policy.require_market_impact_stress
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="market_impact_stress_cost_bps",
            observed=_decimal(
                scorecard.get("market_impact_stress_cost_bps")
                or scorecard.get("market_impact_cost_bps")
                or scorecard.get("cost_shock_bps")
            ),
            operator="gte",
            threshold=policy.min_market_impact_stress_cost_bps
            if policy.require_market_impact_stress
            else Decimal("0"),
        )
    )
    market_impact_net_pnl = _decimal(
        scorecard.get("market_impact_stress_net_pnl_per_day")
        or scorecard.get("post_impact_net_pnl_per_day")
        or scorecard.get("cost_shock_net_pnl_per_day")
    )
    market_impact_net_check = _numeric_check(
        metric="market_impact_stress_net_pnl_per_day",
        observed=market_impact_net_pnl,
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_market_impact_stress:
        market_impact_net_check["passed"] = True
    checks.append(
        {
            **market_impact_net_check,
            "source_marker": "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
        }
    )
    delay_depth_artifact_refs = _artifact_refs(
        scorecard,
        "delay_adjusted_depth_stress_artifact_ref",
        "delay_adjusted_depth_stress_artifact_refs",
        "delay_depth_stress_artifact_ref",
        "latency_depth_stress_artifact_ref",
    )
    delay_depth_artifact_present = bool(delay_depth_artifact_refs)
    delay_depth_passed = _boolish(
        scorecard.get("delay_adjusted_depth_stress_passed")
        or scorecard.get("delay_depth_stress_passed")
        or scorecard.get("latency_depth_stress_passed")
    )
    delay_depth_model = _string(
        scorecard.get("delay_adjusted_depth_stress_model")
        or scorecard.get("delay_depth_stress_model")
        or scorecard.get("latency_depth_stress_model")
    ).lower()
    checks.append(
        {
            "metric": "delay_adjusted_depth_stress_passed",
            "observed": str(delay_depth_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_passed
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_stress_artifact_present",
            "observed": str(delay_depth_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_artifact_present
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    delay_depth_liquidity_evidence_present = _boolish(
        scorecard.get("delay_adjusted_depth_liquidity_evidence_present")
        or scorecard.get("delay_depth_liquidity_evidence_present")
        or scorecard.get("latency_depth_liquidity_evidence_present")
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_liquidity_evidence_present",
            "observed": str(delay_depth_liquidity_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_liquidity_evidence_present
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_liquidity_evidence
            )
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_liquidity_missing_day_count",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_liquidity_missing_day_count")
                or scorecard.get("delay_depth_liquidity_missing_day_count")
                or scorecard.get("latency_depth_liquidity_missing_day_count")
            ),
            operator="lte",
            threshold=Decimal("0")
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_liquidity_evidence
            )
            else Decimal("999999999"),
        )
    )
    delay_depth_latency_grid_ms = _string_sequence(
        scorecard.get("delay_adjusted_depth_latency_grid_ms")
        or scorecard.get("delay_depth_latency_grid_ms")
        or scorecard.get("latency_depth_grid_ms")
    )
    required_latency_grid_ms = {"50", "150", "250"}
    delay_depth_latency_grid_present = required_latency_grid_ms.issubset(
        set(delay_depth_latency_grid_ms)
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_latency_grid_ms",
            "observed": ",".join(delay_depth_latency_grid_ms),
            "operator": "contains",
            "threshold": sorted(required_latency_grid_ms),
            "source_marker": "latency_execution_policy_arxiv_2504_00846_2025",
            "passed": delay_depth_latency_grid_present
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_latency_grid
            )
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_grid_max_stress_ms",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_grid_max_stress_ms")
                or scorecard.get("delay_depth_grid_max_stress_ms")
                or scorecard.get("latency_depth_grid_max_stress_ms")
            ),
            operator="gte",
            threshold=policy.min_delay_adjusted_depth_grid_max_stress_ms
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_latency_grid
            )
            else Decimal("0"),
        )
    )
    delay_depth_tail_coverage_passed = _boolish(
        scorecard.get("delay_adjusted_depth_tail_coverage_passed")
        or scorecard.get("delay_depth_tail_coverage_passed")
        or scorecard.get("latency_depth_tail_coverage_passed")
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_tail_coverage_passed",
            "observed": str(delay_depth_tail_coverage_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_tail_coverage_passed
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_tail_coverage
            )
            else True,
        }
    )
    for metric_name, *keys in (
        (
            "delay_adjusted_depth_worst_active_day_fillable_notional",
            "delay_adjusted_depth_worst_active_day_fillable_notional",
            "delay_depth_worst_active_day_fillable_notional",
            "latency_depth_worst_active_day_fillable_notional",
        ),
        (
            "delay_adjusted_depth_p10_active_day_fillable_notional",
            "delay_adjusted_depth_p10_active_day_fillable_notional",
            "delay_depth_p10_active_day_fillable_notional",
            "latency_depth_p10_active_day_fillable_notional",
        ),
    ):
        checks.append(
            _numeric_check(
                metric=metric_name,
                observed=max((_decimal(scorecard.get(key)) for key in keys)),
                operator="gte",
                threshold=policy.min_delay_adjusted_depth_tail_fillable_notional
                if (
                    policy.require_delay_adjusted_depth_stress
                    and policy.require_delay_adjusted_depth_tail_coverage
                )
                else Decimal("0"),
            )
        )
    checks.append(
        {
            "metric": "delay_adjusted_depth_stress_model",
            "observed": delay_depth_model,
            "operator": "in",
            "threshold": sorted(_ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS),
            "source_marker": "latency_execution_policy_arxiv_2504_00846_2025",
            "passed": (
                delay_depth_model in _ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS
            )
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_stress_ms",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_stress_ms")
                or scorecard.get("delay_depth_stress_delay_ms")
                or scorecard.get("latency_depth_stress_ms")
            ),
            operator="gte",
            threshold=policy.min_delay_adjusted_depth_stress_ms
            if policy.require_delay_adjusted_depth_stress
            else Decimal("0"),
        )
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_fillable_notional_per_day",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_fillable_notional_per_day")
                or scorecard.get("delay_depth_stress_fillable_notional_per_day")
                or scorecard.get("latency_depth_fillable_notional_per_day")
            ),
            operator="gte",
            threshold=policy.min_delay_adjusted_depth_fillable_notional_per_day
            if policy.require_delay_adjusted_depth_stress
            else Decimal("0"),
        )
    )
    delay_depth_net_pnl = _decimal(
        scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")
        or scorecard.get("delay_depth_stress_net_pnl_per_day")
        or scorecard.get("latency_depth_stress_net_pnl_per_day")
    )
    delay_depth_net_check = _numeric_check(
        metric="delay_adjusted_depth_stress_net_pnl_per_day",
        observed=delay_depth_net_pnl,
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_delay_adjusted_depth_stress:
        delay_depth_net_check["passed"] = True
    checks.append(
        {
            **delay_depth_net_check,
            "source_marker": "rl_market_limit_execution_arxiv_2507_06345_2026",
        }
    )
    double_oos_artifact_refs = _artifact_refs(
        scorecard,
        "double_oos_artifact_ref",
        "double_oos_artifact_refs",
        "double_oos_report_ref",
        "walk_forward_oos_artifact_ref",
    )
    double_oos_artifact_present = bool(double_oos_artifact_refs)
    double_oos_passed = _boolish(
        scorecard.get("double_oos_passed")
        or scorecard.get("double_out_of_sample_passed")
        or scorecard.get("walk_forward_oos_passed")
    )
    checks.append(
        {
            "metric": "double_oos_passed",
            "observed": str(double_oos_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
            "passed": double_oos_passed if policy.require_double_oos else True,
        }
    )
    checks.append(
        {
            "metric": "double_oos_artifact_present",
            "observed": str(double_oos_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
            "passed": double_oos_artifact_present
            if policy.require_double_oos
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="double_oos_independent_window_count",
            observed=Decimal(
                _nonnegative_int(
                    scorecard.get("double_oos_independent_window_count")
                    or scorecard.get("double_oos_fold_count")
                    or scorecard.get("oos_fold_count")
                )
            ),
            operator="gte",
            threshold=Decimal(max(0, policy.min_double_oos_independent_window_count))
            if policy.require_double_oos
            else Decimal("0"),
        )
    )
    checks.append(
        _numeric_check(
            metric="double_oos_pass_rate",
            observed=_decimal(
                scorecard.get("double_oos_pass_rate")
                or scorecard.get("double_out_of_sample_pass_rate")
                or scorecard.get("walk_forward_oos_pass_rate")
            ),
            operator="gte",
            threshold=policy.min_double_oos_pass_rate
            if policy.require_double_oos
            else Decimal("0"),
        )
    )
    double_oos_net_check = _numeric_check(
        metric="double_oos_net_pnl_per_day",
        observed=_decimal(
            scorecard.get("double_oos_net_pnl_per_day")
            or scorecard.get("double_out_of_sample_net_pnl_per_day")
            or scorecard.get("walk_forward_oos_net_pnl_per_day")
        ),
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_double_oos:
        double_oos_net_check["passed"] = True
    checks.append(
        {
            **double_oos_net_check,
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
        }
    )
    double_oos_cost_shock_net_check = _numeric_check(
        metric="double_oos_cost_shock_net_pnl_per_day",
        observed=_decimal(
            scorecard.get("double_oos_cost_shock_net_pnl_per_day")
            or scorecard.get("double_oos_market_impact_stress_net_pnl_per_day")
            or scorecard.get("double_oos_cost_sensitivity_net_pnl_per_day")
        ),
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_double_oos:
        double_oos_cost_shock_net_check["passed"] = True
    checks.append(
        {
            **double_oos_cost_shock_net_check,
            "source_marker": "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
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
