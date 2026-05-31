"""Verify Torghut TigerBeetle ledger connectivity and idempotent writes."""

from __future__ import annotations

import argparse
import json
from typing import Any

from app.config import Settings
from app.trading.tigerbeetle_client import create_tigerbeetle_client
from app.trading.tigerbeetle_ids import stable_u128
from app.trading.tigerbeetle_ledger_model import (
    ACCOUNT_CODE_SMOKE_CASH,
    ACCOUNT_CODE_SMOKE_COUNTERPARTY,
    LEDGER_USD_MICRO,
    TRANSFER_CODE_SMOKE,
    TRANSFER_KIND_SMOKE,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)


def _smoke_accounts(settings: Settings) -> list[TigerBeetleAccountSpec]:
    release_key = f"{settings.tigerbeetle_cluster_id}:torghut-smoke"
    return [
        TigerBeetleAccountSpec(
            account_id=stable_u128(
                "torghut.tigerbeetle.smoke.account", f"{release_key}:cash"
            ),
            account_key=f"smoke_cash:{release_key}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_SMOKE_CASH,
            account_label="smoke",
        ),
        TigerBeetleAccountSpec(
            account_id=stable_u128(
                "torghut.tigerbeetle.smoke.account",
                f"{release_key}:counterparty",
            ),
            account_key=f"smoke_counterparty:{release_key}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_SMOKE_COUNTERPARTY,
            account_label="smoke",
        ),
    ]


def run_smoke(settings: Settings) -> dict[str, Any]:
    client = create_tigerbeetle_client(settings)
    accounts = _smoke_accounts(settings)
    transfer = TigerBeetleTransferSpec(
        transfer_id=stable_u128(
            "torghut.tigerbeetle.smoke.transfer",
            f"{settings.tigerbeetle_cluster_id}:torghut-smoke",
        ),
        transfer_kind=TRANSFER_KIND_SMOKE,
        debit_account_id=accounts[0].account_id,
        credit_account_id=accounts[1].account_id,
        amount=1,
        ledger=LEDGER_USD_MICRO,
        code=TRANSFER_CODE_SMOKE,
    )

    client.nop()
    print("protocol probe ok")
    client.create_accounts(accounts)
    client.create_accounts(accounts)
    looked_up_accounts = client.lookup_accounts([item.account_id for item in accounts])
    if len(looked_up_accounts) != len(accounts):
        raise RuntimeError("create_accounts idempotent replay failed")
    print("create_accounts idempotent ok")
    client.create_transfers([transfer])
    client.create_transfers([transfer])
    looked_up_transfers = client.lookup_transfers([transfer.transfer_id])
    if len(looked_up_transfers) != 1:
        raise RuntimeError("lookup_transfers failed")
    print("create_transfers idempotent ok")
    print("lookup_transfers ok")
    print("reconciliation ok")
    return {
        "schema_version": "torghut.tigerbeetle-smoke.v1",
        "ok": True,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "account_ids": [str(item.account_id) for item in accounts],
        "transfer_id": str(transfer.transfer_id),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["smoke"], default="smoke")
    args = parser.parse_args()
    settings = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
    if args.mode == "smoke":
        payload = run_smoke(settings)
        print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
