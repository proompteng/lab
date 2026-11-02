"""Archive bundle and proof helpers for historical profitability validation."""

from __future__ import annotations

import math
import random
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sqlalchemy.orm import Session

from .archive_models import (
    ArchiveWalkForwardFold,
    ArchivedTradingDayBundle,
    DATA_SUFFICIENCY_SCHEMA_VERSION,
    SUFFICIENCY_STATUS_HISTORICAL_READY,
    SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY,
    SUFFICIENCY_STATUS_PAPER_READY,
    SUFFICIENCY_STATUS_RESEARCH_ONLY,
    TRIAL_LEDGER_SCHEMA_VERSION,
    DSR_MIN_SAMPLE_DAYS,
    NORMAL_DIST,
    REALITY_CHECK_MIN_SAMPLE_DAYS,
    UTC,
    as_dict,
    as_float,
    as_text,
    candidate_id_from_manifest,
    decimal_mean,
    decimal_median,
    load_json,
    load_manifest,
    manifest_trading_day,
    mean_optional_floats,
    min_retention_days,
    missing_business_days,
    resolve_manifest_path,
    safe_decimal_ratio,
    simulation_report_path,
    stable_hash,
    write_json,
    build_execution_day_inventory,
    build_market_day_inventory,
    build_replay_day_manifest,
    collect_simulation_postgres_counts,
    copy_archive_artifacts,
    upsert_dataset_snapshot,
)


def archive_historical_simulation_run(
    *,
    run_dir: Path,
    archive_root: Path,
    manifest_path: Path | None = None,
    topic_retention_ms_by_topic: Mapping[str, int] | None = None,
    postgres_counts: Mapping[str, int] | None = None,
    session: Session | None = None,
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    simulation_report_file = simulation_report_path(run_dir)
    if not simulation_report_file.exists():
        raise RuntimeError(f"simulation_report_missing:{run_dir}")
    run_manifest_path = run_dir / "run-manifest.json"
    replay_report_path = run_dir / "replay-report.json"
    if not run_manifest_path.exists():
        raise RuntimeError(f"run_manifest_missing:{run_dir}")
    if not replay_report_path.exists():
        raise RuntimeError(f"replay_report_missing:{run_dir}")

    simulation_report = load_json(simulation_report_file)
    run_manifest = load_json(run_manifest_path)
    replay_report = load_json(replay_report_path)
    resolved_manifest_path = manifest_path
    if resolved_manifest_path is None:
        run_metadata = as_dict(simulation_report.get("run_metadata"))
        manifest_text = as_text(run_metadata.get("manifest_path"))
        if manifest_text is None:
            raise RuntimeError(f"manifest_path_missing:{run_dir}")
        resolved_manifest_path = Path(manifest_text)
    resolved_manifest_path = resolve_manifest_path(run_dir, resolved_manifest_path)
    manifest = load_manifest(resolved_manifest_path)
    trading_day = manifest_trading_day(manifest, simulation_report)
    candidate_id = candidate_id_from_manifest(manifest, run_manifest)
    run_id = as_text(run_manifest.get("run_id")) or run_dir.name
    archive_dir = archive_root / trading_day / candidate_id / run_id
    artifact_refs = copy_archive_artifacts(
        run_dir=run_dir,
        archive_run_dir=archive_dir,
        manifest_path=resolved_manifest_path,
    )
    actual_postgres_counts = dict(postgres_counts or {})
    if not actual_postgres_counts:
        simulation_dsn = (
            as_text(as_dict(manifest.get("postgres")).get("simulation_dsn")) or ""
        )
        if simulation_dsn:
            try:
                actual_postgres_counts = collect_simulation_postgres_counts(
                    simulation_dsn
                )
            except Exception:
                actual_postgres_counts = {}
    market_day_inventory = build_market_day_inventory(
        manifest=manifest,
        run_manifest=run_manifest,
        replay_report=replay_report,
        simulation_report=simulation_report,
        artifact_refs=artifact_refs,
        topic_retention_ms_by_topic=topic_retention_ms_by_topic,
        observed_at=observed_at,
    )
    execution_day_inventory = build_execution_day_inventory(
        manifest=manifest,
        simulation_report=simulation_report,
        artifact_refs=artifact_refs,
        postgres_counts=actual_postgres_counts,
        observed_at=observed_at,
    )
    replay_day_manifest = build_replay_day_manifest(
        manifest=manifest,
        run_manifest=run_manifest,
        replay_report=replay_report,
        archive_dir=archive_dir,
        original_run_dir=run_dir,
        artifact_refs=artifact_refs,
        market_day_inventory=market_day_inventory,
        execution_day_inventory=execution_day_inventory,
        observed_at=observed_at,
    )

    market_day_inventory_path = archive_dir / "market_day_inventory.json"
    execution_day_inventory_path = archive_dir / "execution_day_inventory.json"
    replay_day_manifest_path = archive_dir / "replay_day_manifest.json"
    write_json(market_day_inventory_path, market_day_inventory)
    write_json(execution_day_inventory_path, execution_day_inventory)
    write_json(replay_day_manifest_path, replay_day_manifest)

    if session is not None:
        window = as_dict(manifest.get("window"))
        dataset_from = parse_optional_timestamp(as_text(window.get("start")))
        dataset_to = parse_optional_timestamp(as_text(window.get("end")))
        upsert_dataset_snapshot(
            session,
            run_id=run_id,
            candidate_id=candidate_id,
            dataset_id=as_text(manifest.get("dataset_id")) or run_id,
            dataset_from=dataset_from,
            dataset_to=dataset_to,
            artifact_ref=str(archive_dir),
            payload_json={
                "market_day_inventory": market_day_inventory,
                "execution_day_inventory": execution_day_inventory,
                "replay_day_manifest": replay_day_manifest,
            },
        )

    return {
        "trading_day": trading_day,
        "candidate_id": candidate_id,
        "run_id": run_id,
        "archive_dir": str(archive_dir),
        "market_day_inventory_path": str(market_day_inventory_path),
        "execution_day_inventory_path": str(execution_day_inventory_path),
        "replay_day_manifest_path": str(replay_day_manifest_path),
        "archive_status": replay_day_manifest["archive_status"],
    }


def parse_optional_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    cleaned = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def load_archived_trading_day_bundles(
    archive_root: Path,
) -> list[ArchivedTradingDayBundle]:
    bundles: list[ArchivedTradingDayBundle] = []
    for replay_manifest_path in sorted(archive_root.rglob("replay_day_manifest.json")):
        archive_dir = replay_manifest_path.parent
        replay_day_manifest = load_json(replay_manifest_path)
        market_day_inventory = load_json(archive_dir / "market_day_inventory.json")
        execution_day_inventory = load_json(
            archive_dir / "execution_day_inventory.json"
        )
        trading_day = as_text(replay_day_manifest.get("trading_day"))
        candidate_id = as_text(replay_day_manifest.get("candidate_id"))
        run_id = as_text(replay_day_manifest.get("run_id"))
        original_run_dir = as_text(replay_day_manifest.get("original_run_dir"))
        archived_run_dir = as_text(replay_day_manifest.get("archived_run_dir")) or str(
            archive_dir
        )
        if (
            trading_day is None
            or candidate_id is None
            or run_id is None
            or original_run_dir is None
        ):
            raise RuntimeError(f"archived_bundle_invalid:{archive_dir}")
        bundles.append(
            ArchivedTradingDayBundle(
                trading_day=trading_day,
                candidate_id=candidate_id,
                run_id=run_id,
                archived_run_dir=Path(archived_run_dir),
                original_run_dir=Path(original_run_dir),
                market_day_inventory=market_day_inventory,
                execution_day_inventory=execution_day_inventory,
                replay_day_manifest=replay_day_manifest,
            )
        )
    return bundles


def summarize_data_sufficiency(
    bundles: Sequence[ArchivedTradingDayBundle],
    *,
    min_research_days: int = 20,
    min_historical_days: int = 60,
    min_execution_days: int = 20,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    replayable = sorted(
        {bundle.trading_day for bundle in bundles if bundle.replayable_market_day}
    )
    execution_days = sorted(
        {bundle.trading_day for bundle in bundles if bundle.execution_day_eligible}
    )
    symbols = sorted(
        {
            symbol
            for bundle in bundles
            for symbol in cast(
                list[str], bundle.market_day_inventory.get("symbols") or []
            )
            if str(symbol).strip()
        }
    )
    missing_days = missing_business_days(replayable)
    retention_risk_days_remaining = min_retention_days(bundles)
    blockers: list[str] = []
    status = SUFFICIENCY_STATUS_PAPER_READY
    if len(replayable) < min_research_days:
        status = SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY
        blockers.append("replay_ready_market_days_below_research_minimum")
    elif len(replayable) < min_historical_days:
        status = SUFFICIENCY_STATUS_RESEARCH_ONLY
        blockers.append("replay_ready_market_days_below_historical_minimum")
    elif len(execution_days) < min_execution_days:
        status = SUFFICIENCY_STATUS_HISTORICAL_READY
        blockers.append("execution_days_below_paper_minimum")
    else:
        status = SUFFICIENCY_STATUS_PAPER_READY
    if missing_days:
        blockers.append("missing_business_days_in_archive_window")
    if not bundles:
        blockers.append("archive_bundle_set_empty")
        status = SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY
    return {
        "schema_version": DATA_SUFFICIENCY_SCHEMA_VERSION,
        "generated_at": (generated_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "market_days_available": len({bundle.trading_day for bundle in bundles}),
        "execution_days_available": len(execution_days),
        "replay_ready_market_days": len(replayable),
        "proof_eligible_days": len(
            {
                bundle.trading_day
                for bundle in bundles
                if bundle.replayable_market_day and bundle.execution_day_eligible
            }
        ),
        "symbol_coverage": {
            "count": len(symbols),
            "symbols": symbols,
        },
        "missing_days": missing_days,
        "source_provenance": sorted(
            {
                str(bundle.market_day_inventory.get("reconstruction_source_provenance"))
                for bundle in bundles
                if str(
                    bundle.market_day_inventory.get("reconstruction_source_provenance")
                    or ""
                ).strip()
            }
        ),
        "retention_risk_days_remaining": retention_risk_days_remaining,
        "status": status,
        "blockers": blockers,
    }


def build_trial_ledger(
    bundles: Sequence[ArchivedTradingDayBundle],
    *,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    candidate_ids = sorted({bundle.candidate_id for bundle in bundles})
    entries: list[dict[str, Any]] = []
    selected_candidate_id: str | None = None
    best_sort_key: tuple[Decimal, Decimal, Decimal] | None = None
    for candidate_id in candidate_ids:
        candidate_bundles = [
            bundle for bundle in bundles if bundle.candidate_id == candidate_id
        ]
        replayable_bundles = [
            bundle for bundle in candidate_bundles if bundle.replayable_market_day
        ]
        execution_bundles = [
            bundle for bundle in candidate_bundles if bundle.execution_day_eligible
        ]
        proof_eligible_bundles = [
            bundle for bundle in replayable_bundles if bundle.execution_day_eligible
        ]
        daily_pnls = [bundle.net_pnl_estimated for bundle in proof_eligible_bundles]
        average_daily = decimal_mean(daily_pnls)
        median_daily = decimal_median(daily_pnls)
        profitable_ratio = safe_decimal_ratio(
            Decimal(sum(1 for value in daily_pnls if value > 0)),
            Decimal(len(daily_pnls)),
        )
        entry = {
            "candidate_id": candidate_id,
            "sleeve_id": candidate_id,
            "parameter_hash": stable_hash(candidate_id),
            "search_batch_id": "archive-bundle-v1",
            "dataset_snapshot_refs": sorted(
                {
                    str(bundle.replay_day_manifest.get("dataset_snapshot_ref"))
                    for bundle in candidate_bundles
                    if str(
                        bundle.replay_day_manifest.get("dataset_snapshot_ref") or ""
                    ).strip()
                }
            ),
            "trading_days": sorted(
                {bundle.trading_day for bundle in candidate_bundles}
            ),
            "selection_status": "rejected",
            "selection_reason": "not_selected",
            "metrics_summary": {
                "market_days_available": len(
                    {bundle.trading_day for bundle in replayable_bundles}
                ),
                "execution_days_available": len(
                    {bundle.trading_day for bundle in execution_bundles}
                ),
                "proof_eligible_days": len(
                    {bundle.trading_day for bundle in proof_eligible_bundles}
                ),
                "average_daily_net_pnl": format(average_daily, "f"),
                "median_daily_net_pnl": format(median_daily, "f"),
                "profitable_day_ratio": format(profitable_ratio, "f"),
                "total_net_pnl": format(sum(daily_pnls, Decimal("0")), "f"),
                "average_abs_slippage_bps": mean_optional_floats(
                    [
                        as_float(
                            bundle.execution_day_inventory.get("avg_abs_slippage_bps")
                        )
                        for bundle in execution_bundles
                    ]
                ),
            },
        }
        sort_key = (average_daily, median_daily, profitable_ratio)
        if best_sort_key is None or sort_key > best_sort_key:
            best_sort_key = sort_key
            selected_candidate_id = candidate_id
        entries.append(entry)
    for entry in entries:
        if entry["candidate_id"] == selected_candidate_id:
            entry["selection_status"] = "selected"
            entry["selection_reason"] = "highest_average_daily_net_pnl"
    return {
        "schema_version": TRIAL_LEDGER_SCHEMA_VERSION,
        "generated_at": (generated_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "trial_count": len(entries),
        "selected_candidate_id": selected_candidate_id,
        "entries": entries,
    }


def generate_archive_walkforward_folds(
    trading_days: Sequence[str],
    *,
    train_days: int,
    validation_days: int,
    test_days: int,
    step_days: int,
    embargo_days: int,
) -> list[ArchiveWalkForwardFold]:
    if (
        train_days <= 0
        or validation_days <= 0
        or test_days <= 0
        or step_days <= 0
        or embargo_days < 0
    ):
        raise ValueError("invalid_walkforward_window")
    ordered_days = sorted({str(day) for day in trading_days})
    folds: list[ArchiveWalkForwardFold] = []
    cursor = 0
    fold_index = 1
    while True:
        train_start = cursor
        train_end = train_start + train_days
        validation_start = train_end + embargo_days
        validation_end = validation_start + validation_days
        test_start = validation_end + embargo_days
        test_end = test_start + test_days
        if test_end > len(ordered_days):
            break
        embargo_window = (
            ordered_days[train_end:validation_start]
            + ordered_days[validation_end:test_start]
        )
        folds.append(
            ArchiveWalkForwardFold(
                name=f"fold_{fold_index}",
                train_days=ordered_days[train_start:train_end],
                validation_days=ordered_days[validation_start:validation_end],
                test_days=ordered_days[test_start:test_end],
                embargo_days=embargo_window,
            )
        )
        fold_index += 1
        cursor += step_days
    return folds


def proof_eligible_bundles(
    bundles: Sequence[ArchivedTradingDayBundle],
    *,
    candidate_id: str | None = None,
) -> list[ArchivedTradingDayBundle]:
    return [
        bundle
        for bundle in bundles
        if bundle.replayable_market_day
        and bundle.execution_day_eligible
        and (candidate_id is None or bundle.candidate_id == candidate_id)
    ]


def candidate_daily_net_pnl_by_day(
    bundles: Sequence[ArchivedTradingDayBundle],
) -> dict[str, dict[str, Decimal]]:
    series: dict[str, dict[str, Decimal]] = {}
    for bundle in proof_eligible_bundles(bundles):
        candidate_series = series.setdefault(bundle.candidate_id, {})
        candidate_series[bundle.trading_day] = bundle.net_pnl_estimated
    return series


def fold_selection_rows(
    *,
    candidate_daily_net_pnl_by_day: Mapping[str, Mapping[str, Decimal]],
    folds: Sequence[ArchiveWalkForwardFold],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    candidate_ids = sorted(candidate_daily_net_pnl_by_day)
    for fold in folds:
        is_days = [*fold.train_days, *fold.validation_days]
        oos_days = list(fold.test_days)
        candidate_metrics: list[dict[str, Any]] = []
        for candidate_id in candidate_ids:
            day_map = candidate_daily_net_pnl_by_day[candidate_id]
            is_values = [day_map[day] for day in is_days if day in day_map]
            oos_values = [day_map[day] for day in oos_days if day in day_map]
            if not is_values or not oos_values:
                continue
            candidate_metrics.append(
                {
                    "candidate_id": candidate_id,
                    "is_avg": decimal_mean(is_values),
                    "oos_avg": decimal_mean(oos_values),
                    "oos_sum": sum(oos_values, Decimal("0")),
                }
            )
        if len(candidate_metrics) < 2:
            continue
        candidate_metrics.sort(
            key=lambda item: (cast(Decimal, item["is_avg"]), str(item["candidate_id"])),
            reverse=True,
        )
        selected = candidate_metrics[0]
        oos_ranked = sorted(
            candidate_metrics,
            key=lambda item: (
                cast(Decimal, item["oos_avg"]),
                str(item["candidate_id"]),
            ),
            reverse=True,
        )
        oos_rank_by_candidate = {
            str(item["candidate_id"]): len(oos_ranked) - index
            for index, item in enumerate(oos_ranked)
        }
        selected_candidate_id = str(selected["candidate_id"])
        relative_rank = Decimal(oos_rank_by_candidate[selected_candidate_id]) / Decimal(
            len(oos_ranked) + 1
        )
        omega = min(max(float(relative_rank), 1e-6), 1 - 1e-6)
        rows.append(
            {
                "fold_name": fold.name,
                "selected_candidate_id": selected_candidate_id,
                "is_avg_daily_net_pnl": format(cast(Decimal, selected["is_avg"]), "f"),
                "oos_avg_daily_net_pnl": format(
                    cast(Decimal, selected["oos_avg"]), "f"
                ),
                "oos_total_net_pnl": format(cast(Decimal, selected["oos_sum"]), "f"),
                "oos_relative_rank": float(relative_rank),
                "oos_logit": math.log(omega / (1.0 - omega)),
                "candidate_count": len(oos_ranked),
            }
        )
    return rows


def estimate_pbo(fold_rows: Sequence[Mapping[str, Any]]) -> float | None:
    if not fold_rows:
        return None
    below_median = sum(
        1 for row in fold_rows if float(row.get("oos_logit") or 0.0) < 0.0
    )
    return below_median / len(fold_rows)


def fit_slope(x_values: Sequence[float], y_values: Sequence[float]) -> float | None:
    if len(x_values) != len(y_values) or len(x_values) < 2:
        return None
    mean_x = sum(x_values) / len(x_values)
    mean_y = sum(y_values) / len(y_values)
    numerator = sum(
        (x_value - mean_x) * (y_value - mean_y)
        for x_value, y_value in zip(x_values, y_values, strict=True)
    )
    denominator = sum((x_value - mean_x) ** 2 for x_value in x_values)
    if denominator <= 0:
        return None
    return numerator / denominator


def sample_stddev(values: Sequence[float]) -> float | None:
    if len(values) < 2:
        return None
    mean_value = sum(values) / len(values)
    variance = sum((value - mean_value) ** 2 for value in values) / (len(values) - 1)
    if variance <= 0:
        return None
    return math.sqrt(variance)


def daily_sharpe_ratio(values: Sequence[Decimal]) -> float | None:
    resolved = [float(value) for value in values]
    stddev = sample_stddev(resolved)
    if stddev is None or stddev <= 0:
        return None
    return (sum(resolved) / len(resolved)) / stddev


def skewness_and_kurtosis(values: Sequence[Decimal]) -> tuple[float, float]:
    resolved = [float(value) for value in values]
    if len(resolved) < 3:
        return (0.0, 3.0)
    mean_value = sum(resolved) / len(resolved)
    centered = [value - mean_value for value in resolved]
    second = sum(value**2 for value in centered) / len(centered)
    if second <= 0:
        return (0.0, 3.0)
    third = sum(value**3 for value in centered) / len(centered)
    fourth = sum(value**4 for value in centered) / len(centered)
    skewness = third / (second**1.5)
    kurtosis = fourth / (second**2)
    return (skewness, kurtosis)


def estimate_deflated_sharpe_ratio(
    *,
    selected_values: Sequence[Decimal],
    candidate_daily_net_pnl_by_day: Mapping[str, Mapping[str, Decimal]],
    oos_days: Sequence[str],
    trial_count: int,
) -> dict[str, float | int | None]:
    if len(selected_values) < DSR_MIN_SAMPLE_DAYS:
        return {
            "sample_size": len(selected_values),
            "selecteddaily_sharpe_ratio": None,
            "benchmark_sharpe_threshold": None,
            "deflated_sharpe_ratio": None,
            "deflated_sharpe_z_score": None,
        }

    selected_sharpe = daily_sharpe_ratio(selected_values)
    if selected_sharpe is None:
        return {
            "sample_size": len(selected_values),
            "selecteddaily_sharpe_ratio": None,
            "benchmark_sharpe_threshold": None,
            "deflated_sharpe_ratio": None,
            "deflated_sharpe_z_score": None,
        }

    trial_sharpes: list[float] = []
    for day_map in candidate_daily_net_pnl_by_day.values():
        candidate_values = [day_map[day] for day in oos_days if day in day_map]
        candidate_sharpe = daily_sharpe_ratio(candidate_values)
        if candidate_sharpe is not None:
            trial_sharpes.append(candidate_sharpe)
    trial_reference_count = max(trial_count, len(trial_sharpes))
    if trial_reference_count < 2:
        return {
            "sample_size": len(selected_values),
            "selecteddaily_sharpe_ratio": selected_sharpe,
            "benchmark_sharpe_threshold": None,
            "deflated_sharpe_ratio": None,
            "deflated_sharpe_z_score": None,
        }

    trial_sharpe_mean = (
        sum(trial_sharpes) / len(trial_sharpes) if trial_sharpes else 0.0
    )
    trial_sharpe_stddev = sample_stddev(trial_sharpes) or 0.0
    euler_gamma = 0.5772156649015329
    first_extreme = NORMAL_DIST.inv_cdf(1.0 - (1.0 / trial_reference_count))
    second_extreme = NORMAL_DIST.inv_cdf(1.0 - (1.0 / (trial_reference_count * math.e)))
    benchmark_sharpe_threshold = trial_sharpe_mean + trial_sharpe_stddev * (
        (1.0 - euler_gamma) * first_extreme + euler_gamma * second_extreme
    )

    skewness, kurtosis = skewness_and_kurtosis(selected_values)
    denominator = math.sqrt(
        max(
            1e-12,
            1.0
            - (skewness * selected_sharpe)
            + (((kurtosis - 1.0) / 4.0) * (selected_sharpe**2)),
        )
    )
    z_score = (
        (selected_sharpe - benchmark_sharpe_threshold)
        * math.sqrt(len(selected_values) - 1)
    ) / denominator
    return {
        "sample_size": len(selected_values),
        "selecteddaily_sharpe_ratio": selected_sharpe,
        "benchmark_sharpe_threshold": benchmark_sharpe_threshold,
        "deflated_sharpe_ratio": NORMAL_DIST.cdf(z_score),
        "deflated_sharpe_z_score": z_score,
    }


def moving_block_bootstrap_indices(
    *,
    length: int,
    block_size: int,
    rng: random.Random,
) -> list[int]:
    indices: list[int] = []
    while len(indices) < length:
        start = rng.randrange(length)
        for offset in range(block_size):
            indices.append((start + offset) % length)
            if len(indices) >= length:
                break
    return indices


def estimate_reality_check_p_value(
    *,
    candidate_daily_net_pnl_by_day: Mapping[str, Mapping[str, Decimal]],
    oos_days: Sequence[str],
    bootstrap_replicates: int,
) -> float | None:
    if len(oos_days) < REALITY_CHECK_MIN_SAMPLE_DAYS:
        return None
    aligned_series: list[list[float]] = []
    for day_map in candidate_daily_net_pnl_by_day.values():
        if all(day in day_map for day in oos_days):
            aligned_series.append([float(day_map[day]) for day in oos_days])
    if len(aligned_series) < 2:
        return None

    observed = max(sum(series) / len(series) for series in aligned_series)
    if observed <= 0:
        return 1.0

    centered_series = [
        [value - (sum(series) / len(series)) for value in series]
        for series in aligned_series
    ]
    block_size = max(2, int(round(math.sqrt(len(oos_days)))))
    rng = random.Random(0)
    exceedances = 0
    for _ in range(bootstrap_replicates):
        sample_indices = moving_block_bootstrap_indices(
            length=len(oos_days),
            block_size=block_size,
            rng=rng,
        )
        bootstrap_statistic = max(
            sum(series[index] for index in sample_indices) / len(sample_indices)
            for series in centered_series
        )
        if bootstrap_statistic >= observed:
            exceedances += 1
    return (exceedances + 1) / (bootstrap_replicates + 1)
