#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    RejectedSignalOutcomeEvent,
    WhitepaperAnalysisRun,
    VNextExperimentSpec,
)
from app.trading.discovery.autoresearch import (
    ResearchClaim,
    ResearchSource,
    StrategyAutoresearchProgram,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_payload,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    CandidateCompilationBlocker,
)
from app.whitepapers.claim_compiler import (
    WhitepaperResearchSource,
)


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

from scripts.whitepaper_autoresearch_runner.feedback_loading import (
    _candidate_spec_from_payload,
    _dedupe_feedback_evidence_bundles,
    _load_feedback_evidence_bundles,
    _summary_scorecard_feedback_bundles_for_epoch,
)

from scripts.whitepaper_autoresearch_runner.rejected_signal_feedback import (
    _portfolio_candidate_row_to_feedback_bundles,
    _rejected_signal_outcome_payload_to_feedback_bundle,
)

_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES = 512

_MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS = 12

_PORTFOLIO_FEEDBACK_STATUSES = frozenset({"blocked", "paper_probation", "target_met"})

_PROGRAM_SOURCE_DEFAULT_CONFIDENCE = "0.70"


def _load_recent_persisted_feedback_evidence_bundles(
    *,
    limit: int = _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
    epoch_limit: int = _MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS,
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, Any]]:
    manifest: dict[str, Any] = {
        "source": "autoresearch_epochs.summary_json.candidate_evidence_bundle_payloads",
        "epoch_scan_limit": epoch_limit,
        "bundle_limit": limit,
        "scanned_epoch_count": 0,
        "loaded_bundle_count": 0,
        "invalid_payload_count": 0,
        "legacy_summary_scorecard_count": 0,
        "legacy_summary_matched_scorecard_count": 0,
        "legacy_summary_unmatched_scorecard_count": 0,
        "legacy_summary_bundle_count": 0,
        "legacy_summary_invalid_spec_count": 0,
        "rejected_signal_outcome_scanned_count": 0,
        "rejected_signal_outcome_bundle_count": 0,
        "rejected_signal_outcome_invalid_count": 0,
        "portfolio_candidate_scanned_count": 0,
        "portfolio_candidate_bundle_count": 0,
        "portfolio_candidate_invalid_count": 0,
    }
    try:
        with SessionLocal() as session:
            epochs = (
                session.execute(
                    select(AutoresearchEpoch)
                    .order_by(
                        AutoresearchEpoch.completed_at.desc(),
                        AutoresearchEpoch.created_at.desc(),
                    )
                    .limit(epoch_limit)
                )
                .scalars()
                .all()
            )
            epoch_ids = [epoch.epoch_id for epoch in epochs]
            spec_rows = (
                session.execute(
                    select(AutoresearchCandidateSpec).where(
                        AutoresearchCandidateSpec.epoch_id.in_(epoch_ids)
                    )
                )
                .scalars()
                .all()
                if epoch_ids
                else []
            )
            portfolio_candidate_rows = (
                session.execute(
                    select(AutoresearchPortfolioCandidate)
                    .where(
                        AutoresearchPortfolioCandidate.status.in_(
                            sorted(_PORTFOLIO_FEEDBACK_STATUSES)
                        )
                    )
                    .order_by(
                        AutoresearchPortfolioCandidate.created_at.desc(),
                        AutoresearchPortfolioCandidate.updated_at.desc(),
                    )
                    .limit(limit)
                )
                .scalars()
                .all()
            )
            rejected_signal_outcome_rows = (
                session.execute(
                    select(RejectedSignalOutcomeEvent)
                    .where(RejectedSignalOutcomeEvent.outcome_label_status == "labeled")
                    .order_by(
                        RejectedSignalOutcomeEvent.event_ts.desc(),
                        RejectedSignalOutcomeEvent.created_at.desc(),
                    )
                    .limit(limit)
                )
                .scalars()
                .all()
            )
    except Exception as exc:
        manifest["status"] = "unavailable"
        manifest["error"] = str(exc)
        return (), manifest

    manifest["scanned_epoch_count"] = len(epochs)
    manifest["rejected_signal_outcome_scanned_count"] = len(
        rejected_signal_outcome_rows
    )
    manifest["portfolio_candidate_scanned_count"] = len(portfolio_candidate_rows)
    bundles: list[CandidateEvidenceBundle] = []
    invalid_payload_count = 0
    rejected_signal_outcome_invalid_count = 0
    rejected_signal_outcome_bundle_count = 0
    portfolio_candidate_invalid_count = 0
    portfolio_candidate_bundle_count = 0
    source_epoch_ids: list[str] = []
    legacy_source_epoch_ids: list[str] = []
    rejected_signal_outcome_event_ids: list[str] = []
    portfolio_candidate_ids: list[str] = []
    candidate_specs_by_epoch: dict[str, list[CandidateSpec]] = {}
    invalid_spec_count = 0
    for row in rejected_signal_outcome_rows:
        if len(bundles) >= limit:
            break
        try:
            bundle = _rejected_signal_outcome_payload_to_feedback_bundle(row)
        except Exception:
            rejected_signal_outcome_invalid_count += 1
            continue
        if bundle is None:
            rejected_signal_outcome_invalid_count += 1
            continue
        bundles.append(bundle)
        rejected_signal_outcome_bundle_count += 1
        rejected_signal_outcome_event_ids.append(row.event_id)
    for row in portfolio_candidate_rows:
        if len(bundles) >= limit:
            break
        try:
            row_bundles = _portfolio_candidate_row_to_feedback_bundles(row)
        except Exception:
            portfolio_candidate_invalid_count += 1
            continue
        if not row_bundles:
            portfolio_candidate_invalid_count += 1
            continue
        remaining = limit - len(bundles)
        bundles.extend(row_bundles[:remaining])
        portfolio_candidate_bundle_count += min(len(row_bundles), remaining)
        portfolio_candidate_ids.append(row.portfolio_candidate_id)
    for row in spec_rows:
        try:
            spec = _candidate_spec_from_payload(_mapping(row.payload_json))
        except Exception:
            invalid_spec_count += 1
            continue
        if not spec.candidate_spec_id:
            invalid_spec_count += 1
            continue
        candidate_specs_by_epoch.setdefault(row.epoch_id, []).append(spec)
    for epoch in epochs:
        if len(bundles) >= limit:
            break
        summary = _mapping(epoch.summary_json)
        payloads = _list_of_mappings(summary.get("candidate_evidence_bundle_payloads"))
        if payloads:
            source_epoch_ids.append(epoch.epoch_id)
            for payload in payloads:
                if len(bundles) >= limit:
                    break
                try:
                    bundles.append(evidence_bundle_from_payload(payload))
                except Exception:
                    invalid_payload_count += 1
        if len(bundles) >= limit:
            break
        legacy_bundles, legacy_stats = _summary_scorecard_feedback_bundles_for_epoch(
            epoch, candidate_specs_by_epoch.get(epoch.epoch_id, ())
        )
        manifest["legacy_summary_scorecard_count"] += legacy_stats["scorecard_count"]
        manifest["legacy_summary_matched_scorecard_count"] += legacy_stats[
            "matched_scorecard_count"
        ]
        manifest["legacy_summary_unmatched_scorecard_count"] += legacy_stats[
            "unmatched_scorecard_count"
        ]
        if legacy_bundles:
            legacy_source_epoch_ids.append(epoch.epoch_id)
            remaining = limit - len(bundles)
            bundles.extend(legacy_bundles[:remaining])

    deduped = _dedupe_feedback_evidence_bundles(bundles)
    manifest["status"] = "loaded" if deduped else "empty"
    manifest["source_epoch_ids"] = source_epoch_ids
    manifest["legacy_summary_source_epoch_ids"] = legacy_source_epoch_ids
    manifest["loaded_bundle_count"] = len(deduped)
    manifest["invalid_payload_count"] = invalid_payload_count
    manifest["legacy_summary_bundle_count"] = len(
        _dedupe_feedback_evidence_bundles(
            tuple(
                bundle
                for bundle in bundles
                if bundle.dataset_snapshot_id.endswith(":summary-scorecards")
            )
        )
    )
    manifest["legacy_summary_invalid_spec_count"] = invalid_spec_count
    manifest["rejected_signal_outcome_bundle_count"] = (
        rejected_signal_outcome_bundle_count
    )
    manifest["rejected_signal_outcome_invalid_count"] = (
        rejected_signal_outcome_invalid_count
    )
    manifest["rejected_signal_outcome_event_ids"] = rejected_signal_outcome_event_ids
    manifest["portfolio_candidate_bundle_count"] = portfolio_candidate_bundle_count
    manifest["portfolio_candidate_invalid_count"] = portfolio_candidate_invalid_count
    manifest["portfolio_candidate_ids"] = portfolio_candidate_ids
    return deduped, manifest


def _load_autoresearch_feedback_evidence_bundles(
    paths: Sequence[Path],
    *,
    include_persisted: bool,
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, Any]]:
    explicit_bundles = _load_feedback_evidence_bundles(paths)
    persisted_bundles: tuple[CandidateEvidenceBundle, ...] = ()
    persisted_manifest: dict[str, Any] = {"status": "disabled"}
    if include_persisted:
        (
            persisted_bundles,
            persisted_manifest,
        ) = _load_recent_persisted_feedback_evidence_bundles()
    combined = _dedupe_feedback_evidence_bundles(
        (*explicit_bundles, *persisted_bundles)
    )
    return combined, {
        "schema_version": "torghut.feedback-evidence-source-manifest.v1",
        "explicit_jsonl_path_count": len(paths),
        "explicit_jsonl_bundle_count": len(explicit_bundles),
        "persisted": persisted_manifest,
        "combined_bundle_count": len(combined),
    }


def _program_claim_type(claim: ResearchClaim) -> str:
    explicit_claim_type = str(claim.claim_type or "").strip().lower()
    if explicit_claim_type:
        return explicit_claim_type
    text = f"{claim.summary} {claim.implication}".lower()
    if any(
        token in text
        for token in (
            "validate",
            "validation",
            "held-out",
            "replay",
            "shadow",
            "gate",
            "stress",
            "reject",
            "penalize",
        )
    ):
        return "validation_requirement"
    if any(
        token in text
        for token in (
            "risk",
            "liquidity",
            "cost",
            "spread",
            "drawdown",
            "inventory",
            "sizing",
        )
    ):
        return "risk_constraint"
    if any(
        token in text
        for token in (
            "feature",
            "normalization",
            "microprice",
            "order-flow",
            "order flow",
            "imbalance",
            "volume",
        )
    ):
        return "feature_recipe"
    return "signal_mechanism"


def _program_research_source_to_whitepaper_source(
    source: ResearchSource,
) -> WhitepaperResearchSource | None:
    run_id = str(source.source_id or "").strip()
    if not run_id:
        return None
    claims: list[dict[str, Any]] = []
    for claim in source.claims:
        claim_id = str(claim.claim_id or "").strip()
        claim_text = str(claim.claim_text or "").strip() or ". ".join(
            part
            for part in (
                str(claim.summary or "").strip(),
                str(claim.implication or "").strip(),
            )
            if part
        )
        if not claim_id or not claim_text:
            continue
        claim_type = _program_claim_type(claim)
        data_requirements = [
            item for item in claim.data_requirements if str(item or "").strip()
        ]
        expected_direction = str(claim.expected_direction or "").strip()
        if not expected_direction:
            expected_direction = (
                "neutral"
                if claim_type in {"risk_constraint", "validation_requirement"}
                else "positive"
            )
        claims.append(
            {
                "claim_id": claim_id,
                "claim_type": claim_type,
                "claim_text": claim_text,
                "asset_scope": str(claim.asset_scope or "").strip()
                or "us_equities_intraday",
                "horizon_scope": str(claim.horizon_scope or "").strip()
                or "intraday_microstructure",
                "expected_direction": expected_direction,
                "data_requirements": data_requirements,
                "confidence": _PROGRAM_SOURCE_DEFAULT_CONFIDENCE,
                "metadata": {
                    "program_source_id": run_id,
                    "program_implication": str(claim.implication or "").strip(),
                    "data_requirements": data_requirements,
                },
            }
        )
    if not claims:
        return None
    return WhitepaperResearchSource(
        run_id=run_id,
        title=str(source.title or "").strip() or run_id,
        source_url=str(source.url or "").strip(),
        published_at=str(source.published_at or "").strip(),
        claims=tuple(claims),
    )


def _program_whitepaper_sources(
    program: StrategyAutoresearchProgram,
) -> tuple[WhitepaperResearchSource, ...]:
    sources: list[WhitepaperResearchSource] = []
    for source in program.research_sources:
        converted = _program_research_source_to_whitepaper_source(source)
        if converted is not None:
            sources.append(converted)
    return tuple(sources)


def _dedupe_whitepaper_sources(
    sources: Sequence[WhitepaperResearchSource],
) -> list[WhitepaperResearchSource]:
    resolved: list[WhitepaperResearchSource] = []
    seen_run_ids: set[str] = set()
    for source in sources:
        run_id = str(source.run_id or "").strip()
        if not run_id or run_id in seen_run_ids:
            continue
        seen_run_ids.add(run_id)
        resolved.append(source)
    return resolved


def _load_sources_from_db(
    paper_run_ids: Sequence[str],
) -> list[WhitepaperResearchSource]:
    if not paper_run_ids:
        return []
    run_id_set = {item.strip() for item in paper_run_ids if item.strip()}
    with SessionLocal() as session:
        rows = session.execute(
            select(WhitepaperAnalysisRun).where(
                WhitepaperAnalysisRun.run_id.in_(sorted(run_id_set)),
                WhitepaperAnalysisRun.status == "completed",
            )
        ).scalars()
        sources: list[WhitepaperResearchSource] = []
        for row in rows:
            claims = [
                {
                    "claim_id": claim.claim_id,
                    "claim_type": claim.claim_type,
                    "claim_text": claim.claim_text,
                    "asset_scope": claim.asset_scope,
                    "horizon_scope": claim.horizon_scope,
                    "data_requirements": claim.data_requirements_json,
                    "expected_direction": claim.expected_direction,
                    "required_activity_conditions": claim.required_activity_conditions_json,
                    "liquidity_constraints": claim.liquidity_constraints_json,
                    "validation_notes": claim.validation_notes,
                    "confidence": str(claim.confidence)
                    if claim.confidence is not None
                    else None,
                    "metadata": claim.metadata_json,
                }
                for claim in row.claims
            ]
            relations = [
                {
                    "relation_id": relation.relation_id,
                    "relation_type": relation.relation_type,
                    "source_claim_id": relation.source_claim_id,
                    "target_claim_id": relation.target_claim_id,
                    "target_run_id": relation.target_run_id,
                    "rationale": relation.rationale,
                    "confidence": str(relation.confidence)
                    if relation.confidence is not None
                    else None,
                    "metadata": relation.metadata_json,
                }
                for relation in row.claim_relations
            ]
            sources.append(
                WhitepaperResearchSource(
                    run_id=row.run_id,
                    title=row.document.title or row.run_id,
                    source_url=str(
                        _mapping(row.document.metadata_json).get("source_url") or ""
                    ),
                    published_at=str(row.document.published_at or ""),
                    claims=tuple(claims),
                    claim_relations=tuple(relations),
                )
            )
        return sources


def _persist_vnext_specs(*, source_run_id: str, specs: Sequence[CandidateSpec]) -> None:
    with SessionLocal() as session:
        for spec in specs:
            session.add(
                VNextExperimentSpec(
                    run_id=source_run_id,
                    candidate_id=None,
                    experiment_id=f"{spec.candidate_spec_id}-exp",
                    payload_json=spec.to_vnext_experiment_payload(),
                )
            )
        session.commit()


def _persist_epoch_ledgers(
    *,
    epoch_id: str,
    status: str,
    target_net_pnl_per_day: Decimal,
    paper_run_ids: Sequence[str],
    sources: Sequence[WhitepaperResearchSource],
    candidate_specs: Sequence[CandidateSpec],
    candidate_blockers: Mapping[str, Sequence[CandidateCompilationBlocker]]
    | None = None,
    proposal_rows: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    summary: Mapping[str, Any],
    runner_config: Mapping[str, Any],
    started_at: datetime,
    completed_at: datetime,
    failure_reason: str | None = None,
) -> None:
    candidate_blockers = candidate_blockers or {}
    with SessionLocal() as session:
        session.add(
            AutoresearchEpoch(
                epoch_id=epoch_id,
                status=status,
                target_net_pnl_per_day=target_net_pnl_per_day,
                paper_run_ids_json=list(paper_run_ids),
                snapshot_manifest_json={
                    "source_count": len(sources),
                    "paper_sources": [source.to_payload() for source in sources],
                },
                runner_config_json=dict(runner_config),
                summary_json=dict(summary),
                started_at=started_at,
                completed_at=completed_at,
                failure_reason=failure_reason,
            )
        )
        for spec in candidate_specs:
            payload = spec.to_payload()
            blockers = [
                blocker.to_payload()
                for blocker in candidate_blockers.get(spec.candidate_spec_id, ())
            ]
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id=spec.candidate_spec_id,
                    epoch_id=epoch_id,
                    hypothesis_id=spec.hypothesis_id,
                    candidate_kind=spec.candidate_kind,
                    family_template_id=spec.family_template_id,
                    payload_json=payload,
                    payload_hash=_stable_hash(payload),
                    status="blocked" if blockers else "eligible",
                    blockers_json=blockers,
                )
            )
        for item in proposal_rows:
            candidate_spec_id = str(item.get("candidate_spec_id") or "").strip()
            if not candidate_spec_id:
                continue
            feature_payload = _mapping(item.get("features"))
            session.add(
                AutoresearchProposalScore(
                    epoch_id=epoch_id,
                    candidate_spec_id=candidate_spec_id,
                    model_id=str(item.get("model_id") or "unknown"),
                    backend=str(item.get("backend") or "unknown"),
                    proposal_score=_decimal(item.get("proposal_score")),
                    rank=int(item.get("rank") or 0),
                    selection_reason=str(item.get("selection_reason") or "unselected"),
                    feature_hash=_stable_hash(feature_payload)
                    if feature_payload
                    else None,
                    payload_json=dict(item),
                )
            )
        if portfolio is not None:
            portfolio_payload = portfolio.to_payload()
            promotion_readiness = _mapping(summary.get("promotion_readiness"))
            if promotion_readiness:
                portfolio_payload["promotion_readiness"] = dict(promotion_readiness)
            paper_probation_candidate = _mapping(
                _mapping(summary.get("candidate_board")).get(
                    "paper_probation_candidate"
                )
            )
            paper_probation_authorized = _boolish(
                paper_probation_candidate.get("paper_probation_authorized")
            )
            portfolio_status = "blocked"
            if bool(portfolio.objective_scorecard.get("oracle_passed")):
                portfolio_status = (
                    "promotion_ready"
                    if _boolish(promotion_readiness.get("promotable"))
                    else "target_met"
                )
            elif (
                _boolish(portfolio.objective_scorecard.get("target_met"))
                and paper_probation_authorized
            ):
                portfolio_status = "paper_probation"
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id=portfolio.portfolio_candidate_id,
                    epoch_id=epoch_id,
                    source_candidate_ids_json=list(portfolio.source_candidate_ids),
                    target_net_pnl_per_day=portfolio.target_net_pnl_per_day,
                    objective_scorecard_json=dict(portfolio.objective_scorecard),
                    optimizer_report_json=dict(portfolio.optimizer_report),
                    payload_json=portfolio_payload,
                    status=portfolio_status,
                )
            )
        session.commit()


__all__ = [
    "_load_recent_persisted_feedback_evidence_bundles",
    "_load_autoresearch_feedback_evidence_bundles",
    "_program_claim_type",
    "_program_research_source_to_whitepaper_source",
    "_program_whitepaper_sources",
    "_dedupe_whitepaper_sources",
    "_load_sources_from_db",
    "_persist_vnext_specs",
    "_persist_epoch_ledgers",
]
