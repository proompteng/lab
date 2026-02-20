from __future__ import annotations

from unittest import TestCase

from app.trading.route_metadata import normalize_route_provenance, resolve_order_route_metadata


class _Client:
    name = 'lean'
    last_route = 'alpaca'


class TestRouteMetadata(TestCase):
    def test_normalize_route_provenance_defaults_to_unknown(self) -> None:
        expected, actual, reason, count = normalize_route_provenance(
            expected_adapter=None,
            actual_adapter=None,
            fallback_reason=None,
            fallback_count=None,
        )
        self.assertEqual(expected, 'unknown')
        self.assertEqual(actual, 'unknown')
        self.assertIsNone(reason)
        self.assertEqual(count, 0)

    def test_resolve_route_sets_fallback_reason_when_route_changes(self) -> None:
        expected, actual, reason, count = resolve_order_route_metadata(
            expected_adapter='lean',
            execution_client=_Client(),
            order_response={'_execution_route_actual': 'alpaca'},
        )
        self.assertEqual(expected, 'lean')
        self.assertEqual(actual, 'alpaca')
        self.assertEqual(reason, 'fallback_from_lean_to_alpaca')
        self.assertEqual(count, 1)
