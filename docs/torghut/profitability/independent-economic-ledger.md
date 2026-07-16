# Independent Broker-Economic Ledger

Status: Slice 8 implementation design

Last updated: 2026-07-16

## Decision

Torghut will reconstruct account economics from immutable Alpaca account activities with two separately implemented
reducers:

1. a canonical double-entry journal reducer; and
2. an independent position-and-cash state reducer used only as a differential check.

The reducers share the immutable input contract and comparison result, but they do not share posting, cost-basis, or
position-transition logic. A common bug therefore cannot pass merely because both projections call the same accounting
helper.

Neither reducer is a broker, execution, capital, or mutation authority. Both are disposable projections. The only
executed-economic source is `broker_account_activities` from
`source=account_activities_rest`. `trade_updates_ws` remains a low-latency corroborating source for Slice 7 fill
equivalence and is never counted a second time.

This design follows Alpaca's official
[account-activity contract](https://docs.alpaca.markets/us/docs/account-activities),
[crypto fee contract](https://docs.alpaca.markets/us/docs/crypto-trading), and
[position cost-basis behavior](https://docs.alpaca.markets/us/docs/position-average-entry-price-calculation). It uses
immutable balanced entries and explicit reversals, consistent with
[event-sourced accounting](https://martinfowler.com/eaaDev/EventSourcing.html) and
[two-legged accounting transactions](https://martinfowler.com/eaaDev/AccountingTransaction.html). TigerBeetle remains
the later independent durable ledger comparison in Slice 10, not an implementation dependency of this reducer.

## Verified Production Shape

Read-only Alpaca paper-account inspection on 2026-07-16 established the current input shape without retaining raw
account data:

- the first 2,000 ascending activities were incomplete and contained 1,981 fills, 18 fees, and one cash journal;
- an activity-type-complete read contained 63 USD fees: 38 `TAF`, 18 `CAT`, four `OCC`, and three `ORF`, all negative
  cash amounts;
- seven `CFEE` rows contained quantity, price, and symbol; four had negative cash impact and three had zero cash impact;
- one `JNLC` row had positive cash impact;
- the latest 100 fills contained both equities and crypto, buys and sells, and no broker-provided `net_amount`.

Therefore a credible projection must calculate fill notionals, account for order-independent regulatory fees, handle
crypto fees charged in the received asset, and retain external cash journals. A fill-only realized-PnL counter is not
acceptable.

## Authority And Completeness Boundary

A projection run is admissible only when all of these are true:

- the scope is one provider, environment, account label, endpoint fingerprint, and quote currency;
- the REST cursor exists, is `complete`, has no error, and names a closed scan watermark;
- every selected source row is `account_activities_rest` and its database-verified raw hash is present;
- source identities are unique; identical duplicates collapse and contradictory duplicate bytes fail;
- the ordered input manifest and its SHA-256 digest are persisted with the reducer version;
- every activity type is either supported by an explicit versioned posting rule or appears in the unsupported residual
  set; any unsupported residual makes the run non-admissible;
- every journal transaction balances to zero independently for each commodity;
- canonical and independent cash, quantity, cost, realized PnL, fee, income, and equity outputs agree exactly at the
  configured decimal scale;
- reconciliation uses a fresh read-only broker account/position snapshot captured after the source watermark.

The input manifest orders activities by economic timestamp, settlement date, external activity ID, and raw hash.
`event_at` and `first_observed_at` are retained separately. Late and corrected facts therefore preserve both when the
broker says they occurred and when Torghut learned them.

## Shared Input Contract

The pure reducer accepts bounded decimal and identifier values only:

- external activity ID, raw payload hash, type, subtype, correction reference;
- event timestamp, settlement date, first-observed timestamp;
- symbol, side, quantity, price, net cash amount, and currency;
- provider/account/environment/endpoint scope.

The SQLAlchemy model is adapted into this value object at the boundary. The reducer never reads mutable strategy,
execution, runtime-ledger, candidate, or TigerBeetle state.

### Fixed-point contract

All source quantity, price, and cash fields must fit PostgreSQL `NUMERIC(38, 18)` exactly; inputs with more than 18
fractional digits or at least 20 integer digits fail closed instead of being silently rounded. Reducers calculate with
an 80-digit local decimal context and persist every derived notional, released cost, carrying value, fee, and realized
amount at 18 fractional digits using decimal `ROUND_HALF_UP`, matching Torghut's existing TigerBeetle conversion rule.

Weighted-average partial closes round the released cost once. The retained position receives the exact residual carrying
cost; a full close releases the complete remaining carrying cost without division. Realized PnL is the exact balancing
residual of fixed-point cash and carrying-cost deltas. This keeps every commodity transaction exactly balanced and makes
the two reducers comparable without an epsilon while avoiding context-dependent repeating-decimal dust.

## Chart Of Accounts And Commodities

Amounts use debit-positive signs. Each transaction balances separately by commodity.

USD accounts:

- `asset:cash`;
- `asset:position_cost:<symbol>` for long inventory or a credit balance for short inventory;
- `equity:external_flow` for deposits, withdrawals, and cash journals;
- `income:realized_pnl`;
- `income:dividend` and `income:interest`;
- `expense:broker_fee`, `expense:regulatory_fee`, and `expense:withholding`;
- `equity:corporate_action` only for an explicitly broker-reported cash or basis adjustment.

Quantity accounts use the canonical asset symbol as their commodity:

- `asset:position_units:<symbol>`; and
- a transaction-specific clearing account such as `clearing:broker_fill`, `clearing:fee`, or
  `clearing:corporate_action`.

This separates monetary cost from security quantity while preserving double entry in both dimensions. Market value is
a derived mark, not historical cost and not a source mutation.

## Posting Rules

### Fills

For each `FILL`, quantity and price must be positive, side must be `buy` or `sell`, and USD notional is
`quantity * price` with no binary floating point.

- a buy credits cash and debits position cost for newly opened long quantity;
- a sell debits cash and credits position cost for newly opened short quantity;
- the portion that closes an existing position releases weighted-average signed cost and posts the difference between
  proceeds/cost and released cost to realized PnL;
- a side flip is split deterministically into a closing leg and an opening leg inside one balanced transaction;
- quantity entries move units between broker clearing and the position account.

The canonical reducer uses explicit signed weighted-average cost. The independent reducer computes the same terminal
contract through a separately coded state transition. Alpaca can change displayed average entry price at its beginning-
of-day compression, so broker average-entry-price differences are classified separately from quantity, cash, and total
equity. A flat round trip must converge exactly regardless of lot-display method.

### Cash, Fees, Dividends, And Interest

- positive `CSD`, `JNLC`, `JNL`, or cash-transfer net amount debits cash and credits external flow;
- negative cash flow reverses those legs;
- USD `FEE`, `DIVFEE`, pass-through charge, and withholding debits the matching expense and credits cash;
- positive dividend or interest net amount debits cash and credits income; negative adjustments reverse the original
  economic category;
- `CFEE` with nonzero `net_amount` posts as a cash fee;
- `CFEE` with zero cash and nonzero asset quantity reduces the named asset units, releases their signed average cost,
  posts fair-value fee expense from broker quantity times price, and records any cost/fair-value difference as realized
  PnL. Crypto may not become short through a fee.

Fees remain separate from gross trade PnL so both gross and after-cost results are reproducible.

### Corporate Actions And Corrections

- split and reverse-split rows change units while preserving total signed cost;
- symbol/name changes move both quantity and cost from old to new identity in one balanced transaction;
- dividends, return of capital, assignments, exercises, expirations, mergers, spin-offs, and reorganizations require an
  explicit typed rule and a golden broker fixture before they become admissible;
- `previous_id` never edits or deletes history. A correction creates exact reversing entries for the superseded
  transaction and applies the replacement fact;
- a correction chain occupies its root activity's original economic-order slot, so a late replacement rebuilds the
  historical projection instead of being misclassified as a new trade at observation time; every replacement timestamp
  remains in the immutable input manifest;
- correction chains are resolved before replay, cycles and missing predecessors fail closed, and the manifest records
  every source row even when its economic effect is reversed.

Unknown activity types are residual evidence, not zero-value no-ops.

## Projection Contract

Each reducer emits the same immutable result shape:

- ordered input count, first/last event, source manifest digest, and reducer version;
- cash by currency;
- signed quantity, signed cost, and average cost by symbol;
- realized PnL, fees, dividends, interest, external flows, and other supported adjustments;
- optional marks, market value, unrealized PnL, and equity;
- unsupported, corrected, duplicate, and contradiction counts;
- deterministic transaction/result digests.

For a mark `m`, signed market value is `quantity * m`, unrealized PnL is `market_value - signed_cost`, and equity is
cash plus signed market value. Marks carry their own source, timestamp, and digest and never alter historical entries.

The comparison report enumerates every field delta. It has no tolerance for cash, source quantities, balanced entries,
or realized values derived from identical decimals. Broker snapshot comparisons use explicit configured tolerances only
for venue-displayed marks and timing differences.

## Minimal Persistence

Persistence will use the existing CNPG database and only three append-only projections:

1. `broker_economic_ledger_runs` stores scope, reducer version, input manifest/watermark, result JSON, and result digest;
2. `broker_economic_ledger_entries` stores balanced lines keyed by run, source activity, transaction, commodity, and line
   number;
3. `broker_economic_reconciliations` stores the two run IDs, fresh broker snapshot digest, exact deltas, residuals, and
   admissibility.

There is no mutable ledger cursor, approval row, order path, queue, or second account-activity table. A run and all of
its entries commit atomically after pure reduction succeeds. Failed runs write no partial projection. PostgreSQL rejects
update/delete/truncate, verifies canonical JSON hashes, and independently checks contiguous entry lines and per-
transaction commodity balance. Rebuild creates a new versioned run; it never rewrites an old proof.

## Replay And Publication

The deterministic replay CLI is read-only until publication:

1. lock no source rows and read one repeatable-read snapshot;
2. require the completed REST cursor and build the ordered manifest;
3. run both reducers in memory;
4. validate accounting identities and exact differential equality;
5. optionally fetch a read-only broker snapshot and calculate broker deltas;
6. print the complete report in dry-run mode;
7. publish only with an explicit confirmation token, in one database transaction, if the source watermark is unchanged.

Re-running the same reducer version and input digest returns the existing immutable run. A different result for the same
identity is a hard contradiction.

## Status And Capital Boundary

Slice 8 exposes freshness, input watermark, reducer versions, admissibility, and all residual counts in the trading
status response. It does not by itself enable entry or promotion. Slice 10 will make fresh zero-unexplained-delta parity
blocking for risk increase while leaving service health and reduce-only recovery available.

The existing runtime ledger remains visible as a legacy decision-lineage projection until Slice 9 completes repair. It
is never silently relabeled as the broker-economic ledger.

## Delivery Sequence

To keep review and rollback small, Slice 8 is delivered as three production changes:

1. pure input contract, canonical journal reducer, independent state reducer, differential checker, and golden/property
   tests;
2. minimal append-only CNPG persistence plus dry-run-first replay/publication CLI;
3. fresh broker snapshot reconciliation, status surface, GitOps schedule, and production replay proof.

Each change is independently useful and removable. No framework or generic accounting DSL is introduced.

## Required Tests

- balanced entries for every commodity and every supported activity;
- partial fills, long and short reductions, side flips, and full round trips;
- USD fees, regulatory fees, crypto asset fees, deposits, withdrawals, journals, dividends, and interest;
- splits, symbol changes, corrections, correction chains, missing predecessors, and cycles;
- duplicate-identical and duplicate-contradictory source identities;
- shuffled input, restart from serialized state, repeated replay, and digest determinism;
- randomized differential fill sequences with no NaN, infinity, sign flip, or unbalanced counterexample;
- database hash, immutability, transaction-balance, stale-watermark, and concurrent-publication races;
- broker snapshot mismatch, stale mark, unsupported residual, incomplete cursor, and unknown activity type;
- golden fixtures derived from documented Alpaca shapes with no production account values embedded in source control.

## Production Proof

Slice 8 is complete only when an exact deployed image:

- replays the full completed paper-account REST activity history from the 2016 cursor boundary;
- publishes two independently versioned runs with the same nonempty manifest digest;
- reports every journal transaction balanced and zero canonical/independent differential;
- reconciles current flat broker positions, open orders, cash, and equity at a fresh snapshot or classifies every timing
  delta;
- repeats after process restart with identical result and entry digests;
- proves one injected source contradiction and one unsupported type fail closed without a partial run;
- records source commit, image digest, Argo revision, migration, cursor watermark, run IDs, digests, and residuals in the
  append-only Slice 8 evidence bundle.

This proof establishes deterministic broker-economic reconstruction. It does not establish strategy profitability,
TigerBeetle parity, decision lineage completeness, paper promotion, or live-capital authority.
