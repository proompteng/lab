#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
)
from app.whitepapers.claim_compiler import (
    WhitepaperResearchSource,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _decimal,
    _mapping,
    _string,
    _list_of_mappings,
    _string_list_from_value,
)

from scripts.whitepaper_autoresearch_runner.candidate_goal_metadata import (
    _candidate_family_goal_rows,
    _candidate_sleeve_goal_rows,
    _selected_candidate_spec_ids,
)

from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _bounded_real_replay_shard_timeout_seconds,
)

_DEFAULT_PORTFOLIO_PROFIT_PROGRAM = Path(
    "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
)

_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8

_DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS = 900

_DEFAULT_REAL_REPLAY_SHARD_WORKERS = 2

_UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS = (
    "agentrun",
    "agent-run",
    "broker",
    "fanout",
    "kubectl",
    "kubernetes",
    "live-trading",
    "promotion",
)


def _profitability_system_change_backlog(
    *,
    oracle_candidate_found: bool,
    status_reason: str | None,
    remediation: Mapping[str, Any] | None,
    promotion_blockers: Sequence[str],
    replay_mode: str,
) -> list[dict[str, Any]]:
    backlog: list[dict[str, Any]] = []
    for action in _list_of_mappings(
        remediation.get("next_actions") if remediation else []
    ):
        backlog.append(
            {
                "priority": int(action.get("priority") or len(backlog) + 1),
                "scope": "autoresearch_pipeline",
                "change": _string(action.get("action"))
                or "inspect_autoresearch_artifacts",
                "reason": _string(action.get("reason")),
                "recommended_flags": dict(_mapping(action.get("recommended_flags"))),
                "candidate_spec_ids": _string_list_from_value(
                    action.get("candidate_spec_ids")
                ),
                "blocking_failure_counts": dict(
                    _mapping(action.get("blocking_failure_counts"))
                ),
            }
        )
    if replay_mode != "real":
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "replay_evidence",
                "change": "rerun_with_real_replay_before_any_promotion",
                "reason": "synthetic replay is only a pipeline smoke test and cannot establish standalone profitability",
                "recommended_flags": {"--replay-mode": "real"},
            }
        )
    if not oracle_candidate_found and status_reason:
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "portfolio_oracle",
                "change": "continue_search_until_portfolio_oracle_passes",
                "reason": status_reason,
                "required_result": "portfolio oracle passes the configured daily target without relaxing gates",
            }
        )
    if promotion_blockers:
        backlog.append(
            {
                "priority": len(backlog) + 1,
                "scope": "runtime_closure",
                "change": "produce_runtime_closure_and_shadow_promotion_evidence",
                "reason": "candidate evidence is not enough for standalone trading",
                "promotion_blockers": list(promotion_blockers),
            }
        )
    backlog.append(
        {
            "priority": len(backlog) + 1,
            "scope": "live_submission_controls",
            "change": "keep_live_submission_disabled_until_profit_and_promotion_gates_pass",
            "reason": "standalone money-making requires evidence first, then explicit deployer approval; no gate bypass",
        }
    )
    backlog.sort(key=lambda row: int(row.get("priority") or 10**6))
    return backlog


def _profitability_next_epoch_flags(
    *,
    args: argparse.Namespace,
    target: Decimal,
    remediation: Mapping[str, Any] | None,
) -> dict[str, str]:
    return cast(
        dict[str, str],
        _profitability_next_epoch_plan(
            args=args, target=target, remediation=remediation
        )["flags"],
    )


def _int_arg(args: argparse.Namespace, name: str, default: int) -> int:
    try:
        return int(getattr(args, name, default) or default)
    except (TypeError, ValueError):
        return default


def _flag_int(value: Any) -> int | None:
    text = _string(value)
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _unsafe_next_epoch_remediation_flag(key: str) -> bool:
    normalized = key.strip().lower()
    return any(
        marker in normalized for marker in _UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS
    )


def _decimal_arg_or_default(
    args: argparse.Namespace,
    name: str,
    default: Decimal,
) -> Decimal:
    raw_value = getattr(args, name, None)
    if raw_value is None or _string(raw_value) == "":
        return default
    return _decimal(raw_value, default=str(default))


def _profitability_next_epoch_plan(
    *,
    args: argparse.Namespace,
    target: Decimal,
    remediation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    direct_candidate_specs_artifacts = [
        str(path)
        for path in cast(Sequence[Path], getattr(args, "candidate_specs", ()) or ())
        if str(path)
    ]
    flags: dict[str, str] = {
        "--target-net-pnl-per-day": str(target),
        "--program": str(getattr(args, "program", _DEFAULT_PORTFOLIO_PROFIT_PROGRAM)),
        "--replay-mode": "real",
        "--max-candidates": str(max(64, _int_arg(args, "max_candidates", 64))),
        "--top-k": str(max(16, _int_arg(args, "top_k", 16))),
        "--exploration-slots": str(max(8, _int_arg(args, "exploration_slots", 8))),
        "--feedback-block-reaudit-slots": str(
            max(0, _int_arg(args, "feedback_block_reaudit_slots", 0))
        ),
        "--portfolio-size-min": str(max(2, _int_arg(args, "portfolio_size_min", 2))),
        "--portfolio-size-max": str(max(8, _int_arg(args, "portfolio_size_max", 8))),
        "--max-frontier-candidates-per-spec": str(
            max(
                1,
                _int_arg(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                ),
            )
        ),
    }
    max_total_frontier_candidates = _int_arg(args, "max_total_frontier_candidates", 0)
    if max_total_frontier_candidates > 0:
        flags["--max-total-frontier-candidates"] = str(max_total_frontier_candidates)
    real_replay_timeout_seconds = _int_arg(args, "real_replay_timeout_seconds", 0)
    if real_replay_timeout_seconds > 0:
        flags["--real-replay-timeout-seconds"] = str(real_replay_timeout_seconds)
    real_replay_shard_size = _int_arg(args, "real_replay_shard_size", 0)
    if real_replay_shard_size > 0:
        flags["--real-replay-shard-size"] = str(real_replay_shard_size)
    requested_real_replay_shard_timeout_seconds = _int_arg(
        args,
        "real_replay_shard_timeout_seconds",
        _DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
    )
    real_replay_shard_timeout_seconds = _bounded_real_replay_shard_timeout_seconds(
        requested_real_replay_shard_timeout_seconds
    )
    if real_replay_shard_timeout_seconds > 0:
        flags["--real-replay-shard-timeout-seconds"] = str(
            real_replay_shard_timeout_seconds
        )
    capped_runtime_flags: list[dict[str, str]] = []
    if requested_real_replay_shard_timeout_seconds != real_replay_shard_timeout_seconds:
        capped_runtime_flags.append(
            {
                "flag": "--real-replay-shard-timeout-seconds",
                "requested_value": str(requested_real_replay_shard_timeout_seconds),
                "capped_value": str(real_replay_shard_timeout_seconds),
                "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
            }
        )
    requested_real_replay_shard_workers = _int_arg(
        args, "real_replay_shard_workers", _DEFAULT_REAL_REPLAY_SHARD_WORKERS
    )
    real_replay_shard_workers = max(
        1,
        min(
            requested_real_replay_shard_workers,
            _DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        ),
    )
    if real_replay_shard_workers != requested_real_replay_shard_workers:
        capped_runtime_flags.append(
            {
                "flag": "--real-replay-shard-workers",
                "requested_value": str(requested_real_replay_shard_workers),
                "capped_value": str(real_replay_shard_workers),
                "reason": "capped_to_local_worker_limit_no_kubernetes_fanout",
            }
        )
    if real_replay_shard_workers > 1:
        flags["--real-replay-shard-workers"] = str(real_replay_shard_workers)
    real_replay_failed_spec_retries = _int_arg(
        args, "real_replay_failed_spec_retries", 1
    )
    if real_replay_failed_spec_retries > 0:
        flags["--real-replay-failed-spec-retries"] = str(
            real_replay_failed_spec_retries
        )
    real_replay_retry_timeout_seconds = _int_arg(
        args, "real_replay_retry_timeout_seconds", 0
    )
    if real_replay_retry_timeout_seconds > 0:
        flags["--real-replay-retry-timeout-seconds"] = str(
            real_replay_retry_timeout_seconds
        )
    real_replay_retry_frontier_candidates = _int_arg(
        args, "real_replay_retry_max_frontier_candidates_per_spec", 1
    )
    if real_replay_retry_frontier_candidates > 1:
        flags["--real-replay-retry-max-frontier-candidates-per-spec"] = str(
            real_replay_retry_frontier_candidates
        )
    shadow_validation_artifact = getattr(args, "shadow_validation_artifact", None)
    if shadow_validation_artifact is not None:
        flags["--shadow-validation-artifact"] = str(shadow_validation_artifact)

    applied_recommended_flags: list[dict[str, str]] = []
    rejected_recommended_flags: list[dict[str, str]] = []
    monotonic_int_flags = {
        "--max-candidates",
        "--top-k",
        "--exploration-slots",
        "--feedback-block-reaudit-slots",
        "--portfolio-size-min",
        "--portfolio-size-max",
        "--max-total-frontier-candidates",
        "--real-replay-timeout-seconds",
    }
    if remediation is not None:
        for action in _list_of_mappings(remediation.get("next_actions")):
            action_name = _string(action.get("action"))
            for key, value in _mapping(action.get("recommended_flags")).items():
                if key.startswith("--") and _string(value):
                    if _unsafe_next_epoch_remediation_flag(key):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(flags.get(key, "")),
                                "recommended_value": _string(value),
                                "reason": "rejected_unsafe_cluster_fanout_or_promotion_flag",
                            }
                        )
                        continue
                    current_value = flags.get(key)
                    current_int = _flag_int(current_value)
                    recommended_int = _flag_int(value)
                    if key == "--real-replay-shard-workers" and (
                        recommended_int is None
                        or recommended_int > _DEFAULT_REAL_REPLAY_SHARD_WORKERS
                    ):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_value or ""),
                                "recommended_value": _string(value),
                                "reason": "rejected_broad_replay_worker_fanout",
                            }
                        )
                        continue
                    if key == "--real-replay-shard-timeout-seconds":
                        if recommended_int is None:
                            rejected_recommended_flags.append(
                                {
                                    "action": action_name,
                                    "flag": key,
                                    "current_value": str(current_value or ""),
                                    "recommended_value": _string(value),
                                    "reason": "rejected_invalid_numeric_remediation_flag",
                                }
                            )
                            continue
                        capped_timeout = _bounded_real_replay_shard_timeout_seconds(
                            recommended_int
                        )
                        if capped_timeout != recommended_int:
                            capped_runtime_flags.append(
                                {
                                    "action": action_name,
                                    "flag": key,
                                    "requested_value": str(recommended_int),
                                    "capped_value": str(capped_timeout),
                                    "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
                                }
                            )
                        flags[key] = str(capped_timeout)
                        applied_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "value": str(capped_timeout),
                            }
                        )
                        continue
                    if key in monotonic_int_flags and recommended_int is None:
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_value or ""),
                                "recommended_value": _string(value),
                                "reason": "rejected_invalid_numeric_remediation_flag",
                            }
                        )
                        continue
                    if (
                        key in monotonic_int_flags
                        and current_int is not None
                        and recommended_int is not None
                        and recommended_int < current_int
                    ):
                        rejected_recommended_flags.append(
                            {
                                "action": action_name,
                                "flag": key,
                                "current_value": str(current_int),
                                "recommended_value": str(recommended_int),
                                "reason": (
                                    "rejected_to_preserve_or_increase_search_breadth"
                                ),
                            }
                        )
                        continue
                    flags[key] = _string(value)
                    applied_recommended_flags.append(
                        {
                            "action": action_name,
                            "flag": key,
                            "value": _string(value),
                        }
                    )
    argv: list[str] = [
        "python",
        "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "--output-dir",
        "<next-epoch-output-dir>",
    ]
    for path in direct_candidate_specs_artifacts:
        argv.extend(["--candidate-specs", path])
    for key, value in flags.items():
        argv.extend([key, value])
    return {
        "entrypoint": "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "flags": flags,
        "argv": argv,
        "direct_candidate_specs_artifacts": direct_candidate_specs_artifacts,
        "applied_recommended_flags": applied_recommended_flags,
        "rejected_recommended_flags": rejected_recommended_flags,
        "capped_runtime_flags": capped_runtime_flags,
        "no_fast_path_policy": {
            "target_net_pnl_per_day_is_fixed": str(target),
            "replay_mode": "real",
            "no_kubernetes_fanout": True,
            "max_generated_real_replay_shard_workers": (
                _DEFAULT_REAL_REPLAY_SHARD_WORKERS
            ),
            "monotonic_search_flags": sorted(monotonic_int_flags),
            "unsafe_remediation_flag_markers": sorted(
                _UNSAFE_NEXT_EPOCH_REMEDIATION_FLAG_MARKERS
            ),
            "allowed_decreases": [
                (
                    "timeout remediation may reduce "
                    "--max-frontier-candidates-per-spec only to finish complete evidence"
                )
            ],
        },
    }


def _profitability_search_goal(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    status: str,
    status_reason: str | None,
    target: Decimal,
    program: StrategyAutoresearchProgram,
    sources: Sequence[WhitepaperResearchSource],
    hypothesis_cards: Sequence[HypothesisCard],
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    pre_replay_model: Mapping[str, Any],
    proposal_model: Mapping[str, Any] | None,
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    oracle_candidate_found: bool,
    profit_target_oracle: Mapping[str, Any] | None,
    promotion_blockers: Sequence[str],
    remediation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    replay_mode = _string(getattr(args, "replay_mode", "")) or "real"
    next_epoch_plan = _profitability_next_epoch_plan(
        args=args, target=target, remediation=remediation
    )
    return {
        "schema_version": "torghut.whitepaper-autoresearch-profitability-goal.v1",
        "objective": {
            "target_net_pnl_per_trading_day": str(target),
            "currency": "USD",
            "standalone_system": True,
            "status": status,
            "status_reason": status_reason,
            "oracle_candidate_found": oracle_candidate_found,
            "definition_of_done": [
                "portfolio oracle passes the target without lowering constraints",
                "real replay evidence is complete for selected sleeves",
                "runtime closure writes parity and approval replay evidence",
                "shadow/promotion evidence is persisted before live submission",
                "live submission gate remains blocked until evidence and explicit deployer controls allow it",
            ],
        },
        "candidate_framework": {
            "program_id": program.program_id,
            "program_path": str(
                getattr(args, "program", _DEFAULT_PORTFOLIO_PROFIT_PROGRAM)
            ),
            "replay_mode": replay_mode,
            "source_count": len(sources),
            "claim_count": sum(len(source.claims) for source in sources),
            "hypothesis_count": len(hypothesis_cards),
            "candidate_spec_count": len(candidate_specs),
            "selected_for_replay_count": len(
                _selected_candidate_spec_ids(candidate_selection)
            ),
            "evidence_bundle_count": len(evidence_bundles),
            "portfolio_candidate_count": 1 if portfolio is not None else 0,
            "pre_replay_model": {
                "schema_version": pre_replay_model.get("schema_version"),
                "model_id": pre_replay_model.get("model_id"),
                "backend": pre_replay_model.get("backend"),
                "proposal_stage": pre_replay_model.get("proposal_stage"),
            },
            "post_replay_model": {
                "schema_version": proposal_model.get("schema_version")
                if proposal_model
                else None,
                "model_id": proposal_model.get("model_id") if proposal_model else None,
                "backend": proposal_model.get("backend") if proposal_model else None,
            },
            "families": _candidate_family_goal_rows(
                candidate_specs=candidate_specs,
                candidate_selection=candidate_selection,
                evidence_bundles=evidence_bundles,
            ),
        },
        "sleeve_plan": {
            "source": "portfolio_candidate"
            if portfolio is not None
            else "candidate_selection",
            "rows": _candidate_sleeve_goal_rows(
                candidate_specs=candidate_specs,
                candidate_selection=candidate_selection,
                evidence_bundles=evidence_bundles,
                false_positive_table=false_positive_table,
                best_false_negative_table=best_false_negative_table,
                portfolio=portfolio,
            ),
        },
        "system_change_backlog": _profitability_system_change_backlog(
            oracle_candidate_found=oracle_candidate_found,
            status_reason=status_reason,
            remediation=remediation,
            promotion_blockers=promotion_blockers,
            replay_mode=replay_mode,
        ),
        "no_cheating_contract": {
            "forbidden": [
                "lowering target_net_pnl_per_day to make a candidate pass",
                "relaxing oracle, replay, drawdown, contribution, or promotion gates without a separate reviewed code change",
                "treating synthetic replay as production proof",
                "editing live strategy configuration inside an autoresearch epoch",
                "enabling live submission before promotion evidence and deployer approval exist",
            ],
            "program_forbidden_mutations": list(program.forbidden_mutations),
            "promotion_policy": program.promotion_policy,
        },
        "recommended_next_epoch": next_epoch_plan,
        "profit_target_oracle": dict(profit_target_oracle or {}),
        "candidate_search_remediation": dict(remediation or {}),
        "artifacts": {
            "candidate_selection_manifest": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
            "candidate_evidence_bundles": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(output_dir / "portfolio-candidates.jsonl"),
            "candidate_search_remediation": str(
                output_dir / "candidate-search-remediation.json"
            )
            if remediation is not None
            else None,
            "summary": str(output_dir / "summary.json"),
        },
    }


__all__ = [
    "_profitability_system_change_backlog",
    "_profitability_next_epoch_flags",
    "_int_arg",
    "_flag_int",
    "_unsafe_next_epoch_remediation_flag",
    "_decimal_arg_or_default",
    "_profitability_next_epoch_plan",
    "_profitability_search_goal",
]
