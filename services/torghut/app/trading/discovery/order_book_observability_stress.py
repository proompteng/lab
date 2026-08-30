"""Preview-only order-book observability stress for replay candidate ranking.

This module converts recent market-making and stochastic-cost papers into a
bounded replay harness input. It never simulates fills, writes ledgers, or
creates promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

ORDER_BOOK_OBSERVABILITY_STRESS_SCHEMA_VERSION = (
    "torghut.order-book-observability-stress.v1"
)
ORDER_BOOK_OBSERVABILITY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.order-book-observability-stress-contract.v1"
)
ORDER_BOOK_OBSERVABILITY_STRESS_PROOF_SEMANTICS_LABEL = (
    "order_book_observability_stress_preview_only_exact_replay_route_tca_"
    "runtime_ledger_required"
)
ORDER_BOOK_OBSERVABILITY_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2605.19584",
        "url": "https://arxiv.org/abs/2605.19584",
        "mechanism": "order_book_observation_feedback_vs_trade_censoring",
    },
    {
        "source_id": "arxiv-2507.09196",
        "url": "https://arxiv.org/abs/2507.09196",
        "mechanism": "state_dependent_stochastic_transaction_cost_lob_proxy",
    },
)

_BID_FIELDS: tuple[str, ...] = ("bid", "best_bid", "bid_price", "best_bid_price")
_ASK_FIELDS: tuple[str, ...] = ("ask", "best_ask", "ask_price", "best_ask_price")
_BID_SIZE_FIELDS: tuple[str, ...] = (
    "bid_size",
    "bid_qty",
    "best_bid_size",
    "best_bid_qty",
    "bid_depth",
    "bid_volume",
)
_ASK_SIZE_FIELDS: tuple[str, ...] = (
    "ask_size",
    "ask_qty",
    "best_ask_size",
    "best_ask_qty",
    "ask_depth",
    "ask_volume",
)
_PRICE_FIELDS: tuple[str, ...] = (
    "price",
    "mid_price",
    "mid",
    "mark",
    "last_price",
    "close",
)
_SPREAD_BPS_FIELDS: tuple[str, ...] = (
    "spread_bps",
    "quoted_spread_bps",
    "bid_ask_spread_bps",
)
_SPREAD_PRICE_FIELDS: tuple[str, ...] = ("spread", "quoted_spread", "bid_ask_spread")
_EVENT_FIELDS: tuple[str, ...] = (
    "lob_event_type",
    "event_type",
    "order_event_type",
    "side",
    "aggressor_side",
    "trade_side",
    "liquidity_side",
)
_BOOK_EVENT_TOKENS = frozenset(
    (
        "add",
        "book",
        "cancel",
        "depth",
        "limit",
        "lob",
        "modify",
        "orderbook",
        "quote",
        "replace",
        "update",
    )
)
_TRADE_EVENT_TOKENS = frozenset(("execution", "fill", "market", "trade"))
_EXECUTABLE_SIDE_DEPTH_SHARE_FLOOR = 0.30


@dataclass(frozen=True)
class OrderBookObservabilityStressSummary:
    row_count: int
    observed_quote_count: int
    observed_depth_count: int
    observed_spread_count: int
    book_feedback_event_count: int
    trade_censored_event_count: int
    quote_coverage: float
    depth_coverage: float
    spread_coverage: float
    book_feedback_share: float
    trade_censored_share: float
    observability_confidence: float
    median_spread_bps: float
    spread_cost_bias_bps: float
    executable_side_depth_shortfall_share: float
    median_visible_executable_depth_notional: float
    visible_depth_notional_shortfall_share: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": ORDER_BOOK_OBSERVABILITY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_order_book_observability_ranking",
            "source_papers": [
                dict(item) for item in ORDER_BOOK_OBSERVABILITY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_quote_count": self.observed_quote_count,
            "observed_depth_count": self.observed_depth_count,
            "observed_spread_count": self.observed_spread_count,
            "book_feedback_event_count": self.book_feedback_event_count,
            "trade_censored_event_count": self.trade_censored_event_count,
            "quote_coverage": _stable_float(self.quote_coverage),
            "depth_coverage": _stable_float(self.depth_coverage),
            "spread_coverage": _stable_float(self.spread_coverage),
            "book_feedback_share": _stable_float(self.book_feedback_share),
            "trade_censored_share": _stable_float(self.trade_censored_share),
            "observability_confidence": _stable_float(self.observability_confidence),
            "median_spread_bps": _stable_float(self.median_spread_bps),
            "spread_cost_bias_bps": _stable_float(self.spread_cost_bias_bps),
            "executable_side_depth_shortfall_share": _stable_float(
                self.executable_side_depth_shortfall_share
            ),
            "median_visible_executable_depth_notional": _stable_float(
                self.median_visible_executable_depth_notional
            ),
            "visible_depth_notional_shortfall_share": _stable_float(
                self.visible_depth_notional_shortfall_share
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "observability_confidence": _stable_float(
                    self.observability_confidence
                ),
                "trade_censored_share": _stable_float(self.trade_censored_share),
                "spread_cost_bias_bps": _stable_float(self.spread_cost_bias_bps),
                "executable_side_depth_shortfall_share": _stable_float(
                    self.executable_side_depth_shortfall_share
                ),
                "visible_depth_notional_shortfall_share": _stable_float(
                    self.visible_depth_notional_shortfall_share
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "order_book_feedback_preview": True,
            "stochastic_cost_proxy_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                ORDER_BOOK_OBSERVABILITY_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def order_book_observability_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ORDER_BOOK_OBSERVABILITY_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ORDER_BOOK_OBSERVABILITY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in ORDER_BOOK_OBSERVABILITY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": (
            "quote_depth_observability_vs_trade_censoring_and_state_dependent_"
            "spread_cost"
        ),
        "stress_components": [
            "observability_confidence",
            "trade_censored_share",
            "spread_cost_bias_bps",
            "executable_side_depth_shortfall_share",
            "visible_depth_notional_shortfall_share",
        ],
        "quote_fields": list(_BID_FIELDS + _ASK_FIELDS),
        "depth_fields": list(_BID_SIZE_FIELDS + _ASK_SIZE_FIELDS),
        "spread_fields": list(_SPREAD_BPS_FIELDS + _SPREAD_PRICE_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
        },
    }


def build_order_book_observability_stress_schema_hash() -> str:
    return _stable_hash(order_book_observability_stress_contract())


def extract_order_book_observability_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    max_notional: Decimal | int | float | str | None = None,
) -> OrderBookObservabilityStressSummary:
    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    row_count = len(ordered)
    notional = _nonnegative_float(max_notional)
    spread_values: list[float] = []
    side_depth_shares: list[float] = []
    visible_side_depth_notional_values: list[float] = []
    observed_quote_count = 0
    observed_depth_count = 0
    book_feedback_event_count = 0
    trade_censored_event_count = 0

    for row in ordered:
        bid = _first_positive_float(row.payload, _BID_FIELDS)
        ask = _first_positive_float(row.payload, _ASK_FIELDS)
        price = _price(row, bid=bid, ask=ask)
        quote_observed = bid is not None and ask is not None and ask >= bid
        if quote_observed:
            observed_quote_count += 1

        spread_bps = _spread_bps(row, bid=bid, ask=ask, price=price)
        if spread_bps is not None:
            spread_values.append(spread_bps)

        bid_size = _first_nonnegative_float(row.payload, _BID_SIZE_FIELDS)
        ask_size = _first_nonnegative_float(row.payload, _ASK_SIZE_FIELDS)
        depth_observed = (
            bid_size is not None and ask_size is not None and bid_size + ask_size > 0.0
        )
        if depth_observed:
            observed_depth_count += 1
            assert bid_size is not None
            assert ask_size is not None
            executable_side_depth = ask_size if float(direction) >= 0.0 else bid_size
            total_depth = bid_size + ask_size
            side_depth_shares.append(executable_side_depth / total_depth)
            if price is not None and price > 0.0:
                visible_side_depth_notional_values.append(executable_side_depth * price)

        if quote_observed or depth_observed or _is_book_feedback_event(row):
            book_feedback_event_count += 1
        if _is_trade_censored_event(row) and not quote_observed and not depth_observed:
            trade_censored_event_count += 1

    observed_spread_count = len(spread_values)
    quote_coverage = _share(observed_quote_count, row_count)
    depth_coverage = _share(observed_depth_count, row_count)
    spread_coverage = _share(observed_spread_count, row_count)
    book_feedback_share = _share(book_feedback_event_count, row_count)
    trade_censored_share = _share(trade_censored_event_count, row_count)
    observability_confidence = _clip(
        quote_coverage * 0.45
        + depth_coverage * 0.25
        + spread_coverage * 0.15
        + book_feedback_share * 0.15,
        0.0,
        1.0,
    )
    median_spread_bps = _median(spread_values)
    executable_side_depth_shortfall_share = _mean(
        [
            max(0.0, _EXECUTABLE_SIDE_DEPTH_SHARE_FLOOR - share)
            / _EXECUTABLE_SIDE_DEPTH_SHARE_FLOOR
            for share in side_depth_shares
        ]
    )
    if row_count > 0 and not side_depth_shares:
        executable_side_depth_shortfall_share = 1.0
    median_visible_depth_notional = _median(visible_side_depth_notional_values)
    if notional > 0.0:
        if median_visible_depth_notional <= 0.0:
            visible_depth_notional_shortfall_share = 1.0
        else:
            visible_depth_notional_shortfall_share = _clip(
                (notional - median_visible_depth_notional) / notional,
                0.0,
                1.0,
            )
    else:
        visible_depth_notional_shortfall_share = 0.0
    spread_cost_bias_bps = median_spread_bps * (
        1.0 + (1.0 - observability_confidence) * 0.75 + trade_censored_share * 0.50
    )
    replay_rank_penalty_bps = (
        (1.0 - observability_confidence) * 24.0
        + trade_censored_share * 10.0
        + executable_side_depth_shortfall_share * 12.0
        + visible_depth_notional_shortfall_share * 20.0
        + spread_cost_bias_bps * 0.40
    )
    warnings = _warnings(
        row_count=row_count,
        observed_quote_count=observed_quote_count,
        observed_depth_count=observed_depth_count,
        observed_spread_count=observed_spread_count,
        trade_censored_share=trade_censored_share,
        observability_confidence=observability_confidence,
        executable_side_depth_shortfall_share=executable_side_depth_shortfall_share,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        notional=notional,
    )
    return OrderBookObservabilityStressSummary(
        row_count=row_count,
        observed_quote_count=observed_quote_count,
        observed_depth_count=observed_depth_count,
        observed_spread_count=observed_spread_count,
        book_feedback_event_count=book_feedback_event_count,
        trade_censored_event_count=trade_censored_event_count,
        quote_coverage=quote_coverage,
        depth_coverage=depth_coverage,
        spread_coverage=spread_coverage,
        book_feedback_share=book_feedback_share,
        trade_censored_share=trade_censored_share,
        observability_confidence=observability_confidence,
        median_spread_bps=median_spread_bps,
        spread_cost_bias_bps=spread_cost_bias_bps,
        executable_side_depth_shortfall_share=executable_side_depth_shortfall_share,
        median_visible_executable_depth_notional=median_visible_depth_notional,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=warnings,
        feature_schema_hash=build_order_book_observability_stress_schema_hash(),
    )


def _warnings(
    *,
    row_count: int,
    observed_quote_count: int,
    observed_depth_count: int,
    observed_spread_count: int,
    trade_censored_share: float,
    observability_confidence: float,
    executable_side_depth_shortfall_share: float,
    visible_depth_notional_shortfall_share: float,
    notional: float,
) -> tuple[str, ...]:
    warnings: list[str] = []
    if row_count <= 0:
        warnings.append("empty_order_book_observability_rows")
    if observed_quote_count <= 0:
        warnings.append("missing_order_book_quotes")
    if observed_depth_count <= 0:
        warnings.append("missing_order_book_depth")
    if observed_spread_count <= 0:
        warnings.append("missing_order_book_spread")
    if trade_censored_share > 0.50:
        warnings.append("high_trade_censored_share")
    if observability_confidence < 0.50:
        warnings.append("insufficient_order_book_observability")
    if executable_side_depth_shortfall_share > 0.50:
        warnings.append("thin_visible_executable_side_depth")
    if visible_depth_notional_shortfall_share > 0.50:
        warnings.append("candidate_notional_exceeds_visible_book_depth")
    if notional <= 0.0:
        warnings.append("missing_candidate_notional_for_order_book_stress")
    return tuple(dict.fromkeys(warnings))


def _price(
    record: SignalEnvelope, *, bid: float | None, ask: float | None
) -> float | None:
    price = _first_positive_float(record.payload, _PRICE_FIELDS)
    if price is not None:
        return price
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def _spread_bps(
    record: SignalEnvelope,
    *,
    bid: float | None,
    ask: float | None,
    price: float | None,
) -> float | None:
    explicit_bps = _first_nonnegative_float(record.payload, _SPREAD_BPS_FIELDS)
    if explicit_bps is not None:
        return explicit_bps
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = _first_nonnegative_float(record.payload, _SPREAD_PRICE_FIELDS)
    if spread is not None and price is not None and price > 0.0:
        return spread / price * 10_000.0
    return None


def _is_book_feedback_event(record: SignalEnvelope) -> bool:
    label = _event_label(record)
    tokens = _event_tokens(label)
    return bool(tokens & _BOOK_EVENT_TOKENS)


def _is_trade_censored_event(record: SignalEnvelope) -> bool:
    label = _event_label(record)
    tokens = _event_tokens(label)
    return bool(tokens & _TRADE_EVENT_TOKENS) and not bool(tokens & _BOOK_EVENT_TOKENS)


def _event_label(record: SignalEnvelope) -> str:
    for key in _EVENT_FIELDS:
        value = str(record.payload.get(key) or "").strip().lower()
        if value:
            return value
    return ""


def _event_tokens(label: str) -> frozenset[str]:
    normalized = (
        label.lower()
        .replace("-", "_")
        .replace("/", "_")
        .replace(" ", "_")
        .replace(":", "_")
    )
    return frozenset(token for token in normalized.split("_") if token)


def _first_positive_float(
    payload: Mapping[str, Any], keys: Sequence[str]
) -> float | None:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            return value
    return None


def _first_nonnegative_float(
    payload: Mapping[str, Any], keys: Sequence[str]
) -> float | None:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is not None and value >= 0.0:
            return value
    return None


def _nonnegative_float(value: Any) -> float:
    parsed = _float_or_none(value)
    if parsed is None:
        return 0.0
    return max(0.0, parsed)


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        parsed = float(value)
    elif isinstance(value, (int, float)):
        parsed = float(value)
    else:
        try:
            parsed = float(str(value).strip())
        except ValueError:
            return None
    return parsed if isfinite(parsed) else None


def _share(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return _clip(numerator / denominator, 0.0, 1.0)


def _clip(value: float, lower: float, upper: float) -> float:
    return min(upper, max(lower, value))


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _stable_float(value: float) -> str:
    if not isfinite(value):
        return "0"
    return f"{value:.12g}"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(_json_ready(payload), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        return {
            str(key): _json_ready(mapping[key])
            for key in sorted(mapping.keys(), key=str)
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    return value


__all__ = [
    "ORDER_BOOK_OBSERVABILITY_STRESS_PRIMARY_SOURCES",
    "ORDER_BOOK_OBSERVABILITY_STRESS_PROOF_SEMANTICS_LABEL",
    "ORDER_BOOK_OBSERVABILITY_STRESS_SCHEMA_VERSION",
    "OrderBookObservabilityStressSummary",
    "build_order_book_observability_stress_schema_hash",
    "extract_order_book_observability_stress",
    "order_book_observability_stress_contract",
]
