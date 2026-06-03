"""Preview-only option gamma flow stress for replay ranking.

This module turns recent 2025-2026 option-market gamma papers into deterministic
replay-ranking inputs. It only consumes replay rows or fixtures, records explicit
source gaps when option gamma fields are missing, and never authorizes promotion,
realized PnL, or live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

OPTION_GAMMA_FLOW_STRESS_SCHEMA_VERSION = "torghut.option-gamma-flow-stress.v1"
OPTION_GAMMA_FLOW_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.option-gamma-flow-stress-contract.v1"
)
OPTION_GAMMA_FLOW_STRESS_PROOF_SEMANTICS_LABEL = "option_gamma_flow_stress_preview_only_exact_replay_options_provider_route_tca_runtime_ledger_required"
OPTION_GAMMA_FLOW_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "ssrn-4692190",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4692190",
        "title": "0DTEs: Trading, Gamma Risk and Volatility Propagation",
        "date": "2025-06-06",
        "mechanism": "market_maker_net_gamma_relates_to_intraday_volatility_reversal_and_momentum",
    },
    {
        "source_id": "ssrn-6703098",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6703098",
        "title": "Levering Up! Short-Horizon Option Availability and the Gamification of the Stock Market",
        "date": "2026-05-03",
        "mechanism": "weekly_option_availability_and_gamma_exposure_amplify_underlying_volume_and_volatility",
    },
)

_GAMMA_FIELDS = (
    "dealer_gamma_exposure",
    "net_dealer_gamma_exposure",
    "market_maker_gamma_exposure",
    "net_gamma_exposure",
    "gamma_exposure",
    "gex",
    "gamma_exposure_usd",
)
_OPTION_FLOW_FIELDS = (
    "option_flow",
    "options_flow",
    "option_volume",
    "options_volume",
    "short_horizon_option_volume",
    "weekly_option_volume",
    "zero_dte_option_volume",
    "0dte_option_volume",
)
_WEEKLY_OPTION_FIELDS = (
    "weekly_option_availability",
    "weekly_options_available",
    "has_weekly_options",
    "short_horizon_option_available",
    "option_weekly_available",
)
_DTE_FIELDS = (
    "option_days_to_expiry",
    "option_days_to_expiration",
    "days_to_expiry",
    "days_to_expiration",
    "dte",
    "min_option_dte",
)
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "share_volume",
    "trade_volume",
    "notional_volume",
)


@dataclass(frozen=True)
class OptionGammaFlowStressSummary:
    row_count: int
    observed_gamma_count: int
    observed_option_flow_count: int
    observed_weekly_option_count: int
    observed_short_dte_count: int
    negative_gamma_row_share: float
    positive_gamma_row_share: float
    weekly_or_short_dte_share: float
    median_abs_gamma_exposure: float
    option_flow_intensity_score: float
    intraday_signed_volatility_bps: float
    positive_gamma_reversal_share: float
    negative_gamma_momentum_share: float
    adverse_gamma_feedback_share: float
    gamma_source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": OPTION_GAMMA_FLOW_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_option_gamma_flow_stress_ranking",
            "source_papers": [
                dict(item) for item in OPTION_GAMMA_FLOW_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_gamma_count": self.observed_gamma_count,
            "observed_option_flow_count": self.observed_option_flow_count,
            "observed_weekly_option_count": self.observed_weekly_option_count,
            "observed_short_dte_count": self.observed_short_dte_count,
            "negative_gamma_row_share": _stable_float(self.negative_gamma_row_share),
            "positive_gamma_row_share": _stable_float(self.positive_gamma_row_share),
            "weekly_or_short_dte_share": _stable_float(self.weekly_or_short_dte_share),
            "median_abs_gamma_exposure": _stable_float(self.median_abs_gamma_exposure),
            "option_flow_intensity_score": _stable_float(
                self.option_flow_intensity_score
            ),
            "intraday_signed_volatility_bps": _stable_float(
                self.intraday_signed_volatility_bps
            ),
            "positive_gamma_reversal_share": _stable_float(
                self.positive_gamma_reversal_share
            ),
            "negative_gamma_momentum_share": _stable_float(
                self.negative_gamma_momentum_share
            ),
            "adverse_gamma_feedback_share": _stable_float(
                self.adverse_gamma_feedback_share
            ),
            "gamma_source_gap_score": _stable_float(self.gamma_source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "negative_gamma_row_share": _stable_float(
                    self.negative_gamma_row_share
                ),
                "positive_gamma_row_share": _stable_float(
                    self.positive_gamma_row_share
                ),
                "weekly_or_short_dte_share": _stable_float(
                    self.weekly_or_short_dte_share
                ),
                "option_flow_intensity_score": _stable_float(
                    self.option_flow_intensity_score
                ),
                "intraday_signed_volatility_bps": _stable_float(
                    self.intraday_signed_volatility_bps
                ),
                "positive_gamma_reversal_share": _stable_float(
                    self.positive_gamma_reversal_share
                ),
                "negative_gamma_momentum_share": _stable_float(
                    self.negative_gamma_momentum_share
                ),
                "adverse_gamma_feedback_share": _stable_float(
                    self.adverse_gamma_feedback_share
                ),
                "gamma_source_gap_score": _stable_float(self.gamma_source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "option_gamma_exposure_preview": True,
            "short_horizon_option_availability_preview": True,
            "requires_options_provider_clock_downstream": True,
            "requires_option_open_interest_or_dealer_gamma_source_downstream": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": OPTION_GAMMA_FLOW_STRESS_PROOF_SEMANTICS_LABEL,
        }


def option_gamma_flow_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": OPTION_GAMMA_FLOW_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": OPTION_GAMMA_FLOW_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in OPTION_GAMMA_FLOW_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "short_horizon_option_gamma_flow_feedback_stress",
        "stress_components": [
            "negative_gamma_momentum_share",
            "positive_gamma_reversal_share",
            "weekly_or_short_dte_share",
            "option_flow_intensity_score",
            "gamma_source_gap_score",
            "adverse_gamma_feedback_share",
        ],
        "gamma_fields": list(_GAMMA_FIELDS),
        "option_flow_fields": list(_OPTION_FLOW_FIELDS),
        "weekly_option_fields": list(_WEEKLY_OPTION_FIELDS + _DTE_FIELDS),
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_options_provider_clock": True,
            "requires_option_open_interest_or_dealer_gamma_source": True,
            "requires_runtime_ledger": True,
            "rejects_gamma_proxy_as_realized_pnl_authority": True,
            "rejects_missing_options_source_as_zero_gamma_assumption": True,
        },
    }


def build_option_gamma_flow_stress_schema_hash() -> str:
    return _stable_hash(option_gamma_flow_stress_contract())


def extract_option_gamma_flow_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> OptionGammaFlowStressSummary:
    """Extract deterministic option gamma feedback stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    gammas = tuple(_row_gamma(row) for row in ordered)
    option_flows = tuple(_row_option_flow(row) for row in ordered)
    weekly_flags = tuple(_row_weekly_or_short_dte(row) for row in ordered)
    prices = tuple(_row_price(row) for row in ordered)
    returns = _returns_bps(prices)
    signed_returns = tuple(value * signed_direction for value in returns)

    gamma_values = tuple(value for value in gammas if value is not None)
    option_flow_values = tuple(
        value for value in option_flows if value is not None and value >= 0.0
    )
    weekly_observations = tuple(value for value in weekly_flags if value is not None)
    short_dte_observations = tuple(
        value for row in ordered if (value := _row_short_dte(row)) is not None
    )

    observed_gamma_count = len(gamma_values)
    observed_option_flow_count = len(option_flow_values)
    observed_weekly_option_count = len(weekly_observations)
    observed_short_dte_count = len(short_dte_observations)
    row_denominator = max(1, len(ordered))
    negative_gamma_row_share = (
        sum(1 for value in gamma_values if value < 0.0) / row_denominator
    )
    positive_gamma_row_share = (
        sum(1 for value in gamma_values if value > 0.0) / row_denominator
    )
    weekly_or_short_dte_share = (
        sum(1 for value in weekly_observations if value) / row_denominator
    )
    median_abs_gamma_exposure = _median(tuple(abs(value) for value in gamma_values))
    option_flow_intensity_score = _option_flow_intensity_score(
        option_flow_values, ordered
    )
    intraday_signed_volatility_bps = _median(
        tuple(abs(value) for value in signed_returns)
    )
    positive_gamma_reversal_share, negative_gamma_momentum_share = (
        _gamma_feedback_shares(
            gammas=gammas,
            signed_returns=signed_returns,
        )
    )
    adverse_gamma_feedback_share = _adverse_gamma_feedback_share(
        gammas=gammas,
        signed_returns=signed_returns,
    )
    gamma_source_gap_score = _gamma_source_gap_score(
        observed_gamma_count=observed_gamma_count,
        observed_option_flow_count=observed_option_flow_count,
        observed_weekly_option_count=observed_weekly_option_count,
    )
    replay_rank_penalty_bps = min(
        250.0,
        adverse_gamma_feedback_share * 45.0
        + negative_gamma_momentum_share * 18.0
        + positive_gamma_reversal_share * 12.0
        + weekly_or_short_dte_share * 8.0
        + option_flow_intensity_score * 10.0
        + gamma_source_gap_score * 20.0
        + max(0.0, intraday_signed_volatility_bps - 5.0) * 0.10,
    )
    warnings: set[str] = set()
    if not ordered:
        warnings.add("empty_option_gamma_flow_records")
    if observed_gamma_count == 0:
        warnings.add("missing_option_gamma_inputs")
    if observed_option_flow_count == 0:
        warnings.add("missing_option_flow_inputs")
    if observed_weekly_option_count == 0 and observed_short_dte_count == 0:
        warnings.add("missing_short_horizon_option_availability_inputs")
    if observed_gamma_count and observed_option_flow_count == 0:
        warnings.add("gamma_without_option_flow_context")
    if observed_option_flow_count and observed_gamma_count == 0:
        warnings.add("option_flow_without_dealer_gamma_source")

    return OptionGammaFlowStressSummary(
        row_count=len(ordered),
        observed_gamma_count=observed_gamma_count,
        observed_option_flow_count=observed_option_flow_count,
        observed_weekly_option_count=observed_weekly_option_count,
        observed_short_dte_count=observed_short_dte_count,
        negative_gamma_row_share=negative_gamma_row_share,
        positive_gamma_row_share=positive_gamma_row_share,
        weekly_or_short_dte_share=weekly_or_short_dte_share,
        median_abs_gamma_exposure=median_abs_gamma_exposure,
        option_flow_intensity_score=option_flow_intensity_score,
        intraday_signed_volatility_bps=intraday_signed_volatility_bps,
        positive_gamma_reversal_share=positive_gamma_reversal_share,
        negative_gamma_momentum_share=negative_gamma_momentum_share,
        adverse_gamma_feedback_share=adverse_gamma_feedback_share,
        gamma_source_gap_score=gamma_source_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=build_option_gamma_flow_stress_schema_hash(),
    )


def _gamma_feedback_shares(
    *, gammas: Sequence[float | None], signed_returns: Sequence[float]
) -> tuple[float, float]:
    positive_reversal = 0
    positive_count = 0
    negative_momentum = 0
    negative_count = 0
    for index in range(1, min(len(gammas), len(signed_returns))):
        gamma = gammas[index]
        previous_return = signed_returns[index - 1]
        current_return = signed_returns[index]
        if gamma is None or previous_return == 0.0 or current_return == 0.0:
            continue
        same_sign = previous_return * current_return > 0.0
        if gamma > 0.0:
            positive_count += 1
            if not same_sign:
                positive_reversal += 1
        elif gamma < 0.0:
            negative_count += 1
            if same_sign:
                negative_momentum += 1
    return (
        positive_reversal / max(1, positive_count),
        negative_momentum / max(1, negative_count),
    )


def _adverse_gamma_feedback_share(
    *, gammas: Sequence[float | None], signed_returns: Sequence[float]
) -> float:
    stressed = 0
    adverse = 0
    for index in range(1, min(len(gammas), len(signed_returns))):
        gamma = gammas[index]
        current_return = signed_returns[index]
        previous_return = signed_returns[index - 1]
        if gamma is None or current_return == 0.0 or previous_return == 0.0:
            continue
        stressed += 1
        if gamma < 0.0 and previous_return < 0.0 and current_return < 0.0:
            adverse += 1
        elif gamma > 0.0 and previous_return > 0.0 and current_return < 0.0:
            adverse += 1
    return adverse / max(1, stressed)


def _gamma_source_gap_score(
    *,
    observed_gamma_count: int,
    observed_option_flow_count: int,
    observed_weekly_option_count: int,
) -> float:
    if observed_gamma_count:
        return 0.0
    if observed_option_flow_count or observed_weekly_option_count:
        return 1.0
    return 0.25


def _option_flow_intensity_score(
    values: Sequence[float], rows: Sequence[SignalEnvelope]
) -> float:
    if not values:
        return 0.0
    option_median = _median(values)
    stock_volumes = tuple(
        value
        for row in rows
        if (value := _coalesce_numeric(row.payload, _VOLUME_FIELDS)) is not None
        and value > 0.0
    )
    stock_median = _median(stock_volumes)
    if stock_median <= 0.0:
        return min(1.0, option_median / max(1.0, option_median))
    return min(1.0, option_median / max(1.0, stock_median))


def _row_gamma(row: SignalEnvelope) -> float | None:
    return _coalesce_numeric(row.payload, _GAMMA_FIELDS)


def _row_option_flow(row: SignalEnvelope) -> float | None:
    return _coalesce_numeric(row.payload, _OPTION_FLOW_FIELDS)


def _row_short_dte(row: SignalEnvelope) -> bool | None:
    dte = _coalesce_numeric(row.payload, _DTE_FIELDS)
    if dte is None:
        return None
    return dte <= 7.0


def _row_weekly_or_short_dte(row: SignalEnvelope) -> bool | None:
    weekly = _coalesce_bool(row.payload, _WEEKLY_OPTION_FIELDS)
    short_dte = _row_short_dte(row)
    if weekly is None and short_dte is None:
        return None
    return bool(weekly) or bool(short_dte)


def _row_price(row: SignalEnvelope) -> float | None:
    value = _coalesce_numeric(row.payload, _PRICE_FIELDS)
    if value is None or value <= 0.0:
        return None
    return value


def _returns_bps(prices: Sequence[float | None]) -> tuple[float, ...]:
    clean = tuple(value for value in prices if value is not None and value > 0.0)
    returns: list[float] = []
    for previous, current in zip(clean, clean[1:]):
        if previous > 0.0:
            returns.append((current - previous) / previous * 10_000.0)
    return tuple(returns)


def _coalesce_numeric(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> float | None:
    for field in fields:
        value = _float_or_none(payload.get(field))
        if value is not None:
            return value
    return None


def _coalesce_bool(payload: Mapping[str, Any], fields: Sequence[str]) -> bool | None:
    for field in fields:
        if field not in payload:
            continue
        value = payload.get(field)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "y", "available"}:
                return True
            if normalized in {"0", "false", "no", "n", "unavailable"}:
                return False
        number = _float_or_none(value)
        if number is not None:
            return number > 0.0
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(converted):
        return None
    return converted


def _median(values: Sequence[float]) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    middle = len(clean) // 2
    if len(clean) % 2:
        return clean[middle]
    return (clean[middle - 1] + clean[middle]) / 2.0


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 6)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        return {str(key): _json_ready(item) for key, item in mapping.items()}
    if isinstance(value, (list, tuple)):
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    return value


__all__ = [
    "OPTION_GAMMA_FLOW_STRESS_PRIMARY_SOURCES",
    "OPTION_GAMMA_FLOW_STRESS_PROOF_SEMANTICS_LABEL",
    "OPTION_GAMMA_FLOW_STRESS_SCHEMA_VERSION",
    "OptionGammaFlowStressSummary",
    "build_option_gamma_flow_stress_schema_hash",
    "extract_option_gamma_flow_stress",
    "option_gamma_flow_stress_contract",
]
