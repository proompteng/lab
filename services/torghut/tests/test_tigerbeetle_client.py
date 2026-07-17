from __future__ import annotations

import socket
import sys
import time
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.config import Settings
from app.trading.tigerbeetle_client import (
    FakeTigerBeetleClient,
    HEALTH_PROBE_ACCOUNT_ID,
    RealTigerBeetleClient,
    TigerBeetleClientError,
    TigerBeetleClientTimeoutError,
    _run_with_timeout,
    check_tigerbeetle_health,
    create_tigerbeetle_client,
    parse_replica_addresses,
    resolve_replica_addresses,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)

_TigerBeetleEvent = SimpleNamespace


class TestTigerBeetleClient(TestCase):
    def test_parse_replica_addresses_normalizes_csv(self) -> None:
        self.assertEqual(
            parse_replica_addresses(" 127.0.0.1:3000,127.0.0.2:3000 ,, "),
            ["127.0.0.1:3000", "127.0.0.2:3000"],
        )

    def test_resolve_replica_addresses_resolves_kubernetes_dns(self) -> None:
        def fake_getaddrinfo(
            host: str,
            port: str | None,
            *,
            family: socket.AddressFamily,
            type: socket.SocketKind,
        ) -> list[
            tuple[socket.AddressFamily, socket.SocketKind, int, str, tuple[str, int]]
        ]:
            self.assertEqual(family, socket.AF_INET)
            self.assertEqual(type, socket.SOCK_STREAM)
            self.assertEqual(host, "torghut-tigerbeetle.torghut.svc.cluster.local")
            self.assertEqual(port, "3000")
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.99.251.1", 3000)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.99.251.1", 3000)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.99.251.2", 3000)),
            ]

        with patch(
            "app.trading.tigerbeetle_client.socket.getaddrinfo",
            side_effect=fake_getaddrinfo,
        ):
            self.assertEqual(
                resolve_replica_addresses(
                    [
                        "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
                        "127.0.0.1:3000",
                    ]
                ),
                ["10.99.251.1:3000", "10.99.251.2:3000", "127.0.0.1:3000"],
            )

    def test_resolve_replica_addresses_leaves_ip_and_port_literals(self) -> None:
        with patch("app.trading.tigerbeetle_client.socket.getaddrinfo") as getaddrinfo:
            self.assertEqual(
                resolve_replica_addresses(["3000", "127.0.0.1:3000"]),
                ["3000", "127.0.0.1:3000"],
            )

        getaddrinfo.assert_not_called()

    def test_resolve_replica_addresses_reports_dns_failure(self) -> None:
        with patch(
            "app.trading.tigerbeetle_client.socket.getaddrinfo",
            side_effect=socket.gaierror("no such host"),
        ):
            with self.assertRaisesRegex(
                ValueError,
                "could not resolve TigerBeetle replica address 'missing-tb:3000'",
            ):
                resolve_replica_addresses(["missing-tb:3000"])

    def test_health_is_ok_when_disabled(self) -> None:
        settings = Settings(TORGHUT_TIGERBEETLE_ENABLED=False)

        health = check_tigerbeetle_health(settings)

        self.assertEqual(
            health.as_dict(),
            {
                "enabled": False,
                "required": False,
                "ok": True,
                "cluster_id": 2001,
                "replica_addresses": [
                    "torghut-tigerbeetle.torghut.svc.cluster.local:3000"
                ],
                "last_error": None,
            },
        )

    def test_health_calls_nop_when_enabled(self) -> None:
        settings = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)

        health = check_tigerbeetle_health(settings, client=FakeTigerBeetleClient())

        self.assertTrue(health.ok)
        self.assertIsNone(health.last_error)

    def test_health_records_protocol_failure(self) -> None:
        settings = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_REQUIRED=True,
        )

        health = check_tigerbeetle_health(
            settings,
            client=FakeTigerBeetleClient(fail_nop=RuntimeError("boom")),
        )

        self.assertFalse(health.ok)
        self.assertTrue(health.required)
        self.assertIn("RuntimeError: boom", health.last_error or "")

    def test_health_closes_owned_client(self) -> None:
        class _ClosableFakeTigerBeetleClient(FakeTigerBeetleClient):
            def __init__(self) -> None:
                super().__init__()
                self.closed = False

            def close(self) -> None:
                self.closed = True

        settings = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        client = _ClosableFakeTigerBeetleClient()

        with patch(
            "app.trading.tigerbeetle_client.create_tigerbeetle_client",
            return_value=client,
        ):
            health = check_tigerbeetle_health(settings)

        self.assertTrue(health.ok)
        self.assertTrue(client.closed)

    def test_create_tigerbeetle_client_uses_normalized_settings(self) -> None:
        settings = Settings(
            TORGHUT_TIGERBEETLE_CLUSTER_ID=77,
            TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES="tb-0:3000, tb-1:3000",
        )

        with patch("app.trading.tigerbeetle_client.RealTigerBeetleClient") as cls:
            create_tigerbeetle_client(settings)

        cls.assert_called_once_with(
            cluster_id=77,
            replica_addresses=["tb-0:3000", "tb-1:3000"],
            rpc_timeout_seconds=settings.tigerbeetle_rpc_timeout_seconds,
        )

    def test_timeout_helper_normalizes_operation_errors(self) -> None:
        with self.assertRaisesRegex(
            TigerBeetleClientError,
            "tigerbeetle_lookup_accounts_failed:RuntimeError",
        ) as raised:
            _run_with_timeout(
                operation_name="lookup_accounts",
                timeout_seconds=1.0,
                operation=lambda: (_ for _ in ()).throw(RuntimeError("rpc failed")),
            )
        self.assertIsInstance(raised.exception.__cause__, RuntimeError)

    def test_real_client_times_out_blocked_account_rpc(self) -> None:
        class _BlockingSync:
            def __init__(self, *, cluster_id: int, replica_addresses: str) -> None:
                del cluster_id, replica_addresses

            def create_accounts(self, accounts: list[object]) -> list[object]:
                del accounts
                time.sleep(0.2)
                return []

        fake_module = SimpleNamespace(
            ClientSync=_BlockingSync,
            Account=_TigerBeetleEvent,
            Transfer=_TigerBeetleEvent,
        )
        with (
            patch.dict(sys.modules, {"tigerbeetle": fake_module}),
            patch(
                "app.trading.tigerbeetle_client.socket.getaddrinfo",
                return_value=[
                    (
                        socket.AF_INET,
                        socket.SOCK_STREAM,
                        6,
                        "",
                        ("10.99.251.1", 3000),
                    )
                ],
            ),
        ):
            client = RealTigerBeetleClient(
                cluster_id=2001,
                replica_addresses=[
                    "torghut-tigerbeetle.torghut.svc.cluster.local:3000"
                ],
                rpc_timeout_seconds=0.01,
            )
            account = TigerBeetleAccountSpec(
                account_id=11,
                account_key="cash:paper:usd",
                ledger=LEDGER_USD_MICRO,
                code=1001,
                account_label="paper",
            )

            with self.assertRaisesRegex(
                TigerBeetleClientTimeoutError,
                "tigerbeetle_create_accounts_timeout",
            ):
                client.create_accounts([account])

    def test_real_client_times_out_blocked_health_lookup(self) -> None:
        class _BlockingHealthSync:
            def __init__(self, *, cluster_id: int, replica_addresses: str) -> None:
                del cluster_id, replica_addresses

            def lookup_accounts(self, ids: list[int]) -> list[object]:
                del ids
                time.sleep(0.2)
                return []

        fake_module = SimpleNamespace(
            ClientSync=_BlockingHealthSync,
            Account=_TigerBeetleEvent,
            Transfer=_TigerBeetleEvent,
        )
        with (
            patch.dict(sys.modules, {"tigerbeetle": fake_module}),
            patch(
                "app.trading.tigerbeetle_client.socket.getaddrinfo",
                return_value=[
                    (
                        socket.AF_INET,
                        socket.SOCK_STREAM,
                        6,
                        "",
                        ("10.99.251.1", 3000),
                    )
                ],
            ),
        ):
            client = RealTigerBeetleClient(
                cluster_id=2001,
                replica_addresses=[
                    "torghut-tigerbeetle.torghut.svc.cluster.local:3000"
                ],
                rpc_timeout_seconds=0.01,
            )

            with self.assertRaisesRegex(
                TigerBeetleClientTimeoutError,
                "tigerbeetle_lookup_accounts_timeout",
            ):
                client.nop()

    def test_real_client_times_out_blocked_connect(self) -> None:
        class _BlockingConnectSync:
            def __init__(self, *, cluster_id: int, replica_addresses: str) -> None:
                del cluster_id, replica_addresses
                time.sleep(0.2)

        fake_module = SimpleNamespace(
            ClientSync=_BlockingConnectSync,
            Account=_TigerBeetleEvent,
            Transfer=_TigerBeetleEvent,
        )
        with (
            patch.dict(sys.modules, {"tigerbeetle": fake_module}),
            patch(
                "app.trading.tigerbeetle_client.socket.getaddrinfo",
                return_value=[
                    (
                        socket.AF_INET,
                        socket.SOCK_STREAM,
                        6,
                        "",
                        ("10.99.251.1", 3000),
                    )
                ],
            ),
        ):
            with self.assertRaisesRegex(
                TigerBeetleClientTimeoutError,
                "tigerbeetle_connect_timeout",
            ):
                RealTigerBeetleClient(
                    cluster_id=2001,
                    replica_addresses=[
                        "torghut-tigerbeetle.torghut.svc.cluster.local:3000"
                    ],
                    rpc_timeout_seconds=0.01,
                )

    def test_real_client_converts_domain_specs_to_official_events(self) -> None:
        instances: list[object] = []

        class _FakeSync:
            def __init__(self, *, cluster_id: int, replica_addresses: str) -> None:
                self.cluster_id = cluster_id
                self.replica_addresses = replica_addresses
                self.created_accounts: list[object] = []
                self.created_transfers: list[object] = []
                self.lookup_account_requests: list[list[int]] = []
                self.closed = False
                instances.append(self)

            def close(self) -> None:
                self.closed = True

            def create_accounts(
                self, accounts: list[object]
            ) -> list[dict[str, object]]:
                self.created_accounts = accounts
                return [{"status": "created"}]

            def lookup_accounts(self, ids: list[int]) -> list[object]:
                self.lookup_account_requests.append(ids)
                return [{"id": item} for item in ids]

            def create_transfers(
                self, transfers: list[object]
            ) -> list[dict[str, object]]:
                self.created_transfers = transfers
                return [{"status": "created"}]

            def lookup_transfers(self, ids: list[int]) -> list[object]:
                return [{"id": item} for item in ids]

        fake_module = SimpleNamespace(
            ClientSync=_FakeSync,
            Account=_TigerBeetleEvent,
            Transfer=_TigerBeetleEvent,
        )
        with (
            patch.dict(sys.modules, {"tigerbeetle": fake_module}),
            patch(
                "app.trading.tigerbeetle_client.socket.getaddrinfo",
                return_value=[
                    (
                        socket.AF_INET,
                        socket.SOCK_STREAM,
                        6,
                        "",
                        ("10.99.251.1", 3000),
                    )
                ],
            ),
        ):
            client = RealTigerBeetleClient(
                cluster_id=2001,
                replica_addresses=[
                    "torghut-tigerbeetle.torghut.svc.cluster.local:3000"
                ],
            )
            account = TigerBeetleAccountSpec(
                account_id=11,
                account_key="cash:paper:usd",
                ledger=LEDGER_USD_MICRO,
                code=1001,
                account_label="paper",
            )
            transfer = TigerBeetleTransferSpec(
                transfer_id=22,
                transfer_kind="fill_post",
                debit_account_id=11,
                credit_account_id=12,
                amount=100,
                ledger=LEDGER_USD_MICRO,
                code=2002,
            )

            self.assertEqual(client.create_accounts([account]), [{"status": "created"}])
            self.assertEqual(client.lookup_accounts([11]), [{"id": 11}])
            self.assertEqual(
                client.create_transfers([transfer]), [{"status": "created"}]
            )
            self.assertEqual(client.lookup_transfers([22]), [{"id": 22}])
            client.nop()
            client.close()

        sync = instances[0]
        self.assertEqual(sync.cluster_id, 2001)
        self.assertEqual(sync.replica_addresses, "10.99.251.1:3000")
        self.assertEqual(sync.created_accounts[0].id, 11)
        self.assertEqual(sync.created_transfers[0].id, 22)
        self.assertEqual(sync.lookup_account_requests[-1], [HEALTH_PROBE_ACCOUNT_ID])
        self.assertTrue(sync.closed)

    def test_real_client_close_uses_exit_when_close_missing(self) -> None:
        class _ExitOnly:
            def __init__(self) -> None:
                self.exited = False

            def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
                self.exited = True

        client: RealTigerBeetleClient = object.__new__(RealTigerBeetleClient)
        owned = _ExitOnly()
        client._client = owned

        client.close()

        self.assertTrue(owned.exited)
