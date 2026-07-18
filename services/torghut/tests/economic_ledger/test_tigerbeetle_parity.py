from __future__ import annotations

import json
import uuid
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast

import pytest

from app.trading.economic_ledger import (
    BrokerEconomicLedgerReplay,
    BrokerEconomicLedgerSnapshot,
    EconomicActivity,
    EconomicLedgerError,
    LedgerScope,
    PublishedBrokerEconomicLedgerRuns,
    TigerBeetleEconomicParityObservation,
    audit_broker_economic_tigerbeetle_parity,
    prepare_activities,
    reduce_and_compare,
)
from app.trading.economic_ledger.tigerbeetle_parity import (
    validate_tigerbeetle_economic_parity_payload,
)
from app.trading.economic_ledger.tigerbeetle_projection import (
    TIGERBEETLE_ECONOMIC_PROJECTION_VERSION,
    project_broker_economic_transaction,
)
from app.trading.tigerbeetle_ledger_model import (
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)


_AT = datetime(2026, 7, 16, 14, 0, tzinfo=timezone.utc)
_SCOPE = LedgerScope(
    provider="alpaca",
    environment="paper",
    account_label="parity-test",
    endpoint_fingerprint="c" * 64,
)


class ExactTigerBeetleClient:
    """Small protocol-faithful ledger used to test exact cumulative parity."""

    def __init__(self) -> None:
        self.accounts: dict[int, dict[str, int]] = {}
        self.transfers: dict[int, dict[str, int]] = {}
        self.account_create_calls = 0
        self.transfer_create_calls = 0

    def nop(self) -> None:
        return None

    def create_accounts(self, accounts: list[object]) -> list[object]:
        self.account_create_calls += 1
        results: list[object] = []
        for index, value in enumerate(accounts):
            spec = cast(TigerBeetleAccountSpec, value)
            if spec.account_id in self.accounts:
                results.append({"index": index, "status": "exists"})
                continue
            self.accounts[spec.account_id] = {
                "id": spec.account_id,
                "debits_pending": 0,
                "debits_posted": 0,
                "credits_pending": 0,
                "credits_posted": 0,
                "user_data_128": 0,
                "user_data_64": 0,
                "user_data_32": 0,
                "ledger": spec.ledger,
                "code": spec.code,
                "flags": 0,
            }
        return results

    def lookup_accounts(self, ids: list[int]) -> list[object]:
        return [dict(self.accounts[item]) for item in ids if item in self.accounts]

    def create_transfers(self, transfers: list[object]) -> list[object]:
        self.transfer_create_calls += 1
        results: list[object] = []
        for index, value in enumerate(transfers):
            spec = cast(TigerBeetleTransferSpec, value)
            if spec.transfer_id in self.transfers:
                results.append({"index": index, "status": "exists"})
                continue
            debit = self.accounts[spec.debit_account_id]
            credit = self.accounts[spec.credit_account_id]
            assert debit["ledger"] == credit["ledger"] == spec.ledger
            self.transfers[spec.transfer_id] = {
                "id": spec.transfer_id,
                "debit_account_id": spec.debit_account_id,
                "credit_account_id": spec.credit_account_id,
                "amount": spec.amount,
                "pending_id": spec.pending_id,
                "user_data_128": 0,
                "user_data_64": 0,
                "user_data_32": 0,
                "timeout": spec.timeout,
                "ledger": spec.ledger,
                "code": spec.code,
                "flags": spec.flags,
            }
            debit["debits_posted"] += spec.amount
            credit["credits_posted"] += spec.amount
        return results

    def lookup_transfers(self, ids: list[int]) -> list[object]:
        return [dict(self.transfers[item]) for item in ids if item in self.transfers]

    def remove_transfer(self, transfer_id: int) -> None:
        transfer = self.transfers.pop(transfer_id)
        self.accounts[transfer["debit_account_id"]]["debits_posted"] -= transfer[
            "amount"
        ]
        self.accounts[transfer["credit_account_id"]]["credits_posted"] -= transfer[
            "amount"
        ]


def _activity(
    external_id: str,
    activity_type: str,
    *,
    offset: int,
    symbol: str | None = None,
    side: str | None = None,
    quantity: str | None = None,
    price: str | None = None,
    net_amount: str | None = None,
    correction_of: str | None = None,
) -> EconomicActivity:
    return EconomicActivity(
        scope=_SCOPE,
        external_activity_id=external_id,
        raw_payload_sha256=f"{offset + 1:064x}",
        activity_type=activity_type,
        first_observed_at=_AT + timedelta(seconds=offset),
        event_at=_AT + timedelta(seconds=offset),
        symbol=symbol,
        side=side,
        quantity=Decimal(quantity) if quantity is not None else None,
        price=Decimal(price) if price is not None else None,
        net_amount=Decimal(net_amount) if net_amount is not None else None,
        currency="USD",
        correction_of_external_id=correction_of,
    )


def _replay(*activities: EconomicActivity) -> BrokerEconomicLedgerReplay:
    prepared = prepare_activities(activities)
    manifest = [
        activity.manifest_payload()
        for activity in sorted(activities, key=lambda item: item.sort_key)
    ]
    snapshot = BrokerEconomicLedgerSnapshot(
        cursor_id=uuid.uuid4(),
        source_watermark=_AT + timedelta(minutes=1),
        prepared=prepared,
        activities=activities,
        input_manifest_canonical_json=json.dumps(
            manifest,
            sort_keys=True,
            separators=(",", ":"),
        ),
        option_contract_sizes=(),
    )
    return BrokerEconomicLedgerReplay(
        snapshot=snapshot,
        reduction=reduce_and_compare(prepared),
        publication_token=f"publish:{'d' * 64}",
    )


def _flat_replay() -> BrokerEconomicLedgerReplay:
    return _replay(
        _activity("cash", "CSD", offset=0, net_amount="1000"),
        _activity(
            "buy",
            "FILL",
            offset=1,
            symbol="AAPL",
            side="buy",
            quantity="1",
            price="100",
        ),
        _activity(
            "sell",
            "FILL",
            offset=2,
            symbol="AAPL",
            side="sell",
            quantity="1",
            price="110",
        ),
        _activity("fee", "FEE", offset=3, net_amount="-1"),
    )


def _runs(replay: BrokerEconomicLedgerReplay) -> PublishedBrokerEconomicLedgerRuns:
    return PublishedBrokerEconomicLedgerRuns(
        input_id=uuid.uuid4(),
        journal_run_id=uuid.uuid4(),
        state_run_id=uuid.uuid4(),
        source_watermark=replay.snapshot.source_watermark,
        reused_existing=True,
    )


def _audit(
    client: ExactTigerBeetleClient,
    replay: BrokerEconomicLedgerReplay,
    *,
    runs: PublishedBrokerEconomicLedgerRuns,
    observed_at: datetime | None = None,
    max_age: int = 300,
):
    return audit_broker_economic_tigerbeetle_parity(
        client,
        replay,
        runs=runs,
        observation=TigerBeetleEconomicParityObservation(
            cluster_id=2001,
            observed_at=observed_at or _AT + timedelta(minutes=2),
            max_source_age_seconds=max_age,
        ),
    )


def test_full_projection_is_exact_idempotent_and_bound_to_immutable_runs() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    client = ExactTigerBeetleClient()

    first = _audit(client, replay, runs=runs)
    second = _audit(client, replay, runs=runs)

    assert TIGERBEETLE_ECONOMIC_PROJECTION_VERSION == (
        "torghut.broker-economic-tigerbeetle-projection.v2"
    )
    assert first.payload["projection_version"] == (
        TIGERBEETLE_ECONOMIC_PROJECTION_VERSION
    )
    assert first.parity is True
    assert first.payload["blockers"] == []
    assert first.payload["expected"] == first.payload["actual"] | {
        "transaction_count": len(replay.reduction.journal.transactions)
    }
    assert (
        cast(dict[str, int], first.payload["operations"])[
            "transfer_create_selected_count"
        ]
        > 0
    )
    assert second.parity is True
    assert (
        cast(dict[str, int], second.payload["operations"])[
            "account_create_selected_count"
        ]
        == 0
    )
    assert (
        cast(dict[str, int], second.payload["operations"])[
            "transfer_create_selected_count"
        ]
        == 0
    )
    assert first.payload["expected"] == second.payload["expected"]
    assert first.payload["actual"] == second.payload["actual"]


def test_inadmissible_projection_never_materializes_tigerbeetle_entries() -> None:
    replay = _flat_replay()
    inadmissible_independent = replace(
        replay.reduction.independent,
        unsupported_activity_ids=("unsupported-activity",),
    )
    inadmissible_replay = replace(
        replay,
        reduction=replace(
            replay.reduction,
            independent=inadmissible_independent,
        ),
    )
    client = ExactTigerBeetleClient()

    result = _audit(client, inadmissible_replay, runs=_runs(inadmissible_replay))

    assert result.parity is False
    assert "tigerbeetle_economic_projection_inadmissible" in result.payload["blockers"]
    assert client.account_create_calls == 0
    assert client.transfer_create_calls == 0
    assert client.accounts == {}
    assert client.transfers == {}


def test_linked_transaction_projection_is_deterministic_and_atomic() -> None:
    replay = _flat_replay()
    transaction = replay.reduction.journal.transactions[1]

    first = project_broker_economic_transaction(transaction, scope=_SCOPE)
    second = project_broker_economic_transaction(transaction, scope=_SCOPE)

    assert first == second
    assert len(first) > 1
    assert all(spec.flags == 1 for spec in first[:-1])
    assert first[-1].flags == 0
    assert all(spec.debit_account_id != spec.credit_account_id for spec in first)


def test_partial_chain_is_not_blindly_replayed_and_blocks_parity() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    client = ExactTigerBeetleClient()
    first = _audit(client, replay, runs=runs)
    assert first.parity is True
    multi_transfer = next(
        project_broker_economic_transaction(transaction, scope=_SCOPE)
        for transaction in replay.reduction.journal.transactions
        if len(project_broker_economic_transaction(transaction, scope=_SCOPE)) > 1
    )
    client.remove_transfer(multi_transfer[0].transfer_id)

    result = _audit(client, replay, runs=runs)

    assert result.parity is False
    assert "tigerbeetle_economic_transfer_chain_partial" in result.payload["blockers"]
    assert "tigerbeetle_economic_transfer_missing" in result.payload["blockers"]
    assert (
        cast(dict[str, int], result.payload["operations"])[
            "transfer_create_selected_count"
        ]
        == 0
    )


def test_protocol_can_be_up_while_exact_transfer_parity_is_down() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    client = ExactTigerBeetleClient()
    assert _audit(client, replay, runs=runs).parity is True
    transfer = next(iter(client.transfers.values()))
    transfer["amount"] += 1

    result = _audit(client, replay, runs=runs)

    assert result.parity is False
    assert "tigerbeetle_economic_transfer_mismatch" in result.payload["blockers"]
    assert cast(dict[str, int], result.payload["errors"])["transfer_lookup"] == 0


def test_preexisting_account_identity_mismatch_prevents_transfer_writes() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    seeded = ExactTigerBeetleClient()
    assert _audit(seeded, replay, runs=runs).parity is True
    account_id, account = next(iter(seeded.accounts.items()))
    client = ExactTigerBeetleClient()
    client.accounts[account_id] = {
        **account,
        "code": account["code"] + 1,
        "credits_posted": 0,
        "debits_posted": 0,
    }

    result = _audit(client, replay, runs=runs)

    assert result.parity is False
    assert "tigerbeetle_economic_account_mismatch" in result.payload["blockers"]
    assert "tigerbeetle_economic_transfer_missing" in result.payload["blockers"]
    assert client.transfer_create_calls == 0


def test_exact_account_balance_mismatch_blocks_parity() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    client = ExactTigerBeetleClient()
    assert _audit(client, replay, runs=runs).parity is True
    next(iter(client.accounts.values()))["debits_posted"] += 1

    result = _audit(client, replay, runs=runs)

    assert result.parity is False
    assert "tigerbeetle_economic_account_mismatch" in result.payload["blockers"]
    assert cast(dict[str, int], result.payload["errors"])["account_lookup"] == 0


def test_duplicate_lookup_payload_fails_closed() -> None:
    class DuplicateLookupClient(ExactTigerBeetleClient):
        def lookup_transfers(self, ids: list[int]) -> list[object]:
            values = super().lookup_transfers(ids)
            return values + values[:1]

    replay = _flat_replay()
    result = _audit(DuplicateLookupClient(), replay, runs=_runs(replay))

    assert result.parity is False
    assert "tigerbeetle_economic_transfer_lookup_failed" in result.payload["blockers"]
    assert cast(dict[str, int], result.payload["errors"])["transfer_lookup"] > 0


def test_stale_source_watermark_blocks_authority_without_hiding_exact_ledger() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    result = _audit(
        ExactTigerBeetleClient(),
        replay,
        runs=runs,
        observed_at=_AT + timedelta(minutes=10),
        max_age=300,
    )

    assert result.parity is False
    assert result.payload["capital_authority"] is False
    assert "tigerbeetle_economic_source_watermark_stale" in result.payload["blockers"]
    assert (
        cast(dict[str, object], result.payload["expected"])["account_manifest_sha256"]
        == cast(dict[str, object], result.payload["actual"])["account_manifest_sha256"]
    )


def test_correction_reversal_and_replacement_project_without_delta() -> None:
    replay = _replay(
        _activity("cash-original", "CSD", offset=0, net_amount="100"),
        _activity(
            "cash-correction",
            "CSD",
            offset=1,
            net_amount="120",
            correction_of="cash-original",
        ),
    )
    result = _audit(ExactTigerBeetleClient(), replay, runs=_runs(replay))

    assert result.parity is True
    assert [
        transaction.posting_rule
        for transaction in replay.reduction.journal.transactions
    ] == ["external_cash_flow", "correction_reversal", "external_cash_flow"]


def test_forged_expected_digest_is_rejected_before_persistence() -> None:
    replay = _flat_replay()
    runs = _runs(replay)
    result = _audit(ExactTigerBeetleClient(), replay, runs=runs)
    forged = dict(result.payload)
    forged["expected"] = {
        **cast(dict[str, object], result.payload["expected"]),
        "transfer_manifest_sha256": "0" * 64,
    }

    with pytest.raises(
        EconomicLedgerError,
        match="tigerbeetle_economic_parity_value_contradiction",
    ):
        validate_tigerbeetle_economic_parity_payload(
            forged,
            replay=replay,
            runs=runs,
            observation=TigerBeetleEconomicParityObservation(
                cluster_id=2001,
                observed_at=_AT + timedelta(minutes=2),
                max_source_age_seconds=300,
            ),
        )
