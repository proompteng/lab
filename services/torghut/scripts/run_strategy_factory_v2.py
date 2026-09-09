#!/usr/bin/env python3
"""Compile claim-linked experiment specs into Harness v2 discovery runs."""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml
from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError

from app.db import SessionLocal
from app.models import VNextExperimentRun, VNextExperimentSpec
from app.trading.discovery.family_templates import (
    FamilyTemplate,
    family_template_dir,
    load_family_template,
)
from app.trading.discovery.promotion_contract import (
    blocked_research_candidate_promotion_readiness,
)
from app.trading.discovery.replay_ledger_guided_search import (
    apply_replay_ledger_remediation_guidance,
)
from scripts.search_consistent_profitability_frontier import (
    run_consistent_profitability_frontier,
)


_DEFAULT_CLICKHOUSE_HTTP_URL = (
    "http://torghut-clickhouse.torghut.svc.cluster.local:8123"
)


def _default_clickhouse_http_url() -> str:
    return (
        os.environ.get("CLICKHOUSE_HTTP_URL")
        or os.environ.get("TA_CLICKHOUSE_URL")
        or _DEFAULT_CLICKHOUSE_HTTP_URL
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run strategy-factory v2 from mirrored experiment specs.",
    )
    parser.add_argument(
        "--output-dir", type=Path, required=True, help="Artifact output directory."
    )
    parser.add_argument(
        "--experiment-id",
        action="append",
        default=[],
        help="Experiment id filter. May be repeated.",
    )
    parser.add_argument(
        "--paper-run-id",
        action="append",
        default=[],
        help="Source paper run id filter. May be repeated.",
    )
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=Path("argocd/applications/torghut/strategy-configmap.yaml"),
    )
    parser.add_argument(
        "--family-template-dir",
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        "--seed-sweep-dir",
        type=Path,
        default=Path("config/trading"),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=_default_clickhouse_http_url(),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument("--clickhouse-password", default="")
    parser.add_argument(
        "--clickhouse-password-env",
        default="",
        help="Environment variable that contains the ClickHouse password; ignored when --clickhouse-password is set.",
    )
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument("--train-days", type=int, default=6)
    parser.add_argument("--holdout-days", type=int, default=3)
    parser.add_argument("--second-oos-days", type=int, default=0)
    parser.add_argument("--full-window-start-date", default="")
    parser.add_argument("--full-window-end-date", default="")
    parser.add_argument("--expected-last-trading-day", default="")
    parser.add_argument("--allow-stale-tape", action="store_true")
    parser.add_argument("--prefetch-full-window-rows", action="store_true")
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        default=None,
        help="Optional manifest-verified replay tape reused by each frontier run.",
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        default=None,
        help="Optional manifest path for --replay-tape-path.",
    )
    parser.add_argument(
        "--collect-train-gate-diagnostics",
        action="store_true",
        help="Persist aggregate train-window gate diagnostics for each frontier candidate.",
    )
    parser.add_argument("--top-n", type=int, default=5)
    parser.add_argument("--max-candidates-to-evaluate", type=int, default=0)
    parser.add_argument(
        "--max-total-candidates-to-evaluate",
        type=int,
        default=0,
        help=(
            "Global frontier replay budget across all experiment specs. "
            "When set, each experiment receives only the remaining budget."
        ),
    )
    parser.add_argument(
        "--staged-train-screen-multiplier",
        type=int,
        default=1,
        help=(
            "When train screening is enabled, evaluate this multiple of the "
            "full-replay budget through the cheaper train screen."
        ),
    )
    parser.add_argument(
        "--capture-rejected-seed-full-window-ledger",
        action="store_true",
        help=(
            "Capture proof-only exact full-window ledgers for checked-in "
            "candidate-record seeds rejected by train screening."
        ),
    )
    parser.add_argument(
        "--capture-positive-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=0,
        help=(
            "Capture up to N proof-only exact full-window ledgers for positive "
            "train-screen rejects or candidates over the full-replay budget."
        ),
    )
    parser.add_argument(
        "--capture-top-rejected-full-window-ledgers",
        dest="capture_positive_rejected_full_window_ledgers",
        type=int,
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--symbol-prune-iterations",
        type=int,
        default=0,
        help="Generate bounded child candidates by pruning downside symbols.",
    )
    parser.add_argument("--symbol-prune-candidates", type=int, default=1)
    parser.add_argument("--symbol-prune-min-universe-size", type=int, default=2)
    parser.add_argument(
        "--loss-repair-iterations",
        type=int,
        default=0,
        help="Generate bounded child candidates that tighten loss controls.",
    )
    parser.add_argument("--loss-repair-candidates", type=int, default=1)
    parser.add_argument(
        "--consistency-repair-iterations",
        type=int,
        default=0,
        help="Generate bounded child candidates that repair positive near-misses.",
    )
    parser.add_argument("--consistency-repair-candidates", type=int, default=2)
    parser.add_argument(
        "--persist-results",
        dest="persist_results",
        action="store_true",
        help="Persist compiled and executed experiment runs.",
    )
    parser.add_argument(
        "--no-persist-results",
        dest="persist_results",
        action="store_false",
        help="Skip database persistence.",
    )
    parser.set_defaults(persist_results=True)
    return parser.parse_args()


@dataclass(frozen=True)
class CompiledExperimentSweep:
    source_run_id: str
    experiment_id: str
    family_template: FamilyTemplate
    experiment_payload: dict[str, Any]
    sweep_config: dict[str, Any]


@dataclass(frozen=True)
class InMemoryExperimentSpec:
    run_id: str
    experiment_id: str
    payload_json: Mapping[str, Any]


ExperimentSpecRow = VNextExperimentSpec | InMemoryExperimentSpec


def _mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _list_of_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _coerce_decimal(value: Any, *, default: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int | float):
        return Decimal(str(value))
    text = str(value or "").strip()
    return Decimal(text or default)


def _resolved_clickhouse_password(args: argparse.Namespace) -> str:
    direct_password = str(getattr(args, "clickhouse_password", "") or "").strip()
    if direct_password:
        return direct_password
    password_env = str(getattr(args, "clickhouse_password_env", "") or "").strip()
    if not password_env:
        return ""
    return os.environ.get(password_env, "")


def _coerce_ratio_days(*, ratio: Decimal, total_days: int) -> int:
    if total_days <= 0 or ratio <= 0:
        return 0
    scaled = (ratio * Decimal(total_days)).quantize(
        Decimal("1"), rounding=ROUND_CEILING
    )
    return max(1, int(scaled))


def _force_standalone_research_replay(experiment_payload: Mapping[str, Any]) -> bool:
    promotion_contract = _mapping(experiment_payload.get("promotion_contract"))
    return (
        str(promotion_contract.get("source") or "").strip()
        == "whitepaper_autoresearch_profit_target"
    )


def _singleton_grid(value: Any) -> list[Any]:
    return [json.loads(json.dumps(value))]


def _load_seed_sweep_config(
    family_template_id: str,
    *,
    seed_dir: Path,
) -> dict[str, Any] | None:
    candidates: list[Path] = []
    seen: set[Path] = set()
    for pattern in (
        "profitability-frontier-consistent-*.yaml",
        "profitability-frontier-strict-daily-*.yaml",
        "profitability-frontier-*.yaml",
    ):
        for candidate in sorted(seed_dir.glob(pattern)):
            resolved = candidate.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            candidates.append(candidate)
    for candidate in candidates:
        payload = yaml.safe_load(candidate.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            continue
        if str(payload.get("family_template_id") or "").strip() == family_template_id:
            return json.loads(json.dumps(payload))
    return None


def _compile_sweep_config(
    *,
    experiment_row: ExperimentSpecRow,
    family_dir: Path,
    seed_dir: Path,
    train_days: int,
    holdout_days: int,
) -> CompiledExperimentSweep:
    experiment_payload = _mapping(experiment_row.payload_json)
    experiment_id = str(experiment_row.experiment_id).strip()
    family_template_id = str(experiment_payload.get("family_template_id") or "").strip()
    if not family_template_id:
        raise ValueError(f"experiment_family_template_missing:{experiment_id}")

    family_template = load_family_template(
        family_template_id,
        directory=family_dir,
    )
    runtime_harness = _mapping(family_template.runtime_harness)
    seed_config = _load_seed_sweep_config(family_template_id, seed_dir=seed_dir) or {}

    selection_objectives = {
        **dict(family_template.default_selection_objectives),
        **_mapping(experiment_payload.get("selection_objectives")),
    }
    hard_vetoes = {
        **dict(family_template.default_hard_vetoes),
        **_mapping(experiment_payload.get("hard_vetoes")),
    }
    template_overrides = _mapping(experiment_payload.get("template_overrides"))
    param_overrides = _mapping(template_overrides.pop("params", None))
    feature_variants = _list_of_strings(experiment_payload.get("feature_variants"))
    veto_variants_raw = experiment_payload.get("veto_controller_variants")
    veto_variants = (
        cast(list[Any], veto_variants_raw)
        if isinstance(veto_variants_raw, list)
        else []
    )

    total_days = max(1, train_days + holdout_days)
    min_active_ratio = _coerce_decimal(
        hard_vetoes.get(
            "required_min_active_day_ratio",
            family_template.activity_model.get("min_active_day_ratio", "0"),
        ),
        default="0",
    )
    min_daily_notional = _coerce_decimal(
        hard_vetoes.get(
            "required_min_daily_notional",
            family_template.activity_model.get("min_daily_notional", "0"),
        ),
        default="0",
    )
    positive_day_ratio = _coerce_decimal(
        selection_objectives.get("require_positive_day_ratio"),
        default="0",
    )
    target_net_per_day = _coerce_decimal(
        selection_objectives.get("target_net_pnl_per_day"),
        default="0",
    )
    min_active_days = _coerce_ratio_days(ratio=min_active_ratio, total_days=total_days)
    min_active_holdout_days = _coerce_ratio_days(
        ratio=min_active_ratio, total_days=max(1, holdout_days)
    )
    min_positive_days = _coerce_ratio_days(
        ratio=positive_day_ratio, total_days=total_days
    )
    min_avg_filled_notional_per_active_day = min_daily_notional
    if min_active_ratio > 0:
        min_avg_filled_notional_per_active_day = (
            min_daily_notional / min_active_ratio
        ).quantize(Decimal("1"))

    strategy_overrides = _mapping(seed_config.get("strategy_overrides"))
    for key, value in template_overrides.items():
        strategy_overrides[str(key)] = _singleton_grid(value)
    if feature_variants:
        strategy_overrides["normalization_regime"] = feature_variants
    if veto_variants:
        strategy_overrides["veto_controller_variant"] = veto_variants

    parameters = _mapping(seed_config.get("parameters"))
    for key, value in param_overrides.items():
        parameters[str(key)] = _singleton_grid(value)
    parameters.setdefault("position_isolation_mode", ["per_strategy"])

    family = str(
        seed_config.get("family") or runtime_harness.get("family") or ""
    ).strip()
    strategy_name = str(
        seed_config.get("strategy_name") or runtime_harness.get("strategy_name") or ""
    ).strip()
    if not family or not strategy_name:
        raise ValueError(
            f"family_template_runtime_harness_incomplete:{family_template_id}"
        )

    holdout_constraints = {
        **_mapping(seed_config.get("constraints")),
        "holdout_target_net_per_day": str(target_net_per_day),
        "min_active_holdout_days": min_active_holdout_days,
        "max_worst_holdout_day_loss": str(
            _coerce_decimal(hard_vetoes.get("required_max_worst_day_loss"), default="0")
        ),
        "min_profit_factor": str(
            _coerce_decimal(
                selection_objectives.get("min_profit_factor"), default="1.0"
            )
        ),
        "require_training_decisions": True,
        "require_holdout_decisions": True,
    }
    consistency_constraints = {
        **_mapping(seed_config.get("consistency_constraints")),
        "target_net_per_day": str(target_net_per_day),
        "min_active_days": min_active_days,
        "min_active_ratio": str(min_active_ratio),
        "min_positive_days": min_positive_days,
        "max_worst_day_loss": str(
            _coerce_decimal(hard_vetoes.get("required_max_worst_day_loss"), default="0")
        ),
        "max_negative_days": max(0, total_days - min_positive_days),
        "max_drawdown": str(
            _coerce_decimal(hard_vetoes.get("required_max_drawdown"), default="0")
        ),
        "max_best_day_share_of_total_pnl": str(
            _coerce_decimal(hard_vetoes.get("required_max_best_day_share"), default="1")
        ),
        "min_avg_filled_notional_per_day": str(min_daily_notional),
        "min_avg_filled_notional_per_active_day": str(
            min_avg_filled_notional_per_active_day
        ),
        "require_every_day_active": bool(min_active_ratio >= Decimal("1")),
        "min_regime_slice_pass_rate": str(
            _coerce_decimal(
                hard_vetoes.get("required_min_regime_slice_pass_rate"), default="0"
            )
        ),
    }

    sweep_config = {
        "schema_version": str(
            seed_config.get("schema_version") or "torghut.replay-frontier-sweep.v1"
        ),
        "family": family,
        "family_template_id": family_template.family_id,
        "strategy_name": strategy_name,
        "disable_other_strategies": True
        if _force_standalone_research_replay(experiment_payload)
        else bool(
            seed_config.get(
                "disable_other_strategies",
                runtime_harness.get("disable_other_strategies", True),
            )
        ),
        "constraints": holdout_constraints,
        "consistency_constraints": consistency_constraints,
        "strategy_overrides": strategy_overrides,
        "parameters": parameters,
        "experiment_spec": {
            "source_run_id": experiment_row.run_id,
            "experiment_id": experiment_id,
            "paper_claim_links": experiment_payload.get("paper_claim_links") or [],
            "expected_failure_modes": experiment_payload.get("expected_failure_modes")
            or [],
            "promotion_contract": experiment_payload.get("promotion_contract") or {},
        },
    }
    return CompiledExperimentSweep(
        source_run_id=str(experiment_row.run_id),
        experiment_id=experiment_id,
        family_template=family_template,
        experiment_payload=experiment_payload,
        sweep_config=sweep_config,
    )


def _replay_ledger_remediation_report(
    experiment_payload: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    for key in (
        "exact_replay_ledger_remediation",
        "replay_ledger_remediation",
        "remediation_report",
    ):
        report = _mapping(experiment_payload.get(key))
        if report:
            return report
    return None


def _apply_replay_ledger_guidance_to_compiled_sweep(
    compiled: CompiledExperimentSweep,
) -> CompiledExperimentSweep:
    remediation_report = _replay_ledger_remediation_report(compiled.experiment_payload)
    guided_sweep = apply_replay_ledger_remediation_guidance(
        sweep_config=compiled.sweep_config,
        remediation_report=remediation_report,
    )
    if not guided_sweep.applied:
        return compiled
    return replace(compiled, sweep_config=guided_sweep.sweep_config)


def _frontier_args(
    *,
    args: argparse.Namespace,
    strategy_configmap: Path,
    sweep_config: Path,
    json_output: Path,
    max_candidates_to_evaluate: int | None = None,
) -> argparse.Namespace:
    return argparse.Namespace(
        strategy_configmap=strategy_configmap,
        sweep_config=sweep_config,
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=str(args.clickhouse_username),
        clickhouse_password=str(args.clickhouse_password),
        start_equity=str(args.start_equity),
        chunk_minutes=int(args.chunk_minutes),
        symbols=str(args.symbols),
        progress_log_seconds=int(args.progress_log_seconds),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        second_oos_days=max(0, int(getattr(args, "second_oos_days", 0) or 0)),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        expected_last_trading_day=str(args.expected_last_trading_day),
        allow_stale_tape=bool(args.allow_stale_tape),
        family_template_dir=args.family_template_dir,
        prefetch_full_window_rows=bool(args.prefetch_full_window_rows),
        replay_tape_path=(
            Path(replay_tape_path).resolve()
            if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
            else None
        ),
        replay_tape_manifest=(
            Path(replay_tape_manifest).resolve()
            if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
            is not None
            else None
        ),
        collect_train_gate_diagnostics=bool(
            getattr(args, "collect_train_gate_diagnostics", False)
        ),
        top_n=int(args.top_n),
        max_candidates_to_evaluate=(
            int(max_candidates_to_evaluate)
            if max_candidates_to_evaluate is not None
            else int(getattr(args, "max_candidates_to_evaluate", 0))
        ),
        staged_train_screen_multiplier=max(
            1, int(getattr(args, "staged_train_screen_multiplier", 1) or 1)
        ),
        json_output=json_output,
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
    )


def _load_source_experiment_specs(
    args: argparse.Namespace,
) -> list[VNextExperimentSpec]:
    experiment_ids = {item.strip() for item in args.experiment_id if str(item).strip()}
    run_ids = {item.strip() for item in args.paper_run_id if str(item).strip()}
    with SessionLocal() as session:
        stmt = select(VNextExperimentSpec).where(
            VNextExperimentSpec.candidate_id.is_(None)
        )
        if experiment_ids:
            stmt = stmt.where(
                VNextExperimentSpec.experiment_id.in_(sorted(experiment_ids))
            )
        if run_ids:
            stmt = stmt.where(VNextExperimentSpec.run_id.in_(sorted(run_ids)))
        rows = session.execute(
            stmt.order_by(VNextExperimentSpec.created_at.desc()).limit(
                max(1, int(args.limit))
            )
        ).scalars()
        return list(rows)


def _persist_result_once(
    *,
    runner_run_id: str,
    experiment: CompiledExperimentSweep,
    result_payload: Mapping[str, Any],
    compiled_sweep_path: Path,
    result_path: Path,
) -> None:
    top_candidates = cast(list[dict[str, Any]], result_payload.get("top") or [])
    best_candidate_id = (
        str(top_candidates[0].get("candidate_id") or "").strip()
        if top_candidates
        else None
    ) or None
    promotion_readiness = blocked_research_candidate_promotion_readiness(
        candidate_id=best_candidate_id or "",
        family_template_id=experiment.family_template.family_id,
        runtime_harness=experiment.family_template.runtime_harness,
    )
    experiment_payload = {
        **experiment.experiment_payload,
        "compiled_family_template": experiment.family_template.to_payload(),
        "compiled_sweep_path": str(compiled_sweep_path),
        "result_path": str(result_path),
        "runner": "run_strategy_factory_v2",
        "runner_run_id": runner_run_id,
        "promotion_readiness": promotion_readiness,
        "result": result_payload,
    }
    run_payload = {
        "compiled_sweep_path": str(compiled_sweep_path),
        "result_path": str(result_path),
        "dataset_snapshot_receipt": result_payload.get("dataset_snapshot_receipt"),
        "top_candidate": top_candidates[0] if top_candidates else None,
        "promotion_readiness": promotion_readiness,
    }
    with SessionLocal() as session:
        session.execute(
            delete(VNextExperimentRun).where(
                VNextExperimentRun.run_id == runner_run_id,
                VNextExperimentRun.experiment_id == experiment.experiment_id,
            )
        )
        existing_spec = None
        if best_candidate_id is not None:
            existing_spec = session.execute(
                select(VNextExperimentSpec).where(
                    VNextExperimentSpec.candidate_id == best_candidate_id,
                    VNextExperimentSpec.experiment_id == experiment.experiment_id,
                )
            ).scalar_one_or_none()
        if existing_spec is not None:
            existing_spec.run_id = runner_run_id
            existing_spec.payload_json = experiment_payload
        else:
            session.execute(
                delete(VNextExperimentSpec).where(
                    VNextExperimentSpec.run_id == runner_run_id,
                    VNextExperimentSpec.experiment_id == experiment.experiment_id,
                )
            )
            session.add(
                VNextExperimentSpec(
                    run_id=runner_run_id,
                    candidate_id=best_candidate_id,
                    experiment_id=experiment.experiment_id,
                    payload_json=experiment_payload,
                )
            )

        existing_run = None
        if best_candidate_id is not None:
            existing_run = session.execute(
                select(VNextExperimentRun).where(
                    VNextExperimentRun.candidate_id == best_candidate_id,
                    VNextExperimentRun.run_id == runner_run_id,
                )
            ).scalar_one_or_none()
        if existing_run is not None:
            existing_run.experiment_id = experiment.experiment_id
            existing_run.stage_lineage_root = None
            existing_run.payload_json = run_payload
        else:
            session.add(
                VNextExperimentRun(
                    run_id=runner_run_id,
                    candidate_id=best_candidate_id,
                    experiment_id=experiment.experiment_id,
                    stage_lineage_root=None,
                    payload_json=run_payload,
                )
            )
        session.commit()


def _persist_result(
    *,
    runner_run_id: str,
    experiment: CompiledExperimentSweep,
    result_payload: Mapping[str, Any],
    compiled_sweep_path: Path,
    result_path: Path,
    max_attempts: int = 3,
) -> dict[str, Any]:
    bounded_attempts = max(1, int(max_attempts))
    last_error: SQLAlchemyError | None = None
    for attempt in range(1, bounded_attempts + 1):
        try:
            _persist_result_once(
                runner_run_id=runner_run_id,
                experiment=experiment,
                result_payload=result_payload,
                compiled_sweep_path=compiled_sweep_path,
                result_path=result_path,
            )
            return {"status": "persisted", "attempt": attempt}
        except SQLAlchemyError as exc:
            last_error = exc
            if attempt >= bounded_attempts:
                break
            time.sleep(min(2.0, 0.25 * attempt))
    return {
        "status": "failed",
        "attempts": bounded_attempts,
        "error_type": type(last_error).__name__ if last_error is not None else "",
        "error": str(last_error) if last_error is not None else "",
    }


def run_strategy_factory_v2(args: argparse.Namespace) -> dict[str, Any]:
    return run_strategy_factory_v2_from_specs(args)


def run_strategy_factory_v2_from_specs(
    args: argparse.Namespace,
    *,
    source_specs: Sequence[ExperimentSpecRow] | None = None,
) -> dict[str, Any]:
    args = argparse.Namespace(
        **{
            **vars(args),
            "clickhouse_password": _resolved_clickhouse_password(args),
        }
    )
    source_specs = (
        list(source_specs)
        if source_specs is not None
        else _load_source_experiment_specs(args)
    )
    if not source_specs:
        return {"status": "no_experiments", "count": 0, "experiments": []}

    runner_run_id = (
        f"strategy-factory-v2-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    )
    results: list[dict[str, Any]] = []
    persistence_failures: list[dict[str, Any]] = []
    max_total_candidates_to_evaluate = max(
        0, int(getattr(args, "max_total_candidates_to_evaluate", 0) or 0)
    )
    total_candidate_count = 0
    total_candidate_budget_exhausted = False
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for experiment_row in source_specs:
        per_spec_candidate_budget = max(
            0, int(getattr(args, "max_candidates_to_evaluate", 0) or 0)
        )
        effective_candidate_budget = per_spec_candidate_budget
        if max_total_candidates_to_evaluate > 0:
            remaining_candidate_budget = (
                max_total_candidates_to_evaluate - total_candidate_count
            )
            effective_candidate_budget = (
                remaining_candidate_budget
                if per_spec_candidate_budget <= 0
                else min(per_spec_candidate_budget, remaining_candidate_budget)
            )
        compiled = _compile_sweep_config(
            experiment_row=experiment_row,
            family_dir=args.family_template_dir.resolve(),
            seed_dir=args.seed_sweep_dir.resolve(),
            train_days=max(1, int(args.train_days)),
            holdout_days=max(1, int(args.holdout_days)),
        )
        compiled = _apply_replay_ledger_guidance_to_compiled_sweep(compiled)
        experiment_root = args.output_dir / compiled.experiment_id
        experiment_root.mkdir(parents=True, exist_ok=True)
        compiled_sweep_path = experiment_root / "compiled-sweep.yaml"
        compiled_sweep_path.write_text(
            yaml.safe_dump(compiled.sweep_config, sort_keys=False),
            encoding="utf-8",
        )
        result_path = experiment_root / "result.json"
        frontier_payload = run_consistent_profitability_frontier(
            _frontier_args(
                args=args,
                strategy_configmap=args.strategy_configmap.resolve(),
                sweep_config=compiled_sweep_path,
                json_output=result_path,
                max_candidates_to_evaluate=effective_candidate_budget,
            )
        )
        experiment_candidate_count = max(
            0, int(frontier_payload.get("candidate_count") or 0)
        )
        total_candidate_count += experiment_candidate_count
        result_path.write_text(
            json.dumps(frontier_payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        persistence_status: Mapping[str, Any] | None = None
        if args.persist_results:
            persistence_status = _persist_result(
                runner_run_id=runner_run_id,
                experiment=compiled,
                result_payload=frontier_payload,
                compiled_sweep_path=compiled_sweep_path,
                result_path=result_path,
            )
            if persistence_status.get("status") != "persisted":
                persistence_failures.append(
                    {
                        "experiment_id": compiled.experiment_id,
                        "candidate_spec_id": _mapping(
                            compiled.experiment_payload.get("candidate_spec")
                        ).get("candidate_spec_id")
                        or compiled.experiment_id,
                        **dict(persistence_status),
                    }
                )
        top_candidates = cast(list[dict[str, Any]], frontier_payload.get("top") or [])
        top_candidate_id = (
            str(top_candidates[0].get("candidate_id") or "").strip()
            if top_candidates
            else ""
        )
        candidate_spec_id = str(
            _mapping(compiled.experiment_payload.get("candidate_spec")).get(
                "candidate_spec_id"
            )
            or compiled.experiment_id
        ).strip()
        promotion_readiness = blocked_research_candidate_promotion_readiness(
            candidate_id=top_candidate_id,
            family_template_id=compiled.family_template.family_id,
            runtime_harness=compiled.family_template.runtime_harness,
        )
        replay_guidance = _mapping(
            _mapping(compiled.sweep_config.get("metadata")).get(
                "replay_ledger_guided_search"
            )
        )
        results.append(
            {
                "source_run_id": compiled.source_run_id,
                "experiment_id": compiled.experiment_id,
                "candidate_spec_id": candidate_spec_id,
                "family_template_id": compiled.family_template.family_id,
                "compiled_sweep_path": str(compiled_sweep_path),
                "result_path": str(result_path),
                "dataset_snapshot_id": str(
                    _mapping(frontier_payload.get("dataset_snapshot_receipt")).get(
                        "snapshot_id"
                    )
                    or ""
                ),
                "frontier_candidate_budget": effective_candidate_budget,
                "frontier_candidate_count": experiment_candidate_count,
                "top_candidate_id": top_candidate_id,
                "top_net_per_day": (
                    str(
                        _mapping(top_candidates[0].get("full_window")).get(
                            "net_per_day"
                        )
                        or ""
                    )
                    if top_candidates
                    else ""
                ),
                "replay_ledger_guided_actions": _list_of_strings(
                    replay_guidance.get("applied_actions")
                ),
                "promotion_readiness": promotion_readiness,
                "persistence_status": dict(persistence_status)
                if persistence_status is not None
                else None,
            }
        )
        if (
            max_total_candidates_to_evaluate > 0
            and total_candidate_count >= max_total_candidates_to_evaluate
        ):
            total_candidate_budget_exhausted = True
            break

    summary = {
        "status": (
            "total_candidate_budget_exhausted"
            if total_candidate_budget_exhausted
            else "ok_with_persistence_warnings"
            if persistence_failures
            else "ok"
        ),
        "runner_run_id": runner_run_id,
        "count": len(results),
        "max_total_candidates_to_evaluate": max_total_candidates_to_evaluate,
        "persisted": bool(args.persist_results) and not persistence_failures,
        "persistence_failures": persistence_failures,
        "total_candidate_count": total_candidate_count,
        "experiments": results,
    }
    return summary


def main() -> int:
    args = _parse_args()
    payload = run_strategy_factory_v2(args)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
