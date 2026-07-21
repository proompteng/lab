"""TigerBeetle client boundary for Torghut ledger infrastructure."""

from __future__ import annotations

import ipaddress
import queue
import socket
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar, cast

from app.config import Settings
from app.trading.tigerbeetle_ledger_model import (
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)

HEALTH_PROBE_ACCOUNT_ID = 1
_T = TypeVar("_T")


class TigerBeetleClientProtocol(Protocol):
    def nop(self) -> None: ...

    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]: ...

    def lookup_accounts(self, ids: Sequence[int]) -> Sequence[object]: ...

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]: ...

    def lookup_transfers(self, ids: Sequence[int]) -> Sequence[object]: ...


class TigerBeetleClientError(RuntimeError):
    """Normalized ordinary failure from the official TigerBeetle client."""


class TigerBeetleClientTimeoutError(TigerBeetleClientError, TimeoutError):
    """Raised when the synchronous TigerBeetle client exceeds its RPC deadline."""


def _run_with_timeout(
    *,
    operation_name: str,
    timeout_seconds: float,
    operation: Callable[[], _T],
    on_timeout: Callable[[], None] | None = None,
) -> _T:
    result_queue: queue.Queue[tuple[bool, _T | BaseException]] = queue.Queue(maxsize=1)

    def run_operation() -> None:
        try:
            result_queue.put((True, operation()), block=False)
        except BaseException as exc:
            result_queue.put((False, exc), block=False)

    thread = threading.Thread(
        target=run_operation,
        name=f"torghut-tigerbeetle-{operation_name}",
        daemon=True,
    )
    thread.start()
    try:
        ok, value = result_queue.get(timeout=max(float(timeout_seconds), 0.001))
    except queue.Empty as exc:
        timeout_error = TigerBeetleClientTimeoutError(
            f"tigerbeetle_{operation_name}_timeout:{timeout_seconds:.3f}s"
        )
        if on_timeout is not None:
            on_timeout()
        thread.join(timeout=1.0)
        if thread.is_alive():
            timeout_error.add_note(
                "timed-out TigerBeetle worker did not stop after cancellation"
            )
        raise timeout_error from exc
    if ok:
        return cast(_T, value)
    if isinstance(value, TigerBeetleClientError):
        raise value
    if isinstance(value, Exception):
        raise TigerBeetleClientError(
            f"tigerbeetle_{operation_name}_failed:{type(value).__name__}"
        ) from value
    if isinstance(value, BaseException):
        raise value
    raise RuntimeError(f"tigerbeetle_{operation_name}_failed")  # pragma: no cover


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


def _is_ip_literal(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _split_host_port(address: str) -> tuple[str, str | None]:
    if address.count(":") != 1:
        return address, None

    host, port = address.rsplit(":", 1)
    if not host or not port:
        return address, None
    return host, port


def _resolve_replica_address(address: str) -> list[str]:
    host, port = _split_host_port(address)
    if address.isdigit() or _is_ip_literal(host):
        return [address]

    try:
        infos = socket.getaddrinfo(
            host,
            port,
            family=socket.AF_INET,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError(
            f"could not resolve TigerBeetle replica address {address!r}"
        ) from exc

    resolved: list[str] = []
    for info in infos:
        sockaddr = cast(tuple[str, int], info[4])
        resolved_address = f"{sockaddr[0]}:{port}" if port is not None else sockaddr[0]
        if resolved_address not in resolved:
            resolved.append(resolved_address)

    if not resolved:
        raise ValueError(f"could not resolve TigerBeetle replica address {address!r}")
    return resolved


def resolve_replica_addresses(replica_addresses: Sequence[str]) -> list[str]:
    resolved: list[str] = []
    for address in replica_addresses:
        for resolved_address in _resolve_replica_address(address):
            if resolved_address not in resolved:
                resolved.append(resolved_address)
    return resolved


class RealTigerBeetleClient:
    """Small wrapper around the official synchronous TigerBeetle client."""

    def __init__(
        self,
        *,
        cluster_id: int,
        replica_addresses: Sequence[str],
        rpc_timeout_seconds: float = 10.0,
    ) -> None:
        import tigerbeetle as tb

        # The official client validates endpoint syntax before dialing and
        # accepts IP endpoints, not Kubernetes DNS service names.
        official_addresses = resolve_replica_addresses(replica_addresses)
        self._tb: Any = tb
        self._rpc_timeout_seconds = max(float(rpc_timeout_seconds), 0.001)
        self._close_lock = threading.Lock()
        self._closed = False
        self._client: Any = tb.ClientSync(
            cluster_id=cluster_id,
            replica_addresses=",".join(official_addresses),
        )

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            client = self._client
        client.close()

    def _run(self, operation_name: str, operation: Callable[[], _T]) -> _T:
        with self._close_lock:
            if self._closed:
                raise TigerBeetleClientError("tigerbeetle_client_closed")
        return _run_with_timeout(
            operation_name=operation_name,
            timeout_seconds=self._rpc_timeout_seconds,
            operation=operation,
            on_timeout=self.close,
        )

    def nop(self) -> None:
        # The Python client does not expose TigerBeetle's internal NOP request.
        # A one-id account lookup is read-only but still proves client/server
        # protocol connectivity through the official public API.
        self.lookup_accounts([HEALTH_PROBE_ACCOUNT_ID])

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
        return self._run(
            "create_accounts",
            lambda: self._client.create_accounts(
                [self._account_event(item) for item in accounts]
            ),
        )

    def lookup_accounts(self, ids: Sequence[int]) -> Sequence[object]:
        return self._run(
            "lookup_accounts",
            lambda: self._client.lookup_accounts(list(ids)),
        )

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]:
        return self._run(
            "create_transfers",
            lambda: self._client.create_transfers(
                [self._transfer_event(item) for item in transfers]
            ),
        )

    def lookup_transfers(self, ids: Sequence[int]) -> Sequence[object]:
        return self._run(
            "lookup_transfers",
            lambda: self._client.lookup_transfers(list(ids)),
        )


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
        rpc_timeout_seconds=settings.tigerbeetle_rpc_timeout_seconds,
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
