from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from app.trading.simulation_progress import (
    COMPONENT_ARTIFACTS,
    COMPONENT_REPLAY,
    COMPONENT_TORGHUT,
    simulation_progress_snapshot,
)


def _row(**values: object) -> SimpleNamespace:
    defaults = {
        'component': COMPONENT_REPLAY,
        'dataset_id': 'dataset-a',
        'lane': 'equity',
        'workflow_name': None,
        'status': 'running',
        'updated_at': datetime.now(timezone.utc),
        'last_source_ts': None,
        'last_signal_ts': None,
        'last_price_ts': None,
        'cursor_at': None,
        'records_dumped': 0,
        'records_replayed': 0,
        'trade_decisions': 0,
        'executions': 0,
        'execution_tca_metrics': 0,
        'execution_order_events': 0,
        'strategy_type': None,
        'legacy_path_count': 0,
        'fallback_count': 0,
        'terminal_state': None,
        'last_error_code': None,
        'last_error_message': None,
        'payload_json': {},
    }
    defaults.update(values)
    return SimpleNamespace(**defaults)


class TestSimulationProgress(TestCase):
    def test_snapshot_prefers_top_level_activity_classification(self) -> None:
        session = MagicMock()
        session.execute.return_value.scalars.return_value.all.return_value = [
            _row(
                component=COMPONENT_REPLAY,
                records_dumped=100,
                records_replayed=100,
            ),
            _row(
                component=COMPONENT_TORGHUT,
                trade_decisions=5,
                executions=4,
                execution_tca_metrics=4,
                execution_order_events=4,
            ),
            _row(
                component=COMPONENT_ARTIFACTS,
                terminal_state='complete',
                payload_json={
                    'activity_classification': 'success',
                    'analysis_run': {'phase': 'Successful'},
                },
            ),
        ]

        with patch('app.trading.simulation_progress.simulation_progress_context', return_value=None):
            snapshot = simulation_progress_snapshot(session, run_id='sim-proof')

        self.assertTrue(snapshot['enabled'])
        self.assertEqual(snapshot['summary']['activity_classification'], 'success')
        self.assertTrue(snapshot['summary']['final_artifacts_ready'])
