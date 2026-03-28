#!/usr/bin/env python3
"""Build fail-closed profitability proof artifacts from archived replay bundles."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Sequence

from app.trading.profitability_archive import (
    build_profitability_certificate,
    build_statistical_validity_report,
    build_trial_ledger,
    generate_archive_walkforward_folds,
    load_archived_trading_day_bundles,
    summarize_data_sufficiency,
)
from scripts.build_historical_profitability_proof import build_historical_profitability_bundle


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-root', required=True, help='Root directory containing archived replay bundles.')
    parser.add_argument('--output-dir', required=True, help='Directory where proof artifacts should be written.')
    parser.add_argument('--selected-candidate-id', default='', help='Optional candidate override.')
    parser.add_argument('--profit-target-daily-net-usd', default='250')
    parser.add_argument('--median-target-daily-net-usd', default='125')
    parser.add_argument('--profitable-day-ratio-target', default='0.60')
    parser.add_argument('--min-research-days', type=int, default=20)
    parser.add_argument('--min-historical-days', type=int, default=60)
    parser.add_argument('--min-execution-days', type=int, default=20)
    parser.add_argument('--train-days', type=int, default=40)
    parser.add_argument('--validation-days', type=int, default=10)
    parser.add_argument('--test-days', type=int, default=10)
    parser.add_argument('--step-days', type=int, default=10)
    parser.add_argument('--embargo-days', type=int, default=1)
    parser.add_argument('--reality-check-bootstrap-replicates', type=int, default=500)
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str),
        encoding='utf-8',
    )


def _candidate_run_dirs_for_test_days(
    *,
    bundles: Sequence[Any],
    candidate_id: str,
    trading_days: set[str],
) -> list[Path]:
    run_dirs = {
        Path(bundle.archived_run_dir)
        for bundle in bundles
        if bundle.candidate_id == candidate_id and bundle.trading_day in trading_days
    }
    return sorted(run_dirs)


def run_archive_backed_profitability_proof(
    *,
    archive_root: Path,
    output_dir: Path,
    selected_candidate_id: str | None = None,
    profit_target_daily_net_usd: Decimal = Decimal('250'),
    median_target_daily_net_usd: Decimal = Decimal('125'),
    profitable_day_ratio_target: Decimal = Decimal('0.60'),
    min_research_days: int = 20,
    min_historical_days: int = 60,
    min_execution_days: int = 20,
    train_days: int = 40,
    validation_days: int = 10,
    test_days: int = 10,
    step_days: int = 10,
    embargo_days: int = 1,
    reality_check_bootstrap_replicates: int = 500,
) -> dict[str, Any]:
    archive_root = archive_root.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc)

    bundles = load_archived_trading_day_bundles(archive_root)
    data_sufficiency = summarize_data_sufficiency(
        bundles,
        min_research_days=min_research_days,
        min_historical_days=min_historical_days,
        min_execution_days=min_execution_days,
        generated_at=generated_at,
    )
    trial_ledger = build_trial_ledger(
        bundles,
        generated_at=generated_at,
    )

    selected_candidate = selected_candidate_id or str(trial_ledger.get('selected_candidate_id') or '').strip() or None
    proof_eligible_days = sorted(
        {
            bundle.trading_day
            for bundle in bundles
            if bundle.replayable_market_day and bundle.execution_day_eligible
        }
    )
    folds = generate_archive_walkforward_folds(
        proof_eligible_days,
        train_days=train_days,
        validation_days=validation_days,
        test_days=test_days,
        step_days=step_days,
        embargo_days=embargo_days,
    )

    artifact_refs: list[str] = []
    historical_bundle_summary: dict[str, Any] | None = None
    if selected_candidate is not None and folds:
        test_day_set = {day for fold in folds for day in fold.test_days}
        selected_run_dirs = _candidate_run_dirs_for_test_days(
            bundles=bundles,
            candidate_id=selected_candidate,
            trading_days=test_day_set,
        )
        if selected_run_dirs:
            baseline_candidate_id = next(
                (
                    str(bundle.replay_day_manifest.get('baseline_candidate_id') or '').strip()
                    for bundle in bundles
                    if bundle.candidate_id == selected_candidate
                    and str(bundle.replay_day_manifest.get('baseline_candidate_id') or '').strip()
                ),
                '',
            )
            baseline_run_dirs = (
                _candidate_run_dirs_for_test_days(
                    bundles=bundles,
                    candidate_id=baseline_candidate_id,
                    trading_days=test_day_set,
                )
                if baseline_candidate_id and baseline_candidate_id != selected_candidate
                else []
            )
            historical_bundle_summary = build_historical_profitability_bundle(
                run_dirs=selected_run_dirs,
                baseline_run_dirs=baseline_run_dirs or None,
                output_dir=output_dir / 'historical-proof',
                hypothesis=(
                    f'{selected_candidate} satisfies the archive-backed profitability gate '
                    f'at ${format(profit_target_daily_net_usd, "f")} average daily net P&L'
                ),
                generated_at=generated_at,
            )
            artifact_refs.extend(
                [
                    str(path)
                    for key, path in historical_bundle_summary.items()
                    if key.endswith('_path') and str(path).strip()
                ]
            )

    data_sufficiency_path = output_dir / 'data-sufficiency.json'
    trial_ledger_path = output_dir / 'trial-ledger.json'
    _write_json(data_sufficiency_path, data_sufficiency)
    _write_json(trial_ledger_path, trial_ledger)
    artifact_refs.extend([str(data_sufficiency_path), str(trial_ledger_path)])

    statistical_validity_report = build_statistical_validity_report(
        selected_candidate_id=selected_candidate,
        bundles=bundles,
        trial_ledger=trial_ledger,
        data_sufficiency=data_sufficiency,
        folds=folds,
        profit_target_daily_net_usd=profit_target_daily_net_usd,
        median_target_daily_net_usd=median_target_daily_net_usd,
        profitable_day_ratio_target=profitable_day_ratio_target,
        reality_check_bootstrap_replicates=reality_check_bootstrap_replicates,
        generated_at=generated_at,
    )
    statistical_validity_report_path = output_dir / 'statistical-validity-report.json'
    _write_json(statistical_validity_report_path, statistical_validity_report)
    artifact_refs.append(str(statistical_validity_report_path))

    profitability_certificate = build_profitability_certificate(
        selected_candidate_id=selected_candidate,
        data_sufficiency=data_sufficiency,
        trial_ledger=trial_ledger,
        statistical_validity_report=statistical_validity_report,
        artifact_refs=artifact_refs,
        profit_target_daily_net_usd=profit_target_daily_net_usd,
        generated_at=generated_at,
    )
    profitability_certificate_path = output_dir / 'profitability-certificate.json'
    _write_json(profitability_certificate_path, profitability_certificate)
    artifact_refs.append(str(profitability_certificate_path))

    return {
        'archive_root': str(archive_root),
        'output_dir': str(output_dir),
        'selected_candidate_id': selected_candidate,
        'data_sufficiency_path': str(data_sufficiency_path),
        'trial_ledger_path': str(trial_ledger_path),
        'statistical_validity_report_path': str(statistical_validity_report_path),
        'profitability_certificate_path': str(profitability_certificate_path),
        'certificate_status': profitability_certificate['status'],
        'historical_bundle_summary': historical_bundle_summary,
    }


def main() -> int:
    args = _parse_args()
    summary = run_archive_backed_profitability_proof(
        archive_root=Path(args.archive_root),
        output_dir=Path(args.output_dir),
        selected_candidate_id=args.selected_candidate_id.strip() or None,
        profit_target_daily_net_usd=Decimal(args.profit_target_daily_net_usd),
        median_target_daily_net_usd=Decimal(args.median_target_daily_net_usd),
        profitable_day_ratio_target=Decimal(args.profitable_day_ratio_target),
        min_research_days=args.min_research_days,
        min_historical_days=args.min_historical_days,
        min_execution_days=args.min_execution_days,
        train_days=args.train_days,
        validation_days=args.validation_days,
        test_days=args.test_days,
        step_days=args.step_days,
        embargo_days=args.embargo_days,
        reality_check_bootstrap_replicates=args.reality_check_bootstrap_replicates,
    )
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(json.dumps(summary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
