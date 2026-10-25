# Full Broker-Economic TigerBeetle Parity

Status: production-proven Slice 10 design. The complete delivery and runtime proof is recorded in
[Slice 10 production evidence](evidence/slice-10-tigerbeetle-economic-parity-2026-07-17.md). This status does not grant
capital or claim profitability.

## Decision

Torghut projects the immutable, independently reduced broker-economic journal into TigerBeetle and proves the entire
projection by exact account and transfer readback. Protocol reachability, successful journal calls, legacy runtime-ledger
samples, and bounded recent rows are not economic parity.

The implementation extends the existing broker-economic observation path. It does not add another service, queue,
cursor, approval system, generic accounting framework, or per-transfer PostgreSQL shadow index. The immutable journal is
already the complete source of expected TigerBeetle identities, so a second mutable reference store would add another
authority and another reconciliation problem.

Full, fresh, zero-residual parity is a necessary dependency for risk-increasing Alpaca entry and later promotion. It is
not a capital grant. It never makes Kubernetes readiness or `service_healthy` false, never disables strictly
exposure-reducing actions, and never disables recovery.

## Upstream Semantics

The design follows TigerBeetle's native contracts:

- [Alpaca crypto activity](https://docs.alpaca.markets/us/docs/crypto-trading) records `CFEE` charges at end of day and
  notes that a fee may not be available on the trade day. Economic date and first-observed time are therefore distinct
  facts; neither may be substituted for the other.
- [Requests](https://docs.tigerbeetle.com/coding/requests/) are committed as batches, create events are idempotent, and
  the default create/lookup batch limit is 8,189 events.
- [Accounts](https://docs.tigerbeetle.com/reference/account/) are immutable except for cumulative debit and credit
  balances; account IDs are cluster-wide and ledgers partition which accounts may transact.
- [Transfers](https://docs.tigerbeetle.com/reference/transfer/) are immutable, cluster-wide identities between one debit
  and one credit account on the same ledger.
- [Multi-debit, multi-credit transfers](https://docs.tigerbeetle.com/coding/recipes/multi-debit-credit-transfers/) use
  linked transfer chains so one broker-economic journal transaction is atomic.
- [Currency exchange](https://docs.tigerbeetle.com/coding/recipes/currency-exchange/) requires distinct ledgers for
  distinct commodities. Torghut therefore never mixes USD, an equity unit, a crypto unit, or another commodity in one
  TigerBeetle ledger.

## Authority Chain

The exact dependency chain is:

1. the broker account-activity REST cursor closes a source watermark;
2. raw immutable activity bytes and hashes define one manifest;
3. the canonical journal reducer and independent state reducer are admissible and exactly equivalent;
4. the exact reducer pair has already been published as immutable CNPG runs;
5. the journal projection is materialized in TigerBeetle using deterministic versioned IDs;
6. every expected account and transfer is read back and compared exactly;
7. the parity payload is bound to the source watermark, manifest, reducer, journal, published run IDs, cluster, and
   observation time;
8. broker-state reconciliation and TigerBeetle parity are sealed together in one append-only reconciliation result;
9. only a current observation with broker reconciliation and TigerBeetle parity both true satisfies the entry and
   promotion dependencies;
10. a separate valid strategy-capital authority and every other runtime gate are still required before broker I/O.

No step infers a later step. In particular, `parity=true` does not mean the strategy is profitable, statistically valid,
approved for capital, or presently allowed to submit.

## Deterministic Projection

### Versioning and scope

Projection identity is namespaced by a projection version and a SHA-256 scope digest over provider, broker environment,
configured account label, endpoint fingerprint, and projection version. Raw account labels are not written into the
TigerBeetle parity payload.

Changing any economic encoding rule requires a new projection version. Versioned IDs prevent a revised projection from
silently inheriting balances from an older encoding.

Ordering is part of economic identity. The first publication in a reducer namespace orders the complete closed source
economically; timestamped fills retain event-time order, and date-only fees use first-observed time only as a same-date
tie-break. A later replay loads and hash-validates the latest complete published manifest for that exact reducer pair,
keeps every published activity in the same order, and economically sorts only the newly observed cohort.

Crossing the published economic frontier is not a generic ingestion-time rule. A missing historical trade or a
correction of published history requires a new reducer and projection version. A documented late date-only `CFEE` may
append only after the normal dual reduction remains admissible and equivalent and the dedicated retroactive-append
guard replays the complete source in economic order. That dedicated guard compares the canonical journal and proves:

- the transaction ID and digest multiset is identical;
- the canonical journal's final economic projection is identical, excluding only the order-dependent input-manifest
  digest.

Independent-reducer equivalence is required by the normal replay boundary, but it is not an additional comparison made
inside the retroactive-append guard.

This rejects both obvious insufficient-position cases and sufficient-position cases where later trades changed the
fee's average cost. The implementation never guesses that an append is safe from position quantity alone. A malformed,
hash-invalid, duplicate, or incomplete published manifest also fails closed. Reducer v4 and TigerBeetle projection v2
remain immutable historical evidence because their rule did not preserve this invariant across settlement dates;
reducer v5 and projection v3 own the corrected namespace. Old objects are never deleted, overwritten, or reinterpreted.

### Amounts

Every broker-economic ledger amount is already bounded to 18 decimal places. TigerBeetle amounts use the exact absolute
integer value at scale `10^18`. There is no float conversion, tolerance, cent rounding, or nearest-integer fallback.
Zero, precision loss, and unsigned 128-bit overflow are hard failures.

### Ledgers

Each normalized commodity maps deterministically to one nonzero unsigned 32-bit ledger ID. The projection reserves the
high-bit ledger range to avoid the legacy Torghut ledgers. Before any write, the full journal is scanned for a hash
collision between distinct commodities. A collision is a hard failure; the implementation never silently remaps one
commodity.

### Accounts

An account ID is a deterministic 128-bit hash of projection version, scope digest, commodity, and canonical journal
account. Account codes distinguish assets, clearing, expenses, income, equity, and liabilities. Expected account proof
includes:

- ID, ledger, code, flags, and zero user-data fields;
- exact cumulative posted debits and credits;
- zero pending debits and credits.

Account identity is verified after creation and before any transfer write. A pre-existing ID with different immutable
fields blocks all transfer materialization for that run.

### Transfers and journal atomicity

Positive journal lines are debits and negative journal lines are credits. Within each commodity, deterministic
debit-credit matching decomposes a balanced journal transaction into the minimum ordered sequence of one-debit,
one-credit TigerBeetle transfers. Transfer identity binds:

- projection version and scope digest;
- immutable journal transaction digest;
- commodity;
- debit and credit journal line numbers;
- split segment and exact amount.

All transfers for one journal transaction form one linked chain. The last transfer clears the linked flag. A journal
transaction that would exceed TigerBeetle's 8,189-event request limit is rejected rather than split across atomic
boundaries.

Posting-rule-specific transfer codes preserve whether the source was a fill, external cash flow, dividend, interest,
cash fee, crypto asset fee, or correction reversal.

## Idempotent Materialization

Blindly resubmitting a linked chain is unsafe: an existing event can cause later linked events to report dependent
failure even when an earlier run already committed the full chain. Each request batch therefore follows this sequence:

1. look up all deterministic transfer IDs;
2. skip a chain when every member exists;
3. create a chain only when no member exists;
4. never write a partially present chain;
5. after all writes, look up the complete projection again and verify it independently of create results.

A partially present chain is an irreversible contradiction requiring investigation or a new versioned projection. The
auditor does not guess, delete, overwrite, or manufacture a compensating transfer.

## Full Parity Proof

The auditor makes bounded 8,189-event requests and performs four checks:

1. recompute expected account and transfer manifests from the immutable journal;
2. create only missing accounts and wholly missing transfer chains;
3. read every expected account and compare immutable fields plus cumulative balances;
4. read every expected transfer and compare all economic and protocol fields.

Expected and actual manifests are canonical newline-delimited JSON SHA-256 digests in deterministic order. Parity is
true only when:

- source age is within the configured bound;
- the projection contains at least one transaction, account, and transfer;
- expected and actual counts match;
- account and transfer manifest digests match;
- no create, lookup, missing, mismatch, or partial-chain error occurred;
- no blocker remains.

Mismatch evidence contains only object-ID hashes, field names, counts, digests, and exception class names. It does not
persist broker credentials, endpoint URLs, account labels, account values, or arbitrary exception text.

## Sealed CNPG Evidence

The parity payload is nested inside the existing append-only `BrokerEconomicLedgerReconciliation.result`. This reuses
the existing canonical JSON, SHA-256, and database immutability trigger. No migration or second result table is needed.

Before insert, application code recomputes the full expected projection and validates exact bindings to:

- TigerBeetle cluster and projection version;
- scope digest;
- current and published-input source watermarks;
- observation time and source-age bound;
- input, journal-run, and state-run IDs;
- input-manifest, reducer-comparison, and journal digests;
- reducer version.

Status readback first validates the parent result's canonical bytes and hash, then validates every nested binding. A
missing or malformed payload fails closed.

## Runtime Semantics

`GET /trading/status` exposes these additive fields on `broker_economic_ledger`:

- `accounting_parity_satisfied`;
- `entry_dependency_satisfied`;
- `promotion_dependency_satisfied`;
- `tigerbeetle_economic_parity`;
- combined broker and TigerBeetle reason codes.

`capital_authority` remains false. `diagnostic_only` becomes false because the result is an operational dependency, but
it still grants no action by itself.

When `TORGHUT_TIGERBEETLE_ECONOMIC_PARITY_REQUIRED=true`:

- the runtime action projection adds parity blockers only to `entry`;
- immediate strategy-capital evaluation reloads the latest sealed status before risk-increasing Alpaca authority;
- the final transaction-held revalidation reloads it again immediately before the broker boundary;
- read or validation failure denies entry;
- Hyperliquid authority is not incorrectly coupled to the Alpaca economic scope;
- reduce-only, closeout, cancel, recovery, `service_healthy`, liveness, and readiness retain their existing contracts.

This double read prevents a stale passing observation from being relied on after it expires between decision evaluation
and submission.

## Scheduled Operation and Logging

The existing hourly broker-economic reconciliation CronJob owns parity. It runs observation-only mode with
`--tigerbeetle-parity`, `Forbid` concurrency, zero Kubernetes backoff, a bounded deadline, the exact deployed build
identity, and no publication token. The CLI retries the complete observation only when a concurrent broker-activity
scan opens or changes the source snapshot, for at most three minutes. It never retries TigerBeetle mismatches, broker
residuals, build-identity failures, or any other error; exhaustion remains a hard failure. Retrying the complete attempt
ensures no partially stale reduction or broker snapshot can be reused.

The official TigerBeetle Linux client requires `io_uring`; the upstream project documents `PermissionDenied` under
container seccomp defaults and recommends an unconfined seccomp profile. The reconciliation container therefore uses
the same container-scoped `Unconfined` override as the existing TigerBeetle smoke job while remaining non-root, denying
privilege escalation, dropping every Linux capability, and mounting no service-account token. The pod default remains
`RuntimeDefault`, so the exception is limited to the one container that initializes the trusted TigerBeetle client.
See TigerBeetle's [container troubleshooting](https://docs.tigerbeetle.com/operating/deploying/docker/) and the official
[client io_uring report](https://github.com/tigerbeetle/tigerbeetle/issues/3295).

Observation output is deliberately compact. It omits the publication token, raw scope, broker cash/equity, positions,
residual values, and journal economic values. Durable detailed evidence remains in sealed CNPG rows and the bounded
status surface.

The job exits nonzero when requested TigerBeetle parity is false. Broker-economic residuals remain visible and block the
combined dependency, but preserve the existing distinction between an observation with economic residuals and a
technical TigerBeetle audit failure.

## Failure Matrix

| Condition                                    | Entry                    | Reduce-only / recovery | Readiness                     | Scheduled job         |
| -------------------------------------------- | ------------------------ | ---------------------- | ----------------------------- | --------------------- |
| Fresh broker reconciliation and exact parity | Other gates decide       | Available              | Unchanged                     | Success               |
| Broker residual                              | Blocked                  | Available              | Unchanged                     | Observation completes |
| Source stale                                 | Blocked                  | Available              | Unchanged                     | Nonzero parity result |
| Missing or mismatched account/transfer       | Blocked                  | Available              | Unchanged                     | Nonzero parity result |
| Partial linked chain                         | Blocked; no repair write | Available              | Unchanged                     | Nonzero parity result |
| TigerBeetle protocol/lookup failure          | Blocked                  | Available              | Existing protocol policy only | Nonzero parity result |
| Missing/malformed sealed evidence            | Blocked                  | Available              | Unchanged                     | Not applicable        |

## Tests

Required focused coverage includes:

- deterministic exact projection and idempotent rerun;
- linked multi-debit/multi-credit atomic chains;
- missing and partially present transfers;
- duplicate-ID transfer payload mismatch;
- missing or mismatched accounts and cumulative balances;
- correction reversal plus replacement;
- stale source watermark and source lag;
- protocol-up/parity-down behavior;
- forged expected digest or row binding rejection;
- broker reconciliation plus parity status composition;
- entry-only action-authority gating;
- both pre-broker strategy-capital checks;
- safe observation logging and client closure;
- live GitOps environment and CronJob contracts.

## Production Acceptance

Slice 10 is complete only after all of the following are recorded in a dated evidence document:

1. focused and broad local validation passes, including all five Pyright profiles;
2. PR checks pass and the change is squash-merged;
3. the exact merged image digest is published and promoted through GitOps;
4. Argo reports the intended revision and child resources are healthy;
5. the first explicit parity run materializes the full production projection without partial chains;
6. an exact rerun creates zero accounts and zero transfers and reproduces both manifests;
7. a natural scheduled run completes from a fresh source watermark;
8. CNPG readback proves the nested payload is sealed and bound to the expected runs and build;
9. direct scheduler status shows the combined entry dependency truth while service health and reduce-only remain
   separate;
10. a controlled discrepancy is demonstrated without corrupting production: a read-only wrapper changes one lookup
    field in memory, forbids all create calls, does not persist the synthetic result, and proves parity plus entry fail
    closed;
11. subsequent unmodified scheduled parity returns to exact success;
12. existing Slice 8 broker residuals are reported independently; parity does not erase or relabel them.

## Rollback

TigerBeetle accounts and transfers are immutable and are never deleted during rollback. Before reverting enforcement,
operators must explicitly keep global new exposure blocked. The application and schedule may then be reverted while
retaining the last sealed result for inspection only. A prior passing result is never treated as fresh proof after the
new observer stops.
