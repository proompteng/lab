# Bayn architecture

## Purpose and boundary

Bayn is being built as an autonomous quantitative evaluation, execution, and accounting service. Its first strategy is
adjusted-ETF time-series momentum. The deployed runtime currently stops at evaluation and simulation accounting: it may
not call a broker, submit an order, or promote capital. Later authority is unlocked only by the roadmap's economic,
recovery, reconciliation, and observation gates.

The current TigerBeetle-backed startup path described below is legacy production state, not the target architecture.
The active roadmap replaces it incrementally with finalized Signal publications and Bayn-owned PostgreSQL evidence
before any paper mutation work begins.

## Critical path

1. A one-time operator command loads explicitly versioned, split/dividend-adjusted daily bars into Signal ClickHouse.
2. The runtime's dedicated ClickHouse identity can select only `signal.adjusted_daily_bars_v1`.
3. Bayn validates every bar and hashes the ordered bar contents plus coverage into an immutable input manifest.
4. The committed `tsmom-v1` protocol forms signals at month-end close and executes at the next common session open.
5. One evaluator produces strategy, buy-and-hold, direct-volatility, and doubled-cost results on comparable dates.
6. Deterministic events become double-entry transfers in a Bayn-owned TigerBeetle ledger. Existing IDs are accepted
   only after object lookup and field comparison; accounts, transfers, and posted balances must reconcile exactly.
7. Kubernetes readiness opens only after data validation, evaluation, journaling, and reconciliation complete.

There is one `apps/v1 Deployment`, one replica, and one container. It has no scheduler, CronJob, Knative revision,
broker secret, or Kubernetes API token. `maxSurge: 0` prevents overlapping runtime writers during rollout.

## Reproducibility

The run ID is the SHA-256 hash of:

- the immutable image source revision;
- the canonical protocol hash; and
- the exact ClickHouse input-manifest hash, including an ordered content hash of all bars.

Decision and fill IDs derive from canonical event payloads. TigerBeetle account and transfer IDs derive from the run ID,
event ID, and journal leg. Repeating the same run is idempotent; a changed price, protocol, or source revision creates a
different run namespace.

## Versioned contract boundary

The target evaluation path uses the executable v1 contracts in [`contracts/v1.md`](contracts/v1.md). They strictly
decode finalized-snapshot provenance, evaluation bounds, run identity, evidence freshness, independent status axes, and
authority. Unknown versions and excess fields fail closed. Run identity binds the full source revision, OCI image
digest, compiled strategy behavior hash, decoded strategy parameters, finalized snapshot, exchange-calendar version,
and explicit bounds through canonical JSON and SHA-256.

Contract availability does not mean the deployed runtime has adopted the target path. Adoption, persistence, continuous
health, and removal of the legacy TigerBeetle dependency are separate roadmap tickets with their own rollout evidence.

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
it does not make that dependency highly available and does not grant trading authority.

## Deployment and recovery

The image is built for AMD64 and ARM64 with Nix, published under a source-SHA tag, and pinned in GitOps by digest. Argo
CD owns the `bayn` namespace and Deployment. The ClickHouse credential is separately sealed, reflected only into the
Bayn namespace, and granted table-level `SELECT`. Market-data credentials belong only to the operator backfill command
and are never mounted into the runtime.

On restart, Bayn recomputes the deterministic run, verifies any existing TigerBeetle objects, and reconciles the full
run again before becoming ready. If ClickHouse, TigerBeetle, data validation, evaluation, or reconciliation fails, the
process remains live for diagnosis but readiness stays closed.
