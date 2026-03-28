from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.profitability_archive import archive_historical_simulation_run
from scripts.run_archive_backed_profitability_proof import run_archive_backed_profitability_proof
from tests.profitability_archive_test_utils import (
    default_postgres_counts,
    iter_trading_days,
    write_historical_run,
)


def _archive_candidate_days(
    *,
    root: Path,
    archive_root: Path,
    candidate_id: str,
    trading_days: list[str],
    daily_net_pnl_fn,
) -> None:
    for index, trading_day in enumerate(trading_days):
        run_name = f'{candidate_id}-{trading_day}'
        run_dir, manifest_path = write_historical_run(
            root=root,
            run_name=run_name,
            trading_day=trading_day,
            candidate_id=candidate_id,
            net_pnl=format(Decimal(daily_net_pnl_fn(index)), 'f'),
            avg_abs_slippage_bps=4.0 + float(index % 3),
            p95_abs_slippage_bps=8.0 + float(index % 5),
        )
        archive_historical_simulation_run(
            run_dir=run_dir,
            archive_root=archive_root,
            manifest_path=manifest_path,
            topic_retention_ms_by_topic={'torghut.trades.v1': 14 * 86_400_000},
            postgres_counts=default_postgres_counts(),
        )


class TestRunArchiveBackedProfitabilityProof(TestCase):
    def test_short_archive_resolves_to_insufficient_history(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            archive_root = root / 'archive'
            trading_days = iter_trading_days(start_day=date(2026, 3, 2), count=10)
            _archive_candidate_days(
                root=root,
                archive_root=archive_root,
                candidate_id='momentum_pullback_long',
                trading_days=trading_days,
                daily_net_pnl_fn=lambda _: Decimal('180'),
            )

            summary = run_archive_backed_profitability_proof(
                archive_root=archive_root,
                output_dir=root / 'proof',
            )

            self.assertEqual(summary['certificate_status'], 'insufficient_history')
            certificate = json.loads(Path(summary['profitability_certificate_path']).read_text(encoding='utf-8'))
            self.assertEqual(certificate['status'], 'insufficient_history')
            self.assertIn('replay_ready_market_days_below_research_minimum', certificate['promotion_blockers'])

    def test_positive_but_sub_target_candidate_fails_historical_gate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            archive_root = root / 'archive'
            trading_days = iter_trading_days(start_day=date(2026, 1, 5), count=30)
            _archive_candidate_days(
                root=root,
                archive_root=archive_root,
                candidate_id='momentum_pullback_long',
                trading_days=trading_days,
                daily_net_pnl_fn=lambda index: Decimal('100') + Decimal(index % 5),
            )
            _archive_candidate_days(
                root=root,
                archive_root=archive_root,
                candidate_id='breakout_continuation_long',
                trading_days=trading_days,
                daily_net_pnl_fn=lambda index: Decimal('80') + Decimal(index % 5),
            )

            summary = run_archive_backed_profitability_proof(
                archive_root=archive_root,
                output_dir=root / 'proof',
                profit_target_daily_net_usd=Decimal('250'),
                median_target_daily_net_usd=Decimal('125'),
                profitable_day_ratio_target=Decimal('0.60'),
                min_research_days=10,
                min_historical_days=10,
                min_execution_days=10,
                train_days=3,
                validation_days=3,
                test_days=3,
                step_days=3,
                embargo_days=0,
                reality_check_bootstrap_replicates=100,
            )

            self.assertEqual(summary['certificate_status'], 'research_only')
            self.assertIsNotNone(summary['historical_bundle_summary'])

            statistical_validity = json.loads(
                Path(summary['statistical_validity_report_path']).read_text(encoding='utf-8')
            )
            self.assertIn('average_daily_net_pnl_below_target', statistical_validity['blockers'])
            self.assertIsNotNone(statistical_validity['selection_bias_metrics']['pbo'])
            self.assertIsNotNone(statistical_validity['selection_bias_metrics']['dsr'])
            self.assertIsNotNone(statistical_validity['selection_bias_metrics']['reality_check_p_value'])
