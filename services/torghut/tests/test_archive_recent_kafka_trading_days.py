from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts.archive_recent_kafka_trading_days import (
    _parse_topic_retention_ms,
    archive_recent_kafka_trading_days,
)
from tests.profitability_archive_test_utils import write_historical_run


class TestArchiveRecentKafkaTradingDays(TestCase):
    def test_parse_topic_retention_ms(self) -> None:
        parsed = _parse_topic_retention_ms(['torghut.trades.v1=604800000'])
        self.assertEqual(parsed, {'torghut.trades.v1': 604800000})

    def test_archives_existing_run_dirs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_dir, _manifest_path = write_historical_run(
                root=root,
                run_name='sim-existing-run',
                trading_day='2026-03-27',
                candidate_id='momentum_pullback_long',
                net_pnl='275',
            )
            archive_root = root / 'archive'

            summary = archive_recent_kafka_trading_days(
                archive_root=archive_root,
                run_dirs=[run_dir],
                topic_retention_ms_by_topic={'torghut.trades.v1': 604800000},
            )

            self.assertEqual(summary['archived_count'], 1)
            replay_manifest_path = (
                archive_root
                / '2026-03-27'
                / 'momentum_pullback_long'
                / 'sim-existing-run'
                / 'replay_day_manifest.json'
            )
            replay_manifest = json.loads(replay_manifest_path.read_text(encoding='utf-8'))
            self.assertEqual(replay_manifest['candidate_id'], 'momentum_pullback_long')
