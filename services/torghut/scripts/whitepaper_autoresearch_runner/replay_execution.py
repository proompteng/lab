#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import json
import multiprocessing
import queue
import signal
import time as monotonic_time
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.candidate_specs import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
)

import scripts.run_strategy_factory_v2 as strategy_factory_runner

from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_score_rows as _candidate_board_score_rows,
    _candidate_board_decimal_field as _candidate_board_decimal_field,
    _candidate_board_int_field as _candidate_board_int_field,
    _candidate_board_first_int_field as _candidate_board_first_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_paper_probation import (
    _paper_probation_candidate_payload as _paper_probation_candidate_payload,
    _candidate_board_paper_probation_candidates as _candidate_board_paper_probation_candidates,
    _candidate_board_paper_probation_candidate as _candidate_board_paper_probation_candidate,
    _candidate_board_status_digest as _candidate_board_status_digest,
    _candidate_board_double_oos_summary as _candidate_board_double_oos_summary,
    _candidate_board_portfolio_promotion_subject as _candidate_board_portfolio_promotion_subject,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_payloads import (
    _candidate_board_factor_acceptance_summary as _candidate_board_factor_acceptance_summary,
    _candidate_board_payload as _candidate_board_payload,
    _paper_probation_handoff_payload as _paper_probation_handoff_payload,
    _portfolio_with_runtime_closure_proof as _portfolio_with_runtime_closure_proof,
    _runtime_closure_program_for_candidate as _runtime_closure_program_for_candidate,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_hypothesis_manifest_ref as _candidate_board_hypothesis_manifest_ref,
    _candidate_board_runtime_window_bounds as _candidate_board_runtime_window_bounds,
    _candidate_board_date_only as _candidate_board_date_only,
    _candidate_board_regular_session_bound as _candidate_board_regular_session_bound,
    _candidate_board_runtime_window_import_bounds as _candidate_board_runtime_window_import_bounds,
    _candidate_board_exact_replay_ledger_refs as _candidate_board_exact_replay_ledger_refs,
    _candidate_board_runtime_import_args as _candidate_board_runtime_import_args,
    _candidate_board_runtime_window_import_plan as _candidate_board_runtime_window_import_plan,
    _candidate_factor_acceptance_replay_metadata as _candidate_factor_acceptance_replay_metadata,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_rejected_signal_outcome_summary as _candidate_board_rejected_signal_outcome_summary,
    _candidate_spec_requires_order_type_execution_quality as _candidate_spec_requires_order_type_execution_quality,
    _candidate_spec_requires_predictability_decay_stress as _candidate_spec_requires_predictability_decay_stress,
    _candidate_board_predictability_decay_summary as _candidate_board_predictability_decay_summary,
    _candidate_board_scorecard_with_predictability_decay_blockers as _candidate_board_scorecard_with_predictability_decay_blockers,
    _candidate_board_order_type_execution_quality_summary as _candidate_board_order_type_execution_quality_summary,
    _candidate_board_scorecard_with_order_type_blockers as _candidate_board_scorecard_with_order_type_blockers,
    _candidate_spec_requires_queue_position_survival as _candidate_spec_requires_queue_position_survival,
    _candidate_board_queue_position_survival_summary as _candidate_board_queue_position_survival_summary,
    _candidate_board_scorecard_with_queue_position_survival_blockers as _candidate_board_scorecard_with_queue_position_survival_blockers,
    _candidate_board_scorecard_with_rejected_signal_blockers as _candidate_board_scorecard_with_rejected_signal_blockers,
    _candidate_board_evidence_lineage_summary as _candidate_board_evidence_lineage_summary,
    _candidate_board_scorecard_with_lineage_blockers as _candidate_board_scorecard_with_lineage_blockers,
    _candidate_board_replay_window_coverage_summary as _candidate_board_replay_window_coverage_summary,
    _candidate_board_market_impact_proof_summary as _candidate_board_market_impact_proof_summary,
    _candidate_board_regime_specialist_summary as _candidate_board_regime_specialist_summary,
    _candidate_board_scorecard_with_replay_window_blockers as _candidate_board_scorecard_with_replay_window_blockers,
    _candidate_board_scorecard_with_evidence_blockers as _candidate_board_scorecard_with_evidence_blockers,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_status import (
    _candidate_board_blockers as _candidate_board_blockers,
    _candidate_board_status as _candidate_board_status,
    _candidate_board_activity_count as _candidate_board_activity_count,
    _candidate_board_oracle_blocker_count as _candidate_board_oracle_blocker_count,
    _candidate_board_net_pnl as _candidate_board_net_pnl,
    _candidate_board_lower_bound_net_pnl as _candidate_board_lower_bound_net_pnl,
    _candidate_board_target_progress_ratio as _candidate_board_target_progress_ratio,
    _candidate_board_required_notional_repair_scale as _candidate_board_required_notional_repair_scale,
    _candidate_board_best_executed_candidate as _candidate_board_best_executed_candidate,
    _candidate_board_closest_promotion_candidate as _candidate_board_closest_promotion_candidate,
    _candidate_board_paper_probation_admission_blockers as _candidate_board_paper_probation_admission_blockers,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _CANDIDATE_BOARD_RUNTIME_SESSION_TZ as _CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
    _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN as _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN,
    _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE as _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH as _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _SECOND_OOS_WINDOW_ID as _SECOND_OOS_WINDOW_ID,
    _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS as _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS,
    _resolve_existing_path as _resolve_existing_path,
    _stable_hash as _stable_hash,
    _decimal as _decimal,
    _decimal_payload as _decimal_payload,
    _mapping as _mapping,
    _string as _string,
    _list_of_mappings as _list_of_mappings,
    _sequence_of_mappings as _sequence_of_mappings,
    _rank_sort_value as _rank_sort_value,
    _proposal_sort_value as _proposal_sort_value,
    _string_list_from_value as _string_list_from_value,
    _candidate_board_runtime_ledger_lineage_handoff as _candidate_board_runtime_ledger_lineage_handoff,
    _candidate_board_runtime_ledger_required_materialized_artifacts as _candidate_board_runtime_ledger_required_materialized_artifacts,
    _candidate_spec_requires_rejected_signal_outcome_learning as _candidate_spec_requires_rejected_signal_outcome_learning,
    _boolish as _boolish,
    _oracle_blockers as _oracle_blockers,
)
from scripts.whitepaper_autoresearch_runner.runtime_closure import (
    _runtime_closure_payload as _runtime_closure_payload,
    _portfolio_needs_runtime_closure_proof as _portfolio_needs_runtime_closure_proof,
    _load_json_mapping_artifact as _load_json_mapping_artifact,
    _runtime_closure_artifact_refs as _runtime_closure_artifact_refs,
    _runtime_report_summary_int as _runtime_report_summary_int,
    _runtime_report_int as _runtime_report_int,
    _runtime_closure_ledger_datetime as _runtime_closure_ledger_datetime,
    _runtime_closure_exact_replay_bucket_range as _runtime_closure_exact_replay_bucket_range,
    _runtime_closure_replay_bucket_has_authority as _runtime_closure_replay_bucket_has_authority,
    _runtime_closure_exact_replay_bucket as _runtime_closure_exact_replay_bucket,
    _runtime_report_source_markers as _runtime_report_source_markers,
    _market_impact_default_source_markers as _market_impact_default_source_markers,
    _runtime_closure_start_equity as _runtime_closure_start_equity,
    _portfolio_executable_max_notional as _portfolio_executable_max_notional,
    _runtime_closure_exact_replay_ledger_update as _runtime_closure_exact_replay_ledger_update,
    _runtime_closure_market_impact_stress_update as _runtime_closure_market_impact_stress_update,
    _runtime_closure_delay_adjusted_depth_stress_update as _runtime_closure_delay_adjusted_depth_stress_update,
    _runtime_closure_double_oos_update as _runtime_closure_double_oos_update,
    _runtime_closure_scorecard_update as _runtime_closure_scorecard_update,
    _runtime_closure_pending_promotion_steps as _runtime_closure_pending_promotion_steps,
    _runtime_closure_promotion_prerequisite_blockers as _runtime_closure_promotion_prerequisite_blockers,
    _promotion_readiness_payload as _promotion_readiness_payload,
)

from scripts.whitepaper_autoresearch_runner.artifact_io import (
    _current_code_commit,
    _write_json,
)

from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_payload_with_feedback_metadata,
)

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)

from scripts.whitepaper_autoresearch_runner.replay_models import (
    EpochReplayResult,
)

_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8


def _synthetic_net_for_spec(spec: CandidateSpec, *, rank: int) -> Decimal:
    family_bonus = {
        "microbar_cross_sectional_pairs_v1": Decimal("215"),
        "microstructure_continuation_matched_filter_v1": Decimal("190"),
        "opening_drive_leader_reclaim_v1": Decimal("185"),
        "momentum_pullback_v1": Decimal("175"),
        "washout_rebound_v2": Decimal("165"),
        "breakout_reclaim_v2": Decimal("155"),
        "end_of_day_reversal_v1": Decimal("150"),
        "late_day_continuation_v1": Decimal("145"),
    }.get(spec.family_template_id, Decimal("125"))
    return family_bonus + Decimal(max(0, 12 - rank) * 5)


def _synthetic_symbol_contribution_shares(spec: CandidateSpec) -> dict[str, str]:
    symbols = [
        str(symbol).strip().upper()
        for symbol in cast(
            Sequence[Any], spec.strategy_overrides.get("universe_symbols") or []
        )
        if str(symbol).strip()
    ][:4]
    if not symbols:
        symbols = list(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE[:4])
    share = Decimal("1") / Decimal(len(symbols))
    return {symbol: str(share) for symbol in symbols}


def _synthetic_candidate_payload(spec: CandidateSpec, *, rank: int) -> dict[str, Any]:
    net = _synthetic_net_for_spec(spec, rank=rank)
    active = Decimal("0.92") if rank <= 3 else Decimal("0.82")
    positive = Decimal("0.64") if rank <= 3 else Decimal("0.58")
    symbol_contribution_shares = _synthetic_symbol_contribution_shares(spec)
    daily_net_profile = {
        1: (
            Decimal("0.80"),
            Decimal("1.10"),
            Decimal("0.90"),
            Decimal("1.05"),
            Decimal("1.15"),
        ),
        2: (
            Decimal("1.12"),
            Decimal("0.86"),
            Decimal("1.08"),
            Decimal("0.94"),
            Decimal("1.00"),
        ),
        3: (
            Decimal("0.95"),
            Decimal("1.14"),
            Decimal("0.84"),
            Decimal("1.10"),
            Decimal("0.97"),
        ),
    }.get(
        rank,
        (
            Decimal("1.05"),
            Decimal("0.90"),
            Decimal("1.15"),
            Decimal("0.82"),
            Decimal("1.08"),
        ),
    )
    trading_days = (
        "2026-02-23",
        "2026-02-24",
        "2026-02-25",
        "2026-02-26",
        "2026-02-27",
    )
    daily_filled_notional = {
        "2026-02-23": "350000",
        "2026-02-24": "350000",
        "2026-02-25": "350000",
        "2026-02-26": "350000",
        "2026-02-27": "350000",
    }
    return {
        "candidate_id": f"cand-{spec.candidate_spec_id}",
        "candidate_spec_id": spec.candidate_spec_id,
        "runtime_family": spec.runtime_family,
        "runtime_strategy_name": spec.runtime_strategy_name,
        "family_template_id": spec.family_template_id,
        "execution_signature": _candidate_spec_execution_signature(spec),
        "objective_scorecard": {
            "net_pnl_per_day": str(net),
            "active_day_ratio": str(active),
            "positive_day_ratio": str(positive),
            "avg_filled_notional_per_day": "350000",
            "worst_day_loss": "180",
            "max_drawdown": "520",
            "best_day_share": "0.20",
            "regime_slice_pass_rate": "0.55",
            "posterior_edge_lower": "0.01",
            "shadow_parity_status": "within_budget",
            "symbol_contribution_shares": symbol_contribution_shares,
            "daily_filled_notional": daily_filled_notional,
        },
        "full_window": {
            "net_per_day": str(net),
            "daily_net": {
                day: str(net * multiplier)
                for day, multiplier in zip(trading_days, daily_net_profile, strict=True)
            },
            "daily_filled_notional": daily_filled_notional,
        },
        "promotion_readiness": {
            "stage": "research_candidate",
            "status": "blocked_pending_runtime_parity",
            "promotable": False,
            "blockers": ["scheduler_v3_parity_missing", "shadow_validation_missing"],
        },
    }


def _run_synthetic_replay(
    *,
    specs: Sequence[CandidateSpec],
    output_dir: Path,
    max_candidates: int,
) -> EpochReplayResult:
    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    code_commit = _current_code_commit()
    for rank, spec in enumerate(specs[: max(1, max_candidates)], start=1):
        candidate = _synthetic_candidate_payload(spec, rank=rank)
        result_path = (
            output_dir / "synthetic-replays" / f"{spec.candidate_spec_id}.json"
        )
        result_payload = {
            "schema_version": "torghut.synthetic-autoresearch-replay.v1",
            "dataset_snapshot_receipt": {
                "snapshot_id": "synthetic-recent-whitepaper-2025-2026"
            },
            "top": [candidate],
        }
        _write_json(result_path, result_payload)
        evidence_bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id="synthetic-recent-whitepaper-2025-2026",
                result_path=str(result_path),
                code_commit=code_commit,
            )
        )
        replay_results.append(result_payload)
    return EpochReplayResult(
        evidence_bundles=tuple(evidence_bundles), replay_results=tuple(replay_results)
    )


def _run_real_replay(
    args: argparse.Namespace,
    *,
    output_dir: Path,
    specs: Sequence[CandidateSpec] = (),
) -> EpochReplayResult:
    source_specs = [
        strategy_factory_runner.InMemoryExperimentSpec(
            run_id=_string(spec.feature_contract.get("source_run_id"))
            or "whitepaper-autoresearch",
            experiment_id=f"{spec.candidate_spec_id}-exp",
            payload_json=spec.to_vnext_experiment_payload(
                experiment_id=f"{spec.candidate_spec_id}-exp"
            ),
        )
        for spec in specs
    ]
    max_total_candidates_to_evaluate = max(
        1,
        int(
            getattr(args, "max_total_frontier_candidates", 0)
            or getattr(args, "max_candidates", 1)
        ),
    )
    max_candidates_to_evaluate = int(
        getattr(
            args,
            "max_frontier_candidates_per_spec",
            _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        )
    )
    if source_specs:
        per_spec_total_cap = max(
            1,
            (max_total_candidates_to_evaluate + len(source_specs) - 1)
            // len(source_specs),
        )
        max_candidates_to_evaluate = max(
            1, min(max_candidates_to_evaluate, per_spec_total_cap)
        )
    factory_args = argparse.Namespace(
        output_dir=output_dir / "strategy-factory",
        experiment_id=[],
        paper_run_id=args.paper_run_id,
        limit=max(1, int(args.max_candidates)),
        strategy_configmap=_resolve_existing_path(args.strategy_configmap),
        family_template_dir=_resolve_existing_path(args.family_template_dir),
        seed_sweep_dir=_resolve_existing_path(args.seed_sweep_dir),
        clickhouse_http_url=args.clickhouse_http_url,
        clickhouse_username=args.clickhouse_username,
        clickhouse_password=args.clickhouse_password,
        start_equity=args.start_equity,
        chunk_minutes=args.chunk_minutes,
        symbols="" if source_specs else args.symbols,
        progress_log_seconds=args.progress_log_seconds,
        train_days=args.train_days,
        holdout_days=args.holdout_days,
        second_oos_days=max(0, int(getattr(args, "second_oos_days", 0) or 0)),
        full_window_start_date=args.full_window_start_date,
        full_window_end_date=args.full_window_end_date,
        expected_last_trading_day=args.expected_last_trading_day,
        allow_stale_tape=args.allow_stale_tape,
        prefetch_full_window_rows=args.prefetch_full_window_rows,
        replay_tape_path=getattr(args, "replay_tape_path", None),
        replay_tape_manifest=getattr(args, "replay_tape_manifest", None),
        collect_train_gate_diagnostics=bool(
            getattr(args, "collect_train_gate_diagnostics", True)
        ),
        top_n=args.top_k,
        max_candidates_to_evaluate=max_candidates_to_evaluate,
        max_total_candidates_to_evaluate=max_total_candidates_to_evaluate,
        staged_train_screen_multiplier=max(
            1, int(getattr(args, "staged_train_screen_multiplier", 1) or 1)
        ),
        capture_rejected_seed_full_window_ledger=bool(
            getattr(args, "capture_rejected_seed_full_window_ledger", False)
        ),
        capture_positive_rejected_full_window_ledgers=max(
            0,
            int(getattr(args, "capture_positive_rejected_full_window_ledgers", 0) or 0),
        ),
        symbol_prune_iterations=max(
            0, int(getattr(args, "symbol_prune_iterations", 0) or 0)
        ),
        symbol_prune_candidates=max(
            1, int(getattr(args, "symbol_prune_candidates", 1) or 1)
        ),
        symbol_prune_min_universe_size=max(
            1, int(getattr(args, "symbol_prune_min_universe_size", 2) or 2)
        ),
        loss_repair_iterations=max(
            0, int(getattr(args, "loss_repair_iterations", 0) or 0)
        ),
        loss_repair_candidates=max(
            1, int(getattr(args, "loss_repair_candidates", 1) or 1)
        ),
        consistency_repair_iterations=max(
            0, int(getattr(args, "consistency_repair_iterations", 0) or 0)
        ),
        consistency_repair_candidates=max(
            1, int(getattr(args, "consistency_repair_candidates", 2) or 2)
        ),
        persist_results=args.persist_results,
    )
    factory_payload = (
        strategy_factory_runner.run_strategy_factory_v2_from_specs(
            factory_args,
            source_specs=source_specs,
        )
        if source_specs
        else strategy_factory_runner.run_strategy_factory_v2(factory_args)
    )
    return _real_replay_result_from_factory_payload(
        factory_payload,
        specs_by_id={spec.candidate_spec_id: spec for spec in specs},
    )


def _real_replay_result_from_factory_payload(
    factory_payload: Mapping[str, Any],
    *,
    specs_by_id: Mapping[str, CandidateSpec] | None = None,
) -> EpochReplayResult:
    specs_by_id = specs_by_id or {}
    evidence_bundles: list[CandidateEvidenceBundle] = []
    build = _mapping(factory_payload.get("build"))
    code_commit = _string(build.get("commit")) or _current_code_commit()
    for item in _list_of_mappings(factory_payload.get("experiments")):
        result_path = str(item.get("result_path") or "")
        if not result_path:
            continue
        result_payload = json.loads(Path(result_path).read_text(encoding="utf-8"))
        top = _list_of_mappings(result_payload.get("top"))
        if not top:
            continue
        experiment_spec_id = _string(item.get("candidate_spec_id"))
        fallback_spec_id = str(
            item.get("experiment_id") or item.get("top_candidate_id") or ""
        )
        dataset_snapshot_id = str(item.get("dataset_snapshot_id") or "")
        experiment_promotion_readiness = item.get("promotion_readiness")
        replay_summary = _mapping(result_payload.get("summary"))
        for frontier_candidate in top:
            candidate = dict(frontier_candidate)
            if replay_summary and "summary" not in candidate:
                candidate["summary"] = replay_summary
            candidate_spec_id = experiment_spec_id or _string(
                candidate.get("candidate_spec_id")
            )
            if candidate_spec_id:
                candidate["candidate_spec_id"] = candidate_spec_id
            spec = specs_by_id.get(candidate_spec_id)
            if spec is not None:
                candidate = _candidate_payload_with_feedback_metadata(
                    candidate=candidate,
                    spec=spec,
                )
            if (
                not candidate.get("promotion_readiness")
                and experiment_promotion_readiness
            ):
                candidate["promotion_readiness"] = experiment_promotion_readiness
            evidence_bundles.append(
                evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=candidate_spec_id or fallback_spec_id,
                    candidate=candidate,
                    dataset_snapshot_id=dataset_snapshot_id,
                    result_path=result_path,
                    code_commit=code_commit,
                )
            )
    return EpochReplayResult(
        evidence_bundles=tuple(evidence_bundles), replay_results=(factory_payload,)
    )


def _dedupe_replay_evidence(
    bundles: Sequence[CandidateEvidenceBundle],
) -> tuple[CandidateEvidenceBundle, ...]:
    seen: set[str] = set()
    deduped: list[CandidateEvidenceBundle] = []
    for bundle in bundles:
        if bundle.evidence_bundle_id in seen:
            continue
        seen.add(bundle.evidence_bundle_id)
        deduped.append(bundle)
    return tuple(deduped)


def _candidate_spec_id_from_experiment_result_path(path: Path) -> str:
    name = path.parent.name
    return name[:-4] if name.endswith("-exp") else name


def _collect_partial_real_replay(
    *,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
) -> EpochReplayResult:
    strategy_factory_root = output_dir / "strategy-factory"
    if not strategy_factory_root.exists():
        return EpochReplayResult(evidence_bundles=(), replay_results=())
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    experiments: list[dict[str, Any]] = []
    for result_path in sorted(strategy_factory_root.glob("*/result.json")):
        try:
            result_payload = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        top = _list_of_mappings(result_payload.get("top"))
        if not top:
            continue
        top_candidate = top[0]
        candidate_spec_id = _string(
            top_candidate.get("candidate_spec_id")
        ) or _candidate_spec_id_from_experiment_result_path(result_path)
        spec = spec_by_id.get(candidate_spec_id)
        dataset_snapshot = _mapping(result_payload.get("dataset_snapshot_receipt"))
        experiments.append(
            {
                "source_run_id": _string(spec.feature_contract.get("source_run_id"))
                if spec is not None
                else "",
                "experiment_id": result_path.parent.name,
                "candidate_spec_id": candidate_spec_id,
                "family_template_id": _string(top_candidate.get("family_template_id"))
                or (spec.family_template_id if spec is not None else ""),
                "result_path": str(result_path),
                "dataset_snapshot_id": str(dataset_snapshot.get("snapshot_id") or ""),
                "top_candidate_id": _string(top_candidate.get("candidate_id")),
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "partial_replay_interrupted",
                    "promotable": False,
                    "blockers": ["real_replay_interrupted_before_epoch_summary"],
                },
            }
        )
    if not experiments:
        return EpochReplayResult(evidence_bundles=(), replay_results=())
    return _real_replay_result_from_factory_payload(
        {
            "status": "partial_replay_artifacts_collected",
            "count": len(experiments),
            "experiments": experiments,
        },
        specs_by_id=spec_by_id,
    )


def _run_real_replay_once_with_optional_timeout(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    timeout_seconds: int,
) -> EpochReplayResult:
    if timeout_seconds <= 0:
        return _run_real_replay(args, output_dir=output_dir, specs=specs)
    if not all(
        hasattr(signal, attr) for attr in ("SIGALRM", "alarm", "getsignal", "signal")
    ):
        return _run_real_replay_once_in_child_process(
            args=args,
            output_dir=output_dir,
            specs=specs,
            timeout_seconds=timeout_seconds,
        )

    previous_handler = signal.getsignal(signal.SIGALRM)

    def _timeout_handler(_signum: int, _frame: Any) -> None:
        raise TimeoutError(f"real_replay_timeout_seconds:{timeout_seconds}")

    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_seconds)
    try:
        return _run_real_replay(args, output_dir=output_dir, specs=specs)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)


def _real_replay_worker(
    result_queue: Any,
    args: argparse.Namespace,
    output_dir: str,
    specs: tuple[CandidateSpec, ...],
) -> None:
    try:
        result_queue.put(
            ("ok", _run_real_replay(args, output_dir=Path(output_dir), specs=specs))
        )
    except BaseException as exc:
        try:
            result_queue.put(("error", exc))
        except Exception:
            result_queue.put(("error_payload", (type(exc).__name__, str(exc))))


def _terminate_process(process: Any) -> None:
    if not process.is_alive():
        return
    process.terminate()
    process.join(timeout=5)
    if process.is_alive():
        kill = getattr(process, "kill", None)
        if callable(kill):
            kill()
            process.join(timeout=5)


def _run_real_replay_once_in_child_process(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    timeout_seconds: int,
) -> EpochReplayResult:
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue(maxsize=1)
    process = context.Process(
        target=_real_replay_worker,
        args=(result_queue, args, str(output_dir), tuple(specs)),
    )
    process.start()
    deadline = monotonic_time.monotonic() + timeout_seconds
    try:
        while True:
            remaining = deadline - monotonic_time.monotonic()
            if remaining <= 0:
                _terminate_process(process)
                raise TimeoutError(f"real_replay_timeout_seconds:{timeout_seconds}")
            try:
                status, payload = result_queue.get(timeout=min(remaining, 0.5))
                break
            except queue.Empty:
                if process.exitcode is not None:
                    raise RuntimeError("real_replay_worker_exited_without_result")
        process.join(timeout=5)
        if process.is_alive():
            _terminate_process(process)
        if status == "ok":
            return cast(EpochReplayResult, payload)
        if status == "error":
            raise cast(BaseException, payload)
        error_type, message = cast(tuple[str, str], payload)
        raise RuntimeError(f"{error_type}:{message}")
    finally:
        close = getattr(result_queue, "close", None)
        if callable(close):
            close()
        join_thread = getattr(result_queue, "join_thread", None)
        if callable(join_thread):
            join_thread()


__all__ = [
    "_synthetic_net_for_spec",
    "_synthetic_symbol_contribution_shares",
    "_synthetic_candidate_payload",
    "_run_synthetic_replay",
    "_run_real_replay",
    "_real_replay_result_from_factory_payload",
    "_dedupe_replay_evidence",
    "_candidate_spec_id_from_experiment_result_path",
    "_collect_partial_real_replay",
    "_run_real_replay_once_with_optional_timeout",
    "_real_replay_worker",
    "_terminate_process",
    "_run_real_replay_once_in_child_process",
]
