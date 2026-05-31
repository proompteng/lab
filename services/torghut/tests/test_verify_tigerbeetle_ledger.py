from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from unittest import TestCase
from unittest.mock import patch

from app.config import Settings
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from scripts.verify_tigerbeetle_ledger import main, run_smoke


class MissingAccountLookupClient(FakeTigerBeetleClient):
    def lookup_accounts(self, ids: list[int]) -> list[object]:
        return []


class MissingTransferLookupClient(FakeTigerBeetleClient):
    def lookup_transfers(self, ids: list[int]) -> list[object]:
        return []


class TestVerifyTigerBeetleLedger(TestCase):
    def test_run_smoke_proves_protocol_probe_idempotent_writes_and_lookup(
        self,
    ) -> None:
        client = FakeTigerBeetleClient()
        out = io.StringIO()

        with patch(
            "scripts.verify_tigerbeetle_ledger.create_tigerbeetle_client",
            return_value=client,
        ):
            with redirect_stdout(out):
                payload = run_smoke(Settings(TORGHUT_TIGERBEETLE_ENABLED=True))

        self.assertTrue(payload["ok"])
        self.assertEqual(len(client.accounts), 2)
        self.assertEqual(len(client.transfers), 1)
        output = out.getvalue()
        self.assertIn("protocol probe ok", output)
        self.assertIn("create_accounts idempotent ok", output)
        self.assertIn("create_transfers idempotent ok", output)
        self.assertIn("lookup_transfers ok", output)
        self.assertIn("reconciliation ok", output)

    def test_run_smoke_fails_when_account_lookup_is_missing(self) -> None:
        with patch(
            "scripts.verify_tigerbeetle_ledger.create_tigerbeetle_client",
            return_value=MissingAccountLookupClient(),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "create_accounts idempotent replay failed"
            ):
                run_smoke(Settings(TORGHUT_TIGERBEETLE_ENABLED=True))

    def test_run_smoke_fails_when_transfer_lookup_is_missing(self) -> None:
        with patch(
            "scripts.verify_tigerbeetle_ledger.create_tigerbeetle_client",
            return_value=MissingTransferLookupClient(),
        ):
            with self.assertRaisesRegex(RuntimeError, "lookup_transfers failed"):
                run_smoke(Settings(TORGHUT_TIGERBEETLE_ENABLED=True))

    def test_main_runs_smoke_mode_and_prints_json(self) -> None:
        out = io.StringIO()

        with patch.object(
            sys,
            "argv",
            ["verify_tigerbeetle_ledger.py", "--mode", "smoke"],
        ):
            with patch(
                "scripts.verify_tigerbeetle_ledger.create_tigerbeetle_client",
                return_value=FakeTigerBeetleClient(),
            ):
                with redirect_stdout(out):
                    result = main()

        self.assertEqual(result, 0)
        self.assertIn(
            '"schema_version": "torghut.tigerbeetle-smoke.v1"', out.getvalue()
        )
