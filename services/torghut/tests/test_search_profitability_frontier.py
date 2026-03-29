from __future__ import annotations

from datetime import date, timedelta
from unittest import TestCase

import yaml

from scripts.search_profitability_frontier import (
    apply_candidate_to_configmap,
    iter_parameter_candidates,
    resolve_sweep_window,
)


class TestSearchProfitabilityFrontier(TestCase):
    def test_resolve_sweep_window_uses_latest_train_and_holdout_days(self) -> None:
        days = [date(2026, 3, 2) + timedelta(days=index) for index in range(20)]

        window = resolve_sweep_window(days, train_days=10, holdout_days=5)

        self.assertEqual(len(window.train_days), 10)
        self.assertEqual(len(window.holdout_days), 5)
        self.assertEqual(window.train_days[0], days[5])
        self.assertEqual(window.train_days[-1], days[14])
        self.assertEqual(window.holdout_days[0], days[15])
        self.assertEqual(window.holdout_days[-1], days[19])

    def test_iter_parameter_candidates_is_deterministic(self) -> None:
        candidates = iter_parameter_candidates(
            {
                'min_rank': ['0.4', '0.5'],
                'min_hold_ratio': ['0.6', '0.7'],
            }
        )

        self.assertEqual(
            candidates,
            [
                {'min_rank': '0.4', 'min_hold_ratio': '0.6'},
                {'min_rank': '0.4', 'min_hold_ratio': '0.7'},
                {'min_rank': '0.5', 'min_hold_ratio': '0.6'},
                {'min_rank': '0.5', 'min_hold_ratio': '0.7'},
            ],
        )

    def test_apply_candidate_to_configmap_updates_target_and_disables_others(self) -> None:
        configmap_payload = {
            'apiVersion': 'v1',
            'kind': 'ConfigMap',
            'data': {
                'strategies.yaml': yaml.safe_dump(
                    {
                        'strategies': [
                            {
                                'name': 'breakout-continuation-long-v1',
                                'enabled': False,
                                'params': {'min_cross_section_continuation_rank': '0.55'},
                            },
                            {
                                'name': 'late-day-continuation-long-v1',
                                'enabled': True,
                                'params': {'min_recent_microprice_bias_bps': '0.20'},
                            },
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = apply_candidate_to_configmap(
            configmap_payload=configmap_payload,
            strategy_name='breakout-continuation-long-v1',
            candidate_params={
                'min_cross_section_continuation_rank': '0.65',
                'min_recent_above_opening_window_close_ratio': '0.75',
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated['data']['strategies.yaml'])
        strategies = {item['name']: item for item in catalog['strategies']}
        self.assertTrue(strategies['breakout-continuation-long-v1']['enabled'])
        self.assertEqual(
            strategies['breakout-continuation-long-v1']['params']['min_cross_section_continuation_rank'],
            '0.65',
        )
        self.assertEqual(
            strategies['breakout-continuation-long-v1']['params']['min_recent_above_opening_window_close_ratio'],
            '0.75',
        )
        self.assertFalse(strategies['late-day-continuation-long-v1']['enabled'])
