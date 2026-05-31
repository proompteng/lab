from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.config import Settings
from app.trading.tigerbeetle_client import (
    FakeTigerBeetleClient,
    RealTigerBeetleClient,
    check_tigerbeetle_health,
    create_tigerbeetle_client,
    parse_replica_addresses,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)


class _Event:
    def __init__(self, **kwargs: object) -> None:
        self.__dict__.update(kwargs)


class TestTigerBeetleClient(TestCase):
    def test_parse_replica_addresses_normalizes_csv(self) -> None:
        self.assertEqual(
            parse_replica_addresses(" 127.0.0.1:3000,127.0.0.2:3000 ,, "),
            ["127.0.0.1:3000", "127.0.0.2:3000"],
        )

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
        settings = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        client = FakeTigerBeetleClient()
        closed: list[bool] = []
        client.close = lambda: closed.append(True)  # type: ignore[attr-defined]

        with patch(
            "app.trading.tigerbeetle_client.create_tigerbeetle_client",
            return_value=client,
        ):
            health = check_tigerbeetle_health(settings)

        self.assertTrue(health.ok)
        self.assertEqual(closed, [True])

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
        )

    def test_real_client_converts_domain_specs_to_official_events(self) -> None:
        instances: list[object] = []

        class _FakeSync:
            def __init__(self, *, cluster_id: int, replica_addresses: str) -> None:
                self.cluster_id = cluster_id
                self.replica_addresses = replica_addresses
                self.created_accounts: list[object] = []
                self.created_transfers: list[object] = []
                self.closed = False
                instances.append(self)

            def close(self) -> None:
                self.closed = True

            def nop(self) -> None:
                return None

            def create_accounts(
                self, accounts: list[object]
            ) -> list[dict[str, object]]:
                self.created_accounts = accounts
                return [{"status": "created"}]

            def lookup_accounts(self, ids: list[int]) -> list[object]:
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
            Account=_Event,
            Transfer=_Event,
        )
        with patch.dict(sys.modules, {"tigerbeetle": fake_module}):
            client = RealTigerBeetleClient(
                cluster_id=2001,
                replica_addresses=["tb-0:3000", "tb-1:3000"],
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
        self.assertEqual(sync.replica_addresses, "tb-0:3000,tb-1:3000")
        self.assertEqual(sync.created_accounts[0].id, 11)
        self.assertEqual(sync.created_transfers[0].id, 22)
        self.assertTrue(sync.closed)

    def test_real_client_close_uses_exit_when_close_missing(self) -> None:
        class _ExitOnly:
            def __init__(self) -> None:
                self.exited = False

            def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
                self.exited = True

        client = object.__new__(RealTigerBeetleClient)
        owned = _ExitOnly()
        client._client = owned  # type: ignore[attr-defined]

        client.close()

        self.assertTrue(owned.exited)
