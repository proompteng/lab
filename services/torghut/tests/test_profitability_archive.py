from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.profitability_archive import (
    ARCHIVE_STATUS_ARCHIVED,
    archive_historical_simulation_run,
    build_trial_ledger,
    summarize_data_sufficiency,
)
from tests.profitability_archive_test_utils import (
    default_postgres_counts,
    iter_trading_days,
    make_archived_bundle,
    write_historical_run,
)


class TestProfitabilityArchive(TestCase):
    def test_archive_historical_simulation_run_copies_source_dump_and_writes_bundle_contracts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_dir, manifest_path = write_historical_run(
                root=root,
                run_name='sim-2026-03-27',
                trading_day='2026-03-27',
                candidate_id='momentum_pullback_long',
                net_pnl='275',
            )
            archive_root = root / 'archive'

            result = archive_historical_simulation_run(
                run_dir=run_dir,
                archive_root=archive_root,
                manifest_path=manifest_path,
                topic_retention_ms_by_topic={'torghut.trades.v1': 14 * 86_400_000},
                postgres_counts=default_postgres_counts(),
            )

            self.assertEqual(result['archive_status'], ARCHIVE_STATUS_ARCHIVED)
            archive_dir = Path(result['archive_dir'])
            self.assertTrue((archive_dir / 'source-dump.jsonl.zst').exists())

            replay_manifest = json.loads((archive_dir / 'replay_day_manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(replay_manifest['simulation_database'], 'torghut_sim_sim-2026-03-27')
            self.assertEqual(replay_manifest['archive_status'], ARCHIVE_STATUS_ARCHIVED)

            market_day_inventory = json.loads((archive_dir / 'market_day_inventory.json').read_text(encoding='utf-8'))
            self.assertTrue(market_day_inventory['replayable_market_day'])

            execution_day_inventory = json.loads(
                (archive_dir / 'execution_day_inventory.json').read_text(encoding='utf-8')
            )
            self.assertTrue(execution_day_inventory['execution_day_eligible'])

    def test_trial_ledger_selects_candidate_with_proof_eligible_days(self) -> None:
        bundles = [
            make_archived_bundle(
                trading_day='2026-03-24',
                candidate_id='candidate-a',
                net_pnl='150',
                execution_day_eligible=False,
            ),
            make_archived_bundle(
                trading_day='2026-03-24',
                candidate_id='candidate-b',
                net_pnl='90',
                execution_day_eligible=True,
            ),
        ]

        ledger = build_trial_ledger(bundles)

        self.assertEqual(ledger['selected_candidate_id'], 'candidate-b')

    def test_data_sufficiency_marks_short_archive_insufficient(self) -> None:
        trading_days = iter_trading_days(start_day=date(2026, 3, 2), count=10)
        bundles = [
            make_archived_bundle(
                trading_day=trading_day,
                candidate_id='candidate-a',
                net_pnl='125',
            )
            for trading_day in trading_days
        ]

        summary = summarize_data_sufficiency(bundles)

        self.assertEqual(summary['status'], 'insufficient_history')
        self.assertIn('replay_ready_market_days_below_research_minimum', summary['blockers'])
