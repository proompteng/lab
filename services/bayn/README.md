# Bayn

This directory owns Bayn's Effect-TS runtime modules. The accounting slice journals deterministic simulation economics
to TigerBeetle and refuses to return success until the ledger exactly reproduces the evaluator.

## TigerBeetle accounting contract

`src/accounting/model.ts` is the immutable v1 contract. It versions:

- the evaluator input schema and deterministic SHA-256/u128 identifier scheme;
- TigerBeetle ledgers, account codes, transfer codes, and integer units (`USD_MICRO` and `SHARE_E8`);
- double-entry direction, long-only/cash constraints, fee treatment, ending valuation, and exact reconciliation rules.

Do not change v1 numeric values or semantics in place. Add a new model, input schema, journal planner, and reconciler when
the accounting contract changes. An evaluation identity belongs to one immutable set of economic inputs; corrected or
changed inputs require a new evaluation identity.

The evaluator hands accounting `bayn.evaluation-economics.v1` values using `bigint` integer units. It provides stable
event IDs and a unique sequence across cash entries, trades, and fees. The planner validates, before any write, that:

- all event identities and sequences are unique and all values fit TigerBeetle's unsigned 128-bit fields;
- event order never creates negative cash or a short position;
- fees, ending cash, ending quantities, and ending equity equal the values derived from the event stream exactly.

Each trade produces a USD consideration transfer and a share-quantity transfer. Fees and cash entries remain separate.
Ending market values are journaled in balanced valuation accounts without changing cash. Evaluation-scoped accounts make
both posted sides an exact checksum of the expected economics.

## Idempotency and reconciliation

Account and transfer IDs are non-zero u128 values derived from versioned, length-prefixed Bayn identities. Replaying the
same evaluation receives TigerBeetle `exists` results, looks the objects up, verifies every immutable field, and creates
no additional economics. Reusing an identity with changed fields is a typed conflict.

`journalEvaluation` performs this fail-closed sequence:

1. build and validate the deterministic journal plan;
2. ensure all accounts, verifying existing objects exactly;
3. ensure all transfers, verifying existing objects exactly;
4. look up every account and transfer and reconcile immutable fields, pending balances, both posted sides, cash, fees,
   positions, and equity;
5. return only an `ok: true` reconciliation report; otherwise fail with `BaynReconciliationError`.

The Effect service is `TigerBeetleClient`. Production callers provide `makeTigerBeetleClientLayer({ clusterId,
replicaAddresses })`, which scopes and closes the native client and maps configuration, connection, request, create, and
duplicate conflicts into typed failures.

## Validation

```bash
bun install --frozen-lockfile --ignore-scripts --filter @proompteng/source --filter @proompteng/bayn
bun run --cwd services/bayn lint
bun run --cwd services/bayn lint:oxlint
bun run --cwd services/bayn lint:oxlint:type
bun run --cwd services/bayn tsc
bun run --cwd services/bayn test
```
