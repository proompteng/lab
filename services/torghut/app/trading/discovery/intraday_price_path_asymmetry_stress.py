"""Preview-only intraday price-path asymmetry stress for replay ranking.

This module converts recent intraday price-path and end-of-day reversal papers
into deterministic replay-ranking inputs. It consumes only replay rows/fixtures,
marks source gaps explicitly, and never authorizes promotion, realized PnL, or
live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from math import isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_SCHEMA_VERSION = (
    "torghut.intraday-price-path-asymmetry-stress.v1"
)
INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.intraday-price-path-asymmetry-stress-contract.v1"
)
INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PROOF_SEMANTICS_LABEL = "intraday_price_path_asymmetry_stress_preview_only_next_session_reversal_hypothesis_exact_replay_route_tca_runtime_ledger_required"
INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PRIMARY_SOURCES: tuple[
    Mapping[str, str], ...
] = (
    {
        "source_id": "ssrn-6074846",
        "url": "https://papers.ssrn.com/sol3/Delivery.cfm/6074846.pdf?abstractid=6074846&mirid=1",
        "title": "Intraday Price Asymmetry and Next-Day Intraday Returns in the S&P 500",
        "date": "2026-02-02",
        "mechanism": "range_based_intraday_open_high_low_asymmetry_as_next_session_contrarian_pressure_proxy",
    },
    {
        "source_id": "ssrn-5039009",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5039009",
        "title": "End-of-Day Reversal",
        "date": "2025-05-23",
        "mechanism": "last_thirty_minutes_intraday_reversal_and_price_pressure_requires_session_timing_controls",
    },
)

_OPEN_FIELDS = (
    "open",
    "session_open",
    "regular_session_open",
    "day_open",
    "opening_price",
)
_HIGH_FIELDS = (
    "high",
    "session_high",
    "regular_session_high",
    "day_high",
    "intraday_high",
)
_LOW_FIELDS = (
    "low",
    "session_low",
    "regular_session_low",
    "day_low",
    "intraday_low",
)
_CLOSE_FIELDS = (
    "close",
    "session_close",
    "regular_session_close",
    "day_close",
    "last_price",
    "price",
    "mid_price",
    "mid",
    "mark",
)
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_LATE_RETURN_FIELDS = (
    "late_session_return_bps",
    "last_30m_return_bps",
    "eod_return_bps",
    "close_auction_return_bps",
)
_VOLATILITY_FIELDS = (
    "realized_volatility_bps",
    "intraday_volatility_bps",
    "volatility_bps",
    "abs_return_bps",
)


@dataclass(frozen=True)
class _SessionPath:
    symbol: str
    trading_day: date
    row_count: int
    open_price: float | None
    high_price: float | None
    low_price: float | None
    close_price: float | None
    late_return_bps: float | None
    volatility_bps: float


@dataclass(frozen=True)
class IntradayPricePathAsymmetryStressSummary:
    row_count: int
    session_count: int
    observed_path_count: int
    mean_path_asymmetry: float
    mean_abs_path_asymmetry: float
    contrarian_alignment_score: float
    momentum_chase_score: float
    late_session_pressure_score: float
    volatility_stress_gate: float
    source_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_intraday_price_path_asymmetry_stress_ranking",
            "source_papers": [
                dict(item)
                for item in INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "session_count": self.session_count,
            "observed_path_count": self.observed_path_count,
            "mean_path_asymmetry": _stable_float(self.mean_path_asymmetry),
            "mean_abs_path_asymmetry": _stable_float(self.mean_abs_path_asymmetry),
            "contrarian_alignment_score": _stable_float(
                self.contrarian_alignment_score
            ),
            "momentum_chase_score": _stable_float(self.momentum_chase_score),
            "late_session_pressure_score": _stable_float(
                self.late_session_pressure_score
            ),
            "volatility_stress_gate": _stable_float(self.volatility_stress_gate),
            "source_gap_score": _stable_float(self.source_gap_score),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "mean_path_asymmetry": _stable_float(self.mean_path_asymmetry),
                "mean_abs_path_asymmetry": _stable_float(
                    self.mean_abs_path_asymmetry
                ),
                "contrarian_alignment_score": _stable_float(
                    self.contrarian_alignment_score
                ),
                "momentum_chase_score": _stable_float(self.momentum_chase_score),
                "late_session_pressure_score": _stable_float(
                    self.late_session_pressure_score
                ),
                "volatility_stress_gate": _stable_float(self.volatility_stress_gate),
                "source_gap_score": _stable_float(self.source_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "range_based_open_high_low_asymmetry_preview": True,
            "next_session_contrarian_pressure_hypothesis_preview": True,
            "end_of_day_reversal_timing_control_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def intraday_price_path_asymmetry_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": (
            INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_CONTRACT_SCHEMA_VERSION
        ),
        "feature_schema_version": INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item)
            for item in INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "range_based_intraday_path_asymmetry_next_session_contrarian_screen",
        "stress_components": [
            "mean_path_asymmetry",
            "mean_abs_path_asymmetry",
            "contrarian_alignment_score",
            "momentum_chase_score",
            "late_session_pressure_score",
            "volatility_stress_gate",
            "source_gap_score",
        ],
        "input_fields": {
            "open": list(_OPEN_FIELDS),
            "high": list(_HIGH_FIELDS),
            "low": list(_LOW_FIELDS),
            "close": list(_CLOSE_FIELDS),
            "fallback_price": list(_PRICE_FIELDS),
            "late_session_return": list(_LATE_RETURN_FIELDS),
            "volatility": list(_VOLATILITY_FIELDS),
        },
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_tick_level_replay": True,
            "requires_next_session_replay": True,
            "requires_route_tca": True,
            "requires_runtime_ledger": True,
            "rejects_intraday_asymmetry_as_pnl_authority": True,
            "rejects_same_day_path_proxy_as_execution_authority": True,
            "rejects_missing_ohlc_as_neutral": True,
        },
    }


def build_intraday_price_path_asymmetry_stress_schema_hash() -> str:
    return _stable_hash(intraday_price_path_asymmetry_stress_contract())


def extract_intraday_price_path_asymmetry_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> IntradayPricePathAsymmetryStressSummary:
    """Extract deterministic range-based intraday path stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    sessions = _session_paths(ordered)
    observed_asymmetries: list[float] = []
    contrarian_scores: list[float] = []
    chase_scores: list[float] = []
    late_pressure_scores: list[float] = []
    volatility_gates: list[float] = []
    missing_path_count = 0

    for session in sessions:
        asymmetry = _path_asymmetry(session)
        if asymmetry is None:
            missing_path_count += 1
            continue
        observed_asymmetries.append(asymmetry)
        contrarian_scores.append(max(0.0, -signed_direction * asymmetry))
        chase_scores.append(max(0.0, signed_direction * asymmetry))
        if session.late_return_bps is not None:
            late_pressure_scores.append(
                max(0.0, signed_direction * session.late_return_bps / 100.0)
            )
        volatility_gates.append(min(1.0, max(0.0, session.volatility_bps / 150.0)))

    observed_path_count = len(observed_asymmetries)
    session_count = len(sessions)
    source_gap_score = _source_gap_score(
        row_count=len(ordered),
        session_count=session_count,
        observed_path_count=observed_path_count,
        missing_path_count=missing_path_count,
    )
    mean_path_asymmetry = _mean(tuple(observed_asymmetries))
    mean_abs_path_asymmetry = _mean(tuple(abs(item) for item in observed_asymmetries))
    contrarian_alignment_score = _mean(tuple(contrarian_scores))
    momentum_chase_score = _mean(tuple(chase_scores))
    late_session_pressure_score = _mean(tuple(late_pressure_scores))
    volatility_stress_gate = _mean(tuple(volatility_gates))
    replay_rank_penalty_bps = min(
        250.0,
        source_gap_score * 45.0
        + momentum_chase_score * 36.0
        + late_session_pressure_score * 10.0
        + volatility_stress_gate * momentum_chase_score * 12.0
        + max(0.0, mean_abs_path_asymmetry - 0.35) * 8.0
        - contrarian_alignment_score * 10.0,
    )
    warnings: set[str] = set()
    if not ordered:
        warnings.add("empty_intraday_price_path_asymmetry_records")
    if not sessions:
        warnings.add("missing_session_price_path_rows")
    if missing_path_count:
        warnings.add("missing_open_high_low_path_inputs")
    if observed_path_count == 0:
        warnings.add("missing_intraday_price_path_asymmetry_inputs")
    if momentum_chase_score > contrarian_alignment_score:
        warnings.add("intraday_asymmetry_momentum_chase_downranked")
    if late_session_pressure_score > 0.0:
        warnings.add("same_direction_late_session_pressure_downranked")
    if volatility_stress_gate > 0.5 and momentum_chase_score > 0.0:
        warnings.add("volatility_stress_amplifies_asymmetry_chase_risk")

    return IntradayPricePathAsymmetryStressSummary(
        row_count=len(ordered),
        session_count=session_count,
        observed_path_count=observed_path_count,
        mean_path_asymmetry=mean_path_asymmetry,
        mean_abs_path_asymmetry=mean_abs_path_asymmetry,
        contrarian_alignment_score=contrarian_alignment_score,
        momentum_chase_score=momentum_chase_score,
        late_session_pressure_score=late_session_pressure_score,
        volatility_stress_gate=volatility_stress_gate,
        source_gap_score=source_gap_score,
        replay_rank_penalty_bps=max(0.0, replay_rank_penalty_bps),
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=build_intraday_price_path_asymmetry_stress_schema_hash(),
    )


def _session_paths(rows: Sequence[SignalEnvelope]) -> tuple[_SessionPath, ...]:
    grouped: dict[tuple[str, date], list[SignalEnvelope]] = {}
    for row in rows:
        symbol = row.symbol.strip().upper()
        if not symbol:
            continue
        trading_day = row.event_ts.date()
        grouped.setdefault((symbol, trading_day), []).append(row)
    sessions: list[_SessionPath] = []
    for (symbol, trading_day), group_rows in sorted(grouped.items()):
        ordered = sorted(group_rows, key=lambda item: (item.event_ts, item.seq))
        fallback_prices = [
            price
            for row in ordered
            if (price := _coalesce_numeric(row.payload, _PRICE_FIELDS)) is not None
            and price > 0.0
        ]
        open_price = _first_positive_numeric(ordered, _OPEN_FIELDS)
        if open_price is None and fallback_prices:
            open_price = fallback_prices[0]
        high_price = _max_positive_numeric(ordered, _HIGH_FIELDS)
        if high_price is None and fallback_prices:
            high_price = max(fallback_prices)
        low_price = _min_positive_numeric(ordered, _LOW_FIELDS)
        if low_price is None and fallback_prices:
            low_price = min(fallback_prices)
        close_price = _last_positive_numeric(ordered, _CLOSE_FIELDS)
        if close_price is None and fallback_prices:
            close_price = fallback_prices[-1]
        late_return_bps = _explicit_late_return_bps(ordered)
        if late_return_bps is None:
            late_return_bps = _fallback_late_return_bps(fallback_prices)
        sessions.append(
            _SessionPath(
                symbol=symbol,
                trading_day=trading_day,
                row_count=len(ordered),
                open_price=open_price,
                high_price=high_price,
                low_price=low_price,
                close_price=close_price,
                late_return_bps=late_return_bps,
                volatility_bps=_session_volatility_bps(ordered, fallback_prices),
            )
        )
    return tuple(sessions)


def _path_asymmetry(session: _SessionPath) -> float | None:
    if (
        session.open_price is None
        or session.high_price is None
        or session.low_price is None
        or session.high_price <= session.low_price
    ):
        return None
    upper_excursion = max(0.0, session.high_price - session.open_price)
    lower_excursion = max(0.0, session.open_price - session.low_price)
    price_range = session.high_price - session.low_price
    if price_range <= 0.0:
        return None
    return _clamp((upper_excursion - lower_excursion) / price_range, -1.0, 1.0)


def _source_gap_score(
    *,
    row_count: int,
    session_count: int,
    observed_path_count: int,
    missing_path_count: int,
) -> float:
    if row_count <= 0:
        return 1.0
    if session_count <= 0:
        return 1.0
    score = 0.0
    if observed_path_count <= 0:
        score += 0.75
    else:
        score += missing_path_count / max(1, session_count) * 0.35
    if session_count < 2:
        score += 0.15
    return min(1.0, score)


def _first_positive_numeric(
    rows: Sequence[SignalEnvelope], fields: Sequence[str]
) -> float | None:
    for row in rows:
        value = _coalesce_numeric(row.payload, fields)
        if value is not None and value > 0.0:
            return value
    return None


def _last_positive_numeric(
    rows: Sequence[SignalEnvelope], fields: Sequence[str]
) -> float | None:
    for row in reversed(rows):
        value = _coalesce_numeric(row.payload, fields)
        if value is not None and value > 0.0:
            return value
    return None


def _max_positive_numeric(
    rows: Sequence[SignalEnvelope], fields: Sequence[str]
) -> float | None:
    values = [
        value
        for row in rows
        if (value := _coalesce_numeric(row.payload, fields)) is not None
        and value > 0.0
    ]
    return max(values) if values else None


def _min_positive_numeric(
    rows: Sequence[SignalEnvelope], fields: Sequence[str]
) -> float | None:
    values = [
        value
        for row in rows
        if (value := _coalesce_numeric(row.payload, fields)) is not None
        and value > 0.0
    ]
    return min(values) if values else None


def _explicit_late_return_bps(rows: Sequence[SignalEnvelope]) -> float | None:
    values = [
        value
        for row in rows
        if (value := _coalesce_numeric(row.payload, _LATE_RETURN_FIELDS)) is not None
    ]
    return _mean(tuple(values)) if values else None


def _fallback_late_return_bps(prices: Sequence[float]) -> float | None:
    if len(prices) < 4:
        return None
    start_index = max(0, int(len(prices) * 0.75) - 1)
    start_price = prices[start_index]
    close_price = prices[-1]
    if start_price <= 0.0:
        return None
    return (close_price - start_price) / start_price * 10_000.0


def _session_volatility_bps(
    rows: Sequence[SignalEnvelope], fallback_prices: Sequence[float]
) -> float:
    explicit_values = [
        value
        for row in rows
        if (value := _coalesce_numeric(row.payload, _VOLATILITY_FIELDS)) is not None
        and value >= 0.0
    ]
    if explicit_values:
        return _mean(tuple(explicit_values))
    if len(fallback_prices) < 2:
        return 0.0
    returns = [
        abs((current - previous) / previous * 10_000.0)
        for previous, current in zip(fallback_prices, fallback_prices[1:])
        if previous > 0.0
    ]
    return _mean(tuple(returns))


def _coalesce_numeric(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> float | None:
    for field in fields:
        value = _float_or_none(payload.get(field))
        if value is not None:
            return value
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


def _mean(values: Sequence[float]) -> float:
    clean = [value for value in values if isfinite(value)]
    if not clean:
        return 0.0
    return sum(clean) / len(clean)


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


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
    "INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PRIMARY_SOURCES",
    "INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_PROOF_SEMANTICS_LABEL",
    "INTRADAY_PRICE_PATH_ASYMMETRY_STRESS_SCHEMA_VERSION",
    "IntradayPricePathAsymmetryStressSummary",
    "build_intraday_price_path_asymmetry_stress_schema_hash",
    "extract_intraday_price_path_asymmetry_stress",
    "intraday_price_path_asymmetry_stress_contract",
]
