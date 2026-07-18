"""Controlled pre-broker intent parity fixture for all broker-risk stages."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from .economic_policy import EconomicPolicy
from .execution_policy import ExecutionPolicy
from .models import StrategyDecision
from .prices import MarketSnapshot

ECONOMIC_POLICY_PARITY_SCHEMA_VERSION = "torghut.economic-policy-parity.v1"
EconomicPolicyStage = Literal["replay", "shadow", "paper"]
ECONOMIC_POLICY_STAGES: tuple[EconomicPolicyStage, ...] = (
    "replay",
    "shadow",
    "paper",
)


def build_economic_policy_fixture_result(policy: EconomicPolicy) -> dict[str, object]:
    event_ts = datetime(2026, 7, 1, 15, 0, tzinfo=timezone.utc)
    decision = StrategyDecision(
        strategy_id="economic-policy-parity-fixture",
        symbol="AAPL",
        event_ts=event_ts,
        timeframe="1Sec",
        action="sell",
        qty=Decimal("10"),
        order_type="market",
        time_in_force="day",
        params={
            "price": "200",
            "spread": "0.02",
            "adv": "100000000",
            "volatility": "0.0001",
        },
    )
    snapshot = MarketSnapshot(
        symbol="AAPL",
        as_of=event_ts,
        price=Decimal("200"),
        spread=Decimal("0.02"),
        source="economic_policy_parity_fixture",
        bid=Decimal("199.99"),
        ask=Decimal("200.01"),
        quote_as_of=event_ts,
        quote_source="economic_policy_parity_fixture",
    )
    outcome = ExecutionPolicy(economic_policy=policy).evaluate(
        decision,
        strategy=None,
        positions=(),
        market_snapshot=snapshot,
        kill_switch_enabled=False,
        adaptive_policy=None,
    )
    intent = outcome.pre_broker_intent_payload()
    return {
        "approved": outcome.approved,
        "intent_digest": intent["digest"],
        "economic_policy_digest": intent["economic_policy_digest"],
    }


def build_economic_policy_parity_report(
    policies: Mapping[EconomicPolicyStage, EconomicPolicy],
) -> dict[str, object]:
    actual_stages = set(policies)
    expected_stages = set(ECONOMIC_POLICY_STAGES)
    if actual_stages != expected_stages:
        missing = sorted(expected_stages - actual_stages)
        unexpected = sorted(actual_stages - expected_stages)
        raise ValueError(
            f"economic policy parity stages invalid: missing={missing}, unexpected={unexpected}"
        )
    results = {
        stage: build_economic_policy_fixture_result(policies[stage])
        for stage in ECONOMIC_POLICY_STAGES
    }
    intent_digests = {str(item["intent_digest"]) for item in results.values()}
    policy_digests = {str(item["economic_policy_digest"]) for item in results.values()}
    approved = all(bool(item["approved"]) for item in results.values())
    return {
        "schema_version": ECONOMIC_POLICY_PARITY_SCHEMA_VERSION,
        "fixture_id": "aapl-sell-10-v1",
        "stages": results,
        "common_intent_digest": next(iter(intent_digests))
        if len(intent_digests) == 1
        else None,
        "common_policy_digest": next(iter(policy_digests))
        if len(policy_digests) == 1
        else None,
        "all_approved": approved,
        "parity": approved and len(intent_digests) == 1 and len(policy_digests) == 1,
    }


__all__ = [
    "ECONOMIC_POLICY_PARITY_SCHEMA_VERSION",
    "ECONOMIC_POLICY_STAGES",
    "EconomicPolicyStage",
    "build_economic_policy_fixture_result",
    "build_economic_policy_parity_report",
]
