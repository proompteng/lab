"""Preview-only OFI response-horizon stress for replay candidate ranking.

This module converts 2025 order-flow-imbalance papers into deterministic
replay-ranking inputs. It never creates PnL authority, writes ledgers, simulates
fills, authorizes promotion, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

OFI_RESPONSE_HORIZON_STRESS_SCHEMA_VERSION = "torghut.ofi-response-horizon-stress.v1"
OFI_RESPONSE_HORIZON_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.ofi-response-horizon-stress-contract.v1"
)
OFI_RESPONSE_HORIZON_STRESS_PROOF_SEMANTICS_LABEL = (
    "ofi_response_horizon_stress_preview_only_exact_event_replay_route_tca_"
    "runtime_ledger_required"
)
OFI_RESPONSE_HORIZON_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2505.17388",
        "url": "https://arxiv.org/abs/2505.17388",
        "title": (
            "Stochastic Price Dynamics in Response to Order Flow Imbalance: "
            "Evidence from CSI 300 Index Futures"
        ),
        "date": "2025-05-23",
        "mechanism": (
            "horizon_dependent_ofi_response_ratio_ou_memory_and_regime_taxonomy"
        ),
    },
    {
        "source_id": "arxiv-2508.06788",
        "url": "https://arxiv.org/abs/2508.06788",
        "title": (
            "Returns and Order Flow Imbalances: Intraday Dynamics and "
            "Macroeconomic News Effects"
        ),
        "date": "2025-10-08",
        "mechanism": (
            "one_second_price_flow_impact_dissipation_intraday_and_macro_news_stress"
        ),
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "signed_order_flow_imbalance",
    "order_book_imbalance",
    "ofi_score",
)
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_VOLUME_FIELDS = ("volume", "microbar_volume", "trade_size", "trade_qty", "qty")
_MACRO_EVENT_FIELDS = (
    "macro_event_window",
    "macro_announcement_window",
    "news_event_window",
    "macro_news_stress_score",
    "macro_stress_score",
    "news_stress_score",
)
_SHORT_HORIZON_STEPS = 1
_LONG_HORIZON_STEPS = 3
_SHOCK_OFI_FLOOR = 0.60


@dataclass(frozen=True)
class OfiResponseHorizonStressSummary:
    row_count: int
    observed_ofi_count: int
    observed_price_count: int
    observed_spread_count: int
    observed_volume_count: int
    observed_macro_event_count: int
    median_event_gap_ms: float
    short_horizon_response_bps: float
    long_horizon_response_bps: float
    response_ratio: float
    direction_adjusted_ofi_return_alignment: float
    ofi_memory_reversal_share: float
    shock_dissipation_gap_score: float
    response_instability_score: float
    macro_news_distortion_score: float
    source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": OFI_RESPONSE_HORIZON_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_ofi_response_horizon_stress_ranking",
            "source_papers": [
                dict(item) for item in OFI_RESPONSE_HORIZON_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_ofi_count": self.observed_ofi_count,
            "observed_price_count": self.observed_price_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_volume_count": self.observed_volume_count,
            "observed_macro_event_count": self.observed_macro_event_count,
            "median_event_gap_ms": _stable_float(self.median_event_gap_ms),
            "short_horizon_response_bps": _stable_float(
                self.short_horizon_response_bps
            ),
            "long_horizon_response_bps": _stable_float(self.long_horizon_response_bps),
            "response_ratio": _stable_float(self.response_ratio),
            "direction_adjusted_ofi_return_alignment": _stable_float(
                self.direction_adjusted_ofi_return_alignment
            ),
            "ofi_memory_reversal_share": _stable_float(self.ofi_memory_reversal_share),
            "shock_dissipation_gap_score": _stable_float(
                self.shock_dissipation_gap_score
            ),
            "response_instability_score": _stable_float(
                self.response_instability_score
            ),
            "macro_news_distortion_score": _stable_float(
                self.macro_news_distortion_score
            ),
            "source_gap_score": _stable_float(self.source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "short_horizon_response_bps": _stable_float(
                    self.short_horizon_response_bps
                ),
                "long_horizon_response_bps": _stable_float(
                    self.long_horizon_response_bps
                ),
                "response_ratio": _stable_float(self.response_ratio),
                "direction_adjusted_ofi_return_alignment": _stable_float(
                    self.direction_adjusted_ofi_return_alignment
                ),
                "ofi_memory_reversal_share": _stable_float(
                    self.ofi_memory_reversal_share
                ),
                "shock_dissipation_gap_score": _stable_float(
                    self.shock_dissipation_gap_score
                ),
                "response_instability_score": _stable_float(
                    self.response_instability_score
                ),
                "macro_news_distortion_score": _stable_float(
                    self.macro_news_distortion_score
                ),
                "source_gap_score": _stable_float(self.source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "ofi_horizon_response_preview": True,
            "ofi_memory_decay_preview": True,
            "macro_news_ofi_distortion_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": OFI_RESPONSE_HORIZON_STRESS_PROOF_SEMANTICS_LABEL,
        }


def ofi_response_horizon_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": OFI_RESPONSE_HORIZON_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": OFI_RESPONSE_HORIZON_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in OFI_RESPONSE_HORIZON_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": (
            "ofi_response_ratio_memory_decay_and_macro_news_distortion_ranking"
        ),
        "stress_components": [
            "short_horizon_response_bps",
            "long_horizon_response_bps",
            "response_ratio",
            "direction_adjusted_ofi_return_alignment",
            "ofi_memory_reversal_share",
            "shock_dissipation_gap_score",
            "macro_news_distortion_score",
            "source_gap_score",
        ],
        "ofi_fields": list(_OFI_FIELDS),
        "price_fields": list(_PRICE_FIELDS),
        "spread_fields": list(_SPREAD_BPS_FIELDS),
        "macro_event_fields": list(_MACRO_EVENT_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_event_replay": True,
            "requires_order_lifecycle": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "rejects_ofi_response_as_pnl_authority": True,
            "rejects_news_distortion_as_trade_veto_authority": True,
        },
        "proof_semantics_label": OFI_RESPONSE_HORIZON_STRESS_PROOF_SEMANTICS_LABEL,
    }


def extract_ofi_response_horizon_stress(
    rows: Sequence[SignalEnvelope], *, direction: float = 1.0
) -> OfiResponseHorizonStressSummary:
    ordered = sorted(rows, key=lambda row: (row.event_ts, row.seq))
    warnings: list[str] = []
    prices: list[float | None] = []
    ofi_values: list[float | None] = []
    spreads: list[float] = []
    volumes: list[float] = []
    macro_values: list[float] = []
    event_gaps_ms: list[float] = []

    previous_ts = None
    for row in ordered:
        payload = row.payload
        prices.append(_first_finite(payload, _PRICE_FIELDS))
        ofi_values.append(_first_finite(payload, _OFI_FIELDS))
        spread = _first_finite(payload, _SPREAD_BPS_FIELDS)
        if spread is not None:
            spreads.append(max(0.0, spread))
        volume = _first_finite(payload, _VOLUME_FIELDS)
        if volume is not None:
            volumes.append(max(0.0, volume))
        macro = _extract_macro_value(payload)
        if macro is not None:
            macro_values.append(macro)
        if previous_ts is not None:
            event_gaps_ms.append(
                max(0.0, (row.event_ts - previous_ts).total_seconds() * 1000.0)
            )
        previous_ts = row.event_ts

    price_indices = [idx for idx, price in enumerate(prices) if price is not None]
    if len(price_indices) < 2:
        warnings.append("missing_price_path_for_ofi_response")
    if not any(value is not None for value in ofi_values):
        warnings.append("missing_order_flow_imbalance_for_response_horizon")
    if not spreads:
        warnings.append("missing_spread_context_for_macro_ofi_stress")
    if not volumes:
        warnings.append("missing_volume_context_for_response_ratio")
    if not macro_values:
        warnings.append("missing_macro_news_window_context_neutral")

    short_responses = _horizon_responses(
        prices=prices,
        ofi_values=ofi_values,
        direction=direction,
        horizon_steps=_SHORT_HORIZON_STEPS,
    )
    long_responses = _horizon_responses(
        prices=prices,
        ofi_values=ofi_values,
        direction=direction,
        horizon_steps=_LONG_HORIZON_STEPS,
    )
    short_horizon_response_bps = _mean(short_responses)
    long_horizon_response_bps = _mean(long_responses)
    response_ratio = _bounded_ratio(
        numerator=short_horizon_response_bps,
        denominator=abs(long_horizon_response_bps),
    )
    direction_adjusted_alignment = _alignment_score(short_responses)
    reversal_share = _reversal_share(short_responses, long_responses)
    shock_gap = _shock_dissipation_gap(
        prices=prices,
        ofi_values=ofi_values,
        direction=direction,
    )
    instability = _response_instability(short_responses)
    macro_distortion = _macro_news_distortion_score(
        macro_values=macro_values,
        spreads=spreads,
        short_responses=short_responses,
    )
    source_gap = _source_gap_score(
        row_count=len(ordered),
        observed_ofi_count=sum(1 for value in ofi_values if value is not None),
        observed_price_count=len(price_indices),
        observed_spread_count=len(spreads),
        observed_volume_count=len(volumes),
    )
    penalty = (
        max(0.0, -short_horizon_response_bps) * 0.35
        + max(0.0, 1.0 - response_ratio) * 6.0
        + max(0.0, -direction_adjusted_alignment) * 5.0
        + reversal_share * 12.0
        + shock_gap * 14.0
        + instability * 8.0
        + macro_distortion * 16.0
        + source_gap * 18.0
    )

    return OfiResponseHorizonStressSummary(
        row_count=len(ordered),
        observed_ofi_count=sum(1 for value in ofi_values if value is not None),
        observed_price_count=len(price_indices),
        observed_spread_count=len(spreads),
        observed_volume_count=len(volumes),
        observed_macro_event_count=sum(1 for value in macro_values if value > 0.0),
        median_event_gap_ms=_median(event_gaps_ms),
        short_horizon_response_bps=short_horizon_response_bps,
        long_horizon_response_bps=long_horizon_response_bps,
        response_ratio=response_ratio,
        direction_adjusted_ofi_return_alignment=direction_adjusted_alignment,
        ofi_memory_reversal_share=reversal_share,
        shock_dissipation_gap_score=shock_gap,
        response_instability_score=instability,
        macro_news_distortion_score=macro_distortion,
        source_gap_score=source_gap,
        replay_rank_penalty_bps=float(min(250.0, max(0.0, penalty))),
        warnings=tuple(sorted(set(warnings))),
        feature_schema_hash=build_ofi_response_horizon_stress_schema_hash(),
    )


def build_ofi_response_horizon_stress_schema_hash() -> str:
    payload = {
        "schema_version": OFI_RESPONSE_HORIZON_STRESS_SCHEMA_VERSION,
        "price_fields": _PRICE_FIELDS,
        "ofi_fields": _OFI_FIELDS,
        "spread_fields": _SPREAD_BPS_FIELDS,
        "volume_fields": _VOLUME_FIELDS,
        "macro_event_fields": _MACRO_EVENT_FIELDS,
        "short_horizon_steps": _SHORT_HORIZON_STEPS,
        "long_horizon_steps": _LONG_HORIZON_STEPS,
        "source_ids": tuple(
            source["source_id"]
            for source in OFI_RESPONSE_HORIZON_STRESS_PRIMARY_SOURCES
        ),
        "proof_semantics_label": OFI_RESPONSE_HORIZON_STRESS_PROOF_SEMANTICS_LABEL,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _horizon_responses(
    *,
    prices: Sequence[float | None],
    ofi_values: Sequence[float | None],
    direction: float,
    horizon_steps: int,
) -> list[float]:
    responses: list[float] = []
    signed_direction = 1 if direction >= 0 else -1
    for idx, ofi in enumerate(ofi_values):
        end = idx + horizon_steps
        if ofi is None or end >= len(prices):
            continue
        start_price = prices[idx]
        end_price = prices[end]
        if start_price is None or end_price is None or start_price <= 0:
            continue
        return_bps = (end_price - start_price) / start_price * 10000.0
        responses.append(float(signed_direction * ofi * return_bps))
    return responses


def _shock_dissipation_gap(
    *,
    prices: Sequence[float | None],
    ofi_values: Sequence[float | None],
    direction: float,
) -> float:
    short = _horizon_responses(
        prices=prices,
        ofi_values=ofi_values,
        direction=direction,
        horizon_steps=_SHORT_HORIZON_STEPS,
    )
    long = _horizon_responses(
        prices=prices,
        ofi_values=ofi_values,
        direction=direction,
        horizon_steps=_LONG_HORIZON_STEPS,
    )
    gaps: list[float] = []
    for idx, ofi in enumerate(ofi_values[: min(len(short), len(long))]):
        if ofi is None or abs(ofi) < _SHOCK_OFI_FLOOR:
            continue
        short_abs = abs(short[idx])
        long_abs = abs(long[idx])
        if long_abs <= short_abs:
            gaps.append(0.0)
        else:
            gaps.append(min(1.0, (long_abs - short_abs) / max(1.0, long_abs)))
    return _mean(gaps)


def _alignment_score(responses: Sequence[float]) -> float:
    if not responses:
        return 0.0
    positive = sum(1 for value in responses if value > 0.0)
    negative = sum(1 for value in responses if value < 0.0)
    total = positive + negative
    if total <= 0:
        return 0.0
    return max(-1.0, min(1.0, (positive - negative) / total))


def _reversal_share(short: Sequence[float], long: Sequence[float]) -> float:
    count = min(len(short), len(long))
    if count <= 0:
        return 0.0
    reversals = 0
    observed = 0
    for idx in range(count):
        if abs(short[idx]) < 1e-9 or abs(long[idx]) < 1e-9:
            continue
        observed += 1
        if short[idx] * long[idx] < 0:
            reversals += 1
    if observed <= 0:
        return 0.0
    return reversals / observed


def _response_instability(responses: Sequence[float]) -> float:
    if len(responses) < 3:
        return 0.0
    mean_abs = sum(abs(value) for value in responses) / len(responses)
    if mean_abs <= 0.0:
        return 0.0
    mean_value = sum(responses) / len(responses)
    variance = sum((value - mean_value) ** 2 for value in responses) / len(responses)
    return min(1.0, (variance**0.5) / max(1.0, mean_abs * 2.0))


def _macro_news_distortion_score(
    *,
    macro_values: Sequence[float],
    spreads: Sequence[float],
    short_responses: Sequence[float],
) -> float:
    if not macro_values:
        return 0.0
    macro_share = sum(1 for value in macro_values if value > 0.0) / len(macro_values)
    spread_component = 0.0
    if spreads:
        median_spread = _median(spreads)
        spread_component = min(1.0, median_spread / 25.0)
    negative_response_share = 0.0
    if short_responses:
        negative_response_share = sum(
            1 for value in short_responses if value < 0.0
        ) / len(short_responses)
    return min(
        1.0,
        0.55 * macro_share + 0.25 * spread_component + 0.20 * negative_response_share,
    )


def _source_gap_score(
    *,
    row_count: int,
    observed_ofi_count: int,
    observed_price_count: int,
    observed_spread_count: int,
    observed_volume_count: int,
) -> float:
    if row_count <= 0:
        return 1.0
    coverages = (
        observed_ofi_count / row_count,
        observed_price_count / row_count,
        observed_spread_count / row_count,
        observed_volume_count / row_count,
    )
    return max(0.0, 1.0 - sum(coverages) / len(coverages))


def _bounded_ratio(*, numerator: float, denominator: float) -> float:
    if denominator <= 1e-9:
        return 1.0 if numerator > 0.0 else 0.0
    return max(-2.0, min(2.0, numerator / denominator))


def _extract_macro_value(payload: Mapping[str, Any]) -> float | None:
    for key in _MACRO_EVENT_FIELDS:
        if key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        parsed = _float_or_none(value)
        if parsed is not None:
            return max(0.0, min(1.0, parsed))
        text = str(value).strip().lower()
        if text in {"yes", "true", "macro", "news", "event", "stress"}:
            return 1.0
        if text in {"no", "false", "none", "normal"}:
            return 0.0
    return None


def _first_finite(payload: Mapping[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        if key not in payload:
            continue
        parsed = _float_or_none(payload.get(key))
        if parsed is not None:
            return parsed
    nested = payload.get("features")
    if isinstance(nested, Mapping):
        nested_payload = cast(Mapping[str, Any], nested)
        for key in keys:
            if key not in nested_payload:
                continue
            parsed = _float_or_none(nested_payload.get(key))
            if parsed is not None:
                return parsed
    return None


def _float_or_none(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(cast(Any, value))
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return float(round(value, 8))
