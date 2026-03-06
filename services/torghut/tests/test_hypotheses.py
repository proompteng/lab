from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.hypotheses import (
    _JANGAR_QUORUM_CACHE,
    JangarDependencyQuorumStatus,
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)


def _state(
    *,
    feature_rows: int = 0,
    drift_checks: int = 0,
    evidence_checks: int = 0,
    signal_lag_seconds: int | None = None,
    autonomy_no_signal_streak: int = 0,
    signal_continuity_alert_active: bool = False,
    evidence_report: dict[str, object] | None = None,
) -> SimpleNamespace:
    metrics = SimpleNamespace(
        feature_batch_rows_total=feature_rows,
        drift_detection_checks_total=drift_checks,
        evidence_continuity_checks_total=evidence_checks,
        signal_lag_seconds=signal_lag_seconds,
    )
    return SimpleNamespace(
        metrics=metrics,
        autonomy_no_signal_streak=autonomy_no_signal_streak,
        signal_continuity_alert_active=signal_continuity_alert_active,
        last_evidence_continuity_report=evidence_report,
    )


class _FakeHttpResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self.status = status
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode('utf-8')

    def close(self) -> None:
        return None

    def __enter__(self) -> '_FakeHttpResponse':
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class TestHypothesisReadiness(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            'trading_hypothesis_registry_path': settings.trading_hypothesis_registry_path,
            'trading_jangar_control_plane_status_url': settings.trading_jangar_control_plane_status_url,
            'trading_jangar_control_plane_cache_ttl_seconds': settings.trading_jangar_control_plane_cache_ttl_seconds,
            'trading_jangar_control_plane_timeout_seconds': settings.trading_jangar_control_plane_timeout_seconds,
        }

    def tearDown(self) -> None:
        settings.trading_hypothesis_registry_path = self._settings_snapshot[
            'trading_hypothesis_registry_path'
        ]
        settings.trading_jangar_control_plane_status_url = self._settings_snapshot[
            'trading_jangar_control_plane_status_url'
        ]
        settings.trading_jangar_control_plane_cache_ttl_seconds = self._settings_snapshot[
            'trading_jangar_control_plane_cache_ttl_seconds'
        ]
        settings.trading_jangar_control_plane_timeout_seconds = self._settings_snapshot[
            'trading_jangar_control_plane_timeout_seconds'
        ]
        _JANGAR_QUORUM_CACHE.clear()

    def test_load_hypothesis_registry_reads_directory_payloads(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'h-cont-01.json').write_text(
                json.dumps(
                    {
                        'schema_version': 'torghut.hypothesis-manifest.v1',
                        'hypothesis_id': 'H-CONT-01',
                        'lane_id': 'continuation',
                        'strategy_family': 'intraday_continuation',
                        'initial_state': 'shadow',
                        'expected_gross_edge_bps': '6',
                        'max_allowed_slippage_bps': '12',
                        'min_sample_count_for_live_canary': 40,
                        'min_sample_count_for_scale_up': 80,
                        'max_rolling_drawdown_bps': '150',
                    }
                ),
                encoding='utf-8',
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertTrue(result.loaded)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].hypothesis_id, 'H-CONT-01')
        self.assertEqual(result.errors, [])

    def test_compile_hypothesis_runtime_statuses_stays_shadow_without_feature_and_evidence(self) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={'order_count': 0, 'avg_abs_slippage_bps': 0, 'avg_realized_shortfall_bps': 0},
            market_context_status={'last_freshness_seconds': None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision='allow',
                reasons=[],
                message='ok',
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item['hypothesis_id'] == 'H-CONT-01')
        micro = next(item for item in statuses if item['hypothesis_id'] == 'H-MICRO-01')
        self.assertEqual(cont['state'], 'shadow')
        self.assertIn('feature_rows_missing', cont['reasons'])
        self.assertIn('evidence_continuity_missing', cont['reasons'])
        self.assertIn('drift_checks_missing', cont['reasons'])
        self.assertEqual(micro['state'], 'blocked')
        self.assertIn('required_feature_set_unavailable', micro['reasons'])

    def test_compile_hypothesis_runtime_statuses_promotes_canary_when_thresholds_are_met(self) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                'ok': True,
                'checked_at': '2026-03-06T15:45:00+00:00',
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                'order_count': 45,
                'avg_abs_slippage_bps': 4,
                'avg_realized_shortfall_bps': -8,
            },
            market_context_status={'last_freshness_seconds': 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision='allow',
                reasons=[],
                message='ok',
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item['hypothesis_id'] == 'H-CONT-01')
        rev = next(item for item in statuses if item['hypothesis_id'] == 'H-REV-01')
        self.assertEqual(cont['state'], 'canary_live')
        self.assertEqual(cont['capital_stage'], '0.25x canary')
        self.assertEqual(cont['capital_multiplier'], '0.25')
        self.assertTrue(cont['promotion_eligible'])
        self.assertEqual(rev['state'], 'canary_live')

    def test_summarize_hypothesis_runtime_statuses_reports_state_totals(self) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={'order_count': 0, 'avg_abs_slippage_bps': 0, 'avg_realized_shortfall_bps': 0},
            market_context_status={'last_freshness_seconds': None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision='unknown',
                reasons=['jangar_control_plane_status_url_missing'],
                message='not configured',
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision='unknown',
                reasons=['jangar_control_plane_status_url_missing'],
                message='not configured',
            ),
        )

        self.assertEqual(summary['hypotheses_total'], 3)
        self.assertEqual(summary['state_totals'], {'blocked': 1, 'shadow': 2})
        self.assertEqual(summary['capital_stage_totals'], {'shadow': 3})
        self.assertEqual(summary['promotion_eligible_total'], 0)
        self.assertEqual(summary['rollback_required_total'], 3)
        self.assertEqual(
            summary['dependency_quorum'],
            {
                'decision': 'unknown',
                'reasons': ['jangar_control_plane_status_url_missing'],
                'message': 'not configured',
            },
        )

    def test_load_hypothesis_registry_fails_closed_on_duplicate_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            duplicate_payload = {
                'schema_version': 'torghut.hypothesis-manifest.v1',
                'hypothesis_id': 'H-CONT-01',
                'lane_id': 'continuation',
                'strategy_family': 'intraday_continuation',
                'initial_state': 'shadow',
                'expected_gross_edge_bps': '6',
                'max_allowed_slippage_bps': '12',
                'min_sample_count_for_live_canary': 40,
                'min_sample_count_for_scale_up': 80,
                'max_rolling_drawdown_bps': '150',
            }
            (root / 'one.json').write_text(json.dumps(duplicate_payload), encoding='utf-8')
            (root / 'two.json').write_text(json.dumps(duplicate_payload), encoding='utf-8')
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertFalse(result.loaded)
        self.assertEqual(result.items, [])
        self.assertEqual(len(result.errors), 1)
        self.assertIn('duplicate hypothesis_id H-CONT-01', result.errors[0])

    def test_load_jangar_dependency_quorum_prefers_dependency_quorum_contract(self) -> None:
        settings.trading_jangar_control_plane_status_url = 'https://jangar.example/status'
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with patch(
            'app.trading.hypotheses.urlopen',
            return_value=_FakeHttpResponse(
                {
                    'dependency_quorum': {
                        'decision': 'delay',
                        'reasons': ['workflow_backoff_warning'],
                        'message': 'degraded',
                    }
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, 'delay')
        self.assertEqual(status.reasons, ['workflow_backoff_warning'])
        self.assertEqual(status.message, 'degraded')

    def test_load_jangar_dependency_quorum_falls_back_to_legacy_status_when_needed(self) -> None:
        settings.trading_jangar_control_plane_status_url = 'https://jangar.example/status'
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        with patch(
            'app.trading.hypotheses.urlopen',
            return_value=_FakeHttpResponse(
                {
                    'workflows': {
                        'data_confidence': 'unknown',
                        'backoff_limit_exceeded_jobs': 0,
                    }
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, 'block')
        self.assertEqual(status.reasons, ['workflows_data_unknown'])

    def test_load_jangar_dependency_quorum_handles_malformed_url(self) -> None:
        settings.trading_jangar_control_plane_status_url = 'jangar.example/status'
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, 'unknown')
        self.assertEqual(status.reasons, ['jangar_status_fetch_failed'])
        self.assertIn('fetch failed', status.message)
