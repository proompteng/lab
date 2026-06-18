"""Preview-only queue-survival fill stress for replay candidate ranking.

This module actualizes recent queue-position, fill-probability, and execution-delay
papers into deterministic replay harness inputs. It does not simulate broker
fills, write runtime ledgers, or carry promotion authority.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from math import exp
from typing import Any

from app.trading.models import SignalEnvelope


from .shared_context import (
    QueueSurvivalFillStressSummary,
    ADD_TOKENS as _ADD_TOKENS,
    ASK_SIZE_FIELDS as _ASK_SIZE_FIELDS,
    BID_SIZE_FIELDS as _BID_SIZE_FIELDS,
    CANCEL_TOKENS as _CANCEL_TOKENS,
    FILL_FIELDS as _FILL_FIELDS,
    FILL_TOKENS as _FILL_TOKENS,
    FillBeforeMoveStats as _FillBeforeMoveStats,
    ORDER_BOOK_IMBALANCE_FIELDS as _ORDER_BOOK_IMBALANCE_FIELDS,
    PRICE_FIELDS as _PRICE_FIELDS,
    QUEUE_POSITION_FIELDS as _QUEUE_POSITION_FIELDS,
    QUEUE_RATIO_FIELDS as _QUEUE_RATIO_FIELDS,
    QUEUE_REACTIVE_EVENT_KINDS as _QUEUE_REACTIVE_EVENT_KINDS,
    REJECT_TOKENS as _REJECT_TOKENS,
    SPREAD_FIELDS as _SPREAD_FIELDS,
    VOLUME_FIELDS as _VOLUME_FIELDS,
    build_queue_survival_fill_stress_schema_hash,
)


def _event_label(payload: Mapping[str, Any]) -> str:
    from .group_normalized_downside_reward_penalty_b import event_label as impl

    return impl(payload)


def _first_payload_value(payload: Mapping[str, Any], fields: Sequence[str]) -> Any:
    from .group_normalized_downside_reward_penalty_b import first_payload_value as impl

    return impl(payload, fields)


def _float_or_none(value: Any) -> float | None:
    from .group_normalized_downside_reward_penalty_b import float_or_none as impl

    return impl(value)


def _group_normalized_downside_reward_penalty_bps(*args: Any, **kwargs: Any) -> float:
    from .group_normalized_downside_reward_penalty_b import (
        group_normalized_downside_reward_penalty_bps as impl,
    )

    return impl(*args, **kwargs)


def _label_has_token(label: str, tokens: set[str] | frozenset[str]) -> bool:
    from .group_normalized_downside_reward_penalty_b import label_has_token as impl

    return impl(label, frozenset(tokens))


def _log1p(value: float) -> float:
    from .group_normalized_downside_reward_penalty_b import log1p as impl

    return impl(value)


def _median(values: Sequence[float]) -> float:
    from .group_normalized_downside_reward_penalty_b import median as impl

    return impl(values)


def _nonnegative_float(value: Any) -> float:
    from .group_normalized_downside_reward_penalty_b import nonnegative_float as impl

    return impl(value)


def _positive_float(value: Any) -> float | None:
    from .group_normalized_downside_reward_penalty_b import positive_float as impl

    return impl(value)


def _quantile(values: Sequence[float], q: float) -> float:
    from .group_normalized_downside_reward_penalty_b import quantile as impl

    return impl(values, q)


def _queue_reactive_event_kind(label: str) -> str:
    from .group_normalized_downside_reward_penalty_b import (
        queue_reactive_event_kind as impl,
    )

    return impl(label)


def extract_queue_survival_fill_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    max_notional: int | float | str | None = None,
) -> QueueSurvivalFillStressSummary:
    """Extract deterministic queue-survival fill stress from replay rows.

    The output is a replay-ranking stress input only. Exact replay, route TCA,
    real order-lifecycle fill evidence, and runtime-ledger proof remain
    authoritative.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    notional = _nonnegative_float(max_notional)
    prices = tuple(
        _positive_float(_first_payload_value(row.payload, _PRICE_FIELDS))
        for row in ordered
    )
    spreads = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _SPREAD_FIELDS))
        for row in ordered
    )
    executable_depths = tuple(
        _executable_side_depth(row.payload, direction=signed_direction)
        for row in ordered
    )
    queue_ratios = tuple(
        _queue_ahead_ratio(row.payload, executable_depth=depth)
        for row, depth in zip(ordered, executable_depths)
    )
    volumes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _VOLUME_FIELDS))
        for row in ordered
    )
    event_labels = tuple(_event_label(row.payload) for row in ordered)
    event_kinds = tuple(_queue_reactive_event_kind(label) for label in event_labels)
    fill_sizes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _FILL_FIELDS))
        for row in ordered
    )
    order_book_imbalances = tuple(_order_book_imbalance(row.payload) for row in ordered)

    warnings: list[str] = []
    if len(ordered) < 3:
        warnings.append("insufficient_queue_survival_rows")
    observed_queue_position_count = sum(item is not None for item in queue_ratios)
    if observed_queue_position_count == 0:
        warnings.append("missing_queue_position_fields")
    observed_depth_count = sum(depth > 0.0 for depth in executable_depths)
    if observed_depth_count == 0:
        warnings.append("missing_executable_side_depth")
    valid_prices = tuple(price for price in prices if price is not None and price > 0.0)
    if len(valid_prices) < 2:
        warnings.append("missing_price_path_for_nonfill_cost")
    if notional <= 0.0:
        warnings.append("missing_candidate_notional_for_queue_stress")
    if not any(event_labels):
        warnings.append("missing_queue_reactive_event_labels")
    observed_order_book_imbalance_count = sum(
        item is not None for item in order_book_imbalances
    )
    if observed_order_book_imbalance_count == 0:
        warnings.append("missing_order_book_imbalance_for_maker_dilemma")

    observed_fill_count = sum(
        1
        for label, fill_size in zip(event_labels, fill_sizes)
        if fill_size > 0.0 or _label_has_token(label, _FILL_TOKENS)
    )
    observed_cancel_or_reject_count = sum(
        1
        for label in event_labels
        if _label_has_token(label, _CANCEL_TOKENS | _REJECT_TOKENS)
    )
    usable_queue_ratios = tuple(item for item in queue_ratios if item is not None)
    median_queue_ahead_ratio = _median(usable_queue_ratios)
    executable_notional_samples = tuple(
        depth * price
        for depth, price in zip(executable_depths, prices)
        if depth > 0.0 and price is not None and price > 0.0
    )
    median_visible_executable_depth_notional = _median(executable_notional_samples)
    visible_depth_notional_shortfall_share = (
        max(0.0, notional - median_visible_executable_depth_notional) / notional
        if notional > 0.0
        else 0.0
    )
    visible_depth_notional_shortfall_share = min(
        1.0, visible_depth_notional_shortfall_share
    )
    total_execution_flow = sum(volumes) + sum(fill_sizes)
    median_executable_depth = _median(
        tuple(depth for depth in executable_depths if depth > 0.0)
    )
    execution_turnover_ratio = (
        min(4.0, total_execution_flow / max(1.0, median_executable_depth))
        if median_executable_depth > 0.0
        else 0.0
    )
    cancellation_or_reject_share = observed_cancel_or_reject_count / max(
        1, len(ordered)
    )
    queue_reactive_event_mix_l1 = _queue_reactive_event_mix_l1(
        event_kinds=event_kinds,
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
    )
    order_size_distribution_wasserstein_proxy = (
        _order_size_distribution_wasserstein_proxy(
            volumes=volumes,
            fill_sizes=fill_sizes,
            executable_depths=executable_depths,
        )
    )
    if order_size_distribution_wasserstein_proxy == 0.0:
        warnings.append("missing_order_size_distribution_for_queue_reactive_parity")
    queue_reactive_replay_parity_penalty_bps = (
        queue_reactive_event_mix_l1 * 4.0
        + order_size_distribution_wasserstein_proxy * 2.0
    )
    estimated_limit_fill_probability = _estimated_fill_probability(
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        cancellation_or_reject_share=cancellation_or_reject_share,
        observed_queue_position_count=observed_queue_position_count,
    )
    time_priority_edge_concentration_score = _time_priority_edge_concentration_score(
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        cancellation_or_reject_share=cancellation_or_reject_share,
        fill_probability=estimated_limit_fill_probability,
        observed_queue_position_count=observed_queue_position_count,
    )
    randomized_priority_fill_gap_proxy_bps = _randomized_priority_fill_gap_proxy_bps(
        time_priority_edge_concentration_score=time_priority_edge_concentration_score,
        median_spread_bps=_median(tuple(spread for spread in spreads if spread > 0.0)),
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
    )
    queue_allocation_rule_sensitivity_penalty_bps = (
        randomized_priority_fill_gap_proxy_bps
        + time_priority_edge_concentration_score * 5.0
        + queue_reactive_event_mix_l1 * 1.5
    )
    nonfill_opportunity_cost_bps = _nonfill_opportunity_cost_bps(
        valid_prices,
        direction=signed_direction,
        fill_probability=estimated_limit_fill_probability,
    )
    adverse_selection_after_touch_bps = _adverse_selection_after_touch_bps(
        valid_prices,
        direction=signed_direction,
        fill_probability=estimated_limit_fill_probability,
    )
    median_spread_bps = _median(tuple(spread for spread in spreads if spread > 0.0))
    fill_before_move_stats = _fill_before_opportunity_move_stats(
        rows=ordered,
        prices=prices,
        event_labels=event_labels,
        direction=signed_direction,
        median_spread_bps=median_spread_bps,
    )
    if fill_before_move_stats.trial_count <= 0:
        warnings.append("missing_state_dependent_fill_before_move_trials")
    if fill_before_move_stats.observed_move_count <= 0 and len(valid_prices) >= 2:
        warnings.append("missing_opportunity_midprice_move_before_fill_observations")
    state_dependent_fill_before_move_probability = _state_dependent_fill_before_move_probability(
        estimated_limit_fill_probability=estimated_limit_fill_probability,
        fill_before_move_trial_count=fill_before_move_stats.trial_count,
        fill_before_move_success_share=fill_before_move_stats.fill_before_move_share,
        queue_reactive_event_mix_l1=queue_reactive_event_mix_l1,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
    )
    opportunity_midprice_move_before_fill_share = (
        fill_before_move_stats.opportunity_move_before_fill_share
    )
    state_dependent_order_flow_gap_score = _state_dependent_order_flow_gap_score(
        fill_before_move_trial_count=fill_before_move_stats.trial_count,
        opportunity_midprice_move_before_fill_share=(
            opportunity_midprice_move_before_fill_share
        ),
        queue_reactive_event_mix_l1=queue_reactive_event_mix_l1,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
        cancellation_or_reject_share=cancellation_or_reject_share,
    )
    state_dependent_fill_risk_penalty_bps = _state_dependent_fill_risk_penalty_bps(
        state_dependent_fill_before_move_probability=(
            state_dependent_fill_before_move_probability
        ),
        opportunity_midprice_move_before_fill_share=(
            opportunity_midprice_move_before_fill_share
        ),
        state_dependent_order_flow_gap_score=state_dependent_order_flow_gap_score,
        nonfill_opportunity_cost_bps=nonfill_opportunity_cost_bps,
        median_spread_bps=median_spread_bps,
    )
    directional_imbalances = tuple(
        signed_direction * item for item in order_book_imbalances if item is not None
    )
    median_directional_order_book_imbalance = _median(directional_imbalances)
    contrarian_reversal_support_score = _contrarian_reversal_support_score(
        prices=valid_prices,
        direction=signed_direction,
        median_directional_order_book_imbalance=median_directional_order_book_imbalance,
        median_spread_bps=median_spread_bps,
    )
    maker_fill_return_tradeoff_penalty_bps = _maker_fill_return_tradeoff_penalty_bps(
        fill_probability=estimated_limit_fill_probability,
        adverse_selection_after_touch_bps=adverse_selection_after_touch_bps,
        median_directional_order_book_imbalance=median_directional_order_book_imbalance,
        contrarian_reversal_support_score=contrarian_reversal_support_score,
        median_spread_bps=median_spread_bps,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
    )
    group_normalized_downside_reward_penalty_bps = (
        _group_normalized_downside_reward_penalty_bps(
            rows=ordered,
            direction=signed_direction,
            fallback_spread_bps=median_spread_bps,
        )
    )
    queue_delay_penalty_bps = (
        median_queue_ahead_ratio * 10.0
        + visible_depth_notional_shortfall_share * 12.0
        + (1.0 - estimated_limit_fill_probability) * 9.0
        + cancellation_or_reject_share * 6.0
        + max(0.0, median_spread_bps - 4.0) * 0.35
    )
    missing_penalty_bps = 6.0 * len(warnings)
    replay_rank_penalty_bps = (
        queue_delay_penalty_bps
        + queue_reactive_replay_parity_penalty_bps
        + queue_allocation_rule_sensitivity_penalty_bps
        + maker_fill_return_tradeoff_penalty_bps
        + group_normalized_downside_reward_penalty_bps
        + nonfill_opportunity_cost_bps
        + adverse_selection_after_touch_bps
        + state_dependent_fill_risk_penalty_bps
        + missing_penalty_bps
    )
    return QueueSurvivalFillStressSummary(
        row_count=len(ordered),
        observed_queue_position_count=observed_queue_position_count,
        observed_depth_count=observed_depth_count,
        observed_fill_count=observed_fill_count,
        observed_cancel_or_reject_count=observed_cancel_or_reject_count,
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        median_visible_executable_depth_notional=median_visible_executable_depth_notional,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        execution_turnover_ratio=execution_turnover_ratio,
        cancellation_or_reject_share=cancellation_or_reject_share,
        queue_reactive_event_mix_l1=queue_reactive_event_mix_l1,
        order_size_distribution_wasserstein_proxy=order_size_distribution_wasserstein_proxy,
        queue_reactive_replay_parity_penalty_bps=queue_reactive_replay_parity_penalty_bps,
        time_priority_edge_concentration_score=time_priority_edge_concentration_score,
        randomized_priority_fill_gap_proxy_bps=randomized_priority_fill_gap_proxy_bps,
        queue_allocation_rule_sensitivity_penalty_bps=queue_allocation_rule_sensitivity_penalty_bps,
        fill_before_move_trial_count=fill_before_move_stats.trial_count,
        observed_opportunity_midprice_move_count=fill_before_move_stats.observed_move_count,
        opportunity_midprice_move_before_fill_share=opportunity_midprice_move_before_fill_share,
        state_dependent_fill_before_move_probability=state_dependent_fill_before_move_probability,
        state_dependent_order_flow_gap_score=state_dependent_order_flow_gap_score,
        state_dependent_fill_risk_penalty_bps=state_dependent_fill_risk_penalty_bps,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
        median_directional_order_book_imbalance=median_directional_order_book_imbalance,
        contrarian_reversal_support_score=contrarian_reversal_support_score,
        maker_fill_return_tradeoff_penalty_bps=maker_fill_return_tradeoff_penalty_bps,
        group_normalized_downside_reward_penalty_bps=group_normalized_downside_reward_penalty_bps,
        estimated_limit_fill_probability=estimated_limit_fill_probability,
        nonfill_opportunity_cost_bps=nonfill_opportunity_cost_bps,
        adverse_selection_after_touch_bps=adverse_selection_after_touch_bps,
        queue_delay_penalty_bps=queue_delay_penalty_bps,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_queue_survival_fill_stress_schema_hash(),
    )


def _executable_side_depth(payload: Mapping[str, Any], *, direction: float) -> float:
    fields = _BID_SIZE_FIELDS if direction >= 0.0 else _ASK_SIZE_FIELDS
    return _nonnegative_float(_first_payload_value(payload, fields))


def _queue_ahead_ratio(
    payload: Mapping[str, Any], *, executable_depth: float
) -> float | None:
    ratio = _float_or_none(_first_payload_value(payload, _QUEUE_RATIO_FIELDS))
    if ratio is not None:
        return min(1.0, max(0.0, ratio))
    queue_ahead = _float_or_none(_first_payload_value(payload, _QUEUE_POSITION_FIELDS))
    if queue_ahead is None:
        return None
    if executable_depth <= 0.0:
        return min(1.0, max(0.0, queue_ahead))
    return min(1.0, max(0.0, queue_ahead / executable_depth))


def _estimated_fill_probability(
    *,
    median_queue_ahead_ratio: float,
    execution_turnover_ratio: float,
    visible_depth_notional_shortfall_share: float,
    cancellation_or_reject_share: float,
    observed_queue_position_count: int,
) -> float:
    if observed_queue_position_count <= 0:
        return 0.0
    logit = (
        -1.1
        - median_queue_ahead_ratio * 2.4
        - visible_depth_notional_shortfall_share * 2.2
        - cancellation_or_reject_share * 1.4
        + min(4.0, execution_turnover_ratio) * 0.85
    )
    probability = 1.0 / (1.0 + exp(-logit))
    return min(0.98, max(0.02, probability))


def _time_priority_edge_concentration_score(
    *,
    median_queue_ahead_ratio: float,
    execution_turnover_ratio: float,
    cancellation_or_reject_share: float,
    fill_probability: float,
    observed_queue_position_count: int,
) -> float:
    """Bounded proxy for FIFO-specific early-queue ownership reliance.

    Recent queue-allocation mechanism papers show that measured execution
    quality can depend on the priority rule itself. This proxy does not
    estimate fills; it downranks replay rows whose apparent edge is highly
    concentrated in being early in a price-time queue.
    """

    if observed_queue_position_count <= 0:
        return 0.0
    front_of_queue_advantage = max(0.0, 0.50 - median_queue_ahead_ratio) * 2.0
    turnover_support = min(1.0, max(0.0, execution_turnover_ratio) / 2.0)
    cancellation_survival = max(0.0, 1.0 - cancellation_or_reject_share)
    return min(
        1.0,
        front_of_queue_advantage
        * turnover_support
        * cancellation_survival
        * max(0.0, min(1.0, fill_probability)),
    )


def _randomized_priority_fill_gap_proxy_bps(
    *,
    time_priority_edge_concentration_score: float,
    median_spread_bps: float,
    visible_depth_notional_shortfall_share: float,
) -> float:
    """Estimate ranking penalty for mechanism-specific time-priority edge.

    SSRN:6574208 reports that randomized priority reduced the fast/slow
    execution-quality gap by 35.6% in a controlled dual-engine simulation.
    Torghut uses the effect size only as a stress multiplier and never as fill,
    PnL, or promotion authority.
    """

    clob_speed_gap_decline_fraction = 0.356
    spread_floor_bps = max(1.0, median_spread_bps)
    fifo_edge_bps = time_priority_edge_concentration_score * spread_floor_bps * 2.0
    depth_uncertainty_bps = visible_depth_notional_shortfall_share * 1.5
    return min(
        25.0,
        fifo_edge_bps * clob_speed_gap_decline_fraction + depth_uncertainty_bps,
    )


def _fill_before_opportunity_move_stats(
    *,
    rows: Sequence[SignalEnvelope],
    prices: Sequence[float | None],
    event_labels: Sequence[str],
    direction: float,
    median_spread_bps: float,
) -> _FillBeforeMoveStats:
    """Measure whether fills arrive before the intended-side mid-price move.

    arXiv:2403.02572v2 models LOB fill probabilities jointly with the
    probability that prices move first. Torghut keeps this as a deterministic
    replay-ranking proxy: it does not infer actual fills without lifecycle/TCA
    evidence and does not authorize capital.
    """

    if not rows or len(rows) != len(prices) or len(rows) != len(event_labels):
        return _FillBeforeMoveStats(
            trial_count=0,
            observed_move_count=0,
            fill_before_move_share=0.0,
            opportunity_move_before_fill_share=0.0,
        )
    start_indexes = [
        index
        for index, label in enumerate(event_labels)
        if _label_has_token(label, _ADD_TOKENS)
        and not _label_has_token(label, _CANCEL_TOKENS | _REJECT_TOKENS)
    ]
    if not start_indexes and prices[0] is not None:
        start_indexes = [0]
    threshold_bps = max(0.5, median_spread_bps * 0.5)
    trial_count = 0
    fill_before_move_count = 0
    opportunity_move_before_fill_count = 0
    observed_move_count = 0
    for start_index in start_indexes:
        start_price = prices[start_index]
        if start_price is None or start_price <= 0.0:
            continue
        horizon_end = min(len(rows), start_index + 7)
        for index in range(start_index + 1, horizon_end):
            price = prices[index]
            if price is None or price <= 0.0:
                continue
            move_bps = direction * (price - start_price) / start_price * 10_000.0
            label = event_labels[index]
            if _label_has_token(label, _FILL_TOKENS):
                trial_count += 1
                fill_before_move_count += 1
                break
            if move_bps >= threshold_bps:
                trial_count += 1
                observed_move_count += 1
                opportunity_move_before_fill_count += 1
                break
    if trial_count <= 0:
        return _FillBeforeMoveStats(
            trial_count=0,
            observed_move_count=observed_move_count,
            fill_before_move_share=0.0,
            opportunity_move_before_fill_share=0.0,
        )
    return _FillBeforeMoveStats(
        trial_count=trial_count,
        observed_move_count=observed_move_count,
        fill_before_move_share=fill_before_move_count / trial_count,
        opportunity_move_before_fill_share=(
            opportunity_move_before_fill_count / trial_count
        ),
    )


def _state_dependent_fill_before_move_probability(
    *,
    estimated_limit_fill_probability: float,
    fill_before_move_trial_count: int,
    fill_before_move_success_share: float,
    queue_reactive_event_mix_l1: float,
    observed_order_book_imbalance_count: int,
) -> float:
    if fill_before_move_trial_count <= 0:
        source_coverage_penalty = (
            0.15 if observed_order_book_imbalance_count > 0 else 0.30
        )
        return max(0.0, estimated_limit_fill_probability - source_coverage_penalty)
    parity_penalty = min(0.20, queue_reactive_event_mix_l1 * 0.08)
    probability = (
        estimated_limit_fill_probability * 0.45
        + min(1.0, max(0.0, fill_before_move_success_share)) * 0.55
        - parity_penalty
    )
    return min(0.99, max(0.0, probability))


def _state_dependent_order_flow_gap_score(
    *,
    fill_before_move_trial_count: int,
    opportunity_midprice_move_before_fill_share: float,
    queue_reactive_event_mix_l1: float,
    observed_order_book_imbalance_count: int,
    cancellation_or_reject_share: float,
) -> float:
    missing_trial_penalty = 0.35 if fill_before_move_trial_count <= 0 else 0.0
    missing_state_penalty = 0.20 if observed_order_book_imbalance_count <= 0 else 0.0
    raw = (
        missing_trial_penalty
        + missing_state_penalty
        + min(1.0, max(0.0, opportunity_midprice_move_before_fill_share)) * 0.45
        + min(2.0, max(0.0, queue_reactive_event_mix_l1)) * 0.12
        + min(1.0, max(0.0, cancellation_or_reject_share)) * 0.18
    )
    return min(1.0, raw)


def _state_dependent_fill_risk_penalty_bps(
    *,
    state_dependent_fill_before_move_probability: float,
    opportunity_midprice_move_before_fill_share: float,
    state_dependent_order_flow_gap_score: float,
    nonfill_opportunity_cost_bps: float,
    median_spread_bps: float,
) -> float:
    spread_floor_bps = max(1.0, median_spread_bps)
    raw = (
        (1.0 - min(1.0, max(0.0, state_dependent_fill_before_move_probability)))
        * spread_floor_bps
        * 4.0
        + min(1.0, max(0.0, opportunity_midprice_move_before_fill_share))
        * max(spread_floor_bps, nonfill_opportunity_cost_bps)
        * 0.55
        + min(1.0, max(0.0, state_dependent_order_flow_gap_score))
        * spread_floor_bps
        * 2.5
    )
    return min(35.0, max(0.0, raw))


def _queue_reactive_event_mix_l1(
    *,
    event_kinds: Sequence[str],
    median_queue_ahead_ratio: float,
    execution_turnover_ratio: float,
    visible_depth_notional_shortfall_share: float,
) -> float:
    if not event_kinds:
        return 0.0
    observed = {
        kind: sum(1 for item in event_kinds if item == kind) / len(event_kinds)
        for kind in _QUEUE_REACTIVE_EVENT_KINDS
    }
    target_trade = min(
        0.45,
        max(
            0.08,
            0.18
            + min(4.0, execution_turnover_ratio) * 0.07
            - median_queue_ahead_ratio * 0.08,
        ),
    )
    target_cancel_or_reject = min(
        0.60,
        max(
            0.10,
            0.20
            + median_queue_ahead_ratio * 0.25
            + visible_depth_notional_shortfall_share * 0.10,
        ),
    )
    target_other = 0.08
    target_add = max(0.05, 1.0 - target_trade - target_cancel_or_reject - target_other)
    normalizer = target_add + target_trade + target_cancel_or_reject + target_other
    target = {
        "add": target_add / normalizer,
        "trade": target_trade / normalizer,
        "cancel_or_reject": target_cancel_or_reject / normalizer,
        "other": target_other / normalizer,
    }
    return min(
        2.0,
        sum(abs(observed.get(kind, 0.0) - target[kind]) for kind in target),
    )


def _order_size_distribution_wasserstein_proxy(
    *,
    volumes: Sequence[float],
    fill_sizes: Sequence[float],
    executable_depths: Sequence[float],
) -> float:
    ratios = tuple(
        min(25.0, max(volume, fill_size) / depth)
        for volume, fill_size, depth in zip(volumes, fill_sizes, executable_depths)
        if depth > 0.0 and max(volume, fill_size) > 0.0
    )
    if not ratios:
        return 0.0
    median_ratio = _median(ratios)
    p90_ratio = _quantile(ratios, 0.90)
    median_distance = abs(_log1p(median_ratio) - _log1p(0.05))
    tail_distance = abs(_log1p(p90_ratio) - _log1p(0.25))
    return min(2.0, median_distance * 0.55 + tail_distance * 0.45)


def _nonfill_opportunity_cost_bps(
    prices: Sequence[float], *, direction: float, fill_probability: float
) -> float:
    if len(prices) < 2:
        return 0.0
    arrival = prices[0]
    terminal = prices[-1]
    if arrival <= 0.0:
        return 0.0
    favorable_move_bps = direction * (terminal - arrival) / arrival * 10_000.0
    return max(0.0, favorable_move_bps) * max(0.0, 1.0 - fill_probability)


def _adverse_selection_after_touch_bps(
    prices: Sequence[float], *, direction: float, fill_probability: float
) -> float:
    if len(prices) < 3:
        return 0.0
    touched = prices[len(prices) // 2]
    terminal = prices[-1]
    if touched <= 0.0:
        return 0.0
    adverse_move_bps = -direction * (terminal - touched) / touched * 10_000.0
    return max(0.0, adverse_move_bps) * max(0.0, fill_probability)


def _order_book_imbalance(payload: Mapping[str, Any]) -> float | None:
    explicit = _float_or_none(
        _first_payload_value(payload, _ORDER_BOOK_IMBALANCE_FIELDS)
    )
    if explicit is not None:
        return min(1.0, max(-1.0, explicit))
    bid_size = _nonnegative_float(_first_payload_value(payload, _BID_SIZE_FIELDS))
    ask_size = _nonnegative_float(_first_payload_value(payload, _ASK_SIZE_FIELDS))
    total_depth = bid_size + ask_size
    if total_depth <= 0.0:
        return None
    return min(1.0, max(-1.0, (bid_size - ask_size) / total_depth))


def _contrarian_reversal_support_score(
    *,
    prices: Sequence[float],
    direction: float,
    median_directional_order_book_imbalance: float,
    median_spread_bps: float,
) -> float:
    """Bounded support for maker quotes counter-trading a prevailing imbalance.

    arXiv:2502.18625 documents that maker fill probability can be negatively
    correlated with post-fill returns and that viable maker strategies may need
    to counter-trade the prevailing book imbalance. This proxy is only a
    replay-ranking feature: it cannot authorize fills, PnL, or promotion.
    """

    if len(prices) < 2 or prices[0] <= 0.0:
        return 0.0
    contrarian_pressure = max(0.0, -median_directional_order_book_imbalance)
    terminal_move_bps = direction * (prices[-1] - prices[0]) / prices[0] * 10_000.0
    spread_floor_bps = max(1.0, median_spread_bps)
    reversal_strength = max(0.0, terminal_move_bps) / max(4.0, spread_floor_bps * 4.0)
    return min(1.0, contrarian_pressure * min(1.0, reversal_strength))


def _maker_fill_return_tradeoff_penalty_bps(
    *,
    fill_probability: float,
    adverse_selection_after_touch_bps: float,
    median_directional_order_book_imbalance: float,
    contrarian_reversal_support_score: float,
    median_spread_bps: float,
    observed_order_book_imbalance_count: int,
) -> float:
    if observed_order_book_imbalance_count <= 0:
        return 0.0
    same_direction_pressure = max(0.0, median_directional_order_book_imbalance)
    spread_floor_bps = max(1.0, median_spread_bps)
    raw_penalty = fill_probability * (
        same_direction_pressure * spread_floor_bps * 8.0
        + adverse_selection_after_touch_bps * 0.45
    )
    contrarian_relief = 1.0 - min(0.35, contrarian_reversal_support_score * 0.35)
    return min(40.0, max(0.0, raw_penalty * contrarian_relief))


# Public aliases used by split-module consumers.
adverse_selection_after_touch_bps = _adverse_selection_after_touch_bps
contrarian_reversal_support_score = _contrarian_reversal_support_score
estimated_fill_probability = _estimated_fill_probability
executable_side_depth = _executable_side_depth
fill_before_opportunity_move_stats = _fill_before_opportunity_move_stats
maker_fill_return_tradeoff_penalty_bps = _maker_fill_return_tradeoff_penalty_bps
nonfill_opportunity_cost_bps = _nonfill_opportunity_cost_bps
order_book_imbalance = _order_book_imbalance
order_size_distribution_wasserstein_proxy = _order_size_distribution_wasserstein_proxy
queue_ahead_ratio = _queue_ahead_ratio
queue_reactive_event_mix_l1 = _queue_reactive_event_mix_l1
randomized_priority_fill_gap_proxy_bps = _randomized_priority_fill_gap_proxy_bps
state_dependent_fill_before_move_probability = (
    _state_dependent_fill_before_move_probability
)
state_dependent_fill_risk_penalty_bps = _state_dependent_fill_risk_penalty_bps
state_dependent_order_flow_gap_score = _state_dependent_order_flow_gap_score
time_priority_edge_concentration_score = _time_priority_edge_concentration_score
__all__ = (
    "extract_queue_survival_fill_stress",
    "adverse_selection_after_touch_bps",
    "contrarian_reversal_support_score",
    "estimated_fill_probability",
    "executable_side_depth",
    "fill_before_opportunity_move_stats",
    "maker_fill_return_tradeoff_penalty_bps",
    "nonfill_opportunity_cost_bps",
    "order_book_imbalance",
    "order_size_distribution_wasserstein_proxy",
    "queue_ahead_ratio",
    "queue_reactive_event_mix_l1",
    "randomized_priority_fill_gap_proxy_bps",
    "state_dependent_fill_before_move_probability",
    "state_dependent_fill_risk_penalty_bps",
    "state_dependent_order_flow_gap_score",
    "time_priority_edge_concentration_score",
)
