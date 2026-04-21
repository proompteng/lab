#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import hashlib
import json
import signal
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    WhitepaperAnalysisRun,
    VNextExperimentSpec,
)
from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
    load_strategy_autoresearch_program,
    run_id,
)
from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.candidate_specs import candidate_spec_id_for_payload
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.mlx_snapshot import write_mlx_snapshot_manifest
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import (
    rank_training_rows,
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
    optimize_portfolio_candidate,
)
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)
from app.trading.discovery.whitepaper_autoresearch_notebooks import (
    write_whitepaper_autoresearch_diagnostics_notebook,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    CandidateCompilationBlocker,
    compile_whitepaper_candidate_specs,
)
from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    WhitepaperResearchSource,
    compile_sources_to_hypothesis_cards,
)

import scripts.run_strategy_factory_v2 as strategy_factory_runner


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run whitepaper autoresearch and assemble a portfolio candidate for a profit target.",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--paper-run-id", action="append", default=[])
    parser.add_argument("--seed-recent-whitepapers", action="store_true")
    parser.add_argument("--target-net-pnl-per-day", default="500")
    parser.add_argument("--max-candidates", type=int, default=64)
    parser.add_argument("--top-k", type=int, default=16)
    parser.add_argument("--exploration-slots", type=int, default=8)
    parser.add_argument("--portfolio-size-min", type=int, default=2)
    parser.add_argument("--portfolio-size-max", type=int, default=8)
    parser.add_argument("--replay-mode", choices=("synthetic", "real"), default="real")
    parser.add_argument(
        "--program",
        type=Path,
        default=Path(
            "config/trading/research-programs/strict-daily-profit-autoresearch-v1.yaml"
        ),
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=Path("argocd/applications/torghut/strategy-configmap.yaml"),
    )
    parser.add_argument(
        "--family-template-dir",
        type=Path,
        default=Path("config/trading/families"),
    )
    parser.add_argument(
        "--seed-sweep-dir",
        type=Path,
        default=Path("config/trading"),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
    )
    parser.add_argument("--clickhouse-username", default="torghut")
    parser.add_argument("--clickhouse-password", default="")
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default="AAPL,NVDA,MSFT,AMAT")
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument("--max-frontier-candidates-per-spec", type=int, default=64)
    parser.add_argument("--real-replay-timeout-seconds", type=int, default=0)
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument("--expected-last-trading-day", default="")
    parser.add_argument("--allow-stale-tape", action="store_true")
    parser.add_argument("--prefetch-full-window-rows", action="store_true")
    parser.add_argument("--min-active-day-ratio", default="0.90")
    parser.add_argument("--min-positive-day-ratio", default="0.60")
    parser.add_argument("--max-worst-day-loss", default="350")
    parser.add_argument("--max-drawdown", default="900")
    parser.add_argument("--max-best-day-share", default="0.25")
    parser.add_argument("--max-cluster-contribution-share", default="0.40")
    parser.add_argument("--max-single-symbol-contribution-share", default="0.35")
    parser.add_argument("--min-avg-filled-notional-per-day", default="300000")
    parser.add_argument("--min-regime-slice-pass-rate", default="0.45")
    parser.add_argument(
        "--require-no-flat-days",
        action="store_true",
        help="Require every evaluated trading day to be active and positive at portfolio oracle time.",
    )
    parser.add_argument(
        "--persist-results", dest="persist_results", action="store_true"
    )
    parser.add_argument(
        "--no-persist-results", dest="persist_results", action="store_false"
    )
    parser.set_defaults(persist_results=True)
    return parser.parse_args()


@dataclass(frozen=True)
class EpochReplayResult:
    evidence_bundles: tuple[CandidateEvidenceBundle, ...]
    replay_results: tuple[Mapping[str, Any], ...]


def _write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, sort_keys=True) for row in rows)
        + ("\n" if rows else ""),
        encoding="utf-8",
    )
    return path


def _resolve_existing_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if path.is_absolute() or resolved.exists():
        return resolved
    for parent in Path(__file__).resolve().parents:
        candidate = (parent / path).resolve()
        if candidate.exists():
            return candidate
    return resolved


def _write_failure_summary(
    *,
    output_dir: Path,
    epoch_id: str,
    status: str,
    reason: str,
    started_at: datetime,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    summary = {
        "status": status,
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "failure_reason": reason,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
    }
    if extra:
        summary.update(dict(extra))
    _write_json(output_dir / "error-summary.json", summary)
    _write_json(output_dir / "summary.json", summary)
    return summary


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _string(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _list_of_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        cast(Mapping[str, Any], item) for item in value if isinstance(item, Mapping)
    ]


def _rank_sort_value(value: Any) -> int:
    try:
        return int(str(value))
    except Exception:
        return 10**9


def _proposal_sort_value(value: Any) -> float:
    try:
        return float(str(value))
    except Exception:
        return 0.0


def _oracle_policy_from_args(args: argparse.Namespace) -> ProfitTargetOraclePolicy:
    min_active_day_ratio = _decimal(
        getattr(args, "min_active_day_ratio", "0.90"), default="0.90"
    )
    min_positive_day_ratio = _decimal(
        getattr(args, "min_positive_day_ratio", "0.60"), default="0.60"
    )
    max_worst_day_loss = _decimal(
        getattr(args, "max_worst_day_loss", "350"), default="350"
    )
    max_drawdown = _decimal(getattr(args, "max_drawdown", "900"), default="900")
    if bool(getattr(args, "require_no_flat_days", False)):
        min_active_day_ratio = max(min_active_day_ratio, Decimal("1"))
        min_positive_day_ratio = max(min_positive_day_ratio, Decimal("1"))
        max_worst_day_loss = min(max_worst_day_loss, Decimal("0"))
        max_drawdown = min(max_drawdown, Decimal("0"))
    return ProfitTargetOraclePolicy(
        min_active_day_ratio=min_active_day_ratio,
        min_positive_day_ratio=min_positive_day_ratio,
        max_worst_day_loss=max_worst_day_loss,
        max_drawdown=max_drawdown,
        max_best_day_share=_decimal(
            getattr(args, "max_best_day_share", "0.25"), default="0.25"
        ),
        max_cluster_contribution_share=_decimal(
            getattr(args, "max_cluster_contribution_share", "0.40"), default="0.40"
        ),
        max_single_symbol_contribution_share=_decimal(
            getattr(args, "max_single_symbol_contribution_share", "0.35"),
            default="0.35",
        ),
        min_avg_filled_notional_per_day=_decimal(
            getattr(args, "min_avg_filled_notional_per_day", "300000"),
            default="300000",
        ),
        min_regime_slice_pass_rate=_decimal(
            getattr(args, "min_regime_slice_pass_rate", "0.45"), default="0.45"
        ),
    )


def _candidate_spec_with_oracle_policy(
    spec: CandidateSpec, *, oracle_policy: ProfitTargetOraclePolicy
) -> CandidateSpec:
    objective = {
        **dict(spec.objective),
        "require_positive_day_ratio": str(oracle_policy.min_positive_day_ratio),
    }
    hard_vetoes = {
        **dict(spec.hard_vetoes),
        "required_min_active_day_ratio": str(oracle_policy.min_active_day_ratio),
        "required_min_daily_notional": str(
            oracle_policy.min_avg_filled_notional_per_day
        ),
        "required_max_best_day_share": str(oracle_policy.max_best_day_share),
        "required_max_worst_day_loss": str(oracle_policy.max_worst_day_loss),
        "required_max_drawdown": str(oracle_policy.max_drawdown),
        "required_min_regime_slice_pass_rate": str(
            oracle_policy.min_regime_slice_pass_rate
        ),
    }
    base_payload = {
        "hypothesis_id": spec.hypothesis_id,
        "family_template_id": spec.family_template_id,
        "feature_contract": dict(spec.feature_contract),
        "objective": objective,
    }
    return replace(
        spec,
        candidate_spec_id=candidate_spec_id_for_payload(base_payload),
        objective=objective,
        hard_vetoes=hard_vetoes,
        promotion_contract={
            **dict(spec.promotion_contract),
            "profit_target_oracle_policy": oracle_policy.to_payload(),
        },
    )


def _candidate_specs_with_oracle_policy(
    specs: Sequence[CandidateSpec], *, oracle_policy: ProfitTargetOraclePolicy
) -> list[CandidateSpec]:
    return [
        _candidate_spec_with_oracle_policy(spec, oracle_policy=oracle_policy)
        for spec in specs
    ]


def _load_sources_from_db(
    paper_run_ids: Sequence[str],
) -> list[WhitepaperResearchSource]:
    if not paper_run_ids:
        return []
    run_id_set = {item.strip() for item in paper_run_ids if item.strip()}
    with SessionLocal() as session:
        rows = session.execute(
            select(WhitepaperAnalysisRun).where(
                WhitepaperAnalysisRun.run_id.in_(sorted(run_id_set))
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
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id=portfolio.portfolio_candidate_id,
                    epoch_id=epoch_id,
                    source_candidate_ids_json=list(portfolio.source_candidate_ids),
                    target_net_pnl_per_day=portfolio.target_net_pnl_per_day,
                    objective_scorecard_json=dict(portfolio.objective_scorecard),
                    optimizer_report_json=dict(portfolio.optimizer_report),
                    payload_json=portfolio_payload,
                    status="target_met"
                    if bool(portfolio.objective_scorecard.get("target_met"))
                    else "target_missed",
                )
            )
        session.commit()


def _proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    replay_selection_by_spec: Mapping[str, Mapping[str, Any]] | None = None,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=evidence_bundles
    )
    model = train_mlx_ranker(training_rows, backend_preference="mlx")
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    net_by_spec = {
        bundle.candidate_spec_id: float(
            _decimal(bundle.objective_scorecard.get("net_pnl_per_day"))
        )
        for bundle in evidence_bundles
    }
    policy_result = rank_training_rows_with_lift_policy(
        model=model,
        rows=training_rows,
        metric_name="net_pnl_per_day",
        outcome_by_spec=net_by_spec,
    )
    proposal_rows = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": item.score,
            "rank": item.rank,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": policy_result.selection_reason,
            "replay_selection_reason": _mapping(
                replay_selection_by_spec.get(item.candidate_spec_id)
                if replay_selection_by_spec is not None
                else None
            ).get("selection_reason", "not_selected_budget"),
            "selected_for_replay": bool(
                _mapping(
                    replay_selection_by_spec.get(item.candidate_spec_id)
                    if replay_selection_by_spec is not None
                    else None
                ).get("selected_for_replay")
            ),
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in policy_result.ranked_rows
    ]
    model_payload = {
        **model.to_payload(),
        "rank_bucket_lift": policy_result.rank_bucket_lift.to_payload(),
        "model_status": policy_result.model_status,
    }
    return model_payload, proposal_rows


def _candidate_quality_gate_failures(
    scorecard: Mapping[str, Any], *, oracle_policy: ProfitTargetOraclePolicy
) -> list[str]:
    failures: list[str] = []
    if _decimal(scorecard.get("net_pnl_per_day")) <= 0:
        failures.append("non_positive_net_pnl_per_day")
    if _decimal(scorecard.get("active_day_ratio")) < oracle_policy.min_active_day_ratio:
        failures.append("active_day_ratio_below_oracle")
    if (
        _decimal(scorecard.get("positive_day_ratio"))
        < oracle_policy.min_positive_day_ratio
    ):
        failures.append("positive_day_ratio_below_oracle")
    if (
        _decimal(scorecard.get("best_day_share"), default="1")
        > oracle_policy.max_best_day_share
    ):
        failures.append("best_day_share_above_oracle")
    if (
        _decimal(scorecard.get("worst_day_loss"), default="999999")
        > oracle_policy.max_worst_day_loss
    ):
        failures.append("worst_day_loss_above_oracle")
    if (
        _decimal(scorecard.get("max_drawdown"), default="999999")
        > oracle_policy.max_drawdown
    ):
        failures.append("max_drawdown_above_oracle")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < oracle_policy.min_avg_filled_notional_per_day
    ):
        failures.append("avg_filled_notional_per_day_below_oracle")
    if (
        _decimal(scorecard.get("regime_slice_pass_rate"))
        < oracle_policy.min_regime_slice_pass_rate
    ):
        failures.append("regime_slice_pass_rate_below_oracle")
    if (
        _decimal(scorecard.get("posterior_edge_lower"))
        <= oracle_policy.min_posterior_edge_lower
    ):
        failures.append("posterior_edge_lower_non_positive")
    if _string(scorecard.get("shadow_parity_status")) != "within_budget":
        failures.append("shadow_parity_status_not_within_budget")
    return failures


def _false_positive_table(
    *,
    proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    oracle_policy: ProfitTargetOraclePolicy,
    limit: int = 16,
) -> list[dict[str, Any]]:
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows: list[dict[str, Any]] = []
    for proposal in _list_of_mappings(list(proposal_rows)):
        candidate_spec_id = _string(proposal.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(proposal.get("selected_for_replay")):
            continue
        evidence = evidence_by_spec.get(candidate_spec_id)
        if evidence is None:
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "rank": _rank_sort_value(proposal.get("rank")),
                    "proposal_score": proposal.get("proposal_score"),
                    "replay_selection_reason": _string(
                        proposal.get("replay_selection_reason")
                    )
                    or "selected_for_replay",
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                }
            )
            continue
        scorecard = evidence.objective_scorecard
        failure_reasons = _candidate_quality_gate_failures(
            scorecard, oracle_policy=oracle_policy
        )
        if not failure_reasons:
            continue
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id,
                "rank": _rank_sort_value(proposal.get("rank")),
                "proposal_score": proposal.get("proposal_score"),
                "replay_selection_reason": _string(
                    proposal.get("replay_selection_reason")
                )
                or "selected_for_replay",
                "evidence_status": "replayed",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "best_day_share": _string(scorecard.get("best_day_share")),
                "worst_day_loss": _string(scorecard.get("worst_day_loss")),
                "max_drawdown": _string(scorecard.get("max_drawdown")),
                "avg_filled_notional_per_day": _string(
                    scorecard.get("avg_filled_notional_per_day")
                ),
                "regime_slice_pass_rate": _string(
                    scorecard.get("regime_slice_pass_rate")
                ),
                "posterior_edge_lower": _string(scorecard.get("posterior_edge_lower")),
                "shadow_parity_status": _string(scorecard.get("shadow_parity_status")),
                "failure_reasons": failure_reasons,
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    return rows[: max(0, limit)]


def _best_false_negative_table(
    *,
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    limit: int = 16,
) -> list[dict[str, Any]]:
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    pre_replay_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(pre_replay_proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if (
            not candidate_spec_id
            or bool(selection.get("selected_for_replay"))
            or candidate_spec_id in evidence_by_spec
        ):
            continue
        pre_replay = pre_replay_by_spec.get(candidate_spec_id, {})
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "proposal_score": pre_replay.get("proposal_score"),
                "selection_reason": _string(selection.get("selection_reason"))
                or "not_selected_budget",
                "selected_for_replay": False,
                "evidence_status": "not_replayed",
                "reason": "not_replayed_budget",
            }
        )
    rows.sort(
        key=lambda row: (
            _rank_sort_value(row.get("rank")),
            -_proposal_sort_value(row.get("proposal_score")),
            _string(row.get("candidate_spec_id")),
        )
    )
    return rows[: max(0, limit)]


def _pre_replay_candidate_score(spec: CandidateSpec) -> Decimal:
    family_score = {
        "microbar_cross_sectional_pairs_v1": Decimal("70"),
        "microstructure_continuation_matched_filter_v1": Decimal("65"),
        "momentum_pullback_v1": Decimal("60"),
        "washout_rebound_v2": Decimal("55"),
        "breakout_reclaim_v2": Decimal("50"),
        "mean_reversion_rebound_v1": Decimal("45"),
    }.get(spec.family_template_id, Decimal("40"))
    required_features = spec.feature_contract.get("required_features")
    feature_count = (
        len(cast(Sequence[Any], required_features))
        if isinstance(required_features, Sequence)
        and not isinstance(required_features, str)
        else 0
    )
    failure_penalty = Decimal(len(spec.expected_failure_modes)) * Decimal("0.25")
    return family_score + Decimal(feature_count) - failure_penalty


def _pre_replay_prior_bundle(spec: CandidateSpec) -> CandidateEvidenceBundle:
    prior_score = _pre_replay_candidate_score(spec)
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=spec.candidate_spec_id,
        candidate={
            "candidate_id": f"pre-replay-prior-{spec.candidate_spec_id}",
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "objective_scorecard": {
                "net_pnl_per_day": str(prior_score),
                "active_day_ratio": "0.50",
                "positive_day_ratio": "0.50",
                "regime_slice_pass_rate": "0.45",
                "posterior_edge_lower": "0.001",
                "shadow_parity_status": "pending",
            },
            "promotion_readiness": {
                "stage": "research_candidate",
                "status": "pre_replay_prior",
                "promotable": False,
                "blockers": ["runtime_replay_required"],
            },
        },
        dataset_snapshot_id="pre-replay-proposal-priors",
        result_path=f"pre-replay-proposal-priors://{spec.candidate_spec_id}",
    )


def _pre_replay_proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    prior_bundles = [_pre_replay_prior_bundle(spec) for spec in specs]
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=prior_bundles
    )
    model = train_mlx_ranker(training_rows, backend_preference="mlx")
    ranked_rows = rank_training_rows(model=model, rows=training_rows)
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    rows = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": item.score,
            "rank": item.rank,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": "pre_replay_mlx_rank",
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in ranked_rows
    ]
    return {
        **model.to_payload(),
        "proposal_stage": "pre_replay",
        "model_status": "active",
        "rank_bucket_lift": {"status": "pending_replay_evidence"},
    }, rows


def _proposal_score_confidence(
    proposal_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    scores = [
        Decimal(str(row.get("proposal_score")))
        for row in _list_of_mappings(list(proposal_rows))
        if row.get("proposal_score") is not None
    ]
    if len(scores) < 2:
        return {
            "confidence": "low",
            "score_spread": "0",
            "reason": "insufficient_ranked_candidates",
        }
    score_spread = max(scores) - min(scores)
    confidence = "low" if score_spread < Decimal("5") else "normal"
    return {
        "confidence": confidence,
        "score_spread": str(score_spread),
        "reason": "low_score_dispersion"
        if confidence == "low"
        else "score_dispersion_sufficient",
    }


def _select_candidate_specs_for_replay(
    *,
    specs: Sequence[CandidateSpec],
    proposal_rows: Sequence[Mapping[str, Any]],
    top_k: int,
    exploration_slots: int,
    max_candidates: int,
    portfolio_size_min: int,
) -> tuple[list[CandidateSpec], dict[str, Any]]:
    if not specs:
        return [], {
            "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
            "selected_candidate_spec_ids": [],
            "rows": [],
        }
    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
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
                int(row.get("rank") or 10**9),
                -float(row.get("proposal_score") or 0.0),
                str(row.get("candidate_spec_id") or ""),
            ),
        )
        if str(row.get("candidate_spec_id")) in spec_by_id
    ]
    ranked_ids.extend(
        spec.candidate_spec_id
        for spec in sorted(specs, key=lambda item: item.candidate_spec_id)
        if spec.candidate_spec_id not in set(ranked_ids)
    )
    ordered = [spec_by_id[candidate_spec_id] for candidate_spec_id in ranked_ids]
    exploitation_count = min(max(0, int(top_k)), replay_budget, len(ranked_ids))
    exploitation = [
        spec_by_id[candidate_spec_id]
        for candidate_spec_id in ranked_ids[:exploitation_count]
    ]

    def spec_source_run_id(spec: CandidateSpec) -> str:
        return _string(spec.feature_contract.get("source_run_id")) or spec.hypothesis_id

    def diversity_key(
        spec: CandidateSpec, selected_so_far: Sequence[CandidateSpec]
    ) -> tuple[bool, bool, int, str]:
        selected_families = {item.family_template_id for item in selected_so_far}
        selected_sources = {spec_source_run_id(item) for item in selected_so_far}
        family_selection = _mapping(spec.feature_contract.get("family_selection"))
        return (
            spec.family_template_id in selected_families,
            spec_source_run_id(spec) in selected_sources,
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

    remaining = [
        item
        for item in sorted(specs, key=lambda spec: diversity_key(spec, exploitation))
        if item.candidate_spec_id
        not in {spec.candidate_spec_id for spec in exploitation}
    ]
    exploration_count = min(
        effective_exploration_slots,
        replay_budget - len(exploitation),
        len(remaining),
    )
    exploration = take_diverse(
        remaining,
        count=exploration_count,
        selected_so_far=exploitation,
    )
    if len(exploitation) + len(exploration) < replay_budget:
        selected_ids = {
            item.candidate_spec_id for item in (*exploitation, *exploration)
        }
        backfill_candidates = [
            item for item in ordered if item.candidate_spec_id not in selected_ids
        ]
        backfill = take_diverse(
            backfill_candidates,
            count=replay_budget - len(exploitation) - len(exploration),
            selected_so_far=[*exploitation, *exploration],
        )
    else:
        backfill = []
    selected_reason = {
        item.candidate_spec_id: "exploitation" for item in exploitation
    } | {item.candidate_spec_id: "exploration" for item in exploration}
    selected_reason.update(
        {item.candidate_spec_id: "budget_backfill" for item in backfill}
    )
    selected_ids = {
        item.candidate_spec_id for item in (*exploitation, *exploration, *backfill)
    }
    selected = [item for item in specs if item.candidate_spec_id in selected_ids]
    rows = [
        {
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "pre_replay_score": str(_pre_replay_candidate_score(spec)),
            "rank": index,
            "selected_for_replay": spec.candidate_spec_id in selected_ids,
            "selection_reason": selected_reason.get(
                spec.candidate_spec_id, "not_selected_budget"
            ),
            "selection_hash": _stable_hash(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "score": str(_pre_replay_candidate_score(spec)),
                    "selected": spec.candidate_spec_id in selected_ids,
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
            "portfolio_size_min": max(1, int(portfolio_size_min)),
            "selected_count": len(selected),
            "compiled_candidate_count": len(specs),
        },
        "proposal_score_confidence": model_confidence,
        "selected_candidate_spec_ids": [item.candidate_spec_id for item in selected],
        "rows": rows,
    }


def _synthetic_net_for_spec(spec: CandidateSpec, *, rank: int) -> Decimal:
    family_bonus = {
        "microbar_cross_sectional_pairs_v1": Decimal("215"),
        "microstructure_continuation_matched_filter_v1": Decimal("190"),
        "momentum_pullback_v1": Decimal("175"),
        "washout_rebound_v2": Decimal("165"),
        "breakout_reclaim_v2": Decimal("155"),
    }.get(spec.family_template_id, Decimal("125"))
    return family_bonus + Decimal(max(0, 12 - rank) * 5)


def _synthetic_candidate_payload(spec: CandidateSpec, *, rank: int) -> dict[str, Any]:
    net = _synthetic_net_for_spec(spec, rank=rank)
    active = Decimal("0.92") if rank <= 3 else Decimal("0.82")
    positive = Decimal("0.64") if rank <= 3 else Decimal("0.58")
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
            "symbol_contribution_shares": {
                "AAPL": "0.25",
                "NVDA": "0.25",
                "MSFT": "0.25",
                "AMAT": "0.25",
            },
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
        symbols=args.symbols,
        progress_log_seconds=args.progress_log_seconds,
        train_days=args.train_days,
        holdout_days=args.holdout_days,
        full_window_start_date=args.full_window_start_date,
        full_window_end_date=args.full_window_end_date,
        expected_last_trading_day=args.expected_last_trading_day,
        allow_stale_tape=args.allow_stale_tape,
        prefetch_full_window_rows=args.prefetch_full_window_rows,
        top_n=args.top_k,
        max_candidates_to_evaluate=getattr(
            args, "max_frontier_candidates_per_spec", 64
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
    return _real_replay_result_from_factory_payload(factory_payload)


def _real_replay_result_from_factory_payload(
    factory_payload: Mapping[str, Any],
) -> EpochReplayResult:
    evidence_bundles: list[CandidateEvidenceBundle] = []
    for item in _list_of_mappings(factory_payload.get("experiments")):
        result_path = str(item.get("result_path") or "")
        if not result_path:
            continue
        result_payload = json.loads(Path(result_path).read_text(encoding="utf-8"))
        top = _list_of_mappings(result_payload.get("top"))
        if not top:
            continue
        candidate = dict(top[0])
        candidate_spec_id = _string(item.get("candidate_spec_id")) or _string(
            candidate.get("candidate_spec_id")
        )
        if candidate_spec_id:
            candidate["candidate_spec_id"] = candidate_spec_id
        candidate["promotion_readiness"] = item.get("promotion_readiness")
        evidence_bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=candidate_spec_id
                or str(item.get("experiment_id") or item.get("top_candidate_id") or ""),
                candidate=candidate,
                dataset_snapshot_id=str(item.get("dataset_snapshot_id") or ""),
                result_path=result_path,
            )
        )
    return EpochReplayResult(
        evidence_bundles=tuple(evidence_bundles), replay_results=(factory_payload,)
    )


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
        }
    )


def _run_replay_with_optional_timeout(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
) -> EpochReplayResult:
    timeout_seconds = max(0, int(getattr(args, "real_replay_timeout_seconds", 0) or 0))
    if args.replay_mode == "synthetic" or timeout_seconds <= 0:
        return (
            _run_synthetic_replay(
                specs=specs,
                output_dir=output_dir,
                max_candidates=len(specs),
            )
            if args.replay_mode == "synthetic"
            else _run_real_replay(args, output_dir=output_dir, specs=specs)
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


def _load_epoch_program(args: argparse.Namespace) -> StrategyAutoresearchProgram:
    program = load_strategy_autoresearch_program(
        _resolve_existing_path(args.program),
        family_dir=_resolve_existing_path(args.family_template_dir),
    )
    if args.replay_mode == "synthetic":
        return replace(
            program,
            runtime_closure_policy=replace(
                program.runtime_closure_policy,
                execute_parity_replay=False,
                execute_approval_replay=False,
            ),
        )
    return program


def _epoch_mlx_snapshot_manifest(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    program: StrategyAutoresearchProgram,
    source_count: int,
    hypothesis_count: int,
    candidate_spec_count: int,
    pre_replay_proposal_score_count: int,
    replay_candidate_spec_count: int,
    evidence_bundle_count: int,
    proposal_score_count: int,
    portfolio_candidate_count: int,
) -> MlxSnapshotManifest:
    return build_mlx_snapshot_manifest(
        runner_run_id=epoch_id,
        program=program,
        symbols=str(args.symbols),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        tensor_bundle_paths={
            "hypothesis_cards_jsonl": str(output_dir / "hypothesis-cards.jsonl"),
            "candidate_specs_jsonl": str(output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest_json": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "pre_replay_proposal_scores_jsonl": str(
                output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "proposal_scores_jsonl": str(output_dir / "mlx-proposal-scores.jsonl"),
            "candidate_evidence_bundles_jsonl": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates_jsonl": str(
                output_dir / "portfolio-candidates.jsonl"
            ),
        },
        row_counts={
            "sources": source_count,
            "hypothesis_cards": hypothesis_count,
            "candidate_specs": candidate_spec_count,
            "pre_replay_proposal_scores": pre_replay_proposal_score_count,
            "replay_candidate_specs": replay_candidate_spec_count,
            "candidate_evidence_bundles": evidence_bundle_count,
            "proposal_scores": proposal_score_count,
            "portfolio_candidates": portfolio_candidate_count,
        },
    )


def _runtime_closure_payload(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    program: StrategyAutoresearchProgram,
    manifest: MlxSnapshotManifest,
    portfolio: PortfolioCandidateSpec | None,
) -> Mapping[str, Any]:
    execution_context = RuntimeClosureExecutionContext(
        strategy_configmap_path=_resolve_existing_path(args.strategy_configmap),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=str(args.clickhouse_username)
        if args.clickhouse_username
        else None,
        clickhouse_password=str(args.clickhouse_password)
        if args.clickhouse_password
        else None,
        start_equity=_decimal(args.start_equity, default="31590.02"),
        chunk_minutes=int(args.chunk_minutes),
        symbols=tuple(
            symbol.strip() for symbol in str(args.symbols).split(",") if symbol.strip()
        ),
        progress_log_interval_seconds=int(args.progress_log_seconds),
    )
    return write_runtime_closure_bundle(
        run_root=output_dir,
        runner_run_id=epoch_id,
        program=program,
        best_candidate=portfolio,
        manifest=manifest,
        execution_context=execution_context if portfolio is not None else None,
    ).to_payload()


def run_whitepaper_autoresearch_profit_target(
    args: argparse.Namespace,
) -> dict[str, Any]:
    epoch_id = run_id("whitepaper-autoresearch")
    started_at = datetime.now(UTC)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target = _decimal(args.target_net_pnl_per_day, default="500")
    oracle_policy = _oracle_policy_from_args(args)
    sources = []
    if args.seed_recent_whitepapers:
        sources.extend(RECENT_WHITEPAPER_SEEDS)
    sources.extend(_load_sources_from_db(args.paper_run_id))
    if not sources:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="no_sources",
            reason="no_whitepaper_sources",
            started_at=started_at,
        )

    hypothesis_cards: list[HypothesisCard] = compile_sources_to_hypothesis_cards(
        sources
    )
    compilation = compile_whitepaper_candidate_specs(
        hypothesis_cards=hypothesis_cards,
        target_net_pnl_per_day=target,
        family_template_dir=args.family_template_dir.resolve(),
        seed_sweep_dir=args.seed_sweep_dir.resolve(),
    )
    candidate_specs = list(compilation.executable_specs)
    candidate_specs = _candidate_specs_with_oracle_policy(
        candidate_specs, oracle_policy=oracle_policy
    )
    candidate_specs = candidate_specs[: max(1, int(args.max_candidates))]
    blocker_by_spec: dict[str, list[CandidateCompilationBlocker]] = {}
    for blocker in compilation.blockers:
        blocker_by_spec.setdefault(blocker.candidate_spec_id, []).append(blocker)
    if args.persist_results and args.replay_mode == "real":
        for source in sources:
            source_specs = [
                spec
                for spec in candidate_specs
                if spec.feature_contract.get("source_run_id") == source.run_id
            ]
            _persist_vnext_specs(source_run_id=source.run_id, specs=source_specs)

    _write_json(
        output_dir / "epoch-manifest.json",
        {
            "epoch_id": epoch_id,
            "started_at": datetime.now(UTC).isoformat(),
            "target_net_pnl_per_day": str(target),
            "replay_mode": args.replay_mode,
            "source_count": len(sources),
            "paper_sources": [source.to_payload() for source in sources],
        },
    )
    _write_jsonl(
        output_dir / "hypothesis-cards.jsonl",
        [card.to_payload() for card in hypothesis_cards],
    )
    _write_jsonl(
        output_dir / "candidate-specs.jsonl",
        [spec.to_payload() for spec in candidate_specs],
    )
    _write_json(output_dir / "candidate-compiler-report.json", compilation.to_payload())

    if not candidate_specs:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="no_eligible_candidates",
            reason="candidate_compiler_produced_no_executable_specs",
            started_at=started_at,
        )
    pre_replay_model, pre_replay_proposal_rows = _pre_replay_proposal_model_and_rows(
        specs=candidate_specs
    )
    _write_json(output_dir / "pre-replay-mlx-ranker-model.json", pre_replay_model)
    _write_jsonl(
        output_dir / "pre-replay-mlx-proposal-scores.jsonl",
        pre_replay_proposal_rows,
    )
    replay_candidate_specs, candidate_selection = _select_candidate_specs_for_replay(
        specs=candidate_specs,
        proposal_rows=pre_replay_proposal_rows,
        top_k=int(args.top_k),
        exploration_slots=int(args.exploration_slots),
        max_candidates=int(args.max_candidates),
        portfolio_size_min=int(args.portfolio_size_min),
    )
    candidate_selection = {
        **candidate_selection,
        "proposal_model": {
            "schema_version": pre_replay_model.get("schema_version"),
            "model_id": pre_replay_model.get("model_id"),
            "backend": pre_replay_model.get("backend"),
            "proposal_stage": "pre_replay",
        },
        "proposal_scores_artifact": str(
            output_dir / "pre-replay-mlx-proposal-scores.jsonl"
        ),
    }
    _write_json(output_dir / "candidate-selection-manifest.json", candidate_selection)
    selection_by_spec = {
        str(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(candidate_selection.get("rows"))
    }
    replay_args = argparse.Namespace(
        **{
            **vars(args),
            "max_candidates": len(replay_candidate_specs),
            "top_k": min(int(args.top_k), len(replay_candidate_specs)),
        }
    )
    try:
        replay_result = _run_replay_with_optional_timeout(
            args=replay_args,
            output_dir=output_dir,
            specs=replay_candidate_specs,
        )
    except Exception as exc:
        partial_replay_result = (
            _collect_partial_real_replay(
                output_dir=output_dir, specs=replay_candidate_specs
            )
            if args.replay_mode == "real"
            else EpochReplayResult(evidence_bundles=(), replay_results=())
        )
        partial_artifact_path = output_dir / "candidate-evidence-bundles.partial.jsonl"
        if partial_replay_result.evidence_bundles:
            _write_jsonl(
                partial_artifact_path,
                [
                    bundle.to_payload()
                    for bundle in partial_replay_result.evidence_bundles
                ],
            )
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_failed",
            reason=f"{type(exc).__name__}:{exc}",
            started_at=started_at,
            extra={
                "partial_evidence_bundle_count": len(
                    partial_replay_result.evidence_bundles
                ),
                "partial_replay_result_count": len(
                    partial_replay_result.replay_results
                ),
                "partial_artifacts": {
                    "candidate_evidence_bundles": str(partial_artifact_path)
                    if partial_replay_result.evidence_bundles
                    else None,
                    "strategy_factory_dir": str(output_dir / "strategy-factory"),
                },
                "false_positive_table": _false_positive_table(
                    proposal_rows=pre_replay_proposal_rows,
                    evidence_bundles=partial_replay_result.evidence_bundles,
                    oracle_policy=oracle_policy,
                )
                if partial_replay_result.evidence_bundles
                else [],
                "best_false_negative_table": _best_false_negative_table(
                    candidate_selection=candidate_selection,
                    pre_replay_proposal_rows=pre_replay_proposal_rows,
                    evidence_bundles=partial_replay_result.evidence_bundles,
                ),
            },
        )
    proposal_model, proposal_rows = _proposal_model_and_rows(
        specs=candidate_specs,
        evidence_bundles=replay_result.evidence_bundles,
        replay_selection_by_spec=selection_by_spec,
    )
    _write_json(output_dir / "mlx-ranker-model.json", proposal_model)
    _write_jsonl(output_dir / "mlx-proposal-scores.jsonl", proposal_rows)
    _write_jsonl(
        output_dir / "candidate-evidence-bundles.jsonl",
        [bundle.to_payload() for bundle in replay_result.evidence_bundles],
    )

    portfolio = optimize_portfolio_candidate(
        evidence_bundles=replay_result.evidence_bundles,
        target_net_pnl_per_day=target,
        oracle_policy=oracle_policy,
        portfolio_size_min=int(args.portfolio_size_min),
        portfolio_size_max=int(args.portfolio_size_max),
    )
    portfolio_rows = [portfolio.to_payload()] if portfolio is not None else []
    _write_jsonl(output_dir / "portfolio-candidates.jsonl", portfolio_rows)
    _write_json(
        output_dir / "portfolio-optimizer-report.json",
        portfolio.optimizer_report
        if portfolio is not None
        else {"status": "no_portfolio_candidate"},
    )
    program = _load_epoch_program(args)
    mlx_snapshot_manifest = _epoch_mlx_snapshot_manifest(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=program,
        source_count=len(sources),
        hypothesis_count=len(hypothesis_cards),
        candidate_spec_count=len(candidate_specs),
        pre_replay_proposal_score_count=len(pre_replay_proposal_rows),
        replay_candidate_spec_count=len(replay_candidate_specs),
        evidence_bundle_count=len(replay_result.evidence_bundles),
        proposal_score_count=len(proposal_rows),
        portfolio_candidate_count=len(portfolio_rows),
    )
    write_mlx_snapshot_manifest(
        output_dir / "mlx-snapshot-manifest.json", mlx_snapshot_manifest
    )
    runtime_closure = _runtime_closure_payload(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
    )
    oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
    )
    profit_target_oracle = (
        portfolio.objective_scorecard.get("profit_target_oracle")
        if portfolio is not None
        else None
    )
    status = "ok" if oracle_candidate_found else "no_profit_target_candidate"
    status_reason = None
    if not oracle_candidate_found:
        if portfolio is None:
            status_reason = "portfolio_optimizer_produced_no_candidate"
        else:
            status_reason = "portfolio_candidate_failed_profit_target_oracle"
    false_positive_table = _false_positive_table(
        proposal_rows=proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
        oracle_policy=oracle_policy,
    )
    best_false_negative_table = _best_false_negative_table(
        candidate_selection=candidate_selection,
        pre_replay_proposal_rows=pre_replay_proposal_rows,
        evidence_bundles=replay_result.evidence_bundles,
    )
    summary = {
        "status": status,
        "status_reason": status_reason,
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "target_net_pnl_per_day": str(target),
        "profit_target_oracle_policy": oracle_policy.to_payload(),
        "source_count": len(sources),
        "hypothesis_count": len(hypothesis_cards),
        "candidate_spec_count": len(candidate_specs),
        "candidate_compiler_blocker_count": len(compilation.blockers),
        "evidence_bundle_count": len(replay_result.evidence_bundles),
        "replay_candidate_spec_count": len(replay_candidate_specs),
        "pre_replay_proposal_score_count": len(pre_replay_proposal_rows),
        "proposal_score_count": len(proposal_rows),
        "portfolio_candidate_count": len(portfolio_rows),
        "claim_count": sum(len(source.claims) for source in sources),
        "mlx_rank_bucket_lift": proposal_model.get("rank_bucket_lift", {}),
        "false_positive_table": false_positive_table,
        "best_false_negative_table": best_false_negative_table,
        "best_portfolio_candidate": portfolio.to_payload()
        if portfolio is not None
        else None,
        "oracle_candidate_found": oracle_candidate_found,
        "profit_target_oracle": profit_target_oracle,
        "promotion_readiness": {
            "status": "blocked_pending_runtime_parity"
            if portfolio is not None
            else "no_candidate",
            "promotable": False,
            "blockers": ["scheduler_v3_parity_missing", "shadow_validation_missing"]
            if portfolio is not None
            else [],
        },
        "runtime_closure": runtime_closure,
        "artifacts": {
            "epoch_manifest": str(output_dir / "epoch-manifest.json"),
            "hypothesis_cards": str(output_dir / "hypothesis-cards.jsonl"),
            "candidate_specs": str(output_dir / "candidate-specs.jsonl"),
            "candidate_selection_manifest": str(
                output_dir / "candidate-selection-manifest.json"
            ),
            "pre_replay_proposal_scores": str(
                output_dir / "pre-replay-mlx-proposal-scores.jsonl"
            ),
            "pre_replay_proposal_model": str(
                output_dir / "pre-replay-mlx-ranker-model.json"
            ),
            "mlx_snapshot_manifest": str(output_dir / "mlx-snapshot-manifest.json"),
            "candidate_compiler_report": str(
                output_dir / "candidate-compiler-report.json"
            ),
            "proposal_scores": str(output_dir / "mlx-proposal-scores.jsonl"),
            "proposal_model": str(output_dir / "mlx-ranker-model.json"),
            "candidate_evidence_bundles": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates": str(output_dir / "portfolio-candidates.jsonl"),
            "portfolio_optimizer_report": str(
                output_dir / "portfolio-optimizer-report.json"
            ),
            "summary": str(output_dir / "summary.json"),
            "diagnostics_notebook": str(
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ),
        },
    }
    if args.persist_results:
        _persist_epoch_ledgers(
            epoch_id=epoch_id,
            status=status,
            target_net_pnl_per_day=target,
            paper_run_ids=[str(item) for item in args.paper_run_id],
            sources=sources,
            candidate_specs=candidate_specs,
            candidate_blockers=blocker_by_spec,
            proposal_rows=proposal_rows,
            portfolio=portfolio,
            summary=summary,
            runner_config={
                "replay_mode": args.replay_mode,
                "max_candidates": int(args.max_candidates),
                "top_k": int(args.top_k),
                "exploration_slots": int(args.exploration_slots),
                "replay_candidate_spec_count": len(replay_candidate_specs),
                "portfolio_size_min": int(args.portfolio_size_min),
                "portfolio_size_max": int(args.portfolio_size_max),
            },
            started_at=started_at,
            completed_at=datetime.now(UTC),
        )
    _write_json(output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    return summary


def main() -> int:
    args = _parse_args()
    payload = run_whitepaper_autoresearch_profit_target(args)
    print(json.dumps(payload, indent=2, sort_keys=True))
    status = str(payload.get("status") or "")
    if status == "ok":
        return 0
    if status == "replay_failed":
        return 3
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
