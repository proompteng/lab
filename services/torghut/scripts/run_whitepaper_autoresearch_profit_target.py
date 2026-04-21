#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
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
    load_strategy_autoresearch_program,
    run_id,
)
from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import rank_training_rows, train_mlx_ranker
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
    optimize_portfolio_candidate,
)
from app.trading.discovery.runtime_closure import write_runtime_closure_bundle
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
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument("--expected-last-trading-day", default="")
    parser.add_argument("--allow-stale-tape", action="store_true")
    parser.add_argument("--prefetch-full-window-rows", action="store_true")
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


def _write_failure_summary(
    *,
    output_dir: Path,
    epoch_id: str,
    status: str,
    reason: str,
    started_at: datetime,
) -> dict[str, Any]:
    summary = {
        "status": status,
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "failure_reason": reason,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
    }
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


def _list_of_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        cast(Mapping[str, Any], item) for item in value if isinstance(item, Mapping)
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
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=evidence_bundles
    )
    model = train_mlx_ranker(training_rows, backend_preference="mlx")
    ranked_rows = rank_training_rows(model=model, rows=training_rows)
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    proposal_rows = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": item.score,
            "rank": item.rank,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": "exploitation",
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in ranked_rows
    ]
    net_by_spec = {
        bundle.candidate_spec_id: _decimal(
            bundle.objective_scorecard.get("net_pnl_per_day")
        )
        for bundle in evidence_bundles
    }
    ranked_nets = [
        net_by_spec.get(str(row["candidate_spec_id"]), Decimal("0"))
        for row in proposal_rows
    ]
    split_index = max(1, len(ranked_nets) // 2)
    top_bucket = ranked_nets[:split_index]
    bottom_bucket = ranked_nets[split_index:] or [Decimal("0")]
    top_mean = sum(top_bucket, Decimal("0")) / Decimal(len(top_bucket))
    bottom_mean = sum(bottom_bucket, Decimal("0")) / Decimal(len(bottom_bucket))
    lift = top_mean - bottom_mean
    model_payload = {
        **model.to_payload(),
        "rank_bucket_lift": {
            "top_bucket_mean_net_pnl_per_day": str(top_mean),
            "bottom_bucket_mean_net_pnl_per_day": str(bottom_mean),
            "lift_net_pnl_per_day": str(lift),
        },
        "model_status": "active" if lift >= 0 else "demoted_to_heuristic",
    }
    if lift < 0:
        proposal_rows = sorted(
            proposal_rows,
            key=lambda row: (
                _decimal(row.get("features", {}).get("history_net_pnl_per_day")),
                str(row.get("candidate_spec_id") or ""),
            ),
            reverse=True,
        )
        proposal_rows = [
            {
                **row,
                "rank": index,
                "selection_reason": "heuristic_negative_lift_fallback",
            }
            for index, row in enumerate(proposal_rows, start=1)
        ]
    return model_payload, proposal_rows


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
            "daily_filled_notional": daily_filled_notional,
        },
        "full_window": {
            "net_per_day": str(net),
            "daily_net": {
                "2026-02-23": str(net * Decimal("0.80")),
                "2026-02-24": str(net * Decimal("1.10")),
                "2026-02-25": str(net * Decimal("0.90")),
                "2026-02-26": str(net * Decimal("1.05")),
                "2026-02-27": str(net * Decimal("1.15")),
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
    args: argparse.Namespace, *, output_dir: Path
) -> EpochReplayResult:
    factory_payload = strategy_factory_runner.run_strategy_factory_v2(
        argparse.Namespace(
            output_dir=output_dir / "strategy-factory",
            experiment_id=[],
            paper_run_id=args.paper_run_id,
            limit=max(1, int(args.max_candidates)),
            strategy_configmap=args.strategy_configmap,
            family_template_dir=args.family_template_dir,
            seed_sweep_dir=args.seed_sweep_dir,
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
            persist_results=args.persist_results,
        )
    )
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
        candidate["promotion_readiness"] = item.get("promotion_readiness")
        evidence_bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=str(
                    item.get("experiment_id") or item.get("top_candidate_id") or ""
                ),
                candidate=candidate,
                dataset_snapshot_id=str(item.get("dataset_snapshot_id") or ""),
                result_path=result_path,
            )
        )
    return EpochReplayResult(
        evidence_bundles=tuple(evidence_bundles), replay_results=(factory_payload,)
    )


def _runtime_closure_payload(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    epoch_id: str,
    portfolio: PortfolioCandidateSpec | None,
) -> Mapping[str, Any]:
    program = load_strategy_autoresearch_program(
        args.program.resolve(), family_dir=args.family_template_dir.resolve()
    )
    manifest = build_mlx_snapshot_manifest(
        runner_run_id=epoch_id,
        program=program,
        symbols=str(args.symbols),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        tensor_bundle_paths={
            "candidate_evidence_bundles_jsonl": str(
                output_dir / "candidate-evidence-bundles.jsonl"
            ),
            "portfolio_candidates_jsonl": str(
                output_dir / "portfolio-candidates.jsonl"
            ),
        },
    )
    best_candidate = None
    if portfolio is not None:
        best_candidate = {
            "candidate_id": portfolio.portfolio_candidate_id,
            "family_template_id": "portfolio_whitepaper_autoresearch_v1",
            "objective_scorecard": dict(portfolio.objective_scorecard),
            "portfolio": {
                "base_per_leg_notional": "50000",
                "sleeves": [dict(item) for item in portfolio.sleeves],
            },
            "promotion_status": "blocked_pending_runtime_parity",
            "promotion_stage": "research_candidate",
            "promotion_blockers": [
                "scheduler_v3_parity_missing",
                "shadow_validation_missing",
            ],
            "promotion_required_evidence": [
                "scheduler_v3_parity_replay",
                "shadow_validation",
            ],
        }
    return write_runtime_closure_bundle(
        run_root=output_dir,
        runner_run_id=epoch_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
        execution_context=None,
    ).to_payload()


def run_whitepaper_autoresearch_profit_target(
    args: argparse.Namespace,
) -> dict[str, Any]:
    epoch_id = run_id("whitepaper-autoresearch")
    started_at = datetime.now(UTC)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target = _decimal(args.target_net_pnl_per_day, default="500")
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
    )
    candidate_specs = list(compilation.executable_specs or compilation.candidate_specs)
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
    try:
        replay_result = (
            _run_synthetic_replay(
                specs=candidate_specs,
                output_dir=output_dir,
                max_candidates=int(args.max_candidates),
            )
            if args.replay_mode == "synthetic"
            else _run_real_replay(args, output_dir=output_dir)
        )
    except Exception as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_failed",
            reason=f"{type(exc).__name__}:{exc}",
            started_at=started_at,
        )
    proposal_model, proposal_rows = _proposal_model_and_rows(
        specs=candidate_specs, evidence_bundles=replay_result.evidence_bundles
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
    runtime_closure = _runtime_closure_payload(
        args=args, output_dir=output_dir, epoch_id=epoch_id, portfolio=portfolio
    )
    summary = {
        "status": "ok",
        "epoch_id": epoch_id,
        "run_root": str(output_dir),
        "target_net_pnl_per_day": str(target),
        "source_count": len(sources),
        "hypothesis_count": len(hypothesis_cards),
        "candidate_spec_count": len(candidate_specs),
        "candidate_compiler_blocker_count": len(compilation.blockers),
        "evidence_bundle_count": len(replay_result.evidence_bundles),
        "proposal_score_count": len(proposal_rows),
        "portfolio_candidate_count": len(portfolio_rows),
        "claim_count": sum(len(source.claims) for source in sources),
        "mlx_rank_bucket_lift": proposal_model.get("rank_bucket_lift", {}),
        "false_positive_table": [],
        "best_false_negative_table": [],
        "best_portfolio_candidate": portfolio.to_payload()
        if portfolio is not None
        else None,
        "oracle_candidate_found": bool(
            portfolio is not None
            and portfolio.objective_scorecard.get("oracle_passed") is True
        ),
        "profit_target_oracle": portfolio.objective_scorecard.get(
            "profit_target_oracle"
        )
        if portfolio is not None
        else None,
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
            status="ok",
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
