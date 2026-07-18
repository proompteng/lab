from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings, settings
from app.models import Strategy
from app.trading.costs import CostModelInputs, OrderIntent, TransactionCostModel
from app.trading.economic_policy import (
    DEFAULT_ECONOMIC_POLICY_PATH,
    EconomicPolicy,
    EconomicPolicyError,
    bind_economic_policy_settings,
    load_economic_policy,
    load_runtime_economic_policy,
)
from app.trading.economic_policy_parity import build_economic_policy_parity_report
from app.trading.execution_policy import ExecutionPolicy
from app.trading.models import StrategyDecision


def test_committed_policy_is_strict_pinned_and_cross_stage_identical(
    tmp_path: Path,
) -> None:
    policy = load_economic_policy()
    assert (
        policy.digest
        == "sha256:071068019c37c8f6e7d379529e6506661429d88bb082e876bfca2df221bc4d65"
    )
    assert policy.sizing.max_gross_exposure_pct_equity == Decimal("1.0")

    reordered_path = tmp_path / "policy.json"
    payload = policy.model_dump(mode="json")
    reordered_path.write_text(
        json.dumps(payload, indent=4, sort_keys=True), encoding="utf-8"
    )
    assert load_economic_policy(reordered_path).digest == policy.digest

    report = build_economic_policy_parity_report(
        {"replay": policy, "shadow": policy, "paper": policy}
    )
    assert report["parity"] is True
    assert report["all_approved"] is True
    stage_digests = {value["intent_digest"] for value in report["stages"].values()}
    assert stage_digests == {report["common_intent_digest"]}


def test_policy_rejects_missing_fields_unknown_fields_and_wrong_digest(
    tmp_path: Path,
) -> None:
    payload = json.loads(DEFAULT_ECONOMIC_POLICY_PATH.read_text(encoding="utf-8"))
    del payload["risk"]
    with pytest.raises(ValidationError):
        EconomicPolicy.model_validate(payload)

    payload = json.loads(DEFAULT_ECONOMIC_POLICY_PATH.read_text(encoding="utf-8"))
    payload["hidden_default"] = True
    with pytest.raises(ValidationError):
        EconomicPolicy.model_validate(payload)

    payload = json.loads(DEFAULT_ECONOMIC_POLICY_PATH.read_text(encoding="utf-8"))
    payload["fees"]["cat_fee_per_share"] = "0"
    with pytest.raises(ValidationError):
        EconomicPolicy.model_validate(payload)

    with pytest.raises(EconomicPolicyError, match="economic_policy_digest_mismatch"):
        load_economic_policy(
            expected_digest="sha256:" + "0" * 64,
        )


def test_cross_stage_parity_rejects_policy_or_stage_drift() -> None:
    policy = load_economic_policy()
    drifted_policy = policy.model_copy(
        update={
            "sizing": policy.sizing.model_copy(update={"prefer_limit": False}),
        }
    )
    report = build_economic_policy_parity_report(
        {"replay": policy, "shadow": policy, "paper": drifted_policy}
    )
    assert report["parity"] is False
    assert report["common_policy_digest"] is None
    assert report["common_intent_digest"] is None

    with pytest.raises(ValueError, match="missing=.*paper"):
        build_economic_policy_parity_report({"replay": policy, "shadow": policy})


def test_runtime_projection_is_explicit_and_replay_binding_restores_settings() -> None:
    policy = load_economic_policy()
    runtime_settings = Settings(
        _env_file=None,
        TRADING_ECONOMIC_POLICY_PATH=str(DEFAULT_ECONOMIC_POLICY_PATH),
        TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST=policy.digest,
        TRADING_ALLOW_SHORTS=True,
        TRADING_FRACTIONAL_EQUITIES_ENABLED=True,
        TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY="1.0",
        TRADING_MAX_POSITION_PCT_EQUITY="0.50",
        TRADING_ALLOCATOR_MAX_SYMBOL_PCT_EQUITY="0.50",
        TRADING_PORTFOLIO_MAX_GROSS_EXPOSURE_PCT_EQUITY="1.0",
        TRADING_PORTFOLIO_MAX_NET_EXPOSURE_PCT_EQUITY="0.50",
        TRADING_MAX_PARTICIPATION_RATE="0.10",
        TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS="60",
        TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS="0",
        TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS="20",
    )
    assert load_runtime_economic_policy(runtime_settings, required=True) == policy

    runtime_settings.trading_allow_shorts = False
    with pytest.raises(EconomicPolicyError, match="trading_allow_shorts"):
        load_runtime_economic_policy(runtime_settings, required=True)

    original_gross = runtime_settings.trading_simple_max_gross_exposure_pct_equity
    with bind_economic_policy_settings(policy, runtime_settings):
        assert runtime_settings.trading_allow_shorts is True
        assert runtime_settings.trading_simple_max_gross_exposure_pct_equity == 1.0
    assert runtime_settings.trading_allow_shorts is False
    assert (
        runtime_settings.trading_simple_max_gross_exposure_pct_equity == original_gross
    )


def test_policy_cost_model_applies_current_alpaca_sell_and_buy_fees() -> None:
    policy = load_economic_policy()
    model = TransactionCostModel(policy.cost_model_config())
    market = CostModelInputs(price=Decimal("100"), adv=Decimal("1000000"))

    sell = model.estimate_costs(
        OrderIntent(
            symbol="AAPL", side="sell", qty=Decimal("10"), price=Decimal("100")
        ),
        market,
    )
    buy = model.estimate_costs(
        OrderIntent(symbol="AAPL", side="buy", qty=Decimal("10"), price=Decimal("100")),
        market,
    )

    assert sell.sec_fee_cost == Decimal("0.03")
    assert sell.taf_fee_cost == Decimal("0.01")
    assert sell.cat_fee_cost == Decimal("0.01")
    assert sell.regulatory_fee_cost == Decimal("0.05")
    assert buy.regulatory_fee_cost == Decimal("0.01")


def test_policy_execution_preserves_strategy_and_global_notional_caps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "trading_min_notional_per_trade", Decimal("10"))
    monkeypatch.setattr(settings, "trading_max_notional_per_trade", Decimal("1000"))
    policy = ExecutionPolicy(economic_policy=load_economic_policy())
    strategy = Strategy(
        name="notional-cap-fixture",
        base_timeframe="1Min",
        universe_type="static",
        max_notional_per_trade=Decimal("100"),
    )

    def decision(*, qty: str, price: str) -> StrategyDecision:
        return StrategyDecision(
            strategy_id="notional-cap-fixture",
            symbol="AAPL",
            event_ts=datetime(2026, 7, 1, 15, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal(qty),
            order_type="market",
            time_in_force="day",
            params={
                "price": price,
                "spread": "0.02",
                "adv": "100000000",
                "volatility": "0.0001",
            },
        )

    strategy_capped = policy.evaluate(
        decision(qty="2", price="75"),
        strategy=strategy,
        positions=(),
        market_snapshot=None,
        kill_switch_enabled=False,
    )
    global_capped = policy.evaluate(
        decision(qty="20", price="75"),
        strategy=None,
        positions=(),
        market_snapshot=None,
        kill_switch_enabled=False,
    )
    below_minimum = policy.evaluate(
        decision(qty="1", price="5"),
        strategy=None,
        positions=(),
        market_snapshot=None,
        kill_switch_enabled=False,
    )

    assert strategy_capped.approved is False
    assert "max_notional_exceeded" in strategy_capped.reasons
    assert global_capped.approved is False
    assert "max_notional_exceeded" in global_capped.reasons
    assert below_minimum.approved is False
    assert "min_notional_not_met" in below_minimum.reasons
