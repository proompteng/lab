#!/usr/bin/env python3
"""Pre-replay candidate selection for whitepaper autoresearch."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.mlx_training_data import candidate_spec_capital_features

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)
from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_spec_is_false_negative_rescue,
    _candidate_spec_mechanism_overlay_ids,
    _candidate_spec_required_evidence_tokens,
    _paper_mechanism_prior_score,
    _pre_replay_candidate_score,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _decimal,
    _list_of_mappings,
    _mapping,
    _stable_hash,
    _string,
)
from scripts.whitepaper_autoresearch_runner.proposal_building import (
    _PRE_REPLAY_FEEDBACK_BLOCK_REASONS,
    _proposal_score_confidence,
)


def _select_candidate_specs_for_replay(
    *,
    specs: Sequence[CandidateSpec],
    proposal_rows: Sequence[Mapping[str, Any]],
    top_k: int,
    exploration_slots: int,
    max_candidates: int,
    portfolio_size_min: int,
    feedback_block_reaudit_slots: int = 0,
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    if not specs:
        return [], {
            "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
            "selected_candidate_spec_ids": [],
            "rows": [],
        }
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    execution_signature_by_spec = {
        spec.candidate_spec_id: _candidate_spec_execution_signature(spec)
        for spec in specs
    }
    capital_features_by_spec = {
        spec.candidate_spec_id: dict(candidate_spec_capital_features(spec))
        for spec in specs
    }
    proposal_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    capital_block_reason = "pre_replay_capital_budget_blocked"

    def proposal_score(candidate_spec_id: str) -> Decimal:
        return _decimal(
            proposal_by_spec.get(candidate_spec_id, {}).get("proposal_score")
        )

    def proposal_training_source(candidate_spec_id: str) -> str:
        return (
            _string(proposal_by_spec.get(candidate_spec_id, {}).get("training_source"))
            or "unknown"
        )

    def proposal_feedback_context_count(candidate_spec_id: str) -> int:
        try:
            return int(
                proposal_by_spec.get(candidate_spec_id, {}).get(
                    "feedback_evidence_context_count", 0
                )
                or 0
            )
        except (TypeError, ValueError):
            return 0

    def proposal_selection_reason(candidate_spec_id: str) -> str:
        return _string(
            proposal_by_spec.get(candidate_spec_id, {}).get("selection_reason")
        )

    def proposal_feature(candidate_spec_id: str, key: str) -> Decimal:
        features = _mapping(proposal_by_spec.get(candidate_spec_id, {}).get("features"))
        return _decimal(features.get(key))

    def proposal_has_feature(candidate_spec_id: str, key: str) -> bool:
        features = _mapping(proposal_by_spec.get(candidate_spec_id, {}).get("features"))
        return key in features

    def capital_blocked(spec: CandidateSpec) -> bool:
        features = capital_features_by_spec.get(spec.candidate_spec_id, {})
        oracle_policy = _mapping(
            spec.promotion_contract.get("profit_target_oracle_policy")
        )
        max_gross_exposure = _decimal(
            oracle_policy.get("max_gross_exposure_pct_equity"), default="1.0"
        )
        return (
            _decimal(features.get("capital_feasible_flag")) < Decimal("1")
            or _decimal(features.get("capital_budget_overage_ratio")) > Decimal("0")
            or _decimal(features.get("estimated_max_gross_exposure_pct_equity"))
            > max_gross_exposure
        )

    def pre_replay_block_reason(spec: CandidateSpec) -> str:
        proposal = proposal_by_spec.get(spec.candidate_spec_id, {})
        selection_reason = _string(proposal.get("selection_reason"))
        if selection_reason in _PRE_REPLAY_FEEDBACK_BLOCK_REASONS:
            if (
                selection_reason == "pre_replay_mlx_family_feedback_blocked"
                and _candidate_spec_is_false_negative_rescue(spec)
            ):
                return ""
            return selection_reason
        if capital_blocked(spec):
            return capital_block_reason
        score = proposal_score(spec.candidate_spec_id)
        if proposal.get("proposal_score") is not None and score <= Decimal("-999999"):
            return "pre_replay_mlx_feedback_blocked"
        if (
            proposal_training_source(spec.candidate_spec_id) == "synthetic_prior"
            and proposal_feedback_context_count(spec.candidate_spec_id) > 0
            and proposal.get("proposal_score") is not None
            and score <= Decimal("0")
        ):
            if proposal_has_feature(
                spec.candidate_spec_id,
                "configured_daily_notional_required_ratio",
            ) and proposal_feature(
                spec.candidate_spec_id,
                "configured_daily_notional_required_ratio",
            ) < Decimal("1"):
                return "pre_replay_synthetic_capacity_insufficient"
            return "pre_replay_mlx_synthetic_nonpositive_expected_value"
        return ""

    def is_feedback_block_reason(reason: str) -> bool:
        return (
            reason in _PRE_REPLAY_FEEDBACK_BLOCK_REASONS
            or reason == "pre_replay_mlx_feedback_blocked"
        )

    def capital_sort_key(candidate_spec_id: str) -> tuple[int, Decimal, str]:
        features = capital_features_by_spec.get(candidate_spec_id, {})
        feasible = Decimal(str(features.get("capital_feasible_flag", 0)))
        overage = Decimal(str(features.get("capital_budget_overage_ratio", 0)))
        return (0 if feasible >= Decimal("1") else 1, overage, candidate_spec_id)

    max_budget = max(1, int(max_candidates))
    model_confidence = _proposal_score_confidence(proposal_rows)
    requested_exploration_slots = max(0, int(exploration_slots))
    effective_exploration_slots = requested_exploration_slots + (
        1 if model_confidence["confidence"] == "low" else 0
    )
    requested_budget = max(0, int(top_k)) + effective_exploration_slots
    diversification_floor = min(len(specs), 3)
    replay_budget = min(
        max_budget,
        max(1, int(portfolio_size_min), requested_budget, diversification_floor),
    )
    ranked_ids = [
        str(row.get("candidate_spec_id"))
        for row in sorted(
            _list_of_mappings(list(proposal_rows)),
            key=lambda row: (
                *capital_sort_key(str(row.get("candidate_spec_id") or ""))[:2],
                int(row.get("rank") or 10**9),
                -float(row.get("proposal_score") or 0.0),
                str(row.get("candidate_spec_id") or ""),
            ),
        )
        if str(row.get("candidate_spec_id")) in spec_by_id
    ]
    ranked_ids.extend(
        spec.candidate_spec_id
        for spec in sorted(
            specs,
            key=lambda item: (*capital_sort_key(item.candidate_spec_id),),
        )
        if spec.candidate_spec_id not in set(ranked_ids)
    )
    ordered = [spec_by_id[candidate_spec_id] for candidate_spec_id in ranked_ids]
    representative_by_signature: dict[str, CandidateSpec] = {}
    ordered_unique: list[CandidateSpec] = []
    for spec in ordered:
        execution_signature = execution_signature_by_spec[spec.candidate_spec_id]
        if execution_signature in representative_by_signature:
            continue
        representative_by_signature[execution_signature] = spec
        ordered_unique.append(spec)
    block_reason_by_spec = {
        spec.candidate_spec_id: reason
        for spec in ordered_unique
        if (reason := pre_replay_block_reason(spec))
    }
    ordered_eligible = [
        spec
        for spec in ordered_unique
        if spec.candidate_spec_id not in block_reason_by_spec
    ]
    synthetic_prior_probe_candidates = [
        spec
        for spec in ordered_unique
        if block_reason_by_spec.get(spec.candidate_spec_id)
        == "pre_replay_mlx_synthetic_nonpositive_expected_value"
    ]
    feedback_block_reaudit_candidates = [
        spec
        for spec in ordered_unique
        if is_feedback_block_reason(
            block_reason_by_spec.get(spec.candidate_spec_id, "")
        )
        and block_reason_by_spec.get(spec.candidate_spec_id)
        != "pre_replay_mlx_no_activity_feedback_blocked"
    ]
    rank_position_by_spec = {
        spec.candidate_spec_id: index for index, spec in enumerate(ordered, start=1)
    }
    synthetic_prior_probe_capacity = min(
        requested_exploration_slots,
        len(synthetic_prior_probe_candidates),
    )
    requested_feedback_block_reaudit_slots = max(0, int(feedback_block_reaudit_slots))
    feedback_block_reaudit_capacity = min(
        requested_feedback_block_reaudit_slots,
        len(feedback_block_reaudit_candidates),
    )
    replay_budget = min(
        replay_budget,
        len(ordered_eligible)
        + synthetic_prior_probe_capacity
        + feedback_block_reaudit_capacity,
    )

    def spec_source_run_id(spec: CandidateSpec) -> str:
        return _string(spec.feature_contract.get("source_run_id")) or spec.hypothesis_id

    def spec_universe_key(spec: CandidateSpec) -> str:
        universe = spec.strategy_overrides.get("universe_symbols")
        if not isinstance(universe, Sequence) or isinstance(universe, str):
            return ""
        return ",".join(
            sorted(_string(item).upper() for item in universe if _string(item))
        )

    def spec_signal_key(spec: CandidateSpec) -> str:
        params = _mapping(spec.strategy_overrides.get("params"))
        return "|".join(
            part
            for part in (
                _string(params.get("signal_motif")),
                _string(params.get("selection_mode")),
                _string(params.get("rank_feature")),
            )
            if part
        )

    def spec_param_text(spec: CandidateSpec, key: str) -> str:
        params = _mapping(spec.strategy_overrides.get("params"))
        return _string(params.get(key))

    def diversity_key(
        spec: CandidateSpec, selected_so_far: Sequence[CandidateSpec]
    ) -> tuple[bool, bool, bool, bool, bool, int, int, str]:
        selected_families = {item.family_template_id for item in selected_so_far}
        selected_runtime_strategies = {
            item.runtime_strategy_name for item in selected_so_far
        }
        selected_universes = {spec_universe_key(item) for item in selected_so_far}
        selected_signals = {spec_signal_key(item) for item in selected_so_far}
        selected_sources = {spec_source_run_id(item) for item in selected_so_far}
        family_selection = _mapping(spec.feature_contract.get("family_selection"))
        return (
            spec.family_template_id in selected_families,
            spec.runtime_strategy_name in selected_runtime_strategies,
            bool(spec_universe_key(spec))
            and spec_universe_key(spec) in selected_universes,
            bool(spec_signal_key(spec)) and spec_signal_key(spec) in selected_signals,
            spec_source_run_id(spec) in selected_sources,
            rank_position_by_spec.get(spec.candidate_spec_id, 10**6),
            int(family_selection.get("rank") or 10**6),
            spec.candidate_spec_id,
        )

    def take_diverse(
        candidates: Sequence[CandidateSpec],
        *,
        count: int,
        selected_so_far: Sequence[CandidateSpec],
    ) -> list[CandidateSpec]:
        pool = list(candidates)
        picked: list[CandidateSpec] = []
        while pool and len(picked) < count:
            best = min(
                pool,
                key=lambda spec: diversity_key(spec, [*selected_so_far, *picked]),
            )
            picked.append(best)
            pool.remove(best)
        return picked

    def interleave_replay_segments(
        *segments: Sequence[CandidateSpec],
    ) -> list[CandidateSpec]:
        interleaved: list[CandidateSpec] = []
        max_length = max((len(segment) for segment in segments), default=0)
        for index in range(max_length):
            for segment in segments:
                if index < len(segment):
                    interleaved.append(segment[index])
        return interleaved

    active_loss_counter_candidates = [
        spec
        for spec in ordered_eligible
        if proposal_selection_reason(spec.candidate_spec_id)
        == "pre_replay_mlx_active_loss_counter_candidate"
    ]
    active_loss_counter_cap = 4
    if replay_budget <= 4:
        active_loss_counter_cap = max(1, replay_budget // 2)
    active_loss_counter_count = min(
        active_loss_counter_cap,
        max(0, requested_exploration_slots),
        replay_budget,
        len(active_loss_counter_candidates),
    )
    active_loss_counter = take_diverse(
        active_loss_counter_candidates,
        count=active_loss_counter_count,
        selected_so_far=(),
    )
    active_loss_counter_ids = {spec.candidate_spec_id for spec in active_loss_counter}
    consistency_repair_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in active_loss_counter_ids
        if proposal_selection_reason(spec.candidate_spec_id)
        == "pre_replay_mlx_consistency_repair_candidate"
    ]
    consistency_repair_cap = 4
    if replay_budget <= 4:
        consistency_repair_cap = max(1, replay_budget // 2)
    consistency_repair_count = min(
        consistency_repair_cap,
        max(0, requested_exploration_slots - len(active_loss_counter)),
        replay_budget - len(active_loss_counter),
        len(consistency_repair_candidates),
    )
    consistency_repair = take_diverse(
        consistency_repair_candidates,
        count=consistency_repair_count,
        selected_so_far=active_loss_counter,
    )
    consistency_repair_ids = {spec.candidate_spec_id for spec in consistency_repair}

    runtime_strategy_floor_priority = {
        "intraday-tsmom-profit-v3": 0,
        "late-day-continuation-long-v1": 1,
        "microbar-cross-sectional-pairs-v1": 2,
        "breakout-continuation-long-v1": 3,
    }
    runtime_strategy_representatives: dict[str, CandidateSpec] = {}
    for spec in sorted(
        ordered_eligible,
        key=lambda item: (
            runtime_strategy_floor_priority.get(item.runtime_strategy_name, 100),
            rank_position_by_spec.get(item.candidate_spec_id, 10**6),
            item.candidate_spec_id,
        ),
    ):
        if spec.candidate_spec_id in active_loss_counter_ids | consistency_repair_ids:
            continue
        if spec.runtime_strategy_name not in runtime_strategy_representatives:
            runtime_strategy_representatives[spec.runtime_strategy_name] = spec
    runtime_strategy_floor = (
        list(runtime_strategy_representatives.values())[
            : min(4, replay_budget - len(active_loss_counter) - len(consistency_repair))
        ]
        if len(runtime_strategy_representatives) > 1
        and replay_budget > len(active_loss_counter) + len(consistency_repair)
        else []
    )
    runtime_strategy_floor_ids = {
        spec.candidate_spec_id for spec in runtime_strategy_floor
    }
    paper_contract_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in active_loss_counter_ids
        if spec.candidate_spec_id not in consistency_repair_ids
        if spec.candidate_spec_id not in runtime_strategy_floor_ids
        if _paper_mechanism_prior_score(spec) > Decimal("0")
    ]
    paper_contract_count = min(
        3,
        max(
            0,
            requested_exploration_slots
            - len(active_loss_counter)
            - len(consistency_repair),
        ),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor),
        len(paper_contract_candidates),
    )
    paper_contract_exploration = take_diverse(
        paper_contract_candidates,
        count=paper_contract_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
        ],
    )
    paper_contract_exploration_ids = {
        spec.candidate_spec_id for spec in paper_contract_exploration
    }
    false_negative_rescue_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id not in runtime_strategy_floor_ids
        if spec.candidate_spec_id not in active_loss_counter_ids
        if spec.candidate_spec_id not in consistency_repair_ids
        if spec.candidate_spec_id not in paper_contract_exploration_ids
        if _candidate_spec_is_false_negative_rescue(spec)
    ]
    false_negative_rescue_count = min(
        3,
        max(0, requested_exploration_slots - len(consistency_repair)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration),
        len(false_negative_rescue_candidates),
    )
    false_negative_rescue_exploration = take_diverse(
        false_negative_rescue_candidates,
        count=false_negative_rescue_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
            *paper_contract_exploration,
        ],
    )
    false_negative_rescue_ids = {
        spec.candidate_spec_id for spec in false_negative_rescue_exploration
    }
    exploitation_candidates = [
        spec
        for spec in ordered_eligible
        if spec.candidate_spec_id
        not in active_loss_counter_ids
        | consistency_repair_ids
        | runtime_strategy_floor_ids
        | paper_contract_exploration_ids
        | false_negative_rescue_ids
    ]
    exploitation_count = min(
        max(0, int(top_k)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration),
        len(exploitation_candidates),
    )
    exploitation = take_diverse(
        exploitation_candidates,
        count=exploitation_count,
        selected_so_far=[
            *active_loss_counter,
            *consistency_repair,
            *runtime_strategy_floor,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
        ],
    )
    remaining = [
        item
        for item in sorted(
            ordered_eligible,
            key=lambda spec: diversity_key(
                spec,
                [
                    *active_loss_counter,
                    *consistency_repair,
                    *runtime_strategy_floor,
                    *paper_contract_exploration,
                    *false_negative_rescue_exploration,
                    *exploitation,
                ],
            ),
        )
        if item.candidate_spec_id
        not in {
            spec.candidate_spec_id
            for spec in (
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
            )
        }
    ]
    exploration_count = min(
        effective_exploration_slots,
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation),
        len(remaining),
    )
    exploration = take_diverse(
        remaining,
        count=exploration_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
        ],
    )
    synthetic_prior_probe_exploration_count = min(
        max(0, requested_exploration_slots - len(exploration)),
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation)
        - len(exploration),
        len(synthetic_prior_probe_candidates),
    )
    synthetic_prior_probe_exploration = take_diverse(
        synthetic_prior_probe_candidates,
        count=synthetic_prior_probe_exploration_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
            *exploration,
        ],
    )
    feedback_block_reaudit_count = min(
        requested_feedback_block_reaudit_slots,
        replay_budget
        - len(active_loss_counter)
        - len(consistency_repair)
        - len(runtime_strategy_floor)
        - len(paper_contract_exploration)
        - len(false_negative_rescue_exploration)
        - len(exploitation)
        - len(exploration)
        - len(synthetic_prior_probe_exploration),
        len(feedback_block_reaudit_candidates),
    )
    feedback_block_reaudit = take_diverse(
        feedback_block_reaudit_candidates,
        count=feedback_block_reaudit_count,
        selected_so_far=[
            *runtime_strategy_floor,
            *active_loss_counter,
            *consistency_repair,
            *paper_contract_exploration,
            *false_negative_rescue_exploration,
            *exploitation,
            *exploration,
            *synthetic_prior_probe_exploration,
        ],
    )
    if (
        len(runtime_strategy_floor)
        + len(active_loss_counter)
        + len(consistency_repair)
        + len(paper_contract_exploration)
        + len(false_negative_rescue_exploration)
        + len(exploitation)
        + len(exploration)
        < replay_budget
    ):
        selected_ids = {
            item.candidate_spec_id
            for item in (
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            )
        }
        backfill_candidates = [
            item
            for item in ordered_eligible
            if item.candidate_spec_id not in selected_ids
        ]
        backfill = take_diverse(
            backfill_candidates,
            count=replay_budget
            - len(active_loss_counter)
            - len(consistency_repair)
            - len(runtime_strategy_floor)
            - len(paper_contract_exploration)
            - len(false_negative_rescue_exploration)
            - len(exploitation)
            - len(exploration)
            - len(synthetic_prior_probe_exploration)
            - len(feedback_block_reaudit),
            selected_so_far=[
                *runtime_strategy_floor,
                *active_loss_counter,
                *consistency_repair,
                *paper_contract_exploration,
                *false_negative_rescue_exploration,
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            ],
        )
    else:
        backfill = []
    selected_reason = (
        {
            item.candidate_spec_id: "active_loss_counter_candidate"
            for item in active_loss_counter
        }
        | {
            item.candidate_spec_id: "consistency_repair_candidate"
            for item in consistency_repair
        }
        | {
            item.candidate_spec_id: "runtime_strategy_floor"
            for item in runtime_strategy_floor
        }
        | {
            item.candidate_spec_id: "paper_contract_exploration"
            for item in paper_contract_exploration
        }
        | {
            item.candidate_spec_id: "false_negative_rescue_exploration"
            for item in false_negative_rescue_exploration
        }
        | {item.candidate_spec_id: "exploitation" for item in exploitation}
        | {item.candidate_spec_id: "exploration" for item in exploration}
    )
    selected_reason.update(
        {
            item.candidate_spec_id: "synthetic_prior_exploration"
            for item in synthetic_prior_probe_exploration
        }
    )
    selected_reason.update(
        {
            item.candidate_spec_id: "feedback_block_reaudit"
            for item in feedback_block_reaudit
        }
    )
    selected_reason.update(
        {item.candidate_spec_id: "budget_backfill" for item in backfill}
    )
    selected = [
        *active_loss_counter,
        *consistency_repair,
        *runtime_strategy_floor,
        *paper_contract_exploration,
        *false_negative_rescue_exploration,
        *exploitation,
        *exploration,
        *interleave_replay_segments(
            feedback_block_reaudit,
            synthetic_prior_probe_exploration,
        ),
        *backfill,
    ]
    selected_ids = {item.candidate_spec_id for item in selected}
    selected_pre_replay_blocked_ids = {
        item.candidate_spec_id for item in synthetic_prior_probe_exploration
    } | {item.candidate_spec_id for item in feedback_block_reaudit}
    replay_order_by_spec = {
        item.candidate_spec_id: index for index, item in enumerate(selected, start=1)
    }

    def row_selection_reason(spec: CandidateSpec) -> str:
        if spec.candidate_spec_id in selected_reason:
            return selected_reason[spec.candidate_spec_id]
        representative = representative_by_signature[
            execution_signature_by_spec[spec.candidate_spec_id]
        ]
        if representative.candidate_spec_id != spec.candidate_spec_id:
            return "duplicate_execution_signature"
        block_reason = block_reason_by_spec.get(spec.candidate_spec_id)
        if block_reason:
            return block_reason
        return "not_selected_budget"

    rows = [
        {
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "capital_profile": spec_param_text(spec, "capital_profile") or None,
            "feedback_remediation_profile": spec_param_text(
                spec, "feedback_remediation_profile"
            )
            or None,
            "universe_key": spec_universe_key(spec),
            "signal_key": spec_signal_key(spec),
            "execution_signature": execution_signature_by_spec[spec.candidate_spec_id],
            "duplicate_of_candidate_spec_id": representative_by_signature[
                execution_signature_by_spec[spec.candidate_spec_id]
            ].candidate_spec_id
            if representative_by_signature[
                execution_signature_by_spec[spec.candidate_spec_id]
            ].candidate_spec_id
            != spec.candidate_spec_id
            else None,
            "pre_replay_score": str(_pre_replay_candidate_score(spec)),
            "paper_contract_prior_score": str(_paper_mechanism_prior_score(spec)),
            "paper_mechanism_overlay_ids": sorted(
                _candidate_spec_mechanism_overlay_ids(spec)
            ),
            "paper_required_evidence_tokens": sorted(
                _candidate_spec_required_evidence_tokens(spec)
            ),
            "paper_required_evidence_count": len(
                _candidate_spec_required_evidence_tokens(spec)
            ),
            "proposal_score": proposal_by_spec.get(spec.candidate_spec_id, {}).get(
                "proposal_score"
            ),
            "proposal_training_source": proposal_training_source(
                spec.candidate_spec_id
            ),
            "capital_budget": {
                "max_notional_per_trade": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_notional_per_trade"
                    ]
                ),
                "max_notional_pct_start_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_notional_pct_start_equity"
                    ]
                ),
                "max_position_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_position_pct_equity"
                    ]
                ),
                "max_trade_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "max_trade_pct_equity"
                    ]
                ),
                "estimated_max_gross_exposure_pct_equity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "estimated_max_gross_exposure_pct_equity"
                    ]
                ),
                "estimated_capital_slot_count": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "estimated_capital_slot_count"
                    ]
                ),
                "entry_notional_max_multiplier": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "entry_notional_max_multiplier"
                    ]
                ),
                "configured_daily_notional_capacity": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "configured_daily_notional_capacity"
                    ]
                ),
                "capital_budget_overage_ratio": str(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "capital_budget_overage_ratio"
                    ]
                ),
                "capital_feasible": bool(
                    capital_features_by_spec[spec.candidate_spec_id][
                        "capital_feasible_flag"
                    ]
                ),
            },
            "rank": index,
            "selected_for_replay": spec.candidate_spec_id in selected_ids,
            "selection_reason": row_selection_reason(spec),
            "replay_order": replay_order_by_spec.get(spec.candidate_spec_id),
            "selection_hash": _stable_hash(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "score": str(_pre_replay_candidate_score(spec)),
                    "selected": spec.candidate_spec_id in selected_ids,
                    "replay_order": replay_order_by_spec.get(spec.candidate_spec_id),
                }
            ),
        }
        for index, spec in enumerate(ordered, start=1)
    ]
    return selected, {
        "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
        "budget": {
            "max_candidates": max_budget,
            "top_k": max(0, int(top_k)),
            "exploration_slots_requested": requested_exploration_slots,
            "exploration_slots_effective": effective_exploration_slots,
            "exploration_slots": effective_exploration_slots,
            "feedback_block_reaudit_slots_requested": requested_feedback_block_reaudit_slots,
            "feedback_block_reaudit_slots_effective": feedback_block_reaudit_capacity,
            "feedback_block_reaudit_selected_count": len(feedback_block_reaudit),
            "active_loss_counter_candidate_selected_count": len(active_loss_counter),
            "consistency_repair_candidate_selected_count": len(consistency_repair),
            "runtime_strategy_floor_selected_count": len(runtime_strategy_floor),
            "paper_contract_candidate_selected_count": len(paper_contract_exploration),
            "portfolio_size_min": max(1, int(portfolio_size_min)),
            "selected_count": len(selected),
            "compiled_candidate_count": len(specs),
            "unique_execution_signature_count": len(ordered_unique),
            "eligible_candidate_count": len(ordered_eligible),
            "pre_replay_feedback_blocked_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if is_feedback_block_reason(reason)
            ),
            "pre_replay_nonpositive_synthetic_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == "pre_replay_mlx_synthetic_nonpositive_expected_value"
            ),
            "pre_replay_synthetic_capacity_insufficient_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == "pre_replay_synthetic_capacity_insufficient"
            ),
            "pre_replay_nonpositive_synthetic_exploration_count": len(
                synthetic_prior_probe_exploration
            ),
            "pre_replay_capital_blocked_candidate_count": sum(
                1
                for reason in block_reason_by_spec.values()
                if reason == capital_block_reason
            ),
            "pre_replay_blocked_candidate_count": sum(
                1
                for candidate_spec_id in block_reason_by_spec
                if candidate_spec_id not in selected_pre_replay_blocked_ids
            ),
            "replay_order_policy": "quality_gated_diversity_pick_order_with_consistency_repair_paper_contract_probe_synthetic_prior_probe_and_feedback_reaudit",
            "capital_feasible_candidate_count": sum(
                1
                for features in capital_features_by_spec.values()
                if Decimal(str(features.get("capital_feasible_flag", 0)))
                >= Decimal("1")
            ),
        },
        "proposal_score_confidence": model_confidence,
        "selected_candidate_spec_ids": [item.candidate_spec_id for item in selected],
        "rows": rows,
    }
