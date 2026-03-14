from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from sqlalchemy.orm import Session

from app.trading.simulation_progress import (
    COMPONENT_ARTIFACTS,
    COMPONENT_REPLAY,
    COMPONENT_TORGHUT,
    active_simulation_runtime_context,
    simulation_progress_snapshot,
)


def _row(**values: object) -> SimpleNamespace:
    defaults = {
        'run_id': 'sim-proof',
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
    def test_active_runtime_context_prefers_latest_nonterminal_row(self) -> None:
        active_row = _row(
            run_id='sim-proof-active',
            component=COMPONENT_TORGHUT,
            status='pending',
            updated_at=datetime(2026, 3, 13, 9, 0, tzinfo=timezone.utc),
            payload_json={
                'window_start': '2026-03-11T13:25:00+00:00',
                'window_end': '2026-03-11T13:35:00+00:00',
            },
        )

        with patch(
            'app.trading.simulation_progress._static_simulation_runtime_context',
            return_value=None,
        ), patch(
            'app.trading.simulation_progress.settings.trading_simulation_enabled',
            True,
        ), patch(
            'app.trading.simulation_progress._active_simulation_runtime_context_via_session',
            return_value={
                'run_id': str(active_row.run_id),
                'dataset_id': str(active_row.dataset_id),
                'lane': str(active_row.lane),
                'window_start': '2026-03-11T13:25:00+00:00',
                'window_end': '2026-03-11T13:35:00+00:00',
            },
        ):
            context = active_simulation_runtime_context(Session())

        assert context is not None
        self.assertEqual(context['run_id'], 'sim-proof-active')
        self.assertEqual(context['dataset_id'], 'dataset-a')
        self.assertEqual(context['window_start'], '2026-03-11T13:25:00+00:00')
        self.assertEqual(context['window_end'], '2026-03-11T13:35:00+00:00')

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
