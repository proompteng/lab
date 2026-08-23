from __future__ import annotations

import threading
import time
from unittest import TestCase
from unittest.mock import patch

from app.api.health_checks import tigerbeetle_health as health_checks_context
from app.config import settings
from app.trading.tigerbeetle_client import FakeTigerBeetleClient, TigerBeetleHealth


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

    def test_concurrent_callers_reuse_in_flight_result(self) -> None:
        client = _ClosableFakeTigerBeetleClient()
        probe = health_checks_context.TigerBeetleProtocolHealthProbe()
        probe_started = threading.Event()
        release_probe = threading.Event()
        concurrent_attempt_selected = threading.Event()
        results: list[TigerBeetleHealth] = []
        worker_errors: list[BaseException] = []
        attempt_selection_count = 0
        original_attempt_for = probe._attempt_for

        def observe_attempt(settings_obj):
            nonlocal attempt_selection_count
            selected = original_attempt_for(settings_obj)
            attempt_selection_count += 1
            if attempt_selection_count == 2:
                concurrent_attempt_selected.set()
            return selected

        def blocking_health(
            _settings: object,
            *,
            client: object | None = None,
        ) -> TigerBeetleHealth:
            del client
            probe_started.set()
            release_probe.wait(timeout=1.0)
            return TigerBeetleHealth(
                enabled=True,
                required=True,
                ok=True,
                cluster_id=settings.tigerbeetle_cluster_id,
                replica_addresses=["tb:3000"],
                last_error=None,
            )

        def run_probe() -> None:
            try:
                results.append(probe.check(settings, timeout_seconds=1.0))
            except (ImportError, OSError, RuntimeError, ValueError) as exc:
                worker_errors.append(exc)

        with (
            patch.object(
                health_checks_context,
                "create_tigerbeetle_client",
                return_value=client,
            ) as create_client,
            patch.object(
                health_checks_context,
                "check_tigerbeetle_health",
                side_effect=blocking_health,
            ),
            patch.object(probe, "_attempt_for", side_effect=observe_attempt),
        ):
            worker = threading.Thread(target=run_probe, daemon=True)
            worker.start()
            self.assertTrue(probe_started.wait(timeout=1.0))
            concurrent_worker = threading.Thread(target=run_probe, daemon=True)
            concurrent_worker.start()
            self.assertTrue(concurrent_attempt_selected.wait(timeout=1.0))
            release_probe.set()
            worker.join(timeout=1.0)
            concurrent_worker.join(timeout=1.0)
            probe.close()

        self.assertFalse(worker.is_alive())
        self.assertFalse(concurrent_worker.is_alive())
        self.assertEqual(worker_errors, [])
        self.assertEqual(len(results), 2)
        self.assertIs(results[0], results[1])
        create_client.assert_called_once_with(settings)
        self.assertEqual(client.close_calls, 1)

    def test_close_does_not_wait_for_blocked_probe(self) -> None:
        client = _ClosableFakeTigerBeetleClient()
        probe = health_checks_context.TigerBeetleProtocolHealthProbe()
        probe_started = threading.Event()
        release_probe = threading.Event()
        worker_errors: list[BaseException] = []

        def blocking_health(
            _settings: object,
            *,
            client: object | None = None,
        ) -> TigerBeetleHealth:
            del client
            probe_started.set()
            release_probe.wait(timeout=1.0)
            return TigerBeetleHealth(
                enabled=True,
                required=True,
                ok=True,
                cluster_id=settings.tigerbeetle_cluster_id,
                replica_addresses=["tb:3000"],
                last_error=None,
            )

        def run_probe() -> None:
            try:
                probe.check(settings, timeout_seconds=1.0)
            except (ImportError, OSError, RuntimeError, ValueError) as exc:
                worker_errors.append(exc)

        with (
            patch.object(
                health_checks_context,
                "create_tigerbeetle_client",
                return_value=client,
            ),
            patch.object(
                health_checks_context,
                "check_tigerbeetle_health",
                side_effect=blocking_health,
            ),
        ):
            worker = threading.Thread(target=run_probe, daemon=True)
            worker.start()
            self.assertTrue(probe_started.wait(timeout=1.0))

            started_at = time.monotonic()
            probe.close(wait_timeout_seconds=0.01)
            elapsed = time.monotonic() - started_at

            release_probe.set()
            worker.join(timeout=1.0)

        self.assertLess(elapsed, 0.1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(worker_errors), 1)
        self.assertIsInstance(
            worker_errors[0],
            health_checks_context.TigerBeetleProtocolHealthProbeResetError,
        )
        self.assertEqual(client.close_calls, 1)
