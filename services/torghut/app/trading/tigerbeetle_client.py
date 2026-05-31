"""TigerBeetle client boundary for Torghut ledger infrastructure."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from app.config import Settings
from app.trading.tigerbeetle_ledger_model import (
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)


class TigerBeetleClientProtocol(Protocol):
    def nop(self) -> None: ...

    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]: ...

    def lookup_accounts(self, ids: Sequence[int]) -> Sequence[object]: ...

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]: ...

    def lookup_transfers(self, ids: Sequence[int]) -> Sequence[object]: ...


@dataclass(frozen=True)
class TigerBeetleHealth:
    enabled: bool
    required: bool
    ok: bool
    cluster_id: int
    replica_addresses: list[str]
    last_error: str | None

    def as_dict(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "required": self.required,
            "ok": self.ok,
            "cluster_id": self.cluster_id,
            "replica_addresses": list(self.replica_addresses),
            "last_error": self.last_error,
        }


def parse_replica_addresses(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


class RealTigerBeetleClient:
    """Small wrapper around the official synchronous TigerBeetle client."""

    def __init__(self, *, cluster_id: int, replica_addresses: Sequence[str]) -> None:
        import tigerbeetle as tb

        self._tb: Any = tb
        self._client: Any = tb.ClientSync(
            cluster_id=cluster_id,
            replica_addresses=",".join(replica_addresses),
        )

    def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            close()
            return
        exit_fn = getattr(self._client, "__exit__", None)
        if callable(exit_fn):
            exit_fn(None, None, None)

    def nop(self) -> None:
        self._client.nop()

    def _account_event(self, account: object) -> object:
        if not isinstance(account, TigerBeetleAccountSpec):
            return account
        return self._tb.Account(
            id=account.account_id,
            debits_pending=0,
            debits_posted=0,
            credits_pending=0,
            credits_posted=0,
            user_data_128=0,
            user_data_64=0,
            user_data_32=0,
            ledger=account.ledger,
            code=account.code,
            flags=0,
            timestamp=0,
        )

    def _transfer_event(self, transfer: object) -> object:
        if not isinstance(transfer, TigerBeetleTransferSpec):
            return transfer
        return self._tb.Transfer(
            id=transfer.transfer_id,
            debit_account_id=transfer.debit_account_id,
            credit_account_id=transfer.credit_account_id,
            amount=transfer.amount,
            pending_id=transfer.pending_id,
            user_data_128=0,
            user_data_64=0,
            user_data_32=0,
            timeout=transfer.timeout,
            ledger=transfer.ledger,
            code=transfer.code,
            flags=transfer.flags,
            timestamp=0,
        )

    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]:
        return self._client.create_accounts(
            [self._account_event(item) for item in accounts]
        )

    def lookup_accounts(self, ids: Sequence[int]) -> Sequence[object]:
        return self._client.lookup_accounts(list(ids))

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]:
        return self._client.create_transfers(
            [self._transfer_event(item) for item in transfers]
        )

    def lookup_transfers(self, ids: Sequence[int]) -> Sequence[object]:
        return self._client.lookup_transfers(list(ids))


class FakeTigerBeetleClient:
    """In-memory TigerBeetle client for unit tests and smoke-script dry paths."""

    def __init__(self, *, fail_nop: Exception | None = None) -> None:
        self.fail_nop = fail_nop
        self.accounts: dict[int, object] = {}
        self.transfers: dict[int, object] = {}

    def nop(self) -> None:
        if self.fail_nop is not None:
            raise self.fail_nop

    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]:
        results: list[dict[str, object]] = []
        for index, account in enumerate(accounts):
            account_id = int(getattr(account, "id", getattr(account, "account_id", 0)))
            status = "exists" if account_id in self.accounts else "created"
            self.accounts.setdefault(account_id, account)
            results.append({"index": index, "status": status})
        return results

    def lookup_accounts(self, ids: Sequence[int]) -> Sequence[object]:
        return [self.accounts[item] for item in ids if item in self.accounts]

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]:
        results: list[dict[str, object]] = []
        for index, transfer in enumerate(transfers):
            transfer_id = int(
                getattr(transfer, "id", getattr(transfer, "transfer_id", 0))
            )
            status = "exists" if transfer_id in self.transfers else "created"
            self.transfers.setdefault(transfer_id, transfer)
            results.append({"index": index, "status": status})
        return results

    def lookup_transfers(self, ids: Sequence[int]) -> Sequence[object]:
        return [self.transfers[item] for item in ids if item in self.transfers]


def create_tigerbeetle_client(settings: Settings) -> RealTigerBeetleClient:
    return RealTigerBeetleClient(
        cluster_id=settings.tigerbeetle_cluster_id,
        replica_addresses=parse_replica_addresses(
            settings.tigerbeetle_replica_addresses
        ),
    )


def check_tigerbeetle_health(
    settings: Settings,
    *,
    client: TigerBeetleClientProtocol | None = None,
) -> TigerBeetleHealth:
    replica_addresses = parse_replica_addresses(settings.tigerbeetle_replica_addresses)
    if not settings.tigerbeetle_enabled:
        return TigerBeetleHealth(
            enabled=False,
            required=settings.tigerbeetle_required,
            ok=True,
            cluster_id=settings.tigerbeetle_cluster_id,
            replica_addresses=replica_addresses,
            last_error=None,
        )

    owned_client = client is None
    tb_client = client if client is not None else create_tigerbeetle_client(settings)
    try:
        tb_client.nop()
    except Exception as exc:
        return TigerBeetleHealth(
            enabled=True,
            required=settings.tigerbeetle_required,
            ok=False,
            cluster_id=settings.tigerbeetle_cluster_id,
            replica_addresses=replica_addresses,
            last_error=f"{type(exc).__name__}: {exc}",
        )
    finally:
        if owned_client:
            close = getattr(tb_client, "close", None)
            if callable(close):
                close()

    return TigerBeetleHealth(
        enabled=True,
        required=settings.tigerbeetle_required,
        ok=True,
        cluster_id=settings.tigerbeetle_cluster_id,
        replica_addresses=replica_addresses,
        last_error=None,
    )
