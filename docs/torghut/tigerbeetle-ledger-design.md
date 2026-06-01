# Torghut TigerBeetle Ledger Design

## Scope

TigerBeetle is Torghut's durable double-entry ledger infrastructure. Postgres remains the metadata and control-plane database. The broker and normalized order feed remain the external execution truth.

This lane does not change strategy selection, paper promotion, broker submit authority, or profitability gates. Runtime-ledger and proof systems may consume TigerBeetle-backed references, but they must not treat those references as alpha evidence by themselves.

## Ledger

Torghut v1 uses one TigerBeetle ledger for USD-denominated monetary evidence:

```text
ledger 840001 = USD_MICRO
asset scale = 6
1 USD = 1_000_000 units
```

Amounts that cannot be represented at micro-dollar precision are rejected instead of rounded. Negative accounting inputs are rejected before ledger write construction.

## Account Codes

```text
1001 torghut_cash_control
1101 submitted_order_hold
1201 fill_notional_cost_basis
1301 explicit_execution_cost
1401 realized_pnl_evidence
9001 smoke_cash
9002 smoke_counterparty
```

Account IDs are deterministic. The same Torghut semantic account key must always resolve to the same TigerBeetle account ID for a given cluster.

## Transfer Codes

```text
2000 submitted_order_pending
2001 fill_post_pending
2002 cancel_void_pending
2003 reject_void_pending
2004 explicit_fee
9000 smoke_transfer
```

Transfer IDs are deterministic from immutable source evidence. Replaying the same source event must produce the same transfer ID and must be idempotent.

## ID Semantics

If a source entity already has a UUID, Torghut reuses the UUID integer value as the TigerBeetle 128-bit ID.

For non-UUID keys, Torghut derives a deterministic 128-bit integer from:

```text
sha256(namespace + "\0" + key)[:16]
```

Zero IDs are invalid. Namespace strings are part of the contract and are treated as schema-bearing values, not incidental labels.

## Lifecycle Semantics

Order lifecycle evidence maps into ledger movement as follows:

```text
submitted -> submitted_order_pending transfer
accepted -> submitted_order_pending transfer
filled -> fill_post_pending transfer for fill amount
partial_filled -> fill_post_pending transfer for fill amount
canceled -> cancel_void_pending transfer
cancelled -> cancel_void_pending transfer
expired -> cancel_void_pending transfer
rejected -> reject_void_pending transfer
fee/cost evidence -> explicit_fee transfer
```

The journal writes account refs before transfer refs. A duplicate transfer create result is success only when TigerBeetle lookup confirms the existing transfer matches the expected ledger, code, amount, debit account, and credit account. Conflicting duplicates are ledger errors.

## Reconciliation

Reconciliation compares three sources:

- Postgres `TradeDecision`, `Execution`, and `ExecutionOrderEvent` rows.
- Postgres TigerBeetle reference rows for accounts, transfers, and reconciliation runs.
- TigerBeetle account and transfer lookup results.

The stable blocker vocabulary is:

```text
tigerbeetle_transfer_missing
tigerbeetle_transfer_amount_mismatch
tigerbeetle_transfer_code_mismatch
tigerbeetle_transfer_ledger_mismatch
tigerbeetle_transfer_debit_account_mismatch
tigerbeetle_transfer_credit_account_mismatch
tigerbeetle_postgres_ref_mismatch
tigerbeetle_source_row_missing
tigerbeetle_source_amount_mismatch
tigerbeetle_runtime_ledger_direction_mismatch
tigerbeetle_runtime_ledger_metadata_mismatch
tigerbeetle_runtime_ledger_signed_refs_missing
tigerbeetle_runtime_ledger_account_refs_missing
tigerbeetle_unlinked_order_event
tigerbeetle_unlinked_execution
tigerbeetle_unlinked_execution_cost
tigerbeetle_unlinked_runtime_ledger
tigerbeetle_client_unavailable
tigerbeetle_reconciliation_stale
```

Readiness may fail closed on protocol or reconciliation blockers only when the corresponding `TORGHUT_TIGERBEETLE_REQUIRED` or `TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED` flag is enabled. Stale reconciliation is explicit: `TORGHUT_TIGERBEETLE_RECONCILE_MAX_AGE_SECONDS` bounds the age of the latest reconciliation row, readiness reports the measured age, and stale rows produce `tigerbeetle_reconciliation_stale`.

TigerBeetle evidence is supplementary durability/accounting evidence. It never sets `proof_authority` or `promotion_authority` by itself; final promotion still requires source-backed runtime-ledger/live-paper post-cost proof from the broker/order-feed/runtime sources.

## Production Topology

Torghut v1 uses a single TigerBeetle replica as a bootstrap topology because the current cluster has only two Ready nodes and cannot honestly satisfy TigerBeetle's six-replica production topology across independent failure domains.

The single-replica topology is not HA. Full production HA requires at least six schedulable failure domains, a six-replica TigerBeetle cluster, and a new immutable cluster if replica count, cluster ID, or storage fields change.

## Version Contract

TigerBeetle server and client versions are pinned together. The first rollout pins both to `0.17.4`, matching the latest verified upstream release at implementation start.
