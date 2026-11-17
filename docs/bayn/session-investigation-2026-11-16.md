# Bayn session investigation — November 16, 2026

## Session results

Read-only evidence collected November 16 at approximately 21:55–22:02 UTC covers the rolling fourteen-day
window and ten trading sessions, November 3–16. November 2 executions precede this cut. Deployed source:
`178edec0d2f4392aa3e12a2223031c78137a0015`; trading image:
`sha256:e7038c0e6d28cc819d4ea86bed7f5b1c6f5dfd99376479d27e96311dd9cfb543`.

| Session     | Accounting transactions | Gross realized USD | Posted broker fees USD |              Known subtotal USD |
| ----------- | ----------------------: | -----------------: | ---------------------: | ------------------------------: |
| November 3  |                      37 |              14.49 |                   2.33 |                           12.16 |
| November 4  |                      74 |              97.60 |                   5.41 |                           92.19 |
| November 5  |                      10 |              10.66 |                   0.79 |                            9.87 |
| November 6  |                      83 |              30.97 |                   6.17 |                           24.80 |
| November 9  |                     135 |              62.45 |                  10.43 |                           52.02 |
| November 10 |                      75 |             -10.23 |                   5.73 |                          -15.96 |
| November 11 |                     150 |              41.58 |                  10.51 |                           31.07 |
| November 12 |                     196 |              75.88 |                  14.37 |                           61.51 |
| November 13 |                     174 |            -179.45 |                  13.61 |                         -193.06 |
| November 16 |                     142 |            -111.92 |            Unavailable |             -111.92 before fees |
| Total       |                   1,076 |              32.03 |            69.35 known | -37.32 before outstanding costs |

Transactions include partial fills and are not independent trades. Broker-fee expense is the magnitude of
negative posted `net_amount_micros`; fill-level fees were zero. November 16 broker fees, inference and operating
costs remain incomplete. This subtotal is not all-in profit. No immutable forward-performance receipt exists
for the period. Cumulative ACCOUNT_HISTORY status gauges include earlier strategies.

The cut contains exactly 1,076 fills, accounting transactions and accounting receipts. The latest position
snapshot was flat, accounting EXACT and unresolved mutations zero. All 3,913 November 16 reconciliations were
EXACT at the cut. Existing PAPER sandbox authority was retained. These establish accounting state, not edge.

The cycle census contains 3,613 attempts: 1,823 NO_TRADE, 320 COMPLETED, 1,461 BLOCKED_UNUSED_ENTRY_EXPIRED and
nine BLOCKED_RISK. Every expired attempt had null snapshot and decision identities. These 40.44% of attempts
expired before snapshot/decision construction; they are neither submitted orders nor a downtime percentage.
They do not establish missed profitable opportunities. Controller observations since 14:00 UTC included 686
market-data failures and two context failures. The latest broker-read failure reported an observation
unavailable or invalidated by a mutation. Counts represent attempts, not elapsed availability.

## High-priority operational findings

Both execution-controller replicas were OOMKilled three times after the November 15 rollout; latest
terminations were November 16 20:19:03 and 20:55:42 UTC. Their memory limit was 1 GiB. One read-only sample
found only the controller Node process, about 824 MiB RSS and 765 MiB anonymous cgroup memory. These are runtime
failures separate from the diagnostic-report OOM documented on November 13.

The containment assigns 192 MiB old space and 16 MiB semi-space to each Node isolate. The controller, market
projection and reused decision worker share the container. A probe in the immutable ARM64 image measured
240 MiB heap limits for the main isolate and two workers: 720 MiB total. Against the historical 1 GiB container
limit, that left a nominal 304 MiB outside those V8 allowances. The merged controller configuration requests
1 GiB and has a 2 GiB limit, giving a nominal 1,328 MiB outside the same allowances. These remainders are budget
arithmetic, not observed free memory or a process RSS bound.

Eighty-three decision/projection/worker tests passed under these flags. This bounds V8 allowances;
it does not bound external buffers or establish that the observed OOM cause is fully resolved. Live session
load remains necessary for acceptance.

The Effect OTLP HTTP exporter also lacked a request deadline. Its batch threshold does not limit concurrent
exports, so a collector hanging on response headers or body could retain export fibers. Each HTTP attempt now
has a three-second deadline including body consumption. Regression tests observe connection cancellation,
retry of the same batch and a subsequent healthy export. This repairs a reproduced failure path; the retained
evidence does not establish that telemetry caused today's OOMs.

The published x64 report for retained generation
`5fcc26b3a8aeaa80033862db9dbb265b79e0a2b4e67c87a336d1a192af4cdf0f` completed in 24,029 ms wall time,
22,667 ms measured work, at 1,556,296 KiB peak RSS. The same packaged command on ARM64 exceeded its unchanged
30-second budget, exited in 32,522 ms with zero stdout and reported 2,325,388 KiB peak RSS. Both ran in separately
budgeted 6 GiB status workloads, outside controllers, without persisting a receipt. These are single-cut checks,
not a latency distribution.

The newest main publication, GitHub run `43795736503`, failed before replay observer validation while fetching
pinned Bun 1.4.2 through GitHub's unauthenticated asset API: HTTP 403 after an initial certificate failure.
The repair uses versioned public release downloads with the same archive names, fixed-output hashes and version.
All four platform archives were downloaded and existing SHA-256 and ZIP integrity verified. Replay validation
remains required.

The protective execution reader now retains the latest parent and native child orders under the same
account/generation/reconciliation cut. The verifier checks sealed protection terms, actual child identities,
partial quantities, shared parent inventory, prices, timestamps, fees and accounting allocation. Protective
fills remain separate from parent BUY executions. Parent-only report golden hashes remain unchanged.
Conditional protective exits retain PROTECTIVE_REFERENCE_PRICE_EVIDENCE_GAP rather than an invented
unconditional implementation-shortfall benchmark. PostgreSQL integration and packaged runtime acceptance
remain separate release gates.

Cost completeness retains the requirements in [the November 13 investigation](system-investigation-2026-11-13.md).
Missing invoices, unsettled fee cuts and conditional references cannot be repaired by inventing zeros or
weakening qualification. Natural-session stability, complete costs and all-in profitability remain distinct
from the source repairs and synthetic regressions.

## November 17 release checks and ARM follow-up

The repairs in #15959 and the decision JSON transport in #15961 were published through the normal image cohort
and GitOps path. Source `a662aa567f740144f9c0ca75869810795ac5788f`, publication `43985005179`, was activated by
Argo revision `1c3602dd9bfdef72c0ec95dccd442f83bdf30565`. The native activation hook succeeded. Fresh controller
pass 287016 and status readback retained PAPER/CLEAR, EXACT reconciliation through the latest mutation, flat
positions, zero unresolved mutations and exact accounting. The concurrent recovery change #15960 retained the
192/16 MiB isolate flags and increased controller memory request/limit to 1/2 GiB. Both replicas had zero restarts
at the initial check; the market was closed, so full-session memory stability remains unproven.

The same retained 196-transaction report completed on packaged x64 in 23,408 ms wall time, with 22,084 ms measured
work and 1,538,828 KiB peak RSS. Packaged ARM still failed the original 30-second execution/capture deadline:
32,300 ms wall time, 28,901 ms measured work, 2,390,800 KiB peak RSS and zero stdout. The resource timer excludes
runtime acquisition and outer shutdown. A longer diagnostic run succeeded with identical financial totals and
receipt hash `c4b8d3447f3ed3131b6355dadf70f6d1863b2ab9a1124a9175d74ba5fdcb0f16`; it is not deadline acceptance.
The ClickHouse privilege warning during the interrupted run came from the adapter's secondary cancellation
command; it does not establish the cause of the missed deadline. No privileges or deadline were changed.

A packaged task trace placed the first decision job at 10,333 ms and the last of 83 at 21,941 ms after child
startup. Archive and expense work followed. Market-volume bindings transferred 61.7 MiB across 60 rows before
those workers started. Their database capture can finish after the decision cursor closes while outstanding
verification jobs continue, preserving the same transaction, bounded lookahead and ordered projection.

Bounded read-only PostgreSQL plans also found a repeated decision-JSON subplan in unfinished-cycle counting.
Checking the existing exact intent binding first and rejecting a null decision hash before that subplan reduced
the query from 1,551.4 to 56.7 ms with identical 127-row membership. Correlating every decision lookup regressed
terminal-cycle reads and was rejected. Larger young heaps did not meet the report deadline; array serialization
and lazy-supervisor prototypes also lacked a useful measured improvement and were discarded. Packaged ARM
acceptance at the unchanged deadline remains required after the capture-scheduling repair is released.

## Reproduction

Use a bounded read-only transaction against the financial database. Never run report commands in execution
controller pods. Do not pass `--persist-receipt` for provisional diagnostics.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT (occurred_at AT TIME ZONE 'America/New_York')::date AS session_date,
       count(*) AS transactions,
       sum(realized_pnl_micros) / 1000000.0 AS gross_realized_usd,
       sum(fee_micros) / 1000000.0 AS fill_fees_usd
FROM accounting_transactions
WHERE occurred_at >= now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
SELECT fee_date, sum(net_amount_micros) / 1000000.0 AS broker_fee_net_usd,
       count(*) FILTER (WHERE posted_at IS NULL) AS unposted_records
FROM broker_fee_accounting WHERE fee_date BETWEEN '2026-11-03' AND '2026-11-16'
GROUP BY 1 ORDER BY 1;
COMMIT;
```

The controller observation index begins with controller_key; constrain it before a time range. A global
fourteen-day JSON aggregation exceeded its 30-second statement budget. Indexed hourly sampling completed in
about 1.5 seconds but establishes examples rather than a complete failure rate. The 2,669 pending inference
source rows predate October 5 coverage and are not a current backlog. Retained UNKNOWN_USAGE quote prefixes
must be resolved through native source-matched coverage rather than summed as current expense.
