from __future__ import annotations

from typing import cast
from unittest import TestCase
from unittest.mock import patch

from app.observability import posthog as posthog_observability


class TestPosthogObservability(TestCase):
    def test_capture_returns_disabled_when_posthog_is_off(self) -> None:
        with patch.object(posthog_observability.settings, 'posthog_enabled', False):
            emitted, reason = posthog_observability.capture_posthog_event(
                'torghut.decision.generated',
                properties={'strategy_id': 'demo'},
            )
        self.assertFalse(emitted)
        self.assertEqual(reason, 'disabled')

    def test_capture_redacts_prohibited_properties(self) -> None:
        captured_payload: dict[str, object] = {}

        def _capture_enqueue(url: str, payload: dict[str, object]) -> tuple[bool, str | None]:
            captured_payload['url'] = url
            captured_payload['payload'] = payload
            return True, None

        with patch.multiple(
            posthog_observability.settings,
            posthog_enabled=True,
            posthog_host='http://posthog-events.posthog.svc.cluster.local:8000',
            posthog_api_key='phc_demo',
            posthog_distinct_id='torghut-service',
            app_env='prod',
        ):
            with patch.object(
                posthog_observability._ASYNC_EMITTER,  # noqa: SLF001
                'enqueue',
                side_effect=_capture_enqueue,
            ):
                emitted, reason = posthog_observability.capture_posthog_event(
                    'torghut.execution.submitted',
                    severity='info',
                    properties={
                        'symbol': 'AAPL',
                        'token': 'should-not-leak',
                        'api_key': 'should-not-leak',
                        'raw_order': {'secret': 'drop'},
                        'nested': {'authorization': 'drop', 'safe': 'keep'},
                        'reason_codes': ['one', 'two'],
                    },
                )

        self.assertTrue(emitted)
        self.assertIsNone(reason)
        payload = captured_payload.get('payload')
        self.assertIsInstance(payload, dict)
        payload_map = cast(dict[str, object], payload)
        properties = payload_map.get('properties')
        self.assertIsInstance(properties, dict)
        properties_map = cast(dict[str, object], properties)
        self.assertEqual(properties_map.get('symbol'), 'AAPL')
        self.assertNotIn('token', properties_map)
        self.assertNotIn('api_key', properties_map)
        self.assertNotIn('raw_order', properties_map)
        nested = properties_map.get('nested')
        self.assertIsInstance(nested, dict)
        nested_map = cast(dict[str, object], nested)
        self.assertNotIn('authorization', nested_map)
        self.assertEqual(nested_map.get('safe'), 'keep')

    def test_capture_surfaces_queue_full_drop_reason(self) -> None:
        with patch.multiple(
            posthog_observability.settings,
            posthog_enabled=True,
            posthog_host='http://posthog-events.posthog.svc.cluster.local:8000',
            posthog_api_key='phc_demo',
            posthog_distinct_id='torghut-service',
        ):
            with patch.object(
                posthog_observability._ASYNC_EMITTER,  # noqa: SLF001
                'enqueue',
                return_value=(False, 'queue_full'),
            ):
                emitted, reason = posthog_observability.capture_posthog_event(
                    'torghut.runtime.loop_failed',
                    severity='error',
                    properties={'loop': 'trading'},
                )

        self.assertFalse(emitted)
        self.assertEqual(reason, 'queue_full')
