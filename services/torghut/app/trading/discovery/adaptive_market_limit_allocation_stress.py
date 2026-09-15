"""Preview-only market/limit allocation execution stress for replay ranking.

This module actualizes recent 2025-2026 execution papers into deterministic
replay inputs that penalize candidates whose observed order allocation cannot be
reconciled with fill uncertainty, tactical imbalance, and realistic impact/cost
logging. It never creates fills, writes ledgers, or grants promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log2
from statistics import median
from typing import Any

from app.trading.models import SignalEnvelope

ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_SCHEMA_VERSION = (
    "torghut.adaptive-market-limit-allocation-stress.v2"
)
ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.adaptive-market-limit-allocation-stress-contract.v2"
)
ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PROOF_SEMANTICS_LABEL = (
    "adaptive_market_limit_allocation_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PRIMARY_SOURCES: tuple[
    Mapping[str, str], ...
] = (
    {
        "source_id": "arxiv-2507.06345",
        "url": "https://arxiv.org/abs/2507.06345",
        "title": "Reinforcement Learning for Trade Execution with Market and Limit Orders",
        "date": "2026-01-26",
        "mechanism": "dynamic_market_limit_allocation_with_fill_uncertainty_and_tactical_imbalance",
    },
    {
        "source_id": "arxiv-2605.24242",
        "url": "https://arxiv.org/abs/2605.24242",
        "title": "Explicit Signal-Adaptive Sequential Optimal Execution Quotes",
        "date": "2026-05-22",
        "mechanism": "signal_adaptive_limit_quote_execution_with_inventory_and_execution_risk_penalties",
    },
    {
        "source_id": "arxiv-2603.29086",
        "url": "https://arxiv.org/abs/2603.29086",
        "title": "Realistic Market Impact Modeling for Reinforcement Learning Trading Environments",
        "date": "2026-04-04",
        "mechanism": "trade_level_cost_logging_and_realistic_execution_cost_models_change_rankings",
    },
)

_ORDER_TYPE_FIELDS = (
    "order_type",
    "order_kind",
    "execution_order_type",
    "execution_type",
    "order_instruction",
    "route_order_type",
)
_FILL_STATUS_FIELDS = (
    "fill_status",
    "order_fill_status",
    "execution_status",
    "route_fill_status",
)
_FILLED_QTY_FIELDS = ("filled_qty", "fill_qty", "filled_quantity", "executed_qty")
_ORDER_QTY_FIELDS = ("order_qty", "quantity", "qty", "target_qty", "requested_qty")
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price")
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_IMBALANCE_FIELDS = (
    "order_book_imbalance",
    "book_imbalance",
    "depth_imbalance",
    "bid_ask_imbalance",
    "ofi",
    "order_flow_imbalance",
)
_REMAINING_INVENTORY_QTY_FIELDS = (
    "remaining_inventory_qty",
    "leftover_inventory_qty",
    "unexecuted_inventory_qty",
    "unfilled_inventory_qty",
    "inventory_remaining_qty",
    "held_outside_book_qty",
    "withheld_inventory_qty",
    "remaining_parent_qty",
)
_PARENT_QTY_FIELDS = (
    "parent_order_qty",
    "metaorder_qty",
    "arrival_qty",
    "target_inventory_qty",
    "target_parent_qty",
    "target_qty",
    "order_qty",
    "quantity",
    "qty",
)
_DEADLINE_PROGRESS_FIELDS = (
    "execution_progress",
    "schedule_progress",
    "time_progress",
    "deadline_progress",
    "session_progress",
)
_WIDE_SPREAD_BPS = 8.0
_ADVERSE_IMBALANCE_THRESHOLD = -0.05
_SUPPORTIVE_IMBALANCE_THRESHOLD = 0.05


@dataclass(frozen=True)
class AdaptiveMarketLimitAllocationStressSummary:
    row_count: int
    observed_order_type_count: int
    observed_fill_evidence_count: int
    observed_tactical_imbalance_count: int
    market_order_share: float
    limit_order_share: float
    allocation_entropy: float
    limit_fill_rate: float
    market_unfilled_share: float
    unfilled_limit_share: float
    explicit_withhold_order_share: float
    terminal_inventory_gap_share: float
    terminal_inventory_urgency_score: float
    adverse_market_order_share: float
    wide_spread_market_order_share: float
    supportive_limit_order_share: float
    nonfill_opportunity_cost_bps: float
    allocation_impact_cost_bps: float
    terminal_inventory_penalty_bps: float
    allocation_reality_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_adaptive_market_limit_allocation_stress_ranking",
            "source_papers": [
                dict(item)
                for item in ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_order_type_count": self.observed_order_type_count,
            "observed_fill_evidence_count": self.observed_fill_evidence_count,
            "observed_tactical_imbalance_count": self.observed_tactical_imbalance_count,
            "market_order_share": _stable_float(self.market_order_share),
            "limit_order_share": _stable_float(self.limit_order_share),
            "allocation_entropy": _stable_float(self.allocation_entropy),
            "limit_fill_rate": _stable_float(self.limit_fill_rate),
            "market_unfilled_share": _stable_float(self.market_unfilled_share),
            "unfilled_limit_share": _stable_float(self.unfilled_limit_share),
            "explicit_withhold_order_share": _stable_float(
                self.explicit_withhold_order_share
            ),
            "terminal_inventory_gap_share": _stable_float(
                self.terminal_inventory_gap_share
            ),
            "terminal_inventory_urgency_score": _stable_float(
                self.terminal_inventory_urgency_score
            ),
            "adverse_market_order_share": _stable_float(
                self.adverse_market_order_share
            ),
            "wide_spread_market_order_share": _stable_float(
                self.wide_spread_market_order_share
            ),
            "supportive_limit_order_share": _stable_float(
                self.supportive_limit_order_share
            ),
            "nonfill_opportunity_cost_bps": _stable_float(
                self.nonfill_opportunity_cost_bps
            ),
            "allocation_impact_cost_bps": _stable_float(
                self.allocation_impact_cost_bps
            ),
            "terminal_inventory_penalty_bps": _stable_float(
                self.terminal_inventory_penalty_bps
            ),
            "allocation_reality_gap_score": _stable_float(
                self.allocation_reality_gap_score
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "market_order_share": _stable_float(self.market_order_share),
                "limit_order_share": _stable_float(self.limit_order_share),
                "allocation_entropy": _stable_float(self.allocation_entropy),
                "limit_fill_rate": _stable_float(self.limit_fill_rate),
                "market_unfilled_share": _stable_float(self.market_unfilled_share),
                "unfilled_limit_share": _stable_float(self.unfilled_limit_share),
                "explicit_withhold_order_share": _stable_float(
                    self.explicit_withhold_order_share
                ),
                "terminal_inventory_gap_share": _stable_float(
                    self.terminal_inventory_gap_share
                ),
                "terminal_inventory_urgency_score": _stable_float(
                    self.terminal_inventory_urgency_score
                ),
                "adverse_market_order_share": _stable_float(
                    self.adverse_market_order_share
                ),
                "wide_spread_market_order_share": _stable_float(
                    self.wide_spread_market_order_share
                ),
                "supportive_limit_order_share": _stable_float(
                    self.supportive_limit_order_share
                ),
                "nonfill_opportunity_cost_bps": _stable_float(
                    self.nonfill_opportunity_cost_bps
                ),
                "allocation_impact_cost_bps": _stable_float(
                    self.allocation_impact_cost_bps
                ),
                "terminal_inventory_penalty_bps": _stable_float(
                    self.terminal_inventory_penalty_bps
                ),
                "allocation_reality_gap_score": _stable_float(
                    self.allocation_reality_gap_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "market_limit_allocation_preview": True,
            "fill_uncertainty_preview": True,
            "tactical_imbalance_allocation_preview": True,
            "terminal_inventory_risk_preview": True,
            "trade_level_cost_logging_required_downstream": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def adaptive_market_limit_allocation_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item)
            for item in ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "observed_market_limit_allocation_fill_uncertainty_and_cost_logging_stress",
        "stress_components": [
            "observed_market_limit_order_mix",
            "limit_fill_rate",
            "unfilled_limit_share",
            "adverse_market_order_share",
            "wide_spread_market_order_share",
            "explicit_withhold_order_share",
            "terminal_inventory_gap_share",
            "terminal_inventory_urgency_score",
            "nonfill_opportunity_cost_bps",
            "allocation_impact_cost_bps",
            "terminal_inventory_penalty_bps",
            "allocation_reality_gap_score",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_terminal_inventory_reconciliation": True,
            "requires_runtime_ledger": True,
            "requires_trade_level_cost_logging": True,
            "rejects_model_allocation_as_fill_authority": True,
            "rejects_withheld_inventory_proxy_as_position_authority": True,
            "rejects_terminal_inventory_penalty_as_realized_loss_authority": True,
            "rejects_synthetic_fill_authority": True,
            "rejects_modeled_cost_as_realized_pnl_authority": True,
        },
    }


def build_adaptive_market_limit_allocation_stress_schema_hash() -> str:
    return _stable_hash(adaptive_market_limit_allocation_stress_contract())


def extract_adaptive_market_limit_allocation_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> AdaptiveMarketLimitAllocationStressSummary:
    """Extract observed market/limit allocation stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    warnings: list[str] = []
    order_types: list[str] = []
    fill_evidence_count = 0
    market_unfilled_count = 0
    limit_fill_evidence_count = 0
    limit_filled_count = 0
    limit_unfilled_count = 0
    explicit_withhold_count = 0
    adverse_market_count = 0
    wide_spread_market_count = 0
    supportive_limit_count = 0
    tactical_imbalance_count = 0
    terminal_inventory_gap_share = 0.0
    terminal_inventory_urgency_score = 0.0
    nonfill_costs: list[float] = []
    spread_values: list[float] = []

    prices = tuple(_first_float(row.payload, _PRICE_FIELDS) for row in ordered)

    for index, row in enumerate(ordered):
        order_type = _extract_order_type(row.payload)
        fill_known = _fill_evidence_present(row.payload)
        filled = _is_filled(row.payload)
        spread_bps = _first_float(row.payload, _SPREAD_BPS_FIELDS)
        imbalance = _first_float(row.payload, _IMBALANCE_FIELDS)
        signed_imbalance = (
            signed_direction * imbalance if imbalance is not None else None
        )

        if spread_bps is not None:
            spread_values.append(max(0.0, spread_bps))
        if signed_imbalance is not None:
            tactical_imbalance_count += 1
        inventory_gap_share = _inventory_gap_share(row.payload)
        if inventory_gap_share is not None:
            terminal_inventory_gap_share = inventory_gap_share
            deadline_progress = _first_float(row.payload, _DEADLINE_PROGRESS_FIELDS)
            if deadline_progress is None:
                deadline_progress = (index + 1.0) / max(1.0, float(len(ordered)))
            terminal_inventory_urgency_score = max(
                terminal_inventory_urgency_score,
                inventory_gap_share
                * _clamped_float(deadline_progress, low=0.0, high=1.0),
            )

        if order_type is None:
            continue
        order_types.append(order_type)
        if fill_known:
            fill_evidence_count += 1

        if order_type == "market":
            if fill_known and not filled:
                market_unfilled_count += 1
            if spread_bps is not None and spread_bps >= _WIDE_SPREAD_BPS:
                wide_spread_market_count += 1
            if signed_imbalance is not None and (
                signed_imbalance <= _ADVERSE_IMBALANCE_THRESHOLD
            ):
                adverse_market_count += 1
        elif order_type == "limit":
            if fill_known:
                limit_fill_evidence_count += 1
                if filled:
                    limit_filled_count += 1
                else:
                    limit_unfilled_count += 1
                    cost = _next_price_opportunity_cost_bps(
                        prices,
                        index=index,
                        direction=signed_direction,
                    )
                    if cost is not None:
                        nonfill_costs.append(cost)
            if signed_imbalance is not None and (
                signed_imbalance >= _SUPPORTIVE_IMBALANCE_THRESHOLD
            ):
                supportive_limit_count += 1
        elif order_type == "withheld":
            explicit_withhold_count += 1

    observed_order_type_count = len(order_types)
    market_order_count = sum(1 for item in order_types if item == "market")
    limit_order_count = sum(1 for item in order_types if item == "limit")
    explicit_withhold_order_share = _share(
        explicit_withhold_count, observed_order_type_count
    )
    if len(ordered) < 2:
        warnings.append("insufficient_allocation_replay_rows")
    if observed_order_type_count == 0:
        warnings.append("missing_market_limit_order_type_evidence")
    if fill_evidence_count == 0:
        warnings.append("missing_order_lifecycle_fill_evidence")
    if tactical_imbalance_count == 0:
        warnings.append("missing_tactical_imbalance_evidence")

    market_order_share = _share(market_order_count, observed_order_type_count)
    limit_order_share = _share(limit_order_count, observed_order_type_count)
    allocation_entropy = _binary_entropy(market_order_share)
    limit_fill_rate = _share(limit_filled_count, limit_fill_evidence_count)
    market_unfilled_share = _share(market_unfilled_count, market_order_count)
    unfilled_limit_share = _share(limit_unfilled_count, limit_fill_evidence_count)
    adverse_market_order_share = _share(adverse_market_count, market_order_count)
    wide_spread_market_order_share = _share(
        wide_spread_market_count, market_order_count
    )
    supportive_limit_order_share = _share(supportive_limit_count, limit_order_count)
    nonfill_opportunity_cost_bps = median(nonfill_costs) if nonfill_costs else 0.0
    median_spread_bps = median(spread_values) if spread_values else 0.0
    allocation_impact_cost_bps = (
        market_order_share * median_spread_bps
        + wide_spread_market_order_share * _WIDE_SPREAD_BPS * 0.5
        + adverse_market_order_share * 6.0
    )
    terminal_inventory_gap_share = max(
        terminal_inventory_gap_share,
        explicit_withhold_order_share * 0.50,
    )
    terminal_inventory_penalty_bps = (
        terminal_inventory_gap_share * 14.0
        + terminal_inventory_urgency_score * 18.0
        + explicit_withhold_order_share * 6.0
    )

    evidence_gap_score = (
        (0.0 if observed_order_type_count > 0 else 1.0)
        + (0.0 if fill_evidence_count > 0 else 1.0)
        + (0.0 if tactical_imbalance_count > 0 else 0.5)
    )
    concentration_gap = max(0.0, 0.25 - allocation_entropy)
    allocation_reality_gap_score = min(
        1.0,
        evidence_gap_score * 0.35
        + unfilled_limit_share * 0.25
        + terminal_inventory_gap_share * 0.25
        + terminal_inventory_urgency_score * 0.15
        + adverse_market_order_share * 0.20
        + wide_spread_market_order_share * 0.15
        + concentration_gap * 0.20,
    )
    missing_penalty_bps = 7.0 * len(warnings)
    replay_rank_penalty_bps = (
        missing_penalty_bps
        + allocation_impact_cost_bps
        + terminal_inventory_penalty_bps
        + nonfill_opportunity_cost_bps * 0.60
        + unfilled_limit_share * 10.0
        + adverse_market_order_share * 8.0
        + market_unfilled_share * 8.0
        + allocation_reality_gap_score * 8.0
    )

    return AdaptiveMarketLimitAllocationStressSummary(
        row_count=len(ordered),
        observed_order_type_count=observed_order_type_count,
        observed_fill_evidence_count=fill_evidence_count,
        observed_tactical_imbalance_count=tactical_imbalance_count,
        market_order_share=market_order_share,
        limit_order_share=limit_order_share,
        allocation_entropy=allocation_entropy,
        limit_fill_rate=limit_fill_rate,
        market_unfilled_share=market_unfilled_share,
        unfilled_limit_share=unfilled_limit_share,
        explicit_withhold_order_share=explicit_withhold_order_share,
        terminal_inventory_gap_share=terminal_inventory_gap_share,
        terminal_inventory_urgency_score=terminal_inventory_urgency_score,
        adverse_market_order_share=adverse_market_order_share,
        wide_spread_market_order_share=wide_spread_market_order_share,
        supportive_limit_order_share=supportive_limit_order_share,
        nonfill_opportunity_cost_bps=nonfill_opportunity_cost_bps,
        allocation_impact_cost_bps=allocation_impact_cost_bps,
        terminal_inventory_penalty_bps=terminal_inventory_penalty_bps,
        allocation_reality_gap_score=allocation_reality_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_adaptive_market_limit_allocation_stress_schema_hash(),
    )


def _extract_order_type(payload: Mapping[str, Any]) -> str | None:
    raw = _first_text(payload, _ORDER_TYPE_FIELDS)
    if raw is None:
        return None
    normalized = raw.lower().replace("-", "_").replace(" ", "_")
    if "market" in normalized or normalized in {"mkt", "take", "taker"}:
        return "market"
    if "limit" in normalized or normalized in {"lmt", "post", "maker"}:
        return "limit"
    if normalized in {
        "hold",
        "held",
        "withhold",
        "withheld",
        "wait",
        "outside_book",
        "outside_order_book",
        "no_order",
        "none",
    }:
        return "withheld"
    return None


def _fill_evidence_present(payload: Mapping[str, Any]) -> bool:
    if _first_text(payload, _FILL_STATUS_FIELDS) is not None:
        return True
    return _first_float(payload, _FILLED_QTY_FIELDS) is not None


def _is_filled(payload: Mapping[str, Any]) -> bool:
    status = _first_text(payload, _FILL_STATUS_FIELDS)
    if status is not None:
        normalized = status.lower().replace("-", "_").replace(" ", "_")
        if normalized in {"filled", "fill", "done", "complete", "completed"}:
            return True
        if normalized in {"partial", "partially_filled"}:
            return True
        if normalized in {"unfilled", "not_filled", "missed", "cancelled", "canceled"}:
            return False
    filled_qty = _first_float(payload, _FILLED_QTY_FIELDS)
    order_qty = _first_float(payload, _ORDER_QTY_FIELDS)
    if filled_qty is None:
        return False
    if order_qty is not None and order_qty > 0.0:
        return filled_qty / order_qty >= 0.50
    return filled_qty > 0.0


def _next_price_opportunity_cost_bps(
    prices: Sequence[float | None],
    *,
    index: int,
    direction: float,
) -> float | None:
    current = prices[index]
    if current is None or current <= 0.0:
        return None
    for next_price in prices[index + 1 :]:
        if next_price is not None and next_price > 0.0:
            return max(0.0, direction * (next_price - current) / current * 10_000.0)
    return None


def _share(numerator: int | float, denominator: int | float) -> float:
    if denominator <= 0:
        return 0.0
    return min(1.0, max(0.0, float(numerator) / float(denominator)))


def _inventory_gap_share(payload: Mapping[str, Any]) -> float | None:
    remaining_qty = _first_float(payload, _REMAINING_INVENTORY_QTY_FIELDS)
    parent_qty = _first_float(payload, _PARENT_QTY_FIELDS)
    if remaining_qty is None or parent_qty is None or parent_qty <= 0.0:
        return None
    return _clamped_float(remaining_qty / parent_qty, low=0.0, high=1.0)


def _clamped_float(value: float, *, low: float, high: float) -> float:
    if not isfinite(value):
        return low
    return min(high, max(low, float(value)))


def _binary_entropy(probability: float) -> float:
    probability = min(1.0, max(0.0, probability))
    if probability in {0.0, 1.0}:
        return 0.0
    return -(
        probability * log2(probability) + (1.0 - probability) * log2(1.0 - probability)
    )


def _first_text(payload: Mapping[str, Any], fields: Sequence[str]) -> str | None:
    for field in fields:
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _first_float(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = payload.get(field)
        parsed = _float_or_none(value)
        if parsed is not None:
            return parsed
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return float(f"{value:.10f}")


def _stable_hash(payload: Mapping[str, Any]) -> str:
    stable_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()
