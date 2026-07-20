# Bayn architecture

## Purpose and boundary

Bayn is being built as an autonomous quantitative evaluation, execution, and accounting service. Its first strategy is
adjusted-ETF time-series momentum. The deployed runtime currently stops at evaluation and simulation accounting: it may
not call a broker, submit an order, or promote capital. Later authority is unlocked only by the roadmap's economic,
recovery, reconciliation, and observation gates.

The current deployment retains TigerBeetle as the deterministic simulation journal while Bayn-owned PostgreSQL stores
the durable evaluation evidence. The roadmap replaces the transitional Signal read and simulation accounting
incrementally before any paper mutation work begins.

## Critical path

1. A Signal-owned publisher captures adjusted daily bars and exchange sessions into an immutable snapshot and writes
   its manifest last. Historical and daily modes use the same validation and finalization path.
2. The runtime's dedicated ClickHouse identity has `SELECT` only. It still reads the transitional
   `signal.adjusted_daily_bars_v1` table until the bounded finalized-snapshot reader is adopted.
3. Bayn validates every bar and hashes the ordered bar contents plus coverage into an immutable input manifest.
4. The committed `tsmom-v1` protocol forms signals at month-end close and executes at the next common session open.
5. One evaluator produces strategy, buy-and-hold, direct-volatility, and doubled-cost results on comparable dates.
6. Deterministic events become double-entry transfers in a Bayn-owned TigerBeetle ledger. Existing IDs are accepted
   only after object lookup and field comparison; accounts, transfers, and posted balances must reconcile exactly.
7. After exact reconciliation, a single PostgreSQL transaction records the immutable protocol and snapshot references,
   run identity, metrics, reconciliation receipt, ordered events, gate outcomes, and status history. The transaction
   changes the run from `WRITING` to `COMPLETE` only after exact child-row counts match.
8. Kubernetes readiness opens only after data validation, evaluation, journaling, reconciliation, and the durable
   PostgreSQL commit complete.

There is one `apps/v1 Deployment`, one replica, and one container. It has no scheduler, CronJob, Knative revision,
broker secret, or Kubernetes API token. `maxSurge: 0` prevents overlapping runtime writers during rollout.

## Reproducibility

The executable embeds its full source revision, OCI repository, and a behavior hash derived from the reviewed strategy
and hashing sources. Startup strictly decodes the committed TSMOM parameter JSON, hashes the decoded value with
canonical JSON, and refuses to run when configured source/repository attribution differs from the embedded build.
GitOps supplies the immutable image-index digest after publication. Status and the in-memory evidence envelope expose
all of those facts and their contract versions.

Local package entry points remain usable through an explicit `development-configured` provenance mode. It is reported
in HTTP status with an unverified behavior marker, forces evaluation and journaling off, and cannot override embedded
build facts. The production Nix image does not enable that mode: absent, partial, or mismatched embedded attribution
prevents startup.

The current transitional run ID is the SHA-256 hash of:

- the runtime-provenance envelope; and
- the exact ClickHouse input-manifest hash, including an ordered content hash of all bars.

Decision and fill IDs derive from canonical event payloads. TigerBeetle account and transfer IDs derive from the run ID,
event ID, and journal leg. Repeating the same run is idempotent; a changed price, protocol, or source revision creates a
different run namespace.

PostgreSQL uses the same run ID as its primary idempotency key. Exact replay returns the existing `COMPLETE` receipt
only after verifying its protocol, snapshot, source revision, image, strategy, status sequence, child-row counts, and
every stored payload against its content hash. A collision, partial run, altered payload, or divergent immutable
reference fails closed. Protocol locks and snapshot references are inserted and read back inside the same transaction
as the run, so no partial evidence survives a failed write.

This transitional identity is deliberately not `bayn.run-identity.v1`: the current ClickHouse table does not yet
provide finalized publication provenance, an exchange-calendar version, or explicit evaluation bounds. The finalized
snapshot and bounded-read roadmap slices must supply those facts before the target identity is used.

## Versioned contract boundary

The target evaluation path uses the executable v1 contracts in [`contracts/v1.md`](contracts/v1.md). They strictly
decode finalized-snapshot provenance, evaluation bounds, run identity, evidence freshness, independent status axes, and
authority. Unknown versions and excess fields fail closed. Run identity binds the full source revision, OCI image
digest, compiled strategy behavior hash, decoded strategy parameters, finalized snapshot, exchange-calendar version,
and explicit bounds through canonical JSON and SHA-256.

Runtime provenance, strict TSMOM parameter decoding, and transactional evaluation persistence are adopted contract
slices. Finalized-snapshot identity, bounded reads, continuous health, and removal of the legacy TigerBeetle dependency
remain separate roadmap tickets with their own rollout evidence.

## Economic test

The protocol is long-or-cash across DBC, EEM, EFA, GLD, IEF, SPY, TLT, and VNQ. Direction is the majority sign across
21, 63, 126, and 252-session momentum lookbacks. Rebalancing is monthly and the cost model is charged on every buy and
sell. The verdict fails closed unless all committed gates pass: sufficient observations, positive return after costs,
Sharpe improvement over both benchmarks, bounded drawdown, bounded turnover, and positive return with doubled costs.

This evaluator result is not the excluded locked out-of-sample verdict. Changing the strategy because of the current
result would contaminate that later test.

## Accounting model

All USD amounts use integer micros in TigerBeetle. Per-run accounts are cash, equity, fees, realized gain, realized loss,
and inventory cost per symbol. Buys move cash to inventory cost. Sells remove cost basis, move proceeds to cash, and
separate realized gain or loss. Fees move cash to fee expense. Quantities and prices remain in the immutable evaluation
event payload hash.

TigerBeetle is currently a single-replica shared dependency. Exact Bayn reconciliation is an accounting-integrity gate;
it does not make that dependency highly available and does not grant trading authority. PostgreSQL durably records the
result and receipt, but does not replace the double-entry ledger in this slice.

## Deployment and recovery

The image is built for AMD64 and ARM64 with Nix, published under a source-SHA tag, and pinned in GitOps by digest. Argo
CD owns the `bayn` namespace and Deployment. The ClickHouse credential is separately sealed, reflected only into the
Bayn namespace, and granted table-level `SELECT`. Alpaca credentials and the insert/select-only Signal writer identity
are mounted only into the Signal publisher CronJob and are never mounted into the Bayn runtime.

Bayn connects to `bayn-db-rw` with the CNPG-generated `bayn-db-app` URI and a read-only mount containing only
`bayn-db-ca/ca.crt`; the CA private key is not mounted. TLS hostname and certificate verification are mandatory in a
production artifact. Effect SQL owns the scoped two-connection pool and additive migrations. CNPG backup, retention,
and isolated restore evidence are defined in [`cnpg-backup-restore.md`](cnpg-backup-restore.md).

On restart, Bayn recomputes the deterministic run, verifies any existing TigerBeetle objects, and reconciles the full
run again before reading or writing the matching PostgreSQL receipt. If ClickHouse, TigerBeetle, PostgreSQL, data
validation, evaluation, reconciliation, migration, or persistence fails, the process remains live for diagnosis but
readiness stays closed.
