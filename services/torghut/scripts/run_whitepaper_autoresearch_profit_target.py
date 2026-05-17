#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
from concurrent.futures import ProcessPoolExecutor, as_completed
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
    ResearchClaim,
    ResearchSource,
    StrategyAutoresearchProgram,
    load_strategy_autoresearch_program,
    run_id,
)
from app.trading.discovery.candidate_specs import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    CandidateSpec,
)
from app.trading.discovery.candidate_specs import candidate_spec_id_for_payload
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.mlx_snapshot import write_mlx_snapshot_manifest
from app.trading.discovery.mlx_training_data import build_mlx_training_rows
from app.trading.discovery.mlx_training_data import (
    capital_budget_penalty,
    candidate_spec_capital_features,
    rank_training_rows,
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)
from app.trading.discovery.portfolio_optimizer import (
    PortfolioCandidateSpec,
    optimize_portfolio_candidate,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
    evaluate_profit_target_oracle,
)
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
    sources_from_jsonl,
)

import scripts.run_strategy_factory_v2 as strategy_factory_runner


_DEFAULT_CHIP_UNIVERSE_CSV = ",".join(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)
_DEFAULT_DAILY_PROFIT_TARGET = "500"
_DEFAULT_PORTFOLIO_PROFIT_PROGRAM = Path(
    "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
)
_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC = 8
_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES = 512
_MAX_PERSISTED_FEEDBACK_EVIDENCE_EPOCHS = 12
_PROGRAM_SOURCE_DEFAULT_CONFIDENCE = "0.70"
_RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS = frozenset(
    {
        "shadow_parity_status_failed",
        "executable_replay_passed_failed",
        "executable_replay_artifact_present_failed",
        "executable_replay_order_count_failed",
        "executable_replay_account_buying_power_failed",
        "executable_replay_max_notional_per_trade_failed",
        "executable_replay_notional_within_buying_power_failed",
    }
)
_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
    }
)
_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
        "active_day_ratio_failed",
        "positive_day_ratio_failed",
        "min_daily_net_pnl_failed",
        "daily_net_observed_day_count_failed",
        "best_day_share_failed",
        "max_single_day_contribution_share_failed",
        "max_single_symbol_contribution_share_failed",
        "max_cluster_contribution_share_failed",
    }
)


def _default_strategy_config_path() -> Path:
    configured = str(os.getenv("TRADING_STRATEGY_CONFIG_PATH") or "").strip()
    if configured:
        return Path(configured)
    return Path("argocd/applications/torghut/strategy-configmap.yaml")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run whitepaper autoresearch and assemble a portfolio candidate for a profit target.",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--epoch-id",
        default="",
        help=(
            "Optional persisted autoresearch epoch id. Defaults to a generated "
            "whitepaper-autoresearch id when omitted."
        ),
    )
    parser.add_argument("--paper-run-id", action="append", default=[])
    parser.add_argument("--seed-recent-whitepapers", action="store_true")
    parser.add_argument(
        "--source-jsonl",
        action="append",
        default=[],
        type=Path,
        help="JSONL file of normalized WhitepaperResearchSource payloads.",
    )
    parser.add_argument(
        "--feedback-evidence-jsonl",
        action="append",
        default=[],
        type=Path,
        help=(
            "Prior real-replay candidate evidence bundles to feed back into the "
            "pre-replay MLX ranker for the next autoresearch epoch."
        ),
    )
    parser.add_argument(
        "--target-net-pnl-per-day", default=_DEFAULT_DAILY_PROFIT_TARGET
    )
    parser.add_argument("--max-candidates", type=int, default=64)
    parser.add_argument("--top-k", type=int, default=16)
    parser.add_argument("--exploration-slots", type=int, default=8)
    parser.add_argument(
        "--feedback-block-reaudit-slots",
        type=int,
        default=0,
        help=(
            "Bounded slots for replaying candidates blocked only by prior "
            "feedback. These are diagnostic re-audits; capital blocks and final "
            "promotion/oracle gates still apply."
        ),
    )
    parser.add_argument("--portfolio-size-min", type=int, default=2)
    parser.add_argument("--portfolio-size-max", type=int, default=8)
    parser.add_argument("--replay-mode", choices=("synthetic", "real"), default="real")
    parser.add_argument(
        "--program",
        type=Path,
        default=_DEFAULT_PORTFOLIO_PROFIT_PROGRAM,
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=_default_strategy_config_path(),
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
    parser.add_argument(
        "--clickhouse-password-env",
        default="",
        help="Environment variable that contains the ClickHouse password; ignored when --clickhouse-password is set.",
    )
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default=_DEFAULT_CHIP_UNIVERSE_CSV)
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument(
        "--shadow-validation-artifact",
        type=Path,
        default=None,
        help=(
            "Optional real shadow/live deviation artifact to attach to runtime "
            "closure. Missing or invalid artifacts stay fail-closed."
        ),
    )
    parser.add_argument(
        "--max-frontier-candidates-per-spec",
        type=int,
        default=_DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
    )
    parser.add_argument(
        "--max-total-frontier-candidates",
        type=int,
        default=0,
        help=(
            "Global real-replay frontier candidate budget across all selected "
            "candidate specs. Defaults to --max-candidates when omitted."
        ),
    )
    parser.add_argument("--real-replay-timeout-seconds", type=int, default=0)
    parser.add_argument(
        "--real-replay-shard-size",
        type=int,
        default=0,
        help=(
            "Replay selected candidate specs in bounded shards. A value <= 0 "
            "keeps the legacy single-batch replay path."
        ),
    )
    parser.add_argument(
        "--real-replay-shard-timeout-seconds",
        type=int,
        default=0,
        help=(
            "Per-shard timeout for sharded real replay. Defaults to "
            "--real-replay-timeout-seconds when omitted."
        ),
    )
    parser.add_argument(
        "--real-replay-shard-workers",
        type=int,
        default=1,
        help=(
            "Maximum number of bounded real-replay shards to run concurrently. "
            "Defaults to 1 for the legacy sequential behavior."
        ),
    )
    parser.add_argument(
        "--real-replay-failed-spec-retries",
        type=int,
        default=1,
        help=(
            "Retry candidate specs from timed-out real-replay shards individually "
            "before marking the epoch replay incomplete."
        ),
    )
    parser.add_argument(
        "--real-replay-retry-timeout-seconds",
        type=int,
        default=0,
        help=(
            "Timeout for missing-spec retry replays. Defaults to twice the shard "
            "timeout when omitted."
        ),
    )
    parser.add_argument(
        "--real-replay-retry-max-frontier-candidates-per-spec",
        type=int,
        default=1,
        help="Frontier candidate budget for each missing-spec retry replay.",
    )
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument("--expected-last-trading-day", default="")
    parser.add_argument("--allow-stale-tape", action="store_true")
    parser.add_argument("--prefetch-full-window-rows", action="store_true")
    parser.add_argument(
        "--collect-train-gate-diagnostics",
        dest="collect_train_gate_diagnostics",
        action="store_true",
        help="Persist aggregate train-window gate diagnostics for real replay candidates.",
    )
    parser.add_argument(
        "--no-collect-train-gate-diagnostics",
        dest="collect_train_gate_diagnostics",
        action="store_false",
        help="Disable aggregate train-window gate diagnostics.",
    )
    parser.add_argument("--min-active-day-ratio", default="0.90")
    parser.add_argument("--min-positive-day-ratio", default="0.60")
    parser.add_argument("--min-daily-net-pnl", default=None)
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
    parser.set_defaults(
        persist_results=True,
        collect_train_gate_diagnostics=True,
    )
    return parser.parse_args()


@dataclass(frozen=True)
class EpochReplayResult:
    evidence_bundles: tuple[CandidateEvidenceBundle, ...]
    replay_results: tuple[Mapping[str, Any], ...]
    incomplete: bool = False
    failure_reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class _ReplayShardPlan:
    shard_index: int
    args: argparse.Namespace
    output_dir: Path
    specs: tuple[CandidateSpec, ...]
    timeout_seconds: int


@dataclass(frozen=True)
class _ReplayShardOutcome:
    shard_index: int
    candidate_spec_ids: tuple[str, ...]
    result: EpochReplayResult
    failure: Mapping[str, Any] | None = None


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


def _load_feedback_evidence_bundles(
    paths: Sequence[Path],
) -> tuple[CandidateEvidenceBundle, ...]:
    bundles: list[CandidateEvidenceBundle] = []
    for raw_path in paths:
        path = _resolve_existing_path(raw_path)
        if not path.exists():
            raise ValueError(f"feedback_evidence_jsonl_missing:{raw_path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
                if not isinstance(payload, Mapping):
                    raise ValueError("payload_not_object")
                bundles.append(evidence_bundle_from_payload(payload))
            except Exception as exc:
                raise ValueError(
                    f"feedback_evidence_jsonl_invalid:{raw_path}:{line_number}:{exc}"
                ) from exc
    return tuple(bundles)


def _dedupe_feedback_evidence_bundles(
    bundles: Sequence[CandidateEvidenceBundle],
) -> tuple[CandidateEvidenceBundle, ...]:
    seen: set[str] = set()
    deduped: list[CandidateEvidenceBundle] = []
    for bundle in bundles:
        key = bundle.evidence_bundle_id or _stable_hash(bundle.to_payload())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(bundle)
    return tuple(deduped)


def _evidence_bundle_payloads_for_epoch_summary(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    return [
        bundle.to_payload()
        for bundle in evidence_bundles[:_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES]
    ]


def _candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    return CandidateSpec(
        schema_version="torghut.candidate-spec.v1",
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        hypothesis_id=_string(payload.get("hypothesis_id")),
        family_template_id=_string(payload.get("family_template_id")),
        candidate_kind=cast(Any, _string(payload.get("candidate_kind")) or "sleeve"),
        runtime_family=_string(payload.get("runtime_family")),
        runtime_strategy_name=_string(payload.get("runtime_strategy_name")),
        feature_contract=_mapping(payload.get("feature_contract")),
        parameter_space=_mapping(payload.get("parameter_space")),
        strategy_overrides=_mapping(payload.get("strategy_overrides")),
        objective=_mapping(payload.get("objective")),
        hard_vetoes=_mapping(payload.get("hard_vetoes")),
        expected_failure_modes=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("expected_failure_modes") or ())
            if str(item).strip()
        ),
        promotion_contract=_mapping(payload.get("promotion_contract")),
    )


def _summary_scorecard_feedback_bundles_for_epoch(
    epoch: AutoresearchEpoch,
    candidate_specs: Sequence[CandidateSpec],
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, int]]:
    stats = {
        "scorecard_count": 0,
        "matched_scorecard_count": 0,
        "unmatched_scorecard_count": 0,
        "bundle_count": 0,
    }
    summary = _mapping(epoch.summary_json)
    remediation = _mapping(summary.get("candidate_search_remediation"))
    scorecards = _list_of_mappings(remediation.get("partial_scorecards"))
    stats["scorecard_count"] = len(scorecards)
    if not scorecards or not candidate_specs:
        return (), stats

    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    spec_by_signature = {
        _candidate_spec_execution_signature(spec): spec for spec in candidate_specs
    }
    build = _mapping(summary.get("build"))
    code_commit = _string(build.get("commit")) or "unknown"
    bundles: list[CandidateEvidenceBundle] = []
    for index, scorecard in enumerate(scorecards, start=1):
        candidate_spec_id = _string(scorecard.get("candidate_spec_id"))
        execution_signature = _string(scorecard.get("execution_signature"))
        spec = spec_by_id.get(candidate_spec_id) or spec_by_signature.get(
            execution_signature
        )
        if spec is None:
            stats["unmatched_scorecard_count"] += 1
            continue
        stats["matched_scorecard_count"] += 1
        candidate_id = _string(scorecard.get("candidate_id")) or spec.candidate_spec_id
        candidate = {
            "candidate_id": candidate_id,
            "family_template_id": _string(scorecard.get("family_template_id"))
            or spec.family_template_id,
            "runtime_family": _string(scorecard.get("runtime_family"))
            or spec.runtime_family,
            "runtime_strategy_name": _string(scorecard.get("runtime_strategy_name"))
            or spec.runtime_strategy_name,
            "execution_signature": execution_signature
            or _candidate_spec_execution_signature(spec),
            "objective_scorecard": scorecard,
            "hard_vetoes": scorecard.get("hard_vetoes")
            or scorecard.get("veto_reasons")
            or (),
            "promotion_readiness": {
                "stage": "research_candidate",
                "status": "blocked_by_prior_replay_scorecard",
                "promotable": False,
                "blockers": list(
                    str(item)
                    for item in cast(
                        Sequence[Any],
                        scorecard.get("hard_vetoes")
                        or scorecard.get("veto_reasons")
                        or (),
                    )
                    if str(item).strip()
                ),
            },
        }
        bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id=f"autoresearch-epoch:{epoch.epoch_id}:summary-scorecards",
                result_path=(
                    f"db://autoresearch_epochs/{epoch.epoch_id}/"
                    f"candidate_search_remediation/partial_scorecards/{index}"
                ),
                code_commit=code_commit,
            )
        )
    stats["bundle_count"] = len(bundles)
    return tuple(bundles), stats


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
    except Exception as exc:
        manifest["status"] = "unavailable"
        manifest["error"] = str(exc)
        return (), manifest

    manifest["scanned_epoch_count"] = len(epochs)
    bundles: list[CandidateEvidenceBundle] = []
    invalid_payload_count = 0
    source_epoch_ids: list[str] = []
    legacy_source_epoch_ids: list[str] = []
    candidate_specs_by_epoch: dict[str, list[CandidateSpec]] = {}
    invalid_spec_count = 0
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
        claim_text = ". ".join(
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
        claims.append(
            {
                "claim_id": claim_id,
                "claim_type": claim_type,
                "claim_text": claim_text,
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral"
                if claim_type in {"risk_constraint", "validation_requirement"}
                else "positive",
                "confidence": _PROGRAM_SOURCE_DEFAULT_CONFIDENCE,
                "metadata": {
                    "program_source_id": run_id,
                    "program_implication": str(claim.implication or "").strip(),
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
    write_whitepaper_autoresearch_diagnostics_notebook(
        output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    return summary


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _resolved_clickhouse_password(args: argparse.Namespace) -> str:
    direct_password = str(getattr(args, "clickhouse_password", "") or "").strip()
    if direct_password:
        return direct_password
    password_env = str(getattr(args, "clickhouse_password_env", "") or "").strip()
    if not password_env:
        return ""
    return os.environ.get(password_env, "")


def _candidate_universe_symbols_from_args(args: argparse.Namespace) -> tuple[str, ...]:
    symbols_raw = str(getattr(args, "symbols", "") or "")
    raw_symbols: list[str] = []
    raw_seen: set[str] = set()
    for item in symbols_raw.split(","):
        symbol = item.strip().upper()
        if not symbol or symbol in raw_seen:
            continue
        raw_symbols.append(symbol)
        raw_seen.add(symbol)
    if len(raw_symbols) > 12:
        raise ValueError(f"candidate_universe_too_large:{len(raw_symbols)}")

    allowed = set(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)
    filtered_symbols = [symbol for symbol in raw_symbols if symbol in allowed]
    if not filtered_symbols:
        return LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE
    return tuple(filtered_symbols)


def _candidate_universe_symbols_for_compilation(
    args: argparse.Namespace,
) -> tuple[str, ...]:
    symbols = _candidate_universe_symbols_from_args(args)
    if set(symbols) == set(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE) and len(
        symbols
    ) == len(LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE):
        return ()
    return symbols


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
    target_net_pnl_per_day = _decimal(
        getattr(args, "target_net_pnl_per_day", _DEFAULT_DAILY_PROFIT_TARGET),
        default=_DEFAULT_DAILY_PROFIT_TARGET,
    )
    min_active_day_ratio = _decimal(
        getattr(args, "min_active_day_ratio", "0.90"), default="0.90"
    )
    min_positive_day_ratio = _decimal(
        getattr(args, "min_positive_day_ratio", "0.60"), default="0.60"
    )
    min_daily_net_pnl = _decimal(getattr(args, "min_daily_net_pnl", "0"), default="0")
    max_worst_day_loss = _decimal(
        getattr(args, "max_worst_day_loss", "350"), default="350"
    )
    max_drawdown = _decimal(getattr(args, "max_drawdown", "900"), default="900")
    if bool(getattr(args, "require_no_flat_days", False)):
        min_active_day_ratio = max(min_active_day_ratio, Decimal("1"))
        min_positive_day_ratio = max(min_positive_day_ratio, Decimal("1"))
        min_daily_net_pnl = max(min_daily_net_pnl, target_net_pnl_per_day)
        max_worst_day_loss = min(max_worst_day_loss, Decimal("0"))
        max_drawdown = min(max_drawdown, Decimal("0"))
    return ProfitTargetOraclePolicy(
        min_active_day_ratio=min_active_day_ratio,
        min_positive_day_ratio=min_positive_day_ratio,
        min_daily_net_pnl=min_daily_net_pnl,
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
                    if bool(portfolio.objective_scorecard.get("oracle_passed"))
                    else "blocked",
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
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > oracle_policy.max_gross_exposure_pct_equity
    ):
        failures.append("max_gross_exposure_above_oracle")
    if _decimal(scorecard.get("min_cash")) < oracle_policy.min_cash:
        failures.append("min_cash_below_oracle")
    if (
        int(_decimal(scorecard.get("negative_cash_observation_count")))
        > oracle_policy.max_negative_cash_observation_count
    ):
        failures.append("negative_cash_observed")
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
    if oracle_policy.require_executable_replay:
        if str(scorecard.get("executable_replay_passed")).lower() != "true":
            failures.append("executable_replay_not_passed")
        if not _string(scorecard.get("executable_replay_artifact_ref")):
            failures.append("executable_replay_artifact_missing")
        executable_order_count = int(
            _decimal(
                scorecard.get("executable_replay_order_count")
                or scorecard.get("executable_replay_submitted_order_count")
                or scorecard.get("executable_replay_orders_submitted_total")
            )
        )
        if executable_order_count < oracle_policy.min_executable_order_count:
            failures.append("executable_replay_order_count_below_oracle")
        replay_buying_power = _decimal(
            scorecard.get("executable_replay_account_buying_power")
            or scorecard.get("executable_replay_buying_power")
        )
        replay_max_notional = _decimal(
            scorecard.get("executable_replay_max_notional_per_trade")
            or scorecard.get("executable_replay_max_notional_per_order")
        )
        if replay_buying_power <= 0:
            failures.append("executable_replay_account_buying_power_missing")
        if replay_max_notional <= 0:
            failures.append("executable_replay_max_notional_missing")
        if (
            oracle_policy.require_executable_replay_notional_within_buying_power
            and replay_max_notional > replay_buying_power
        ):
            failures.append("executable_replay_notional_exceeds_buying_power")
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


def _replay_diagnostic_proposal_rows(
    *,
    candidate_selection: Mapping[str, Any],
    pre_replay_proposal_rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    pre_replay_by_spec = {
        _string(row.get("candidate_spec_id")): row
        for row in _list_of_mappings(list(pre_replay_proposal_rows))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id:
            continue
        pre_replay = pre_replay_by_spec.get(candidate_spec_id, {})
        rows.append(
            {
                **dict(pre_replay),
                "candidate_spec_id": candidate_spec_id,
                "proposal_score": pre_replay.get("proposal_score"),
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "selected_for_replay": bool(selection.get("selected_for_replay")),
                "replay_selection_reason": _string(selection.get("selection_reason"))
                or "not_selected_budget",
            }
        )
    return rows


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
            or _string(selection.get("selection_reason"))
            == "duplicate_execution_signature"
            or _selection_reason_blocks_replay(
                _string(selection.get("selection_reason"))
            )
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


def _candidate_search_remediation(
    *,
    failure_reason: str,
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    replay_timeout_seconds: int,
    max_frontier_candidates_per_spec: int,
    current_top_k: int = 16,
    current_exploration_slots: int = 8,
    current_portfolio_size_min: int = 2,
    current_max_candidates: int = 64,
    current_max_total_frontier_candidates: int = 0,
) -> dict[str, Any]:
    failure_counts: dict[str, int] = {}
    for row in _list_of_mappings(list(false_positive_table)):
        for reason in cast(Sequence[Any], row.get("failure_reasons") or ()):
            reason_text = _string(reason)
            if reason_text:
                failure_counts[reason_text] = failure_counts.get(reason_text, 0) + 1

    partial_scorecards = [
        dict(bundle.objective_scorecard) for bundle in evidence_bundles
    ]
    selected_rows = [
        row
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
    ]
    selected_but_missing = [
        row
        for row in _list_of_mappings(list(false_positive_table))
        if row.get("evidence_status") == "missing"
    ]
    selection_budget = _mapping(candidate_selection.get("budget"))

    def budget_int(name: str, default: int = 0) -> int:
        try:
            return int(selection_budget.get(name, default) or default)
        except (TypeError, ValueError):
            return default

    observed_selection_budget = {
        "compiled_candidate_count": budget_int("compiled_candidate_count"),
        "unique_execution_signature_count": budget_int(
            "unique_execution_signature_count"
        ),
        "eligible_candidate_count": budget_int("eligible_candidate_count"),
        "pre_replay_feedback_blocked_candidate_count": budget_int(
            "pre_replay_feedback_blocked_candidate_count"
        ),
        "pre_replay_nonpositive_synthetic_candidate_count": budget_int(
            "pre_replay_nonpositive_synthetic_candidate_count"
        ),
        "pre_replay_blocked_candidate_count": budget_int(
            "pre_replay_blocked_candidate_count"
        ),
        "selected_count": budget_int("selected_count", len(selected_rows)),
        "max_candidates": budget_int("max_candidates", current_max_candidates),
        "top_k": budget_int("top_k", current_top_k),
        "exploration_slots": budget_int(
            "exploration_slots_effective",
            budget_int("exploration_slots", current_exploration_slots),
        ),
    }
    unique_execution_signature_count = observed_selection_budget[
        "unique_execution_signature_count"
    ]
    candidate_surface_exhausted = (
        unique_execution_signature_count > 0
        and observed_selection_budget["selected_count"]
        >= unique_execution_signature_count
        and observed_selection_budget["max_candidates"]
        >= unique_execution_signature_count
        and observed_selection_budget["top_k"]
        + observed_selection_budget["exploration_slots"]
        >= unique_execution_signature_count
    )
    replayable_candidate_surface_exhausted = (
        observed_selection_budget["eligible_candidate_count"] > 0
        and observed_selection_budget["selected_count"]
        >= observed_selection_budget["eligible_candidate_count"]
        and observed_selection_budget["max_candidates"]
        >= observed_selection_budget["eligible_candidate_count"]
        and observed_selection_budget["top_k"]
        + observed_selection_budget["exploration_slots"]
        >= observed_selection_budget["eligible_candidate_count"]
    )
    next_actions: list[dict[str, Any]] = []
    if (
        observed_selection_budget["selected_count"] <= 0
        and observed_selection_budget["pre_replay_feedback_blocked_candidate_count"] > 0
    ):
        next_actions.append(
            {
                "priority": 1,
                "action": "expand_or_mutate_strategy_surface_after_feedback_blocks_all_candidates",
                "reason": (
                    "pre-replay feedback vetoed every eligible execution profile; "
                    "the next epoch needs new sleeves or materially different execution signatures"
                ),
                "observed_selection_budget": observed_selection_budget,
                "recommended_code_change": (
                    "mutate strategy templates, sleeves, or execution/risk profiles before replaying "
                    "the same blocked signatures again"
                ),
            }
        )
    if (
        observed_selection_budget["selected_count"] <= 0
        and observed_selection_budget[
            "pre_replay_nonpositive_synthetic_candidate_count"
        ]
        > 0
    ):
        next_actions.append(
            {
                "priority": 2,
                "action": "expand_or_mutate_strategy_surface_after_negative_mlx_prior",
                "reason": (
                    "the pre-replay model assigned nonpositive expected value to every synthetic-prior "
                    "candidate; wider replay would only spend budget on unpromising candidates"
                ),
                "observed_selection_budget": observed_selection_budget,
                "recommended_code_change": (
                    "add new candidate families, sleeves, or feature/risk variants that can earn a "
                    "positive pre-replay expected value before real replay"
                ),
            }
        )
    if next_actions:
        next_actions.sort(key=lambda row: int(row.get("priority") or 10**6))
        return {
            "schema_version": "torghut.whitepaper-autoresearch-remediation.v1",
            "failure_reason": failure_reason,
            "partial_evidence_bundle_count": len(evidence_bundles),
            "selected_for_replay_count": len(selected_rows),
            "selected_missing_evidence_count": len(selected_but_missing),
            "failure_reason_counts": dict(sorted(failure_counts.items())),
            "partial_scorecards": partial_scorecards,
            "candidate_surface_exhausted": candidate_surface_exhausted,
            "replayable_candidate_surface_exhausted": replayable_candidate_surface_exhausted,
            "observed_selection_budget": observed_selection_budget,
            "next_actions": next_actions,
        }
    if "TimeoutError:real_replay_timeout_seconds" in failure_reason:
        current_per_spec = max(1, int(max_frontier_candidates_per_spec))
        retry_per_spec = (
            max(1, min(4, current_per_spec // 4)) if current_per_spec > 2 else 1
        )
        next_actions.append(
            {
                "priority": 1,
                "action": "shrink_per_spec_frontier_or_extend_timeout",
                "reason": "real replay timed out before all selected candidate specs emitted evidence",
                "recommended_flags": {
                    "--max-frontier-candidates-per-spec": str(retry_per_spec),
                    "--real-replay-timeout-seconds": str(
                        max(replay_timeout_seconds * 2, 900)
                        if replay_timeout_seconds > 0
                        else 900
                    ),
                },
            }
        )
    if selected_but_missing:
        next_actions.append(
            {
                "priority": 2,
                "action": "replay_missing_selected_specs_individually",
                "reason": "some high-ranked specs were selected but did not produce replay evidence",
                "candidate_spec_ids": [
                    _string(row.get("candidate_spec_id"))
                    for row in selected_but_missing[:8]
                    if _string(row.get("candidate_spec_id"))
                ],
            }
        )
    promotion_proof_failures = (
        "shadow_parity_status_not_within_budget",
        "executable_replay_not_passed",
        "executable_replay_artifact_missing",
        "executable_replay_order_count_below_oracle",
        "executable_replay_account_buying_power_missing",
        "executable_replay_max_notional_missing",
        "executable_replay_notional_exceeds_buying_power",
    )
    proof_failure_counts = {
        reason: count
        for reason, count in failure_counts.items()
        if reason in promotion_proof_failures
    }
    non_proof_failure_counts = {
        reason: count
        for reason, count in failure_counts.items()
        if reason not in promotion_proof_failures
    }
    if proof_failure_counts:
        proof_action: dict[str, Any] = {
            "priority": 3 if not non_proof_failure_counts else 7,
            "action": "complete_executable_replay_and_shadow_parity_evidence",
            "reason": (
                "replayed candidates are missing promotion-closure evidence required by the oracle"
                if not non_proof_failure_counts
                else "promotion-closure evidence is required, but current candidates still fail profit or risk gates"
            ),
            "blocking_failure_counts": proof_failure_counts,
            "required_scorecard_fields": [
                "shadow_parity_status",
                "executable_replay_passed",
                "executable_replay_artifact_ref",
                "executable_replay_order_count",
                "executable_replay_account_buying_power",
                "executable_replay_max_notional_per_trade",
            ],
        }
        if non_proof_failure_counts:
            proof_action["deferred_until"] = (
                "portfolio_profit_and_risk_oracle_failures_clear"
            )
            proof_action["blocked_by_non_proof_failure_counts"] = dict(
                sorted(non_proof_failure_counts.items())
            )
        next_actions.append(proof_action)
    if any(
        reason in failure_counts
        for reason in (
            "active_day_ratio_below_oracle",
            "positive_day_ratio_below_oracle",
        )
    ):
        if candidate_surface_exhausted or replayable_candidate_surface_exhausted:
            selected_families = sorted(
                {
                    _string(row.get("family_template_id"))
                    for row in selected_rows
                    if _string(row.get("family_template_id"))
                }
            )
            next_actions.append(
                {
                    "priority": 4,
                    "action": "expand_execution_profile_surface",
                    "reason": (
                        (
                            "candidate selection replayed every currently eligible execution signature; "
                            "pre-replay feedback, capital, or expected-value gates blocked the rest"
                        )
                        if replayable_candidate_surface_exhausted
                        and not candidate_surface_exhausted
                        else (
                            "candidate selection replayed every unique execution signature; "
                            "max-candidates, top-k, and exploration-slots are no longer binding"
                        )
                    ),
                    "observed_selection_budget": observed_selection_budget,
                    "target_family_template_ids": selected_families,
                    "recommended_code_change": (
                        "add risk-diversified execution profiles, sleeves, or family mappings "
                        "before spending another epoch on wider selection flags"
                    ),
                }
            )
        else:
            next_top_k = min(
                max(1, current_max_candidates),
                max(16, current_top_k + max(4, current_exploration_slots)),
            )
            next_exploration_slots = min(
                max(1, current_max_candidates),
                max(8, current_exploration_slots + max(4, current_exploration_slots)),
            )
            next_max_candidates = max(
                current_max_candidates,
                next_top_k + next_exploration_slots,
                min(128, current_max_candidates + 32),
            )
            recommended_flags = {
                "--max-candidates": str(next_max_candidates),
                "--top-k": str(next_top_k),
                "--exploration-slots": str(next_exploration_slots),
                "--portfolio-size-min": str(max(3, current_portfolio_size_min)),
            }
            if current_max_total_frontier_candidates > 0:
                recommended_flags["--max-total-frontier-candidates"] = str(
                    max(
                        current_max_total_frontier_candidates,
                        min(128, current_max_total_frontier_candidates * 2),
                    )
                )
            next_actions.append(
                {
                    "priority": 4,
                    "action": "increase_breadth_and_portfolio_diversity",
                    "reason": "replayed candidates had flat or non-positive days",
                    "recommended_flags": recommended_flags,
                }
            )
    if any(
        reason in failure_counts
        for reason in (
            "non_positive_net_pnl_per_day",
            "worst_day_loss_above_oracle",
            "max_drawdown_above_oracle",
        )
    ):
        next_actions.append(
            {
                "priority": 5,
                "action": "pivot_family_mix_away_from_failed_exposures",
                "reason": "partial replay evidence failed profit or risk gates",
                "recommended_review_fields": [
                    "family_template_id",
                    "runtime_strategy_name",
                    "daily_net",
                    "symbol_contribution_shares",
                ],
            }
        )
    if best_false_negative_table:
        next_actions.append(
            {
                "priority": 6,
                "action": "expand_exploration_for_unreplayed_high_ranked_specs",
                "reason": "ranked specs were not replayed because of budget",
                "candidate_spec_ids": [
                    _string(row.get("candidate_spec_id"))
                    for row in _list_of_mappings(list(best_false_negative_table))[:8]
                    if _string(row.get("candidate_spec_id"))
                ],
            }
        )
    if not next_actions:
        next_actions.append(
            {
                "priority": 1,
                "action": "inspect_partial_artifacts_before_next_epoch",
                "reason": "failure did not match a known replay remediation pattern",
            }
        )

    next_actions.sort(key=lambda row: int(row.get("priority") or 10**6))
    return {
        "schema_version": "torghut.whitepaper-autoresearch-remediation.v1",
        "failure_reason": failure_reason,
        "partial_evidence_bundle_count": len(evidence_bundles),
        "selected_for_replay_count": len(selected_rows),
        "selected_missing_evidence_count": len(selected_but_missing),
        "failure_reason_counts": dict(sorted(failure_counts.items())),
        "partial_scorecards": partial_scorecards,
        "candidate_surface_exhausted": candidate_surface_exhausted,
        "replayable_candidate_surface_exhausted": replayable_candidate_surface_exhausted,
        "observed_selection_budget": observed_selection_budget,
        "next_actions": next_actions,
    }


def _string_list_from_value(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    rows = cast(Sequence[Any], value)
    return [text for item in rows if (text := _string(item))]


def _selected_candidate_spec_ids(
    candidate_selection: Mapping[str, Any],
) -> set[str]:
    explicit_ids = set(
        _string_list_from_value(candidate_selection.get("selected_candidate_spec_ids"))
    )
    selected_rows = {
        _string(row.get("candidate_spec_id"))
        for row in _list_of_mappings(candidate_selection.get("rows"))
        if bool(row.get("selected_for_replay"))
        and _string(row.get("candidate_spec_id"))
    }
    return explicit_ids | selected_rows


def _candidate_family_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    selected_ids = _selected_candidate_spec_ids(candidate_selection)
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    rows_by_family: dict[str, dict[str, Any]] = {}
    for spec in candidate_specs:
        family_id = spec.family_template_id
        row = rows_by_family.setdefault(
            family_id,
            {
                "family_template_id": family_id,
                "runtime_families": set(),
                "runtime_strategy_names": set(),
                "candidate_spec_count": 0,
                "selected_for_replay_count": 0,
                "evidence_bundle_count": 0,
                "sample_candidate_spec_ids": [],
                "sample_selected_candidate_spec_ids": [],
            },
        )
        row["candidate_spec_count"] = int(row["candidate_spec_count"]) + 1
        cast(set[str], row["runtime_families"]).add(spec.runtime_family)
        cast(set[str], row["runtime_strategy_names"]).add(spec.runtime_strategy_name)
        if len(cast(list[str], row["sample_candidate_spec_ids"])) < 3:
            cast(list[str], row["sample_candidate_spec_ids"]).append(
                spec.candidate_spec_id
            )
        if spec.candidate_spec_id in selected_ids:
            row["selected_for_replay_count"] = int(row["selected_for_replay_count"]) + 1
            if len(cast(list[str], row["sample_selected_candidate_spec_ids"])) < 3:
                cast(list[str], row["sample_selected_candidate_spec_ids"]).append(
                    spec.candidate_spec_id
                )
        if spec.candidate_spec_id in evidence_by_spec:
            row["evidence_bundle_count"] = int(row["evidence_bundle_count"]) + 1

    payload_rows: list[dict[str, Any]] = []
    for row in rows_by_family.values():
        payload_rows.append(
            {
                **row,
                "runtime_families": sorted(cast(set[str], row["runtime_families"])),
                "runtime_strategy_names": sorted(
                    cast(set[str], row["runtime_strategy_names"])
                ),
            }
        )
    payload_rows.sort(
        key=lambda row: (
            -int(row.get("selected_for_replay_count") or 0),
            -int(row.get("candidate_spec_count") or 0),
            _string(row.get("family_template_id")),
        )
    )
    return payload_rows


def _candidate_sleeve_goal_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    candidate_selection: Mapping[str, Any],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
    false_positive_table: Sequence[Mapping[str, Any]],
    best_false_negative_table: Sequence[Mapping[str, Any]],
    portfolio: PortfolioCandidateSpec | None,
    limit: int = 16,
) -> list[dict[str, Any]]:
    if portfolio is not None:
        return [dict(sleeve) for sleeve in portfolio.sleeves[:limit]]

    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    evidence_by_spec = {bundle.candidate_spec_id: bundle for bundle in evidence_bundles}
    failure_by_spec = {
        _string(row.get("candidate_spec_id")): list(
            cast(Sequence[Any], row.get("failure_reasons") or ())
        )
        for row in _list_of_mappings(list(false_positive_table))
        if _string(row.get("candidate_spec_id"))
    }
    rows: list[dict[str, Any]] = []
    for selection in _list_of_mappings(candidate_selection.get("rows")):
        candidate_spec_id = _string(selection.get("candidate_spec_id"))
        if not candidate_spec_id or not bool(selection.get("selected_for_replay")):
            continue
        spec = spec_by_id.get(candidate_spec_id)
        evidence = evidence_by_spec.get(candidate_spec_id)
        scorecard = evidence.objective_scorecard if evidence is not None else {}
        rows.append(
            {
                "candidate_spec_id": candidate_spec_id,
                "candidate_id": evidence.candidate_id if evidence is not None else None,
                "family_template_id": spec.family_template_id
                if spec is not None
                else None,
                "runtime_family": spec.runtime_family if spec is not None else None,
                "runtime_strategy_name": spec.runtime_strategy_name
                if spec is not None
                else None,
                "rank": _rank_sort_value(selection.get("rank")),
                "pre_replay_score": _string(selection.get("pre_replay_score")),
                "evidence_status": "replayed" if evidence is not None else "missing",
                "net_pnl_per_day": _string(scorecard.get("net_pnl_per_day")),
                "active_day_ratio": _string(scorecard.get("active_day_ratio")),
                "positive_day_ratio": _string(scorecard.get("positive_day_ratio")),
                "failure_reasons": [
                    _string(item)
                    for item in failure_by_spec.get(candidate_spec_id, ())
                    if _string(item)
                ],
            }
        )
        if len(rows) >= limit:
            break

    if len(rows) < limit:
        for row in _list_of_mappings(list(best_false_negative_table)):
            candidate_spec_id = _string(row.get("candidate_spec_id"))
            if not candidate_spec_id:
                continue
            spec = spec_by_id.get(candidate_spec_id)
            rows.append(
                {
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": None,
                    "family_template_id": spec.family_template_id
                    if spec is not None
                    else None,
                    "runtime_family": spec.runtime_family if spec is not None else None,
                    "runtime_strategy_name": spec.runtime_strategy_name
                    if spec is not None
                    else None,
                    "rank": _rank_sort_value(row.get("rank")),
                    "pre_replay_score": _string(row.get("pre_replay_score")),
                    "evidence_status": "not_replayed",
                    "reason": _string(row.get("reason")) or "not_replayed_budget",
                    "failure_reasons": ["not_replayed_budget"],
                }
            )
            if len(rows) >= limit:
                break
    return rows


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
    real_replay_shard_timeout_seconds = _int_arg(
        args, "real_replay_shard_timeout_seconds", 0
    )
    if real_replay_shard_timeout_seconds > 0:
        flags["--real-replay-shard-timeout-seconds"] = str(
            real_replay_shard_timeout_seconds
        )
    real_replay_shard_workers = _int_arg(args, "real_replay_shard_workers", 1)
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
                    current_value = flags.get(key)
                    current_int = _flag_int(current_value)
                    recommended_int = _flag_int(value)
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
    for key, value in flags.items():
        argv.extend([key, value])
    return {
        "entrypoint": "services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py",
        "flags": flags,
        "argv": argv,
        "applied_recommended_flags": applied_recommended_flags,
        "rejected_recommended_flags": rejected_recommended_flags,
        "no_fast_path_policy": {
            "target_net_pnl_per_day_is_fixed": str(target),
            "replay_mode": "real",
            "monotonic_search_flags": sorted(monotonic_int_flags),
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


def _pre_replay_candidate_score(spec: CandidateSpec) -> Decimal:
    family_score = {
        "microbar_cross_sectional_pairs_v1": Decimal("70"),
        "microstructure_continuation_matched_filter_v1": Decimal("65"),
        "opening_drive_leader_reclaim_v1": Decimal("63"),
        "momentum_pullback_v1": Decimal("60"),
        "washout_rebound_v2": Decimal("55"),
        "breakout_reclaim_v2": Decimal("50"),
        "end_of_day_reversal_v1": Decimal("48"),
        "mean_reversion_rebound_v1": Decimal("45"),
        "late_day_continuation_v1": Decimal("45"),
    }.get(spec.family_template_id, Decimal("40"))
    required_features = spec.feature_contract.get("required_features")
    feature_count = (
        len(cast(Sequence[Any], required_features))
        if isinstance(required_features, Sequence)
        and not isinstance(required_features, str)
        else 0
    )
    failure_penalty = Decimal(len(spec.expected_failure_modes)) * Decimal("0.25")
    capital_penalty = Decimal(
        str(capital_budget_penalty(candidate_spec_capital_features(spec)))
    )
    return family_score + Decimal(feature_count) - failure_penalty - capital_penalty


def _candidate_spec_universe_key(spec: CandidateSpec) -> str:
    universe = spec.strategy_overrides.get("universe_symbols")
    if not isinstance(universe, Sequence) or isinstance(universe, str):
        return ""
    return ",".join(sorted(_string(item).upper() for item in universe if _string(item)))


def _candidate_spec_signal_key(spec: CandidateSpec) -> str:
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


def _candidate_spec_execution_profile(spec: CandidateSpec) -> Mapping[str, Any]:
    return _mapping(spec.feature_contract.get("execution_profile"))


def _feedback_risk_profile_key_payload(
    *,
    family_template_id: str,
    runtime_strategy_name: str,
    execution_profile_id: str,
    universe_key: str,
    signal_key: str,
) -> Mapping[str, Any]:
    return {
        "family_template_id": family_template_id,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
    }


def _candidate_spec_feedback_risk_profile_key(spec: CandidateSpec) -> str:
    execution_profile = _candidate_spec_execution_profile(spec)
    return _stable_hash(
        _feedback_risk_profile_key_payload(
            family_template_id=spec.family_template_id,
            runtime_strategy_name=spec.runtime_strategy_name,
            execution_profile_id=_string(execution_profile.get("profile_id")),
            universe_key=_candidate_spec_universe_key(spec),
            signal_key=_candidate_spec_signal_key(spec),
        )
    )


def _candidate_spec_feedback_shape_key(spec: CandidateSpec) -> str:
    params = _mapping(spec.strategy_overrides.get("params"))
    execution_profile = _candidate_spec_execution_profile(spec)
    return _stable_hash(
        {
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "execution_profile_id": _string(execution_profile.get("profile_id")),
            "universe_key": _candidate_spec_universe_key(spec),
            "signal_key": _candidate_spec_signal_key(spec),
            "capital_profile": _string(params.get("capital_profile")),
            "entry_minute_after_open": _string(params.get("entry_minute_after_open")),
            "exit_minute_after_open": _string(params.get("exit_minute_after_open")),
            "entry_start_minute_utc": _string(params.get("entry_start_minute_utc")),
            "entry_end_minute_utc": _string(params.get("entry_end_minute_utc")),
            "max_entries_per_session": _string(params.get("max_entries_per_session")),
            "max_concurrent_positions": _string(params.get("max_concurrent_positions")),
            "top_n": _string(params.get("top_n")),
            "max_pair_legs": _string(params.get("max_pair_legs")),
            "long_stop_loss_bps": _string(params.get("long_stop_loss_bps")),
            "short_stop_loss_bps": _string(params.get("short_stop_loss_bps")),
            "max_session_negative_exit_bps": _string(
                params.get("max_session_negative_exit_bps")
            ),
        }
    )


def _candidate_spec_feedback_metadata(spec: CandidateSpec) -> dict[str, Any]:
    execution_profile = _candidate_spec_execution_profile(spec)
    params = _mapping(spec.strategy_overrides.get("params"))
    universe_symbols = [
        _string(symbol).upper()
        for symbol in cast(
            Sequence[Any], spec.strategy_overrides.get("universe_symbols") or []
        )
        if _string(symbol)
    ]
    return {
        "family_template_id": spec.family_template_id,
        "runtime_family": spec.runtime_family,
        "runtime_strategy_name": spec.runtime_strategy_name,
        "execution_signature": _candidate_spec_execution_signature(spec),
        "execution_profile_id": _string(execution_profile.get("profile_id")),
        "execution_profile_index": execution_profile.get("profile_index"),
        "feedback_risk_profile_key": _candidate_spec_feedback_risk_profile_key(spec),
        "feedback_shape_key": _candidate_spec_feedback_shape_key(spec),
        "universe_key": _candidate_spec_universe_key(spec),
        "signal_key": _candidate_spec_signal_key(spec),
        "runtime_params": dict(params),
        "universe_symbols": universe_symbols,
    }


def _candidate_payload_with_feedback_metadata(
    *, candidate: Mapping[str, Any], spec: CandidateSpec
) -> dict[str, Any]:
    metadata = _candidate_spec_feedback_metadata(spec)
    next_candidate = {**dict(candidate), **metadata}
    scorecard = _mapping(next_candidate.get("objective_scorecard"))
    next_candidate["objective_scorecard"] = {
        **metadata,
        **scorecard,
    }
    return next_candidate


def _pre_replay_prior_bundle(spec: CandidateSpec) -> CandidateEvidenceBundle:
    prior_score = _pre_replay_candidate_score(spec)
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=spec.candidate_spec_id,
        candidate=_candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": f"pre-replay-prior-{spec.candidate_spec_id}",
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
        ),
        dataset_snapshot_id="pre-replay-proposal-priors",
        result_path=f"pre-replay-proposal-priors://{spec.candidate_spec_id}",
    )


def _feedback_scorecard_has_hard_veto(scorecard: Mapping[str, Any]) -> bool:
    if _oracle_blockers(scorecard):
        return True
    oracle_passed = scorecard.get("oracle_passed")
    if oracle_passed is not None and not _boolish(oracle_passed):
        return True
    hard_vetoes = scorecard.get("hard_vetoes") or scorecard.get("veto_reasons")
    if isinstance(hard_vetoes, str):
        return bool(hard_vetoes.strip())
    if isinstance(hard_vetoes, Sequence) and not isinstance(hard_vetoes, str):
        return any(_string(item) for item in hard_vetoes)
    return False


def _feedback_daily_net_has_loss(scorecard: Mapping[str, Any]) -> bool:
    daily_net = scorecard.get("daily_net")
    if not isinstance(daily_net, Mapping):
        return False
    return any(
        _decimal(value, default="0") <= Decimal("0")
        for value in cast(Mapping[Any, Any], daily_net).values()
    )


def _feedback_family_prior_has_hard_block(scorecard: Mapping[str, Any]) -> bool:
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS:
        return True
    if _decimal(scorecard.get("active_day_ratio"), default="1") < Decimal("1"):
        return True
    if _decimal(scorecard.get("positive_day_ratio"), default="1") < Decimal("1"):
        return True
    if _decimal(scorecard.get("best_day_share")) > Decimal("0.50"):
        return True
    return _feedback_daily_net_has_loss(scorecard)


def _feedback_risk_profile_has_penalty(scorecard: Mapping[str, Any]) -> bool:
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS:
        return True
    if _decimal(scorecard.get("active_day_ratio"), default="1") < Decimal("1"):
        return True
    if _decimal(scorecard.get("positive_day_ratio"), default="1") < Decimal("0.60"):
        return True
    if _decimal(scorecard.get("best_day_share")) > Decimal("0.35"):
        return True
    if _decimal(scorecard.get("max_single_day_contribution_share")) > Decimal("0.35"):
        return True
    if _decimal(scorecard.get("max_single_symbol_contribution_share")) > Decimal(
        "0.35"
    ):
        return True
    if _decimal(scorecard.get("max_cluster_contribution_share")) > Decimal("0.40"):
        return True
    return False


def _feedback_risk_profile_has_terminal_block(scorecard: Mapping[str, Any]) -> bool:
    if not _feedback_risk_profile_has_penalty(scorecard):
        return False
    if _feedback_has_nonpositive_expected_value(scorecard):
        return True
    if _decimal(scorecard.get("max_gross_exposure_pct_equity")) > Decimal("1.0"):
        return True
    if _decimal(scorecard.get("min_cash")) < Decimal("0"):
        return True
    return _decimal(scorecard.get("negative_cash_observation_count")) > Decimal("0")


def _feedback_is_blocked(scorecard: Mapping[str, Any]) -> bool:
    if _feedback_scorecard_has_hard_veto(scorecard):
        return True
    if _decimal(scorecard.get("max_gross_exposure_pct_equity")) > Decimal("1.0"):
        return True
    if _decimal(scorecard.get("min_cash")) < Decimal("0"):
        return True
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal("0"):
        return True
    return (
        _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")
        or _decimal(scorecard.get("negative_day_count")) > Decimal("0")
        or _feedback_daily_net_has_loss(scorecard)
    )


def _feedback_has_nonpositive_expected_value(scorecard: Mapping[str, Any]) -> bool:
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_bundle_sort_value(
    bundle: CandidateEvidenceBundle,
) -> tuple[int, Decimal, str]:
    scorecard = bundle.objective_scorecard
    return (
        0 if _feedback_is_blocked(scorecard) else 1,
        _decimal(scorecard.get("net_pnl_per_day")),
        _string(bundle.candidate_id),
    )


def _feedback_family_template_id(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("family_template_id"))


def _feedback_execution_signature(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("execution_signature"))


def _feedback_shape_key(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("feedback_shape_key"))


def _feedback_risk_profile_key_from_scorecard(scorecard: Mapping[str, Any]) -> str:
    direct_key = _string(scorecard.get("feedback_risk_profile_key"))
    if direct_key:
        return direct_key
    payload = _feedback_risk_profile_key_payload(
        family_template_id=_string(scorecard.get("family_template_id")),
        runtime_strategy_name=_string(scorecard.get("runtime_strategy_name")),
        execution_profile_id=_string(scorecard.get("execution_profile_id")),
        universe_key=_string(scorecard.get("universe_key")),
        signal_key=_string(scorecard.get("signal_key")),
    )
    if not any(_string(value) for value in payload.values()):
        return ""
    return _stable_hash(payload)


def _feedback_risk_profile_key(bundle: CandidateEvidenceBundle) -> str:
    return _feedback_risk_profile_key_from_scorecard(bundle.objective_scorecard)


def _execution_signature_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "execution_signature",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"signature-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _shape_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_shape_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"shape-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _risk_profile_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_risk_profile_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"risk-profile-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _family_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "family_template_id",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"family-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _pre_replay_proposal_model_and_rows(
    *,
    specs: Sequence[CandidateSpec],
    feedback_evidence_bundles: Sequence[CandidateEvidenceBundle] = (),
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    spec_ids = {spec.candidate_spec_id for spec in specs}
    execution_signature_by_spec = {
        spec.candidate_spec_id: _candidate_spec_execution_signature(spec)
        for spec in specs
    }
    feedback_shape_key_by_spec = {
        spec.candidate_spec_id: _candidate_spec_feedback_shape_key(spec)
        for spec in specs
    }
    feedback_risk_profile_key_by_spec = {
        spec.candidate_spec_id: _candidate_spec_feedback_risk_profile_key(spec)
        for spec in specs
    }
    feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        if bundle.candidate_spec_id not in spec_ids:
            continue
        current = feedback_by_spec.get(bundle.candidate_spec_id)
        if current is None or _feedback_bundle_sort_value(
            bundle
        ) > _feedback_bundle_sort_value(current):
            feedback_by_spec[bundle.candidate_spec_id] = bundle

    feedback_by_execution_signature: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        execution_signature = _feedback_execution_signature(bundle)
        if not execution_signature:
            continue
        current = feedback_by_execution_signature.get(execution_signature)
        if current is None or _feedback_bundle_sort_value(
            bundle
        ) > _feedback_bundle_sort_value(current):
            feedback_by_execution_signature[execution_signature] = bundle
    signature_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if spec.candidate_spec_id in feedback_by_spec:
            continue
        signature = execution_signature_by_spec[spec.candidate_spec_id]
        bundle = feedback_by_execution_signature.get(signature)
        if bundle is not None:
            signature_feedback_by_spec[spec.candidate_spec_id] = (
                _execution_signature_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_shape: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        feedback_shape_key = _feedback_shape_key(bundle)
        if not feedback_shape_key:
            continue
        current = feedback_by_shape.get(feedback_shape_key)
        if current is None or _feedback_bundle_sort_value(
            bundle
        ) > _feedback_bundle_sort_value(current):
            feedback_by_shape[feedback_shape_key] = bundle
    shape_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
        ):
            continue
        bundle = feedback_by_shape.get(
            feedback_shape_key_by_spec[spec.candidate_spec_id]
        )
        if bundle is not None:
            shape_feedback_by_spec[spec.candidate_spec_id] = (
                _shape_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_risk_profile: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        if not _feedback_risk_profile_has_penalty(bundle.objective_scorecard):
            continue
        risk_profile_key = _feedback_risk_profile_key(bundle)
        if not risk_profile_key:
            continue
        current = feedback_by_risk_profile.get(risk_profile_key)
        if current is None or _feedback_bundle_sort_value(
            bundle
        ) > _feedback_bundle_sort_value(current):
            feedback_by_risk_profile[risk_profile_key] = bundle
    risk_profile_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
            or spec.candidate_spec_id in shape_feedback_by_spec
        ):
            continue
        bundle = feedback_by_risk_profile.get(
            feedback_risk_profile_key_by_spec[spec.candidate_spec_id]
        )
        if bundle is not None:
            risk_profile_feedback_by_spec[spec.candidate_spec_id] = (
                _risk_profile_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    feedback_by_family: dict[str, CandidateEvidenceBundle] = {}
    for bundle in feedback_evidence_bundles:
        family_template_id = _feedback_family_template_id(bundle)
        if not family_template_id:
            continue
        current = feedback_by_family.get(family_template_id)
        if current is None or _feedback_bundle_sort_value(
            bundle
        ) > _feedback_bundle_sort_value(current):
            feedback_by_family[family_template_id] = bundle
    family_feedback_by_spec: dict[str, CandidateEvidenceBundle] = {}
    for spec in specs:
        if (
            spec.candidate_spec_id in feedback_by_spec
            or spec.candidate_spec_id in signature_feedback_by_spec
            or spec.candidate_spec_id in shape_feedback_by_spec
            or spec.candidate_spec_id in risk_profile_feedback_by_spec
        ):
            continue
        bundle = feedback_by_family.get(spec.family_template_id)
        if bundle is not None:
            family_feedback_by_spec[spec.candidate_spec_id] = (
                _family_feedback_bundle_for_spec(spec=spec, bundle=bundle)
            )

    prior_bundles = [_pre_replay_prior_bundle(spec) for spec in specs]
    training_bundles: list[CandidateEvidenceBundle] = []
    training_source_by_spec: dict[str, str] = {}
    feedback_source_candidate_spec_by_spec: dict[str, str | None] = {}
    feedback_match_scope_by_spec: dict[str, str | None] = {}
    for spec, prior_bundle in zip(specs, prior_bundles, strict=True):
        candidate_spec_id = spec.candidate_spec_id
        if candidate_spec_id in feedback_by_spec:
            bundle = feedback_by_spec[candidate_spec_id]
            training_source = "feedback_real_replay"
            match_scope = "candidate_spec_id"
            source_spec_id: str | None = bundle.candidate_spec_id
        elif candidate_spec_id in signature_feedback_by_spec:
            bundle = signature_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_execution_signature_replay"
            match_scope = "execution_signature"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in shape_feedback_by_spec:
            bundle = shape_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_shape_prior"
            match_scope = "feedback_shape_key"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in risk_profile_feedback_by_spec:
            bundle = risk_profile_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_risk_profile_prior"
            match_scope = "feedback_risk_profile_key"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        elif candidate_spec_id in family_feedback_by_spec:
            bundle = family_feedback_by_spec[candidate_spec_id]
            training_source = "feedback_family_replay"
            match_scope = "family_template_id"
            source_spec_id = _string(
                bundle.objective_scorecard.get("feedback_source_candidate_spec_id")
            )
        else:
            bundle = prior_bundle
            training_source = "synthetic_prior"
            match_scope = None
            source_spec_id = None
        training_bundles.append(bundle)
        training_source_by_spec[candidate_spec_id] = training_source
        feedback_source_candidate_spec_by_spec[candidate_spec_id] = source_spec_id
        feedback_match_scope_by_spec[candidate_spec_id] = match_scope
    training_rows = build_mlx_training_rows(
        candidate_specs=specs, evidence_bundles=training_bundles
    )
    model = train_mlx_ranker(training_rows, backend_preference="mlx")
    ranked_rows = rank_training_rows(model=model, rows=training_rows)
    feature_by_spec = {
        row.candidate_spec_id: row.to_payload()["features"] for row in training_rows
    }
    target_by_spec = {row.candidate_spec_id: row.target for row in training_rows}
    feedback_bundle_by_spec = {
        **feedback_by_spec,
        **signature_feedback_by_spec,
        **shape_feedback_by_spec,
        **risk_profile_feedback_by_spec,
        **family_feedback_by_spec,
    }

    training_source_counts: dict[str, int] = {}
    for source in training_source_by_spec.values():
        training_source_counts[source] = training_source_counts.get(source, 0) + 1

    def row_selection_reason(candidate_spec_id: str) -> str:
        source = training_source_by_spec.get(candidate_spec_id, "synthetic_prior")
        bundle = feedback_bundle_by_spec.get(candidate_spec_id)
        is_blocked = bundle is not None and _feedback_is_blocked(
            bundle.objective_scorecard
        )
        if source == "feedback_real_replay" and is_blocked:
            if bundle is not None and _feedback_has_nonpositive_expected_value(
                bundle.objective_scorecard
            ):
                return "pre_replay_mlx_feedback_blocked"
            return "pre_replay_mlx_feedback_penalized"
        if source == "feedback_execution_signature_replay" and is_blocked:
            if bundle is not None and _feedback_has_nonpositive_expected_value(
                bundle.objective_scorecard
            ):
                return "pre_replay_mlx_signature_feedback_blocked"
            return "pre_replay_mlx_signature_feedback_penalized"
        if source == "feedback_shape_prior" and bundle is not None:
            if _feedback_family_prior_has_hard_block(bundle.objective_scorecard):
                return "pre_replay_mlx_shape_feedback_blocked"
            if is_blocked:
                return "pre_replay_mlx_family_feedback_penalized"
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_penalty(bundle.objective_scorecard)
        ):
            if _feedback_risk_profile_has_terminal_block(bundle.objective_scorecard):
                return "pre_replay_mlx_risk_profile_feedback_blocked"
            return "pre_replay_mlx_risk_profile_feedback_penalized"
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            return "pre_replay_mlx_family_feedback_blocked"
        if source == "feedback_family_replay" and is_blocked:
            return "pre_replay_mlx_family_feedback_penalized"
        return "pre_replay_mlx_rank"

    def proposal_score_for_item(candidate_spec_id: str, raw_score: float) -> float:
        source = training_source_by_spec.get(candidate_spec_id, "synthetic_prior")
        bundle = feedback_bundle_by_spec.get(candidate_spec_id)
        if (
            source in {"feedback_real_replay", "feedback_execution_signature_replay"}
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_has_nonpositive_expected_value(bundle.objective_scorecard)
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_shape_prior"
            and bundle is not None
            and _feedback_family_prior_has_hard_block(bundle.objective_scorecard)
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_terminal_block(bundle.objective_scorecard)
        ):
            return min(-1_000_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_risk_profile_prior"
            and bundle is not None
            and _feedback_risk_profile_has_penalty(bundle.objective_scorecard)
        ):
            return min(-500_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        if (
            source == "feedback_family_replay"
            and bundle is not None
            and _feedback_is_blocked(bundle.objective_scorecard)
        ):
            return min(-100_000.0, target_by_spec.get(candidate_spec_id, raw_score))
        return raw_score

    rows_unranked = [
        {
            "candidate_spec_id": item.candidate_spec_id,
            "proposal_score": proposal_score_for_item(
                item.candidate_spec_id, item.score
            ),
            "raw_mlx_proposal_score": item.score,
            "feedback_replay_target": target_by_spec.get(item.candidate_spec_id)
            if item.candidate_spec_id in feedback_bundle_by_spec
            else None,
            "backend": item.backend,
            "model_id": item.model_id,
            "selection_reason": row_selection_reason(item.candidate_spec_id),
            "training_source": training_source_by_spec.get(
                item.candidate_spec_id, "synthetic_prior"
            ),
            "feedback_source_candidate_spec_id": feedback_source_candidate_spec_by_spec.get(
                item.candidate_spec_id
            ),
            "feedback_match_scope": feedback_match_scope_by_spec.get(
                item.candidate_spec_id
            ),
            "feedback_evidence_context_count": len(feedback_evidence_bundles),
            "feature_hash": item.feature_hash,
            "features": feature_by_spec.get(item.candidate_spec_id, {}),
        }
        for item in ranked_rows
    ]
    rows_unranked.sort(
        key=lambda row: (
            -float(row.get("proposal_score") or 0.0),
            _string(row.get("candidate_spec_id")),
        )
    )
    rows = [{**row, "rank": index} for index, row in enumerate(rows_unranked, start=1)]
    return {
        **model.to_payload(),
        "proposal_stage": "pre_replay",
        "model_status": "active",
        "rank_bucket_lift": {"status": "pending_replay_evidence"},
        "feedback_evidence_bundle_count": len(feedback_evidence_bundles),
        "feedback_matched_spec_count": len(feedback_by_spec),
        "feedback_execution_signature_matched_spec_count": len(
            signature_feedback_by_spec
        ),
        "feedback_shape_matched_spec_count": len(shape_feedback_by_spec),
        "feedback_risk_profile_matched_spec_count": len(risk_profile_feedback_by_spec),
        "feedback_family_matched_spec_count": len(family_feedback_by_spec),
        "training_source_counts": training_source_counts,
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


def _candidate_spec_execution_signature(spec: CandidateSpec) -> str:
    vnext_payload = spec.to_vnext_experiment_payload()
    return _stable_hash(
        {
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "template_overrides": vnext_payload.get("template_overrides", {}),
            "feature_variants": vnext_payload.get("feature_variants", []),
            "veto_controller_variants": vnext_payload.get(
                "veto_controller_variants", []
            ),
            "selection_objectives": vnext_payload.get("selection_objectives", {}),
            "hard_vetoes": vnext_payload.get("hard_vetoes", {}),
        }
    )


_PRE_REPLAY_FEEDBACK_BLOCK_REASONS = frozenset(
    {
        "pre_replay_mlx_feedback_blocked",
        "pre_replay_mlx_signature_feedback_blocked",
        "pre_replay_mlx_shape_feedback_blocked",
        "pre_replay_mlx_risk_profile_feedback_blocked",
        "pre_replay_mlx_family_feedback_blocked",
    }
)
_PRE_REPLAY_SELECTION_BLOCK_REASONS = frozenset(
    {
        *_PRE_REPLAY_FEEDBACK_BLOCK_REASONS,
        "pre_replay_capital_budget_blocked",
        "pre_replay_mlx_synthetic_nonpositive_expected_value",
    }
)


def _selection_reason_blocks_replay(reason: str) -> bool:
    return reason in _PRE_REPLAY_SELECTION_BLOCK_REASONS


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
    exploitation_count = min(max(0, int(top_k)), replay_budget, len(ordered_eligible))

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

    exploitation = take_diverse(
        ordered_eligible,
        count=exploitation_count,
        selected_so_far=(),
    )
    remaining = [
        item
        for item in sorted(
            ordered_eligible, key=lambda spec: diversity_key(spec, exploitation)
        )
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
    synthetic_prior_probe_exploration_count = min(
        max(0, requested_exploration_slots - len(exploration)),
        replay_budget - len(exploitation) - len(exploration),
        len(synthetic_prior_probe_candidates),
    )
    synthetic_prior_probe_exploration = take_diverse(
        synthetic_prior_probe_candidates,
        count=synthetic_prior_probe_exploration_count,
        selected_so_far=[*exploitation, *exploration],
    )
    feedback_block_reaudit_count = min(
        requested_feedback_block_reaudit_slots,
        replay_budget
        - len(exploitation)
        - len(exploration)
        - len(synthetic_prior_probe_exploration),
        len(feedback_block_reaudit_candidates),
    )
    feedback_block_reaudit = take_diverse(
        feedback_block_reaudit_candidates,
        count=feedback_block_reaudit_count,
        selected_so_far=[
            *exploitation,
            *exploration,
            *synthetic_prior_probe_exploration,
        ],
    )
    if len(exploitation) + len(exploration) < replay_budget:
        selected_ids = {
            item.candidate_spec_id
            for item in (
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
            - len(exploitation)
            - len(exploration)
            - len(synthetic_prior_probe_exploration)
            - len(feedback_block_reaudit),
            selected_so_far=[
                *exploitation,
                *exploration,
                *synthetic_prior_probe_exploration,
                *feedback_block_reaudit,
            ],
        )
    else:
        backfill = []
    selected_reason = {
        item.candidate_spec_id: "exploitation" for item in exploitation
    } | {item.candidate_spec_id: "exploration" for item in exploration}
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
        *exploitation,
        *exploration,
        *synthetic_prior_probe_exploration,
        *feedback_block_reaudit,
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
            "replay_order_policy": "quality_gated_diversity_pick_order_with_synthetic_prior_probe_and_feedback_reaudit",
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
        symbols="" if source_specs else args.symbols,
        progress_log_seconds=args.progress_log_seconds,
        train_days=args.train_days,
        holdout_days=args.holdout_days,
        full_window_start_date=args.full_window_start_date,
        full_window_end_date=args.full_window_end_date,
        expected_last_trading_day=args.expected_last_trading_day,
        allow_stale_tape=args.allow_stale_tape,
        prefetch_full_window_rows=args.prefetch_full_window_rows,
        collect_train_gate_diagnostics=bool(
            getattr(args, "collect_train_gate_diagnostics", True)
        ),
        top_n=args.top_k,
        max_candidates_to_evaluate=getattr(
            args,
            "max_frontier_candidates_per_spec",
            _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        ),
        max_total_candidates_to_evaluate=max(
            1,
            int(
                getattr(args, "max_total_frontier_candidates", 0)
                or getattr(args, "max_candidates", 1)
            ),
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
        for frontier_candidate in top:
            candidate = dict(frontier_candidate)
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


def _run_replay_with_optional_timeout(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
) -> EpochReplayResult:
    timeout_seconds = max(0, int(getattr(args, "real_replay_timeout_seconds", 0) or 0))
    if args.replay_mode == "synthetic":
        return _run_synthetic_replay(
            specs=specs,
            output_dir=output_dir,
            max_candidates=len(specs),
        )

    shard_size = max(0, int(getattr(args, "real_replay_shard_size", 0) or 0))
    if shard_size > 0 and len(specs) > shard_size:
        shard_timeout_seconds = max(
            0, int(getattr(args, "real_replay_shard_timeout_seconds", 0) or 0)
        )
        return _run_real_replay_shards(
            args=args,
            output_dir=output_dir,
            specs=specs,
            shard_size=shard_size,
            shard_timeout_seconds=shard_timeout_seconds or timeout_seconds,
        )

    return _run_real_replay_once_with_optional_timeout(
        args=args,
        output_dir=output_dir,
        specs=specs,
        timeout_seconds=timeout_seconds,
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


def _build_real_replay_shards(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_size: int,
    shard_timeout_seconds: int,
) -> tuple[_ReplayShardPlan, ...]:
    ordered_specs = list(specs)
    bounded_shard_size = max(1, int(shard_size))
    max_frontier_candidates_per_spec = max(
        1,
        int(
            getattr(
                args,
                "max_frontier_candidates_per_spec",
                _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            )
            or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
        ),
    )
    configured_total_frontier_budget = max(
        1,
        int(
            getattr(args, "max_total_frontier_candidates", 0)
            or getattr(args, "max_candidates", 1)
        ),
    )
    plans: list[_ReplayShardPlan] = []
    for shard_index, start in enumerate(
        range(0, len(ordered_specs), bounded_shard_size), start=1
    ):
        shard_specs = tuple(ordered_specs[start : start + bounded_shard_size])
        shard_frontier_budget = min(
            configured_total_frontier_budget,
            max(1, len(shard_specs) * max_frontier_candidates_per_spec),
        )
        shard_args = argparse.Namespace(
            **{
                **vars(args),
                "max_candidates": len(shard_specs),
                "top_k": min(
                    int(getattr(args, "top_k", len(shard_specs))), len(shard_specs)
                ),
                "max_total_frontier_candidates": shard_frontier_budget,
            }
        )
        plans.append(
            _ReplayShardPlan(
                shard_index=shard_index,
                args=shard_args,
                output_dir=output_dir
                / "strategy-factory-shards"
                / f"shard-{shard_index:03d}",
                specs=shard_specs,
                timeout_seconds=shard_timeout_seconds,
            )
        )
    return tuple(plans)


def _execute_real_replay_shard(plan: _ReplayShardPlan) -> _ReplayShardOutcome:
    candidate_spec_ids = tuple(spec.candidate_spec_id for spec in plan.specs)
    try:
        result = _run_real_replay_once_with_optional_timeout(
            args=plan.args,
            output_dir=plan.output_dir,
            specs=plan.specs,
            timeout_seconds=plan.timeout_seconds,
        )
    except TimeoutError as exc:
        partial_result = _collect_partial_real_replay(
            output_dir=plan.output_dir,
            specs=plan.specs,
        )
        return _ReplayShardOutcome(
            shard_index=plan.shard_index,
            candidate_spec_ids=candidate_spec_ids,
            result=partial_result,
            failure={
                "shard_index": plan.shard_index,
                "candidate_spec_ids": list(candidate_spec_ids),
                "reason": f"{type(exc).__name__}:{exc}",
                "partial_evidence_bundle_count": len(partial_result.evidence_bundles),
                "shard_timeout_seconds": plan.timeout_seconds,
            },
        )

    failure: dict[str, Any] | None = None
    if result.incomplete:
        failure = {
            "shard_index": plan.shard_index,
            "candidate_spec_ids": list(candidate_spec_ids),
            "reason": ";".join(result.failure_reasons) or "nested_shard_incomplete",
        }
    return _ReplayShardOutcome(
        shard_index=plan.shard_index,
        candidate_spec_ids=candidate_spec_ids,
        result=result,
        failure=failure,
    )


def _failed_shard_spec_ids(
    shard_failures: Sequence[Mapping[str, Any]],
) -> tuple[str, ...]:
    spec_ids: list[str] = []
    seen: set[str] = set()
    for failure in shard_failures:
        raw_ids = failure.get("candidate_spec_ids")
        if not isinstance(raw_ids, Sequence) or isinstance(raw_ids, str):
            continue
        for raw_id in raw_ids:
            candidate_spec_id = _string(raw_id)
            if not candidate_spec_id or candidate_spec_id in seen:
                continue
            seen.add(candidate_spec_id)
            spec_ids.append(candidate_spec_id)
    return tuple(spec_ids)


def _evidenced_spec_ids(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> frozenset[str]:
    return frozenset(
        candidate_spec_id
        for candidate_spec_id in (
            _string(bundle.candidate_spec_id) for bundle in evidence_bundles
        )
        if candidate_spec_id
    )


def _retry_real_replay_failed_shard_specs(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_failures: Sequence[Mapping[str, Any]],
    shard_timeout_seconds: int,
    starting_shard_index: int,
) -> tuple[
    tuple[CandidateEvidenceBundle, ...],
    tuple[Mapping[str, Any], ...],
    tuple[Mapping[str, Any], ...],
    Mapping[str, Any] | None,
]:
    retry_limit = max(0, int(getattr(args, "real_replay_failed_spec_retries", 1) or 0))
    failed_spec_ids = _failed_shard_spec_ids(shard_failures)
    if retry_limit <= 0 or not failed_spec_ids:
        return (), (), tuple(shard_failures), None

    spec_by_id = {spec.candidate_spec_id: spec for spec in specs}
    retry_specs = tuple(
        spec_by_id[candidate_spec_id]
        for candidate_spec_id in failed_spec_ids
        if candidate_spec_id in spec_by_id
    )
    if not retry_specs:
        return (), (), tuple(shard_failures), None

    configured_timeout = max(
        0, int(getattr(args, "real_replay_retry_timeout_seconds", 0) or 0)
    )
    retry_timeout_seconds = configured_timeout
    if retry_timeout_seconds <= 0 and shard_timeout_seconds > 0:
        retry_timeout_seconds = max(shard_timeout_seconds * 2, 900)
    retry_frontier_budget = max(
        1,
        int(
            getattr(args, "real_replay_retry_max_frontier_candidates_per_spec", 1) or 1
        ),
    )

    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    completed_spec_ids: set[str] = set()
    last_failure_by_spec: dict[str, Mapping[str, Any]] = {}
    attempt_summaries: list[dict[str, Any]] = []
    next_shard_index = starting_shard_index

    for attempt in range(1, retry_limit + 1):
        pending_specs = tuple(
            spec
            for spec in retry_specs
            if spec.candidate_spec_id not in completed_spec_ids
        )
        if not pending_specs:
            break
        attempt_failures: list[dict[str, Any]] = []
        attempt_completed: list[str] = []
        attempt_evidence_before = len(evidence_bundles)
        for retry_index, spec in enumerate(pending_specs, start=1):
            next_shard_index += 1
            retry_args = argparse.Namespace(
                **{
                    **vars(args),
                    "max_candidates": 1,
                    "top_k": 1,
                    "max_frontier_candidates_per_spec": retry_frontier_budget,
                    "max_total_frontier_candidates": retry_frontier_budget,
                }
            )
            outcome = _execute_real_replay_shard(
                _ReplayShardPlan(
                    shard_index=next_shard_index,
                    args=retry_args,
                    output_dir=output_dir
                    / "strategy-factory-failed-spec-retries"
                    / f"attempt-{attempt:02d}"
                    / f"retry-{retry_index:03d}-{spec.candidate_spec_id}",
                    specs=(spec,),
                    timeout_seconds=retry_timeout_seconds,
                )
            )
            evidence_bundles.extend(outcome.result.evidence_bundles)
            replay_results.extend(outcome.result.replay_results)
            if outcome.failure is not None:
                failure = {
                    **dict(outcome.failure),
                    "retry_attempt": attempt,
                    "retry_candidate_spec_id": spec.candidate_spec_id,
                    "retry_timeout_seconds": retry_timeout_seconds,
                    "retry_max_frontier_candidates_per_spec": retry_frontier_budget,
                }
                attempt_failures.append(failure)
                last_failure_by_spec[spec.candidate_spec_id] = failure
                continue
            completed_spec_ids.add(spec.candidate_spec_id)
            last_failure_by_spec.pop(spec.candidate_spec_id, None)
            attempt_completed.append(spec.candidate_spec_id)
        attempt_summaries.append(
            {
                "attempt": attempt,
                "requested_candidate_spec_ids": [
                    spec.candidate_spec_id for spec in pending_specs
                ],
                "completed_candidate_spec_ids": attempt_completed,
                "failure_count": len(attempt_failures),
                "failures": attempt_failures,
                "new_evidence_bundle_count": len(evidence_bundles)
                - attempt_evidence_before,
            }
        )

    deduped_retry_evidence = _dedupe_replay_evidence(evidence_bundles)
    remaining_failures = tuple(last_failure_by_spec.values())
    summary = {
        "status": "failed_shard_specs_retried",
        "schema_version": "torghut.whitepaper-autoresearch-shard-retry.v1",
        "retry_limit": retry_limit,
        "retry_timeout_seconds": retry_timeout_seconds,
        "retry_max_frontier_candidates_per_spec": retry_frontier_budget,
        "original_failure_count": len(shard_failures),
        "requested_candidate_spec_ids": [
            spec.candidate_spec_id for spec in retry_specs
        ],
        "completed_candidate_spec_ids": sorted(completed_spec_ids),
        "evidence_candidate_spec_ids": sorted(
            _evidenced_spec_ids(deduped_retry_evidence)
        ),
        "remaining_failed_candidate_spec_ids": [
            _string(failure.get("retry_candidate_spec_id"))
            for failure in remaining_failures
            if _string(failure.get("retry_candidate_spec_id"))
        ],
        "attempts": attempt_summaries,
    }
    return deduped_retry_evidence, tuple(replay_results), remaining_failures, summary


def _run_real_replay_shards(
    *,
    args: argparse.Namespace,
    output_dir: Path,
    specs: Sequence[CandidateSpec],
    shard_size: int,
    shard_timeout_seconds: int,
) -> EpochReplayResult:
    evidence_bundles: list[CandidateEvidenceBundle] = []
    replay_results: list[Mapping[str, Any]] = []
    shard_failures: list[dict[str, Any]] = []
    plans = _build_real_replay_shards(
        args=args,
        output_dir=output_dir,
        specs=specs,
        shard_size=shard_size,
        shard_timeout_seconds=shard_timeout_seconds,
    )
    bounded_shard_size = max(1, int(shard_size))
    shard_workers = max(
        1,
        min(
            len(plans) or 1,
            int(getattr(args, "real_replay_shard_workers", 1) or 1),
        ),
    )
    if shard_workers <= 1:
        outcomes = [_execute_real_replay_shard(plan) for plan in plans]
    else:
        outcomes = []
        with ProcessPoolExecutor(max_workers=shard_workers) as executor:
            future_by_plan = {
                executor.submit(_execute_real_replay_shard, plan): plan
                for plan in plans
            }
            for future in as_completed(future_by_plan):
                outcomes.append(future.result())

    for outcome in sorted(outcomes, key=lambda item: item.shard_index):
        evidence_bundles.extend(outcome.result.evidence_bundles)
        replay_results.extend(outcome.result.replay_results)
        if outcome.failure is not None:
            shard_failures.append(dict(outcome.failure))

    deduped_evidence = _dedupe_replay_evidence(evidence_bundles)
    if shard_failures:
        (
            retry_evidence,
            retry_replay_results,
            remaining_failures,
            retry_summary,
        ) = _retry_real_replay_failed_shard_specs(
            args=args,
            output_dir=output_dir,
            specs=specs,
            shard_failures=shard_failures,
            shard_timeout_seconds=shard_timeout_seconds,
            starting_shard_index=len(plans),
        )
        if retry_evidence:
            evidence_bundles.extend(retry_evidence)
            deduped_evidence = _dedupe_replay_evidence(evidence_bundles)
        replay_results.extend(retry_replay_results)
        if retry_summary is not None:
            replay_results.append(dict(retry_summary))
        shard_failures = [dict(item) for item in remaining_failures]
    if shard_failures and not deduped_evidence:
        raise TimeoutError(f"real_replay_shards_failed:{len(shard_failures)}")
    if shard_failures:
        replay_results.append(
            {
                "status": "partial_replay_shards_interrupted",
                "schema_version": "torghut.whitepaper-autoresearch-shards.v1",
                "shard_size": bounded_shard_size,
                "shard_workers": shard_workers,
                "shard_timeout_seconds": shard_timeout_seconds,
                "selected_candidate_spec_count": len(specs),
                "evidence_bundle_count": len(deduped_evidence),
                "failures": shard_failures,
            }
        )
    return EpochReplayResult(
        evidence_bundles=deduped_evidence,
        replay_results=tuple(replay_results),
        incomplete=bool(shard_failures),
        failure_reasons=tuple(
            _string(item.get("reason")) for item in shard_failures if item.get("reason")
        ),
    )


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
        shadow_validation_artifact_path=_resolve_existing_path(
            cast(Path, getattr(args, "shadow_validation_artifact"))
        )
        if getattr(args, "shadow_validation_artifact", None) is not None
        else None,
    )
    return write_runtime_closure_bundle(
        run_root=output_dir,
        runner_run_id=epoch_id,
        program=program,
        best_candidate=portfolio,
        manifest=manifest,
        execution_context=execution_context if portfolio is not None else None,
    ).to_payload()


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _string(value).lower() in {"1", "true", "yes", "y", "passed"}


def _oracle_blockers(scorecard: Mapping[str, Any]) -> frozenset[str]:
    raw_blockers = _mapping(scorecard.get("profit_target_oracle")).get("blockers")
    if not isinstance(raw_blockers, Sequence) or isinstance(raw_blockers, str):
        return frozenset()
    return frozenset(
        blocker
        for blocker in (_string(item) for item in cast(Sequence[Any], raw_blockers))
        if blocker
    )


def _portfolio_needs_runtime_closure_proof(portfolio: PortfolioCandidateSpec) -> bool:
    scorecard = _mapping(portfolio.objective_scorecard)
    if _boolish(scorecard.get("oracle_passed")):
        return False
    if not _boolish(scorecard.get("target_met")):
        return False
    blockers = _oracle_blockers(scorecard)
    return bool(blockers) and blockers <= _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS


def _load_json_mapping_artifact(path_value: Any) -> dict[str, Any]:
    path_text = _string(path_value)
    if not path_text:
        return {}
    try:
        payload = json.loads(Path(path_text).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return _mapping(payload)


def _runtime_closure_artifact_refs(
    runtime_closure: Mapping[str, Any],
) -> tuple[str, ...]:
    refs: list[str] = []
    root = _string(runtime_closure.get("root"))
    if root:
        summary_path = Path(root) / "summary.json"
        if summary_path.exists():
            refs.append(str(summary_path))
    for key in (
        "candidate_configmap_path",
        "gate_report_path",
        "parity_replay_path",
        "parity_report_path",
        "approval_replay_path",
        "approval_report_path",
        "shadow_validation_path",
        "portfolio_proof_receipt_path",
        "profitability_stage_manifest_path",
        "promotion_prerequisites_path",
        "replay_plan_path",
    ):
        ref = _string(runtime_closure.get(key))
        if ref and Path(ref).exists() and ref not in refs:
            refs.append(ref)
    return tuple(refs)


def _runtime_report_summary_int(
    report: Mapping[str, Any], key: str, *, default: int = 0
) -> int:
    value = _mapping(report.get("summary")).get(key)
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def _runtime_closure_start_equity(runtime_closure: Mapping[str, Any]) -> Decimal:
    replay_plan = _load_json_mapping_artifact(runtime_closure.get("replay_plan_path"))
    execution_context = _mapping(replay_plan.get("execution_context"))
    return _decimal(execution_context.get("start_equity"))


def _portfolio_executable_max_notional(portfolio: PortfolioCandidateSpec) -> Decimal:
    max_notional = Decimal("0")
    base_per_leg_notional = Decimal("50000")
    for sleeve in portfolio.sleeves:
        explicit_max = _decimal(sleeve.get("max_notional_per_trade"))
        if explicit_max > 0:
            max_notional = max(max_notional, explicit_max)
            continue
        weight = _decimal(sleeve.get("weight"), default="1")
        if weight <= 0:
            weight = Decimal("1")
        max_notional = max(max_notional, base_per_leg_notional * weight)
    return max_notional


def _runtime_closure_scorecard_update(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
) -> dict[str, Any]:
    parity_report = _load_json_mapping_artifact(
        runtime_closure.get("parity_report_path")
    )
    approval_report = _load_json_mapping_artifact(
        runtime_closure.get("approval_report_path")
    )
    shadow_validation = _load_json_mapping_artifact(
        runtime_closure.get("shadow_validation_path")
    )
    parity_pass = _boolish(parity_report.get("objective_met"))
    approval_pass = _boolish(approval_report.get("objective_met"))
    artifact_refs = _runtime_closure_artifact_refs(runtime_closure)
    executable_artifact_refs = tuple(
        ref
        for ref in (
            _string(runtime_closure.get("parity_replay_path")),
            _string(runtime_closure.get("approval_replay_path")),
        )
        if ref and Path(ref).exists()
    )
    executable_report = approval_report if approval_report else parity_report
    filled_order_count = _runtime_report_summary_int(executable_report, "filled_count")
    submitted_order_count = _runtime_report_summary_int(
        executable_report, "decision_count"
    )
    shadow_status = _string(shadow_validation.get("status")) or "missing"
    return {
        "runtime_closure_proof": {
            "status": _string(runtime_closure.get("status")) or "missing",
            "parity_objective_met": parity_pass,
            "approval_objective_met": approval_pass,
            "shadow_status": shadow_status,
            "artifact_refs": list(artifact_refs),
            "executable_replay_artifact_refs": list(executable_artifact_refs),
        },
        "runtime_closure_artifact_refs": list(artifact_refs),
        "shadow_parity_status": "within_budget"
        if shadow_status == "within_budget"
        else shadow_status,
        "executable_replay_passed": (
            parity_pass and approval_pass and bool(executable_artifact_refs)
        ),
        "executable_replay_artifact_refs": list(executable_artifact_refs),
        "executable_replay_artifact_ref": executable_artifact_refs[-1]
        if executable_artifact_refs
        else "",
        "executable_replay_order_count": filled_order_count,
        "executable_replay_submitted_order_count": submitted_order_count,
        "executable_replay_account_buying_power": str(
            _runtime_closure_start_equity(runtime_closure)
        ),
        "executable_replay_max_notional_per_trade": str(
            _portfolio_executable_max_notional(portfolio)
        ),
    }


def _portfolio_with_runtime_closure_proof(
    *,
    portfolio: PortfolioCandidateSpec,
    runtime_closure: Mapping[str, Any],
    target: Decimal,
    oracle_policy: ProfitTargetOraclePolicy,
) -> PortfolioCandidateSpec:
    proof_update = _runtime_closure_scorecard_update(
        portfolio=portfolio, runtime_closure=runtime_closure
    )
    proof_payload = _mapping(proof_update.get("runtime_closure_proof"))
    if not proof_payload.get("executable_replay_artifact_refs") and proof_payload.get(
        "shadow_status"
    ) not in {"within_budget", "invalid_artifact"}:
        return portfolio

    scorecard = {**dict(portfolio.objective_scorecard), **proof_update}
    scorecard["profit_target_oracle"] = evaluate_profit_target_oracle(
        scorecard,
        target_net_pnl_per_day=target,
        policy=oracle_policy,
    )
    scorecard["oracle_passed"] = bool(scorecard["profit_target_oracle"]["passed"])
    runtime_refs = tuple(
        ref
        for ref in cast(
            Sequence[Any], scorecard.get("runtime_closure_artifact_refs") or ()
        )
        if _string(ref)
    )
    evidence_refs = tuple(dict.fromkeys((*portfolio.evidence_refs, *runtime_refs)))
    optimizer_report = {
        **dict(portfolio.optimizer_report),
        "runtime_closure_proof_status": proof_payload.get("status"),
        "runtime_closure_artifact_count": len(runtime_refs),
        "oracle_passed_after_runtime_closure": scorecard["oracle_passed"],
    }
    return replace(
        portfolio,
        objective_scorecard=scorecard,
        evidence_refs=evidence_refs,
        optimizer_report=optimizer_report,
    )


def _runtime_closure_program_for_candidate(
    *,
    program: StrategyAutoresearchProgram,
    manifest: MlxSnapshotManifest,
    portfolio: PortfolioCandidateSpec | None,
    oracle_candidate_found: bool,
) -> StrategyAutoresearchProgram:
    runtime_window_available = bool(manifest.source_window_start) and bool(
        manifest.source_window_end
    )
    if portfolio is None:
        return program
    if runtime_window_available and (
        oracle_candidate_found or _portfolio_needs_runtime_closure_proof(portfolio)
    ):
        return program
    return replace(
        program,
        runtime_closure_policy=replace(
            program.runtime_closure_policy,
            execute_parity_replay=False,
            execute_approval_replay=False,
        ),
    )


def run_whitepaper_autoresearch_profit_target(
    args: argparse.Namespace,
) -> dict[str, Any]:
    args = argparse.Namespace(
        **{
            **vars(args),
            "clickhouse_password": _resolved_clickhouse_password(args),
        }
    )
    epoch_id = str(getattr(args, "epoch_id", "") or "").strip() or run_id(
        "whitepaper-autoresearch"
    )
    started_at = datetime.now(UTC)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    program = _load_epoch_program(args)
    objective = program.objective
    try:
        candidate_universe_symbols = _candidate_universe_symbols_for_compilation(args)
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="invalid_universe",
            reason=str(exc),
            started_at=started_at,
            extra={"symbols": str(getattr(args, "symbols", "") or "")},
        )
    args = argparse.Namespace(
        **{
            **vars(args),
            "min_active_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_active_day_ratio", "0.90")),
                    objective.min_active_day_ratio,
                )
            ),
            "min_positive_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_positive_day_ratio", "0.60")),
                    objective.min_positive_day_ratio,
                )
            ),
            "min_daily_net_pnl": str(
                max(
                    _decimal_arg_or_default(
                        args,
                        "min_daily_net_pnl",
                        objective.min_daily_net_pnl,
                    ),
                    objective.min_daily_net_pnl,
                )
            ),
            "max_worst_day_loss": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss", "350")),
                    objective.max_worst_day_loss,
                )
            ),
            "max_drawdown": str(
                min(
                    _decimal(getattr(args, "max_drawdown", "900")),
                    objective.max_drawdown,
                )
            ),
            "max_best_day_share": str(
                min(
                    _decimal(getattr(args, "max_best_day_share", "0.25")),
                    objective.max_best_day_share,
                )
            ),
            "min_avg_filled_notional_per_day": str(
                max(
                    _decimal(
                        getattr(args, "min_avg_filled_notional_per_day", "300000")
                    ),
                    objective.min_daily_notional,
                )
            ),
        }
    )
    target = _decimal(args.target_net_pnl_per_day, default=_DEFAULT_DAILY_PROFIT_TARGET)
    oracle_policy = _oracle_policy_from_args(args)
    explicit_source_inputs = bool(
        args.seed_recent_whitepapers
        or getattr(args, "source_jsonl", [])
        or getattr(args, "paper_run_id", [])
    )
    sources = (
        list(_program_whitepaper_sources(program)) if not explicit_source_inputs else []
    )
    if args.seed_recent_whitepapers:
        sources.extend(_program_whitepaper_sources(program))
        sources.extend(RECENT_WHITEPAPER_SEEDS)
    for source_jsonl in getattr(args, "source_jsonl", []):
        sources.extend(sources_from_jsonl(source_jsonl))
    sources.extend(_load_sources_from_db(args.paper_run_id))
    sources = _dedupe_whitepaper_sources(sources)
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
        universe_symbols=candidate_universe_symbols,
    )
    candidate_specs = list(compilation.executable_specs)
    candidate_specs = _candidate_specs_with_oracle_policy(
        candidate_specs, oracle_policy=oracle_policy
    )
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
        output_dir / "whitepaper-sources.jsonl",
        [source.to_payload() for source in sources],
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
        (
            feedback_evidence_bundles,
            feedback_evidence_source_manifest,
        ) = _load_autoresearch_feedback_evidence_bundles(
            cast(Sequence[Path], getattr(args, "feedback_evidence_jsonl", ()) or ()),
            include_persisted=bool(getattr(args, "persist_results", False)),
        )
    except ValueError as exc:
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="invalid_feedback_evidence",
            reason=str(exc),
            started_at=started_at,
        )
    _write_json(
        output_dir / "feedback-evidence-source-manifest.json",
        feedback_evidence_source_manifest,
    )
    pre_replay_model, pre_replay_proposal_rows = _pre_replay_proposal_model_and_rows(
        specs=candidate_specs,
        feedback_evidence_bundles=feedback_evidence_bundles,
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
        feedback_block_reaudit_slots=int(
            getattr(args, "feedback_block_reaudit_slots", 0) or 0
        ),
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
        failure_reason = f"{type(exc).__name__}:{exc}"
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
        replay_diagnostic_rows = _replay_diagnostic_proposal_rows(
            candidate_selection=candidate_selection,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
        )
        false_positive_table = _false_positive_table(
            proposal_rows=replay_diagnostic_rows,
            evidence_bundles=partial_replay_result.evidence_bundles,
            oracle_policy=oracle_policy,
        )
        best_false_negative_table = _best_false_negative_table(
            candidate_selection=candidate_selection,
            pre_replay_proposal_rows=pre_replay_proposal_rows,
            evidence_bundles=partial_replay_result.evidence_bundles,
        )
        remediation = _candidate_search_remediation(
            failure_reason=failure_reason,
            candidate_selection=candidate_selection,
            evidence_bundles=partial_replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(getattr(args, "portfolio_size_min", 2) or 2),
            current_max_candidates=int(getattr(args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(args, "max_total_frontier_candidates", 0) or 0
            ),
        )
        remediation_path = output_dir / "candidate-search-remediation.json"
        _write_json(remediation_path, remediation)
        profitability_goal = _profitability_search_goal(
            args=args,
            output_dir=output_dir,
            status="replay_failed",
            status_reason=failure_reason,
            target=target,
            program=program,
            sources=sources,
            hypothesis_cards=hypothesis_cards,
            candidate_specs=candidate_specs,
            candidate_selection=candidate_selection,
            pre_replay_model=pre_replay_model,
            proposal_model=None,
            evidence_bundles=partial_replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            portfolio=None,
            oracle_candidate_found=False,
            profit_target_oracle=None,
            promotion_blockers=["replay_failed", failure_reason],
            remediation=remediation,
        )
        profitability_goal_path = output_dir / "profitability-search-goal.json"
        _write_json(profitability_goal_path, profitability_goal)
        return _write_failure_summary(
            output_dir=output_dir,
            epoch_id=epoch_id,
            status="replay_failed",
            reason=failure_reason,
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
                "false_positive_table": false_positive_table,
                "best_false_negative_table": best_false_negative_table,
                "candidate_search_remediation": remediation,
                "profitability_search_goal": profitability_goal,
                "artifacts": {
                    "candidate_search_remediation": str(remediation_path),
                    "profitability_search_goal": str(profitability_goal_path),
                    "candidate_selection_manifest": str(
                        output_dir / "candidate-selection-manifest.json"
                    ),
                    "feedback_evidence_source_manifest": str(
                        output_dir / "feedback-evidence-source-manifest.json"
                    ),
                    "partial_candidate_evidence_bundles": str(partial_artifact_path)
                    if partial_replay_result.evidence_bundles
                    else None,
                    "summary": str(output_dir / "summary.json"),
                    "diagnostics_notebook": str(
                        output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
                    ),
                },
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
    initial_oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not replay_result.incomplete
    )
    runtime_closure_program = _runtime_closure_program_for_candidate(
        program=program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
        oracle_candidate_found=initial_oracle_candidate_found,
    )
    runtime_closure = _runtime_closure_payload(
        args=args,
        output_dir=output_dir,
        epoch_id=epoch_id,
        program=runtime_closure_program,
        manifest=mlx_snapshot_manifest,
        portfolio=portfolio,
    )
    if portfolio is not None:
        portfolio = _portfolio_with_runtime_closure_proof(
            portfolio=portfolio,
            runtime_closure=runtime_closure,
            target=target,
            oracle_policy=oracle_policy,
        )
        portfolio_rows = [portfolio.to_payload()]
        _write_jsonl(output_dir / "portfolio-candidates.jsonl", portfolio_rows)
        _write_json(
            output_dir / "portfolio-optimizer-report.json", portfolio.optimizer_report
        )

    oracle_candidate_found = bool(
        portfolio is not None
        and portfolio.objective_scorecard.get("oracle_passed") is True
        and not replay_result.incomplete
    )
    replay_failure_reasons = list(replay_result.failure_reasons)
    profit_target_oracle = (
        portfolio.objective_scorecard.get("profit_target_oracle")
        if portfolio is not None
        else None
    )
    if portfolio is None:
        promotion_status = "no_candidate"
        promotion_blockers: list[str] = []
    elif replay_result.incomplete:
        promotion_status = "blocked_pending_complete_replay"
        promotion_blockers = ["selected_replay_incomplete", *replay_failure_reasons]
    elif oracle_candidate_found:
        runtime_status = _string(runtime_closure.get("status"))
        promotion_status = runtime_status or "ready_for_promotion_review"
        promotion_blockers = [
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
            )
            if _string(item) and _string(item) != "promotion_review"
        ]
    else:
        runtime_next_steps = [
            _string(item)
            for item in cast(
                Sequence[Any], runtime_closure.get("next_required_steps") or ()
            )
            if _string(item)
        ]
        promotion_status = "blocked_pending_runtime_closure_or_oracle"
        promotion_blockers = list(
            dict.fromkeys(
                (
                    *sorted(_oracle_blockers(_mapping(portfolio.objective_scorecard))),
                    *runtime_next_steps,
                )
            )
        ) or [
            "scheduler_v3_parity_missing",
            "shadow_validation_missing",
        ]
    status = "ok" if oracle_candidate_found else "no_profit_target_candidate"
    status_reason = None
    if not oracle_candidate_found:
        if replay_result.incomplete:
            status_reason = "selected_replay_incomplete"
        elif portfolio is None:
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
    candidate_search_remediation: dict[str, Any] | None = None
    remediation_path = output_dir / "candidate-search-remediation.json"
    if not oracle_candidate_found:
        candidate_search_remediation = _candidate_search_remediation(
            failure_reason=status_reason or status,
            candidate_selection=candidate_selection,
            evidence_bundles=replay_result.evidence_bundles,
            false_positive_table=false_positive_table,
            best_false_negative_table=best_false_negative_table,
            replay_timeout_seconds=int(
                getattr(args, "real_replay_timeout_seconds", 0) or 0
            ),
            max_frontier_candidates_per_spec=int(
                getattr(
                    args,
                    "max_frontier_candidates_per_spec",
                    _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
                )
                or _DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC
            ),
            current_top_k=int(getattr(args, "top_k", 16) or 16),
            current_exploration_slots=int(getattr(args, "exploration_slots", 8) or 8),
            current_portfolio_size_min=int(getattr(args, "portfolio_size_min", 2) or 2),
            current_max_candidates=int(getattr(args, "max_candidates", 64) or 64),
            current_max_total_frontier_candidates=int(
                getattr(args, "max_total_frontier_candidates", 0) or 0
            ),
        )
        _write_json(remediation_path, candidate_search_remediation)
    profitability_goal = _profitability_search_goal(
        args=args,
        output_dir=output_dir,
        status=status,
        status_reason=status_reason,
        target=target,
        program=program,
        sources=sources,
        hypothesis_cards=hypothesis_cards,
        candidate_specs=candidate_specs,
        candidate_selection=candidate_selection,
        pre_replay_model=pre_replay_model,
        proposal_model=proposal_model,
        evidence_bundles=replay_result.evidence_bundles,
        false_positive_table=false_positive_table,
        best_false_negative_table=best_false_negative_table,
        portfolio=portfolio,
        oracle_candidate_found=oracle_candidate_found,
        profit_target_oracle=cast(Mapping[str, Any], profit_target_oracle)
        if isinstance(profit_target_oracle, Mapping)
        else None,
        promotion_blockers=promotion_blockers,
        remediation=candidate_search_remediation,
    )
    profitability_goal_path = output_dir / "profitability-search-goal.json"
    _write_json(profitability_goal_path, profitability_goal)
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
        "candidate_evidence_bundle_payloads": _evidence_bundle_payloads_for_epoch_summary(
            replay_result.evidence_bundles
        ),
        "candidate_evidence_bundle_payload_count": min(
            len(replay_result.evidence_bundles),
            _MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES,
        ),
        "replay_candidate_spec_count": len(replay_candidate_specs),
        "replay_incomplete": replay_result.incomplete,
        "replay_failure_reasons": replay_failure_reasons,
        "pre_replay_proposal_score_count": len(pre_replay_proposal_rows),
        "proposal_score_count": len(proposal_rows),
        "portfolio_candidate_count": len(portfolio_rows),
        "claim_count": sum(len(source.claims) for source in sources),
        "mlx_rank_bucket_lift": proposal_model.get("rank_bucket_lift", {}),
        "false_positive_table": false_positive_table,
        "best_false_negative_table": best_false_negative_table,
        "candidate_search_remediation": candidate_search_remediation,
        "profitability_search_goal": profitability_goal,
        "best_portfolio_candidate": portfolio.to_payload()
        if portfolio is not None
        else None,
        "oracle_candidate_found": oracle_candidate_found,
        "profit_target_oracle": profit_target_oracle,
        "promotion_readiness": {
            "status": promotion_status,
            "promotable": False,
            "blockers": promotion_blockers,
        },
        "runtime_closure": runtime_closure,
        "artifacts": {
            "epoch_manifest": str(output_dir / "epoch-manifest.json"),
            "hypothesis_cards": str(output_dir / "hypothesis-cards.jsonl"),
            "whitepaper_sources": str(output_dir / "whitepaper-sources.jsonl"),
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
            "feedback_evidence_source_manifest": str(
                output_dir / "feedback-evidence-source-manifest.json"
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
            "candidate_search_remediation": str(remediation_path)
            if candidate_search_remediation is not None
            else None,
            "profitability_search_goal": str(profitability_goal_path),
            "summary": str(output_dir / "summary.json"),
            "diagnostics_notebook": str(
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ),
        },
    }
    _write_json(output_dir / "summary.json", summary)
    write_whitepaper_autoresearch_diagnostics_notebook(
        output_dir / "whitepaper-autoresearch-diagnostics.ipynb",
        summary=summary,
    )
    if args.persist_results:
        runner_config = {
            "replay_mode": args.replay_mode,
            "max_candidates": int(args.max_candidates),
            "top_k": int(args.top_k),
            "exploration_slots": int(args.exploration_slots),
            "feedback_block_reaudit_slots": int(
                getattr(args, "feedback_block_reaudit_slots", 0) or 0
            ),
            "replay_candidate_spec_count": len(replay_candidate_specs),
            "replay_incomplete": replay_result.incomplete,
            "replay_failure_reasons": replay_failure_reasons,
            "portfolio_size_min": int(args.portfolio_size_min),
            "portfolio_size_max": int(args.portfolio_size_max),
            "real_replay_shard_size": int(
                getattr(args, "real_replay_shard_size", 0) or 0
            ),
            "real_replay_shard_timeout_seconds": int(
                getattr(args, "real_replay_shard_timeout_seconds", 0) or 0
            ),
            "real_replay_shard_workers": int(
                getattr(args, "real_replay_shard_workers", 1) or 1
            ),
            "real_replay_failed_spec_retries": int(
                getattr(args, "real_replay_failed_spec_retries", 1) or 0
            ),
            "real_replay_retry_timeout_seconds": int(
                getattr(args, "real_replay_retry_timeout_seconds", 0) or 0
            ),
            "real_replay_retry_max_frontier_candidates_per_spec": int(
                getattr(args, "real_replay_retry_max_frontier_candidates_per_spec", 1)
                or 1
            ),
            "source_jsonl": [str(path) for path in getattr(args, "source_jsonl", [])],
        }
        try:
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
                runner_config=runner_config,
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            summary["persistence_status"] = "persisted"
            _write_json(output_dir / "summary.json", summary)
        except Exception as exc:
            summary["pre_persistence_status"] = status
            summary["status"] = "persistence_failed"
            summary["status_reason"] = "epoch_ledger_persistence_failed"
            summary["persistence_status"] = "failed"
            summary["persistence_error"] = str(exc)
            summary["persistence_runner_config"] = runner_config
            _write_json(output_dir / "persistence-error-summary.json", summary)
            _write_json(output_dir / "error-summary.json", summary)
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
    if status == "persistence_failed":
        return 1
    if status == "replay_failed":
        return 3
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
