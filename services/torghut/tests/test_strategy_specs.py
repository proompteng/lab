from __future__ import annotations

import json
import tempfile
import uuid
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.models import Strategy
from app.trading.autonomy.lane import load_runtime_strategy_config
from app.trading.strategy_runtime import StrategyRuntime
from app.trading.strategy_specs import (
    build_compiled_strategy_artifacts,
    build_experiment_spec_from_strategy,
)


class TestStrategySpecs(TestCase):
    def test_compiled_strategy_artifacts_are_stable_for_legacy_macd_rsi(self) -> None:
        compiled = build_compiled_strategy_artifacts(
            strategy_id='legacy-spec',
            strategy_type='legacy_macd_rsi',
            semantic_version='1.0.0',
            params={'qty': 2, 'buy_rsi_threshold': 33},
            base_timeframe='1Min',
            universe_symbols=['AAPL'],
            source='spec_v2',
        )

        self.assertEqual(compiled.strategy_spec.strategy_id, 'legacy-spec')
        self.assertEqual(
            compiled.evaluator_config['feature_view_spec_ref'],
            'features/legacy-macd-rsi-v1',
        )
        self.assertEqual(
            compiled.shadow_runtime_config['strategy_type'],
            'legacy_macd_rsi',
        )
        self.assertEqual(
            compiled.live_runtime_config['mode'],
            'live',
        )
        self.assertEqual(
            compiled.promotion_metadata['promotion_policy_ref'],
            'torghut-promotion/vnext-default-v1',
        )

    def test_compiled_strategy_artifacts_build_experiment_spec(self) -> None:
        compiled = build_compiled_strategy_artifacts(
            strategy_id='tsmom-spec',
            strategy_type='intraday_tsmom_v1',
            semantic_version='1.1.0',
            params={'qty': 1},
            base_timeframe='1Min',
            universe_symbols=['NVDA'],
            source='spec_v2',
        )

        experiment = build_experiment_spec_from_strategy(
            experiment_id='exp-tsmom-spec',
            hypothesis='intraday continuation',
            strategy_spec=compiled.strategy_spec,
            llm_provenance={'mode': 'advisory_only'},
        )

        self.assertEqual(experiment.model_family, 'intraday_tsmom_v1')
        self.assertEqual(
            experiment.feature_view_spec_ref,
            'features/intraday-momentum-v1',
        )
        self.assertEqual(
            experiment.acceptance_criteria['promotion_policy_ref'],
            'torghut-promotion/vnext-default-v1',
        )

    def test_load_runtime_strategy_config_compiles_supported_strategy_types(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / 'strategies.json'
            config_path.write_text(
                json.dumps(
                    {
                        'strategies': [
                            {
                                'strategy_id': 'legacy-a',
                                'strategy_type': 'legacy_macd_rsi',
                                'version': '1.0.0',
                                'params': {'qty': 2},
                                'base_timeframe': '1Min',
                            },
                            {
                                'strategy_id': 'tsmom-a',
                                'strategy_type': 'intraday_tsmom_v1',
                                'version': '1.1.0',
                                'params': {'qty': 1},
                                'base_timeframe': '1Min',
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )

            configs = load_runtime_strategy_config(config_path)

        self.assertEqual([item.strategy_id for item in configs], ['legacy-a', 'tsmom-a'])
        self.assertTrue(all(item.compiler_source == 'spec_v2' for item in configs))
        self.assertTrue(all(item.strategy_spec for item in configs))
        self.assertTrue(all(item.compiled_targets for item in configs))

    def test_strategy_runtime_definition_uses_spec_v2_for_supported_types(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name='intraday-tsmom',
            description='intraday_tsmom_v1@1.1.0',
            enabled=True,
            base_timeframe='1Min',
            universe_type='intraday_tsmom_v1',
            universe_symbols=['NVDA'],
            max_position_pct_equity=Decimal('0.02'),
            max_notional_per_trade=Decimal('2500'),
        )

        definition = StrategyRuntime.definition_from_strategy(strategy)

        self.assertEqual(definition.compiler_source, 'spec_v2')
        self.assertEqual(definition.version, '1.1.0')
        self.assertEqual(definition.strategy_type, 'intraday_tsmom_v1')
        self.assertEqual(
            definition.strategy_spec['feature_view_spec_ref'],
            'features/intraday-momentum-v1',
        )
