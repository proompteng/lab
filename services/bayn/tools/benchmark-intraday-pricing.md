# Intraday execution hot-path audit

The [streaming worker](../src/market-data/streaming/market-projection-worker.ts) incorporates completed bars and
quotes; the account owner wakes and [evaluates the entry](../src/observe-composition/entry-observation.ts) against
the original cut. [Entry planning](../src/observe-composition/decision-builder.ts) reconciles, then samples a new
quote-only cut. Intraday alpha still [anchors its limit to the completed bar](../src/jev/runtime.ts); the executable
quote gates stop and target eligibility. The [intent calculator](../src/execution/intent-pricing.ts) rounds the
collar inward. Mutation admission records a durable start before broker I/O. The broker request retains native
protection terms; follow-up [protection](../src/observe-composition/position-protection-interpreter.ts) and
[reconciliation](../src/db/reconciliation.ts) still require their original quote, accounting and settlement proofs.

- **Quote-only work:** The projection compacted away bars and trades only after looking them up for each symbol.
  `ENTRY_PRICING` and `LIQUIDATION` now skip those history reads. They still apply the original source, partition,
  receipt-time and replay checks. Full signal cuts still select and verify bar and trade evidence.
- **Submit containment:** Admission ranked every historical mutation before excluding terminal intents. It now
  excludes terminal and current intents before ranking, using the existing mutation index. It still examines the
  latest outcome of every remaining mutation, including cancels, under the same writer fence. There is no migration.
- **Feed handoff:** The signal and execution cuts bind the same universe, feed, delay class and source topics,
  both before order planning and when validating durable decisions. Dedicated entry pricing rejects a stale or
  future quote at the pricing cut using the existing age limit. This does not extend the later risk deadline.

Offline cutover fixtures accept a complete SIP quote cut for QQQ and SMH at the same observation time as IEX,
reject retained IEX evidence in the SIP cut, and reject pairing an independently valid SIP pricing cut with an
IEX signal. The fixtures use a two-symbol SIP universe, not the full 73-symbol shadow; the snapshot verifier still
caps universes at 64 and the native raw consumer is still IEX for equities. Leave production config and subscriptions
unchanged. The [SIP shadow runbook](../../../docs/bayn/consolidated-sip-shadow-rollout.md)
defines the separate entitlement, parity, and rollout gates. No live cutover, fill improvement, or achievement of
the B0 **< 2.5 bp** round-trip budget is established here.

## Quote projection: local before and after

Build the baseline modules at `01534e8f50ffbd2e261f331608ed15d497affe11` before applying the change, then build and run
the candidate against those bundles. Requires the locked Bun and Node toolchain. The fixture uses 389 completed
minute bars per symbol. Both implementations receive the same projection and must produce identical serialized
snapshots, including their hashes. Four warmup and 12 measured rounds alternate order, each with 500 reads per
revision. Each sample includes projection compaction and snapshot construction, but not Kafka, worker messaging,
signal evaluation, PostgreSQL or broker I/O.

```sh
scratch=$(mktemp -d)
# Baseline revision:
bun build services/bayn/src/market-data/streaming/{query-cut,snapshot}.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka --outdir="$scratch/baseline"
# Candidate revision, reusing the same scratch directory:
bun build services/bayn/tools/benchmark-intraday-pricing.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka --outfile="$scratch/benchmark.mjs"
node "$scratch/benchmark.mjs" "$scratch/baseline"
rm -r "$scratch"
```

Node 24.11.1, Bun 1.4.2 bundler, Linux x64. Median of round means, milliseconds per read:

| Fixture                 | Baseline | Candidate |
| ----------------------- | -------: | --------: |
| QQQ + SMH entry pricing |    1.152 |     0.714 |
| SMH liquidation pricing |    0.891 |     0.649 |

## Submit containment: local before and after

On isolated PostgreSQL 18.6 with JIT off, compare the `otherUnresolved` fragments in
[`start.ts`](../src/execution/mutations/postgres/start.ts) at the same two revisions. Use the intent primary key,
mutation-event primary key, foreign key and unique indexes from the existing schema. Seed 2,000 (then 20,000)
terminal intents plus two acknowledged intents, with `SUBMIT_STARTED` and `SUBMIT_ACCEPTED` on each. After `ANALYZE`,
prepare each fragment as `SELECT EXISTS (...)` with the tested intent ID bound to `$1`, and check that both return
`false` for a new intent. Use one `REPEATABLE READ READ ONLY` transaction and alternate the order of
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) EXECUTE ...` across 20 pairs. Discard the first four pairs.

| Terminal intents | Mutation rows ranked (before → after) | Baseline median SQL ms | Candidate median SQL ms |
| ---------------: | ------------------------------------: | ---------------------: | ----------------------: |
|            2,000 |                             4,004 → 4 |                  4.633 |                   0.121 |
|           20,000 |                            40,004 → 4 |                 64.999 |                   1.183 |

PostgreSQL still scans the intents in these plans; it reads mutation rows through the existing index for the two
nonterminal intents. These timings measure the SQL predicate only, not writer-fence waits, the admission
transaction, or the broker. The PostgreSQL admission regression separately checks that an unresolved nonterminal
submit or cancel still blocks, a resolved latest submit is not blocked by its earlier start, and no test attempt
adds a durable mutation.
