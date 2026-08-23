from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from app.api.health_checks import tigerbeetle_health as health_checks_context
from app.config import settings
from app.trading.tigerbeetle_client import FakeTigerBeetleClient


class _ClosableFakeTigerBeetleClient(FakeTigerBeetleClient):
    def __init__(self, *, fail_nop: Exception | None = None) -> None:
        super().__init__(fail_nop=fail_nop)
        self.nop_calls = 0
        self.close_calls = 0

    def nop(self) -> None:
        self.nop_calls += 1
        super().nop()

    def close(self) -> None:
        self.close_calls += 1


class TestTigerBeetleProtocolHealthProbe(TestCase):
    def setUp(self) -> None:
        self._orig_enabled = settings.tigerbeetle_enabled
        self._orig_required = settings.tigerbeetle_required
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = True

    def tearDown(self) -> None:
        settings.tigerbeetle_enabled = self._orig_enabled
        settings.tigerbeetle_required = self._orig_required

    def test_reuses_one_client_until_shutdown(self) -> None:
        client = _ClosableFakeTigerBeetleClient()
        probe = health_checks_context.TigerBeetleProtocolHealthProbe()

        with patch.object(
            health_checks_context,
            "create_tigerbeetle_client",
            return_value=client,
        ) as create_client:
            first = probe.check(settings)
            second = probe.check(settings)
            probe.close()

        self.assertTrue(first.ok)
        self.assertTrue(second.ok)
        create_client.assert_called_once_with(settings)
        self.assertEqual(client.nop_calls, 2)
        self.assertEqual(client.close_calls, 1)

    def test_failed_probe_evicts_client_before_retry(self) -> None:
        failed_client = _ClosableFakeTigerBeetleClient(
            fail_nop=RuntimeError("unavailable")
        )
        healthy_client = _ClosableFakeTigerBeetleClient()
        probe = health_checks_context.TigerBeetleProtocolHealthProbe()

        with patch.object(
            health_checks_context,
            "create_tigerbeetle_client",
            side_effect=(failed_client, healthy_client),
        ) as create_client:
            failed = probe.check(settings)
            healthy = probe.check(settings)
            probe.close()

        self.assertFalse(failed.ok)
        self.assertTrue(healthy.ok)
        self.assertEqual(create_client.call_count, 2)
        self.assertEqual(failed_client.close_calls, 1)
        self.assertEqual(healthy_client.close_calls, 1)

    def test_reset_replaces_a_healthy_client(self) -> None:
        first_client = _ClosableFakeTigerBeetleClient()
        second_client = _ClosableFakeTigerBeetleClient()
        probe = health_checks_context.TigerBeetleProtocolHealthProbe()

        with patch.object(
            health_checks_context,
            "create_tigerbeetle_client",
            side_effect=(first_client, second_client),
        ) as create_client:
            first = probe.check(settings)
            probe.request_reset()
            second = probe.check(settings)
            probe.close()

        self.assertTrue(first.ok)
        self.assertTrue(second.ok)
        self.assertEqual(create_client.call_count, 2)
        self.assertEqual(first_client.close_calls, 1)
        self.assertEqual(second_client.close_calls, 1)
