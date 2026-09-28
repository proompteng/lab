"""Preview-only public-feed lag and quoted-liquidity reliability stress.

This module converts recent public-feed delay, ingestion-lag, and public-feed
microstructure measurement papers into deterministic replay-ranking inputs. It
never repairs fills, writes ledgers, authorizes promotion, or enables capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

FEED_LAG_LIQUIDITY_STRESS_SCHEMA_VERSION = "torghut.feed-lag-liquidity-stress.v1"
FEED_LAG_LIQUIDITY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.feed-lag-liquidity-stress-contract.v1"
)
FEED_LAG_LIQUIDITY_STRESS_PROOF_SEMANTICS_LABEL = "feed_lag_liquidity_stress_preview_only_exact_replay_authoritative_trade_direction_route_tca_runtime_ledger_required"
FEED_LAG_LIQUIDITY_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "ssrn-6675338",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6675338",
        "title": "When the Feed Lags: Public-Data Delay and Quoted Liquidity in Crypto Markets",
        "date": "2026-04-29",
        "mechanism": "public_feed_delay_predicts_worse_quoted_spreads_and_displayed_depth",
    },
    {
        "source_id": "arxiv-2604.24366",
        "url": "https://arxiv.org/abs/2604.24366",
        "title": "The Anatomy of a Decentralized Prediction Market: Microstructure Evidence from the Polymarket Order Book",
        "date": "2026-04-27",
        "mechanism": "public_order_book_ingestion_delay_tail_and_authoritative_trade_direction_join",
    },
    {
        "source_id": "arxiv-2511.20606",
        "url": "https://arxiv.org/abs/2511.20606",
        "title": "Limit Order Book Dynamics in Matching Markets: Microstructure, Spread, and Execution Slippage",
        "date": "2025-11-26",
        "mechanism": "time_decaying_liquidity_threshold_and_execution_slippage_context",
    },
)

_DELAY_MS_FIELDS = (
    "feed_delay_ms",
    "public_feed_delay_ms",
    "ingestion_delay_ms",
    "archive_ingestion_delay_ms",
    "event_receipt_delay_ms",
    "market_data_delay_ms",
    "latency_ms",
)
_EVENT_TS_FIELDS = (
    "exchange_event_ts",
    "exchange_ts",
    "source_event_ts",
    "market_event_ts",
    "book_event_ts",
)
_RECEIPT_TS_FIELDS = (
    "receipt_ts",
    "received_ts",
    "local_receipt_ts",
    "ingest_ts",
    "archive_ingest_ts",
)
_SPREAD_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_BID_SIZE_FIELDS = ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty", "bid_depth")
_ASK_SIZE_FIELDS = ("ask_size", "ask_qty", "best_ask_size", "best_ask_qty", "ask_depth")
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_FEED_DIRECTION_FIELDS = (
    "feed_trade_direction",
    "public_feed_trade_direction",
    "lee_ready_direction",
    "inferred_trade_direction",
    "feed_side",
)
_AUTHORITATIVE_DIRECTION_FIELDS = (
    "authoritative_trade_direction",
    "onchain_trade_direction",
    "order_filled_direction",
    "venue_trade_direction",
    "execution_side",
)


@dataclass(frozen=True)
class FeedLagLiquidityStressSummary:
    row_count: int
    observed_delay_count: int
    observed_spread_count: int
    observed_depth_count: int
    observed_direction_join_count: int
    direction_disagreement_count: int
    median_feed_delay_ms: float
    p95_feed_delay_ms: float
    max_feed_delay_ms: float
    high_delay_row_share: float
    median_spread_bps: float
    high_delay_spread_widening_bps: float
    median_displayed_depth_notional: float
    high_delay_depth_thinning_share: float
    stale_quote_adverse_move_bps: float
    public_feed_direction_disagreement_share: float
    feed_reliability_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": FEED_LAG_LIQUIDITY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_feed_lag_liquidity_stress_ranking",
            "source_papers": [
                dict(item) for item in FEED_LAG_LIQUIDITY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_delay_count": self.observed_delay_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_depth_count": self.observed_depth_count,
            "observed_direction_join_count": self.observed_direction_join_count,
            "direction_disagreement_count": self.direction_disagreement_count,
            "median_feed_delay_ms": _stable_float(self.median_feed_delay_ms),
            "p95_feed_delay_ms": _stable_float(self.p95_feed_delay_ms),
            "max_feed_delay_ms": _stable_float(self.max_feed_delay_ms),
            "high_delay_row_share": _stable_float(self.high_delay_row_share),
            "median_spread_bps": _stable_float(self.median_spread_bps),
            "high_delay_spread_widening_bps": _stable_float(
                self.high_delay_spread_widening_bps
            ),
            "median_displayed_depth_notional": _stable_float(
                self.median_displayed_depth_notional
            ),
            "high_delay_depth_thinning_share": _stable_float(
                self.high_delay_depth_thinning_share
            ),
            "stale_quote_adverse_move_bps": _stable_float(
                self.stale_quote_adverse_move_bps
            ),
            "public_feed_direction_disagreement_share": _stable_float(
                self.public_feed_direction_disagreement_share
            ),
            "feed_reliability_score": _stable_float(self.feed_reliability_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "median_feed_delay_ms": _stable_float(self.median_feed_delay_ms),
                "p95_feed_delay_ms": _stable_float(self.p95_feed_delay_ms),
                "high_delay_row_share": _stable_float(self.high_delay_row_share),
                "high_delay_spread_widening_bps": _stable_float(
                    self.high_delay_spread_widening_bps
                ),
                "high_delay_depth_thinning_share": _stable_float(
                    self.high_delay_depth_thinning_share
                ),
                "stale_quote_adverse_move_bps": _stable_float(
                    self.stale_quote_adverse_move_bps
                ),
                "public_feed_direction_disagreement_share": _stable_float(
                    self.public_feed_direction_disagreement_share
                ),
                "feed_reliability_score": _stable_float(self.feed_reliability_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "public_feed_delay_preview": True,
            "quoted_liquidity_reliability_preview": True,
            "authoritative_trade_direction_join_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": FEED_LAG_LIQUIDITY_STRESS_PROOF_SEMANTICS_LABEL,
        }


def feed_lag_liquidity_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": FEED_LAG_LIQUIDITY_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": FEED_LAG_LIQUIDITY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in FEED_LAG_LIQUIDITY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "public_feed_delay_quoted_liquidity_and_authoritative_trade_direction_stress",
        "stress_components": [
            "feed_delay_ms",
            "high_delay_spread_widening_bps",
            "high_delay_depth_thinning_share",
            "stale_quote_adverse_move_bps",
            "public_feed_direction_disagreement_share",
        ],
        "delay_fields": list(_DELAY_MS_FIELDS + _EVENT_TS_FIELDS + _RECEIPT_TS_FIELDS),
        "direction_join_fields": list(
            _FEED_DIRECTION_FIELDS + _AUTHORITATIVE_DIRECTION_FIELDS
        ),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_authoritative_trade_direction_join": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_public_feed_only_direction_authority": True,
            "rejects_delay_free_quote_replay_assumptions": True,
        },
    }


def build_feed_lag_liquidity_stress_schema_hash() -> str:
    return _stable_hash(feed_lag_liquidity_stress_contract())


def extract_feed_lag_liquidity_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> FeedLagLiquidityStressSummary:
    """Extract deterministic feed-lag liquidity stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    delays = tuple(_row_delay_ms(row) for row in ordered)
    spreads = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _SPREAD_FIELDS))
        for row in ordered
    )
    prices = tuple(
        _positive_float(_first_payload_value(row.payload, _PRICE_FIELDS))
        for row in ordered
    )
    depth_notionals = tuple(_displayed_depth_notional(row) for row in ordered)
    delay_values = tuple(delay for delay in delays if delay is not None)
    spread_values = tuple(spread for spread in spreads if spread > 0.0)
    depth_values = tuple(depth for depth in depth_notionals if depth > 0.0)
    warnings: list[str] = []
    if len(ordered) < 3:
        warnings.append("insufficient_feed_lag_rows")
    if not delay_values:
        warnings.append("missing_feed_delay_or_ingest_timestamps")
    if not spread_values:
        warnings.append("missing_quoted_spread_fields")
    if not depth_values:
        warnings.append("missing_displayed_depth_fields")

    median_delay = _median(delay_values)
    p95_delay = _percentile(delay_values, 0.95)
    max_delay = max(delay_values) if delay_values else 0.0
    delay_threshold = max(250.0, median_delay * 1.5, p95_delay * 0.5)
    high_delay_indexes = tuple(
        index
        for index, delay in enumerate(delays)
        if delay is not None and delay >= delay_threshold
    )
    low_delay_indexes = tuple(
        index
        for index, delay in enumerate(delays)
        if delay is not None and delay < delay_threshold
    )
    high_delay_share = len(high_delay_indexes) / max(1, len(ordered))
    high_delay_spread = _median(tuple(spreads[index] for index in high_delay_indexes))
    low_delay_spread = _median(tuple(spreads[index] for index in low_delay_indexes))
    high_delay_spread_widening_bps = (
        max(0.0, high_delay_spread - low_delay_spread) if high_delay_indexes else 0.0
    )
    high_delay_depth = _median(
        tuple(depth_notionals[index] for index in high_delay_indexes)
    )
    low_delay_depth = _median(
        tuple(depth_notionals[index] for index in low_delay_indexes)
    )
    high_delay_depth_thinning_share = (
        max(0.0, low_delay_depth - high_delay_depth) / low_delay_depth
        if high_delay_indexes and low_delay_depth > 0.0
        else 0.0
    )
    high_delay_depth_thinning_share = min(1.0, high_delay_depth_thinning_share)
    stale_quote_adverse_move_bps = _stale_quote_adverse_move_bps(
        prices, high_delay_indexes=high_delay_indexes, direction=signed_direction
    )
    (
        observed_direction_join_count,
        direction_disagreement_count,
    ) = _direction_join_counts(ordered)
    disagreement_share = direction_disagreement_count / max(
        1, observed_direction_join_count
    )
    reliability_score = max(
        0.0,
        min(
            1.0,
            1.0
            - min(1.0, p95_delay / 10_000.0) * 0.25
            - high_delay_share * 0.20
            - high_delay_depth_thinning_share * 0.20
            - min(1.0, high_delay_spread_widening_bps / 20.0) * 0.20
            - disagreement_share * 0.15,
        ),
    )
    missing_penalty_bps = 5.0 * len(warnings)
    replay_rank_penalty_bps = (
        min(18.0, p95_delay / 650.0)
        + high_delay_share * 9.0
        + high_delay_spread_widening_bps * 0.8
        + high_delay_depth_thinning_share * 12.0
        + stale_quote_adverse_move_bps
        + disagreement_share * 10.0
        + missing_penalty_bps
    )
    return FeedLagLiquidityStressSummary(
        row_count=len(ordered),
        observed_delay_count=len(delay_values),
        observed_spread_count=len(spread_values),
        observed_depth_count=len(depth_values),
        observed_direction_join_count=observed_direction_join_count,
        direction_disagreement_count=direction_disagreement_count,
        median_feed_delay_ms=median_delay,
        p95_feed_delay_ms=p95_delay,
        max_feed_delay_ms=max_delay,
        high_delay_row_share=high_delay_share,
        median_spread_bps=_median(spread_values),
        high_delay_spread_widening_bps=high_delay_spread_widening_bps,
        median_displayed_depth_notional=_median(depth_values),
        high_delay_depth_thinning_share=high_delay_depth_thinning_share,
        stale_quote_adverse_move_bps=stale_quote_adverse_move_bps,
        public_feed_direction_disagreement_share=disagreement_share,
        feed_reliability_score=reliability_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_feed_lag_liquidity_stress_schema_hash(),
    )


def _row_delay_ms(row: SignalEnvelope) -> float | None:
    payload_delay = _float_or_none(_first_payload_value(row.payload, _DELAY_MS_FIELDS))
    if payload_delay is not None and payload_delay >= 0.0:
        return payload_delay
    event_ts = _datetime_or_none(_first_payload_value(row.payload, _EVENT_TS_FIELDS))
    receipt_ts = _datetime_or_none(
        _first_payload_value(row.payload, _RECEIPT_TS_FIELDS)
    )
    if event_ts is not None and receipt_ts is not None:
        return max(0.0, (receipt_ts - event_ts).total_seconds() * 1000.0)
    if row.ingest_ts is not None:
        return max(0.0, (row.ingest_ts - row.event_ts).total_seconds() * 1000.0)
    return None


def _displayed_depth_notional(row: SignalEnvelope) -> float:
    bid_depth = _nonnegative_float(_first_payload_value(row.payload, _BID_SIZE_FIELDS))
    ask_depth = _nonnegative_float(_first_payload_value(row.payload, _ASK_SIZE_FIELDS))
    price = _positive_float(_first_payload_value(row.payload, _PRICE_FIELDS))
    if price is None:
        return 0.0
    return (bid_depth + ask_depth) * price


def _stale_quote_adverse_move_bps(
    prices: Sequence[float | None],
    *,
    high_delay_indexes: Sequence[int],
    direction: float,
) -> float:
    penalties: list[float] = []
    high_delay_index_set = set(high_delay_indexes)
    for index in high_delay_index_set:
        if index + 1 >= len(prices):
            continue
        current = prices[index]
        next_price = prices[index + 1]
        if current is None or next_price is None or current <= 0.0:
            continue
        adverse_move_bps = -direction * (next_price - current) / current * 10_000.0
        penalties.append(max(0.0, adverse_move_bps))
    return _median(penalties)


def _direction_join_counts(records: Sequence[SignalEnvelope]) -> tuple[int, int]:
    observed = 0
    disagreements = 0
    for row in records:
        feed_direction = _normalized_direction(
            _first_payload_value(row.payload, _FEED_DIRECTION_FIELDS)
        )
        authoritative_direction = _normalized_direction(
            _first_payload_value(row.payload, _AUTHORITATIVE_DIRECTION_FIELDS)
        )
        if feed_direction is None or authoritative_direction is None:
            continue
        observed += 1
        if feed_direction != authoritative_direction:
            disagreements += 1
    return observed, disagreements


def _normalized_direction(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and isfinite(float(value)):
        parsed = float(value)
        if parsed > 0.0:
            return 1
        if parsed < 0.0:
            return -1
        return None
    normalized = str(value).strip().lower()
    if normalized in {"buy", "b", "bid", "buyer", "aggressor_buy", "1", "+1"}:
        return 1
    if normalized in {"sell", "s", "ask", "seller", "aggressor_sell", "-1"}:
        return -1
    return None


def _first_payload_value(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> Any | None:
    for field in fields:
        value = payload.get(field)
        if value is not None:
            return value
    return None


def _datetime_or_none(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if value is None:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _positive_float(value: object) -> float | None:
    parsed = _float_or_none(value)
    if parsed is None or parsed <= 0.0:
        return None
    return parsed


def _nonnegative_float(value: object) -> float:
    parsed = _float_or_none(value)
    if parsed is None or parsed < 0.0:
        return 0.0
    return parsed


def _float_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(cast(Any, value))
    except (TypeError, ValueError):
        return None
    return parsed if isfinite(parsed) else None


def _median(values: Sequence[float]) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    midpoint = len(clean) // 2
    if len(clean) % 2:
        return clean[midpoint]
    return (clean[midpoint - 1] + clean[midpoint]) / 2.0


def _percentile(values: Sequence[float], percentile: float) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    index = min(len(clean) - 1, max(0, int(round((len(clean) - 1) * percentile))))
    return clean[index]


def _stable_float(value: float) -> str:
    return f"{value:.10f}".rstrip("0").rstrip(".") or "0"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        cast(dict[str, Any], payload),
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
