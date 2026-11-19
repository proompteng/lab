from types import SimpleNamespace

import pytest

from cosmosalpha.agents import FactorSpec
from cosmosalpha.core import from_json_value
from cosmosalpha.factors import (
    build_base_field_catalog,
    build_base_operator_catalog,
    normalize_expression,
    parse_expression,
    validate_expression,
)
from cosmosalpha.pipeline.graph.controller import (
    _BatchDuplicateCoordinator,
    DuplicateIndex,
)


def specification(expression):
    return from_json_value(
        {
            "description": "Saved failing-batch expression fixture",
            "expected_direction": "positive",
            "expression": expression,
            "expression_schema_version": "factor-expression/1.0",
            "factor_id": "a" * 64,
            "field_schema_version": "field-catalog/1.0",
            "frequency": "1d",
            "hypothesis_id": "hypothesis-regression",
            "name": "regression",
            "operator_set_version": "operator-set-base/1.0",
            "proposal_id": "proposal-regression",
            "required_fields": ["close"],
            "schema_version": "factor-spec/1.0",
        },
        FactorSpec,
    )


def test_small_number_roundtrip():
    normalized = normalize_expression(parse_expression("add(close, 0.00000001)"))
    assert normalized == "add(close, 1e-08)"
    assert normalize_expression(parse_expression(normalized)) == normalized


@pytest.mark.parametrize(
    "literal", ["1e-08", "-2.5E-10", "3e+20", "0.000000000001", "-0.25", "1", "10.0"]
)
def test_finite_literal_roundtrip(literal):
    normalized = normalize_expression(parse_expression("add(close, " + literal + ")"))
    assert normalize_expression(parse_expression(normalized)) == normalized


@pytest.mark.parametrize("literal", ["1e9999", "-1e9999", "1e", "1e+", "1.2.3"])
def test_invalid_literals_rejected(literal):
    report = validate_expression(
        "add(close, " + literal + ")",
        build_base_field_catalog(),
        build_base_operator_catalog(),
        proposal_id="proposal-invalid-number",
        frequency="1d",
    )
    assert not report.is_valid


def coordinator(expressions_by_attempt):
    requests = tuple(
        SimpleNamespace(attempt_id=k, parent_selection_rank=i)
        for i, k in enumerate(expressions_by_attempt)
    )
    value = _BatchDuplicateCoordinator(requests, DuplicateIndex())
    value._candidates = {
        key: tuple(
            SimpleNamespace(candidate_index=i, factor_spec=specification(expression))
            for i, expression in enumerate(expressions)
        )
        for key, expressions in expressions_by_attempt.items()
    }
    return value


def test_batch_duplicate_loser():
    decisions = coordinator(
        {"first": ["rank(close)"], "second": ["rank(close)"]}
    )._compute()
    assert decisions["first"][0].proceed
    assert not decisions["second"][0].proceed
    assert decisions["second"][0].reason_code == "DUPLICATE_ATTEMPT"


def test_same_attempt_duplicate_loser():
    decisions = coordinator({"first": ["rank(close)", "rank(close)"]})._compute()
    assert decisions["first"][0].proceed
    assert not decisions["first"][1].proceed
    assert decisions["first"][1].reason_code == "DUPLICATE_ATTEMPT"


def test_real_failing_batch_normalized_literal():
    expressions = {
        "first": [
            "mul(ts_zscore(sub(div(close, vwap), 1), 20), mul(rank(free_turn), rank(volume)))",
            "mul(mul(ts_rank(sub(div(close, vwap), 1), 5), ts_rank(free_turn, 5)), ts_rank(volume, 5))",
        ],
        "second": [
            "mul(rank(sub(1.0, div(abs(sub(close, vwap)), add(sub(high, low), 1e-08)))), rank(sub(1.0, ts_rank(free_turn, 10))))",
            "mul(rank(sub(1, div(abs(sub(close, vwap)), add(sub(high, low), 0.0001)))), rank(sub(1, rank(delta(free_turn, 5)))))",
        ],
        "third": [
            "mul(rank(sub(div(close, vwap), 1)), div(add(rank(decay_linear(volume, 5)), rank(decay_linear(free_turn, 5))), 2))",
            "mul(rank(ts_zscore(sub(div(close, vwap), 1), 10)), add(mul(rank(decay_linear(volume, 10)), 0.4), mul(rank(decay_linear(free_turn, 20)), 0.6)))",
        ],
        "fourth": [
            "sub(0, mul(rank(div(sub(close, low), sub(high, low))), mul(rank(free_turn), rank(ts_zscore(returns, 5)))))",
            "sub(0, mul(rank(div(sub(close, ts_min(low, 5)), sub(ts_max(high, 5), ts_min(low, 5)))), mul(rank(free_turn), rank(ts_zscore(returns, 5)))))",
        ],
    }
    decisions = coordinator(expressions)._compute()
    assert sum(len(items) for items in decisions.values()) == 8
    assert all(decision.proceed for items in decisions.values() for decision in items)
