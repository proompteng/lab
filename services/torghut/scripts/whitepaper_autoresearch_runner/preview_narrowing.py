#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.fast_replay import (
    build_fast_replay_preview,
)
from app.trading.discovery.mlx_training_data import (
    candidate_spec_capital_features,
)
from app.trading.discovery.replay_tape import (
    load_replay_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _stable_hash,
    _mapping,
    _string,
    _list_of_mappings,
)

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _candidate_universe_symbols_from_args,
    _write_json,
    _write_jsonl,
)

from scripts.whitepaper_autoresearch_runner.candidate_goal_metadata import (
    _selected_candidate_spec_ids,
)

from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_spec_mechanism_overlay_ids,
    _candidate_spec_required_evidence_tokens,
    _paper_mechanism_prior_score,
    _pre_replay_candidate_score,
)

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)
from scripts.whitepaper_autoresearch_runner.proposal_building import (
    _proposal_score_confidence,
)

from scripts.whitepaper_autoresearch_runner.queue_metadata import (
    _bounded_sim_target_queue_metadata,
    _fast_replay_preview_date_arg,
    _fast_replay_preview_proof_semantics,
    _materialized_replay_tape_cost_model_hash,
    _materialized_replay_tape_feature_schema_hash,
    _materialized_replay_tape_source_query_digest,
    _materialized_replay_tape_strategy_family,
)

_DEFAULT_FAST_REPLAY_PREVIEW_TOP_K = 48

_DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP = 6

_DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS = 4

_DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS = 2


def _candidate_selection_for_direct_replay(
    *,
    specs: Sequence[CandidateSpec],
    proposal_rows: Sequence[Mapping[str, Any]],
    candidate_specs_paths: Sequence[Path],
) -> dict[str, Any]:
    proposal_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for index, spec in enumerate(specs, start=1):
        params = _mapping(spec.strategy_overrides.get("params"))
        universe = spec.strategy_overrides.get("universe_symbols")
        universe_key = (
            ",".join(
                sorted(_string(item).upper() for item in universe if _string(item))
            )
            if isinstance(universe, Sequence) and not isinstance(universe, str)
            else ""
        )
        proposal = _mapping(proposal_by_spec.get(spec.candidate_spec_id))
        rows.append(
            {
                "candidate_spec_id": spec.candidate_spec_id,
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "capital_profile": _string(params.get("capital_profile")) or None,
                "feedback_remediation_profile": _string(
                    params.get("feedback_remediation_profile")
                )
                or None,
                "universe_key": universe_key,
                "signal_key": "|".join(
                    part
                    for part in (
                        _string(params.get("signal_motif")),
                        _string(params.get("selection_mode")),
                        _string(params.get("rank_feature")),
                    )
                    if part
                ),
                "execution_signature": _candidate_spec_execution_signature(spec),
                "duplicate_of_candidate_spec_id": None,
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
                "proposal_score": proposal.get("proposal_score"),
                "proposal_training_source": proposal.get("training_source")
                or "direct_candidate_specs_handoff",
                "rank": index,
                "selected_for_replay": True,
                "selection_reason": "direct_candidate_specs_handoff",
                "replay_order": index,
                "selection_hash": _stable_hash(
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "source_paths": [str(path) for path in candidate_specs_paths],
                        "replay_order": index,
                    }
                ),
            }
        )
    return {
        "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
        "selection_mode": "direct_candidate_specs_handoff",
        "candidate_specs_artifacts": [str(path) for path in candidate_specs_paths],
        "budget": {
            "max_candidates": len(specs),
            "top_k": len(specs),
            "exploration_slots_requested": 0,
            "exploration_slots_effective": 0,
            "exploration_slots": 0,
            "feedback_block_reaudit_slots_requested": 0,
            "feedback_block_reaudit_slots_effective": 0,
            "feedback_block_reaudit_selected_count": 0,
            "portfolio_size_min": 1,
            "selected_count": len(specs),
            "compiled_candidate_count": len(specs),
            "unique_execution_signature_count": len(
                {_candidate_spec_execution_signature(spec) for spec in specs}
            ),
            "eligible_candidate_count": len(specs),
            "replay_order_policy": "preserve_candidate_specs_jsonl_order",
            "capital_feasible_candidate_count": sum(
                1
                for spec in specs
                if Decimal(
                    str(
                        candidate_spec_capital_features(spec).get(
                            "capital_feasible_flag", 0
                        )
                    )
                )
                >= Decimal("1")
            ),
        },
        "proposal_score_confidence": _proposal_score_confidence(proposal_rows),
        "selected_candidate_spec_ids": [spec.candidate_spec_id for spec in specs],
        "rows": rows,
    }


def _apply_fast_replay_preview_narrowing(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    preview_top_k = _resolved_fast_replay_preview_top_k(args)
    if preview_top_k <= 0:
        return list(specs), dict(candidate_selection)
    if str(getattr(args, "replay_mode", "") or "") != "real":
        raise ValueError("fast_replay_preview_requires_real_replay")
    tape_path = getattr(args, "replay_tape_path", None)
    if tape_path is None:
        raise ValueError("fast_replay_preview_requires_replay_tape_path")
    exact_replay_candidate_cap = _resolved_fast_replay_exact_candidate_cap(
        args,
        preview_top_k=preview_top_k,
    )
    exploitation_slots = max(
        0,
        int(
            getattr(
                args,
                "replay_tape_frontier_exploitation_slots",
                _DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS,
            )
            or 0
        ),
    )
    exploration_slots = max(
        0,
        int(
            getattr(
                args,
                "replay_tape_frontier_exploration_slots",
                _DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS,
            )
            or 0
        ),
    )

    start_date = _fast_replay_preview_date_arg(args, "full_window_start_date")
    end_date = _fast_replay_preview_date_arg(args, "full_window_end_date")
    requested_symbols = _candidate_universe_symbols_from_args(args)
    tape = load_replay_tape(
        Path(tape_path).resolve(),
        manifest_path=(
            Path(args.replay_tape_manifest).resolve()
            if getattr(args, "replay_tape_manifest", None) is not None
            else None
        ),
    )
    validation = validate_tape_freshness(
        tape.manifest,
        start_date=start_date,
        end_date=end_date,
        symbols=requested_symbols,
        allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
        require_exact_cache_identity=True,
        expected_dataset_snapshot_ref=(
            str(getattr(args, "replay_tape_dataset_snapshot_ref", "") or "").strip()
            or None
        ),
        expected_source_query_digest=_materialized_replay_tape_source_query_digest(
            args=args,
            symbols=requested_symbols,
            start_date=start_date,
            end_date=end_date,
        ),
        expected_feature_schema_hash=_materialized_replay_tape_feature_schema_hash(
            args
        ),
        expected_cost_model_hash=_materialized_replay_tape_cost_model_hash(args),
        expected_strategy_family=_materialized_replay_tape_strategy_family(args),
    )
    selected_rows = slice_tape_by_symbols(
        slice_tape_by_window(
            tape.rows,
            start_date=start_date,
            end_date=end_date,
        ),
        symbols=requested_symbols,
    )
    preview = build_fast_replay_preview(
        specs=specs,
        rows=selected_rows,
        replay_tape_manifest=tape.manifest,
        top_k=preview_top_k,
        min_rows_per_candidate=max(
            1, int(getattr(args, "replay_tape_preview_min_rows", 2) or 2)
        ),
        exploitation_count=exploitation_slots,
        exploration_count=exploration_slots,
        exact_replay_candidate_cap=exact_replay_candidate_cap,
    )
    preview_scores_path = output_dir / "replay-tape-preview-scores.jsonl"
    preview_manifest_path = output_dir / "replay-tape-preview-manifest.json"
    _write_jsonl(preview_scores_path, [row.to_payload() for row in preview.rows])
    preview_manifest = {
        **preview.to_manifest_payload(),
        "validation": validation,
        "proof_semantics": _fast_replay_preview_proof_semantics(),
        "artifacts": {
            "scores_jsonl": str(preview_scores_path),
            "manifest_json": str(preview_manifest_path),
        },
    }
    _write_json(preview_manifest_path, preview_manifest)

    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    narrowed_specs = [
        spec_by_id[candidate_spec_id]
        for candidate_spec_id in preview.selected_candidate_spec_ids
        if candidate_spec_id in spec_by_id
    ]
    if not narrowed_specs and specs and not preview.rows:
        narrowed_specs = [specs[0]]

    selected_ids = {spec.candidate_spec_id for spec in narrowed_specs}
    replay_order_by_spec = {
        spec.candidate_spec_id: index
        for index, spec in enumerate(narrowed_specs, start=1)
    }
    preview_row_by_spec = {
        row.candidate_spec_id: row.to_payload() for row in preview.rows
    }
    original_selected_ids = _selected_candidate_spec_ids(candidate_selection)
    updated_rows: list[dict[str, Any]] = []
    for row in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(row.get("candidate_spec_id"))
        updated = dict(row)
        preview_row = preview_row_by_spec.get(candidate_spec_id)
        if preview_row is not None:
            updated["fast_replay_preview_rank"] = preview_row["rank"]
            updated["fast_replay_preview_score"] = preview_row["preview_score"]
            updated["fast_replay_preview_rank_score"] = preview_row.get(
                "preview_rank_score", preview_row["preview_score"]
            )
            updated["fast_replay_robust_lower_percentile_post_cost_utility_bps"] = (
                preview_row.get("robust_lower_percentile_post_cost_utility_bps")
            )
            updated["fast_replay_bootstrap_lower_percentile_post_cost_utility_bps"] = (
                preview_row.get("bootstrap_lower_percentile_post_cost_utility_bps")
            )
            updated["fast_replay_ranking_only_reasons"] = list(
                cast(Sequence[Any], preview_row.get("ranking_only_reasons") or ())
            )
            updated["fast_replay_risk_veto_reasons"] = list(
                cast(Sequence[Any], preview_row.get("risk_veto_reasons") or ())
            )
            updated["fast_replay_exact_replay_required"] = True
            updated["fast_replay_runtime_ledger_required"] = True
            updated["fast_replay_preview_selected"] = preview_row["selected"]
            updated["fast_replay_preview_selection_reason"] = preview_row[
                "selection_reason"
            ]
            updated["fast_replay_preview_matched_row_count"] = preview_row[
                "matched_row_count"
            ]
            updated["fast_replay_preview_ofi_pressure_score"] = preview_row[
                "ofi_pressure_score"
            ]
            updated["fast_replay_preview_microprice_bias_bps"] = preview_row[
                "microprice_bias_bps"
            ]
            updated["fast_replay_preview_spread_tail_bps"] = preview_row[
                "spread_tail_bps"
            ]
            updated["fast_replay_preview_return_tail_abs_bps"] = preview_row[
                "return_tail_abs_bps"
            ]
            updated["fast_replay_preview_impact_liquidity_penalty_bps"] = preview_row[
                "impact_liquidity_penalty_bps"
            ]
            updated["fast_replay_preview_observed_post_cost_expectancy_bps"] = (
                preview_row.get("observed_post_cost_expectancy_bps")
            )
            updated["fast_replay_preview_required_daily_notional"] = preview_row.get(
                "required_daily_notional"
            )
            updated["fast_replay_target_implied_notional_context"] = preview_row.get(
                "target_implied_notional_context"
            )
            updated["fast_replay_exact_replay_selection_blocked"] = preview_row.get(
                "exact_replay_selection_blocked"
            )
            updated["fast_replay_exact_replay_selection_blockers"] = list(
                cast(
                    Sequence[Any],
                    preview_row.get("exact_replay_selection_blockers") or (),
                )
            )
            updated["fast_replay_cost_impact_lineage"] = preview_row.get(
                "cost_impact_lineage"
            )
            updated["fast_replay_adv_capacity_context"] = preview_row.get(
                "adv_capacity_context"
            )
            updated["fast_replay_lineage_blockers"] = list(
                cast(Sequence[Any], preview_row.get("lineage_blockers") or ())
            )
            updated["fast_replay_risk_flags"] = list(
                cast(Sequence[Any], preview_row.get("risk_flags") or ())
            )
            updated["fast_replay_frontier_bucket"] = preview_row["frontier_bucket"]
            updated["fast_replay_discovery_stage_metadata"] = preview_row.get(
                "discovery_stage_metadata"
            )
            updated["fast_replay_candidate_frontier_hash"] = preview_row.get(
                "candidate_frontier_hash"
            )
            updated["fast_replay_exact_replay_frontier_key"] = preview_row.get(
                "exact_replay_frontier_key"
            )
            updated["fast_replay_frontier_dedupe_status"] = preview_row.get(
                "frontier_dedupe_status"
            )
            updated["fast_replay_frontier_dedupe_metadata"] = preview_row.get(
                "frontier_dedupe_metadata"
            )
            adaptive_signal_falsification_stress = _mapping(
                preview_row.get("adaptive_signal_falsification_stress")
            )
            if adaptive_signal_falsification_stress:
                updated["fast_replay_adaptive_signal_falsification_stress"] = (
                    adaptive_signal_falsification_stress
                )
                updated[
                    "fast_replay_adaptive_signal_falsification_objective_scorecard_patch"
                ] = _mapping(
                    adaptive_signal_falsification_stress.get(
                        "objective_scorecard_patch"
                    )
                )
                updated["fast_replay_adaptive_signal_falsification_required"] = True
                updated["fast_replay_adaptive_signal_falsification_passed"] = bool(
                    adaptive_signal_falsification_stress.get(
                        "adaptive_signal_falsification_passed"
                    )
                )
                updated["fast_replay_adaptive_signal_falsification_artifact_ref"] = (
                    adaptive_signal_falsification_stress.get("artifact_ref")
                )
                updated["fast_replay_adaptive_signal_falsification_source_markers"] = (
                    list(
                        cast(
                            Sequence[Any],
                            adaptive_signal_falsification_stress.get("source_markers")
                            or (),
                        )
                    )
                )
                updated["fast_replay_adaptive_signal_falsification_warnings"] = list(
                    cast(
                        Sequence[Any],
                        adaptive_signal_falsification_stress.get("warnings") or (),
                    )
                )
            updated["fast_replay_proof_semantics_label"] = preview_row[
                "proof_semantics_label"
            ]
            updated["fast_replay_prefilter_only"] = True
            updated["fast_replay_promotion_proof"] = False
            updated["fast_replay_proof_authority"] = False
            updated["fast_replay_promotion_authority"] = False
            updated["fast_replay_promotion_allowed"] = False
            updated["fast_replay_final_promotion_allowed"] = False
            updated["fast_replay_final_authority_ok"] = False
            microstructure_prefilter = _mapping(
                preview_row.get("hpairs_microstructure_prefilter")
                or preview_row.get("microstructure_prefilter")
            )
            if microstructure_prefilter:
                updated["hpairs_microstructure_prefilter_rank"] = (
                    microstructure_prefilter.get("rank")
                )
                updated["hpairs_microstructure_prefilter_score"] = (
                    microstructure_prefilter.get("prefilter_score")
                )
                updated["hpairs_microstructure_behavior_bucket"] = _mapping(
                    microstructure_prefilter.get("cluster_behavior")
                ).get("behavior_bucket")
                updated["hpairs_microstructure_macro_window_stress"] = _mapping(
                    microstructure_prefilter.get("macro_window_stress")
                )
                updated["hpairs_microstructure_impact_capacity_lineage"] = _mapping(
                    microstructure_prefilter.get("impact_capacity_lineage")
                )
                updated["hpairs_microstructure_source_input_blockers"] = list(
                    cast(
                        Sequence[Any],
                        microstructure_prefilter.get("source_input_blockers") or (),
                    )
                )
                updated["hpairs_microstructure_proof_source"] = (
                    microstructure_prefilter.get("proof_source")
                )
        if candidate_spec_id in original_selected_ids:
            updated["pre_fast_replay_preview_selected_for_replay"] = bool(
                row.get("selected_for_replay")
            )
            updated["selected_for_replay"] = candidate_spec_id in selected_ids
            updated["replay_order"] = replay_order_by_spec.get(candidate_spec_id)
            if candidate_spec_id not in selected_ids:
                updated["selection_reason"] = "fast_replay_preview_filtered"
        updated_rows.append(updated)

    updated_selection = {
        **dict(candidate_selection),
        "budget": {
            **_mapping(candidate_selection.get("budget")),
            "fast_replay_preview_enabled": True,
            "fast_replay_preview_requested_top_k": preview_top_k,
            "fast_replay_exact_replay_candidate_cap": exact_replay_candidate_cap,
            "fast_replay_frontier_exploitation_slots": exploitation_slots,
            "fast_replay_frontier_exploration_slots": exploration_slots,
            "fast_replay_preview_selected_count": len(narrowed_specs),
            "pre_fast_replay_preview_selected_count": len(specs),
            "selected_count": len(narrowed_specs),
        },
        "selected_candidate_spec_ids": [
            spec.candidate_spec_id for spec in narrowed_specs
        ],
        "rows": updated_rows,
        "replay_tape_preview": {
            **preview_manifest,
            "scores_artifact": str(preview_scores_path),
            "manifest_artifact": str(preview_manifest_path),
        },
        "bounded_sim_target_queue": _bounded_sim_target_queue_metadata(
            preview_rows=[row.to_payload() for row in preview.rows],
            replay_tape_manifest=tape.manifest,
            exact_replay_candidate_cap=exact_replay_candidate_cap,
            exploitation_slots=exploitation_slots,
            exploration_slots=exploration_slots,
        ),
    }
    return narrowed_specs, updated_selection


def _resolved_fast_replay_preview_top_k(args: argparse.Namespace) -> int:
    explicit_top_k = max(
        0,
        int(getattr(args, "replay_tape_preview_top_k", 0) or 0),
    )
    if explicit_top_k > 0:
        return explicit_top_k
    if not bool(getattr(args, "staged_replay_frontier_default", False)):
        return 0
    if bool(getattr(args, "disable_staged_replay_frontier", False)):
        return 0
    if str(getattr(args, "replay_mode", "") or "") != "real":
        return 0
    if getattr(args, "replay_tape_path", None) is None:
        return 0
    return max(
        _DEFAULT_FAST_REPLAY_PREVIEW_TOP_K,
        int(getattr(args, "max_candidates", 0) or 0),
    )


def _resolved_fast_replay_exact_candidate_cap(
    args: argparse.Namespace,
    *,
    preview_top_k: int,
) -> int:
    requested_cap = max(
        1,
        int(
            getattr(
                args,
                "replay_tape_exact_candidate_cap",
                _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
            )
            or _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP
        ),
    )
    requested_cap = min(requested_cap, _DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP)
    return max(1, min(max(1, preview_top_k), requested_cap))


__all__ = [
    "_candidate_selection_for_direct_replay",
    "_apply_fast_replay_preview_narrowing",
    "_resolved_fast_replay_preview_top_k",
    "_resolved_fast_replay_exact_candidate_cap",
]
