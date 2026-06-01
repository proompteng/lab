from __future__ import annotations

from unittest import TestCase

from app.trading.route_metadata import (
    normalize_route_provenance,
    resolve_order_route_metadata,
    route_repair_recommendation,
)


class _BasicClient:
    name = 'lean'
    last_route = 'alpaca'


class _FallbackClient:
    name = 'lean'
    last_route = 'alpaca'
    last_fallback_reason = 'lean_get_order_contract_violation'
    last_fallback_count = 1


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
            execution_client=_BasicClient(),
            order_response={'_execution_route_actual': 'alpaca'},
        )
        self.assertEqual(expected, 'lean')
        self.assertEqual(actual, 'alpaca')
        self.assertEqual(reason, 'fallback_from_lean_to_alpaca')
        self.assertEqual(count, 1)

    def test_resolve_route_uses_client_fallback_reason_when_payload_omits_metadata(self) -> None:
        expected, actual, reason, count = resolve_order_route_metadata(
            expected_adapter='lean',
            execution_client=_FallbackClient(),
            order_response={'id': 'order-1', 'status': 'accepted'},
        )
        self.assertEqual(expected, 'lean')
        self.assertEqual(actual, 'alpaca')
        self.assertEqual(reason, 'lean_get_order_contract_violation')
        self.assertEqual(count, 1)

    def test_route_repair_recommendations_map_actionable_blockers(self) -> None:
        self.assertEqual(
            route_repair_recommendation('stale_quote'),
            'refresh_quote_snapshot_and_recompute_route_fillability',
        )
        self.assertEqual(
            route_repair_recommendation('missing_bid_ask'),
            'collect_bid_ask_quote_before_routeability_claim',
        )
        self.assertEqual(
            route_repair_recommendation('session_closed'),
            'wait_for_regular_session_open_then_refresh_route_probe',
        )
        self.assertEqual(
            route_repair_recommendation('pair_imbalance'),
            'repair_pair_leg_balance_before_routeability_claim',
        )
        self.assertEqual(
            route_repair_recommendation('missing_target'),
            'collect_target_notional_and_side_plan_before_probe',
        )
        self.assertEqual(
            route_repair_recommendation('blocked_submit'),
            'keep_submit_disabled_and_collect_submit_gate_receipt',
        )
        self.assertEqual(
            route_repair_recommendation('missing_close_flatten_handoff'),
            'collect_close_flatten_handoff_receipt_before_reentry',
        )
        self.assertEqual(
            route_repair_recommendation('runtime_import_pending'),
            'complete_runtime_import_reconciliation_before_authority',
        )
