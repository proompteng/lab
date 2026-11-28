# Bayn session investigation — November 16, 2026

The [November 18 follow-up](../session-investigation-2026-11-18.md) covers the completed November 4–17 window,
reconciles broker cash and session fees, and investigates entry economics, partial native exits and inference
admission. It supersedes the partial November 17 economic cuts below while preserving their historical evidence.

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

## November 17 independent revalidation

At source `1773ae4f9d6422bf250762133cad700a0ef4b9ba`, a fresh review of #15959, #15961, #15964, #15965 and
#15966 found no production validation bypass, invented success branch or new cross-report evidence cache. The JSON
worker path still invokes the complete decision verifier; cursor capture retains its transaction, bounded lookahead
and interruption race; watermark sharing retains per-decision identity and lower-bound verification; descriptor
inspection preserves the original validation and failure details. Protective exits retain their explicit unknown
conditional-reference reason.

The final-head Bayn workflows for those five PRs succeeded. This claim concerns the applicable Bayn gates, not every
repository workflow: #15959 also had an unrelated failed Codex-devbox ARM build. For #15966, run `44020344516`
matches head `4fa40fbfd681d1124eef972256548d0c2f7621d9`; the inspected unit shard logged 2,545 passes, 1,283 skips
and zero failures, PostgreSQL shard 1 logged 278 plus six passes and zero failures, and the release gate received
successful applicable unit, PostgreSQL, ledger, archive, replay and formal results. The earlier local full-suite count
was 5,771 passes, 1,453 skips and zero failures; local skips are not executed tests.

### Updated broker fees and the retained closure defect

November 16 fees arrived after the earlier cuts. Two records totaling $11.70 were first observed at
`2026-11-17T07:56:31.047Z` and posted by `07:56:34.589046Z`, with no unposted records. The bounded read-only
November 3–16 account query still contains one account and exactly 1,076 transactions, gross realized P&L $32.03
and zero fill-level fees. Posted broker fees now total **$81.05**, giving a known subtotal of **-$49.02** before
operating and inference charges. This supersedes the earlier known subtotal, not its recorded observation time.

The source-matched native read at `08:40:38.941Z` retained generation
`5fcc26b3a8aeaa80033862db9dbb265b79e0a2b4e67c87a336d1a192af4cdf0f` and its reconciliation cutoff
`2026-11-13T08:23:10.393Z`:

| Fee session | Rows | Selected generation | Other generation | Late relative to selected cutoff |
| ----------- | ---: | ------------------- | ---------------- | -------------------------------- |
| November 12 |    2 | Yes                 | No               | No                               |
| November 13 |    2 | No                  | Yes              | Yes                              |
| November 16 |    2 | No                  | Yes              | Yes                              |

At `08:41:14.124Z`, the selected generation had 127 native incomplete cycles, all terminally blocked for unused entry
expiry. Its late accounting-transaction, unaccounted-fill and mutation counts were all zero. The unmodified reader
reported 131 because it counted all four unrelated late fee records against this generation's cutoff. The earlier
129 had the same defect with only the two November 13 fees. This defect predates the five PRs, in October 6 commit
`a4f6dcf24e3`.

The repair restricts late fee closure evidence to fees owned by or overlapping the selected generation, plus
unattributed fees on selected cycle dates. Account-history reporting still includes every late fee. All account fee
records and original/correction ledger plans remain available for independent ledger verification. No 127 blocked
cycles are removed or reclassified, and no missing cost is replaced with zero. The corrected expected closure count
is **127**, not 129 or zero. Reader regressions reproduced six failures before the repair and cover owned, shared,
other-generation, unattributed and account-wide fees, including late and pending corrections.

A fresh packaged ARM report at `08:34 UTC` completed with the original 30,000 ms command deadline in 29,357 ms wall
time, 25,905 ms measured work and 2,292,184 KiB peak RSS. Its financial counts/totals and execution-quality evidence
matched the earlier cut, but its proof and receipt comparison correctly failed on 129 versus 131. A receipt from a
fresh query is not generally immutable when relevant source evidence changes. Future before/after validation must
separately assert the corrected count and compare all other receipt fields; it must not silently accept a changed
proof or drop the whole reconciliation object. ARM headroom remains narrow; a few runs do not establish a latency
distribution or loaded service SLO.

### Standing research recovery and live limits

Native history records a reconciliation-discrepancy restriction at `07:56:35 UTC`, settlement at `08:21:58.823`,
an OBSERVE successor at `08:22:01` and PAPER activation at `08:22:03.659`. The same standing Research request was
reused. This sequence is not evidence of a new human operator request; the native grant contract has no actor field.
It also does not establish an authority bypass. The existing recovery contract explicitly permits a filled generation
to settle after a recognized temporary restriction, followed by fresh exact/flat reconciliation and ordinary grant
validation. Research requests are standing plan-bound grants; qualified one-shot requests separately carry cutoff and
expiry. The completed/expired receipt requirement must not be generalized into an unrequested profitability gate for
ordinary research recovery. No authority, kill state, risk limit or capital grant was changed during this validation.

At `08:32 UTC`, the same source/image cohort remained Synced/Healthy. Current PAPER/CLEAR generation was
`722d940e8baa628cbc188ed90e2e119702823875554e6d7def4d7f00099eaa49`, with exact reconciliation covering the latest
mutation, flat positions and zero unresolved/accounting gaps. Controller restart counts remained x64 zero and ARM one
from the recovered startup Valkey timeout. Memory events were zero; current/peak bytes were x64
328,732,672/363,683,840 and ARM 503,808,000/525,770,752 against 2 GiB limits. No recurring Valkey, OOM or fatal matches
were found between `05:41` and approximately `08:36`; three Alpaca account-header timeouts preceded one recovered
130.932-second pass gap. This closed-market interval does not prove full-session stability or an availability rate.

System-assessment and durable forward-performance receipt counts remained zero. No actual operating-cost packet path
was supplied or established in the inspected sources; this is not a claim that every private storage location was
searched. A bounded cash-cut query timed out and therefore establishes no missing-cash conclusion. Actual source
artifacts, reviewed cost allocation and sufficient closed evidence remain necessary before all-in profit qualification.

## Loss-mechanism investigation — November 17

The economic reconstruction below uses a frozen native read at `2026-11-17T18:46:28.274402Z`, with broker
occurrence cut exclusive `2026-11-17T18:40:22.724Z`. It contains 1,110 equity accounting transactions and 225
completed flat-to-flat position episodes. Every selected transaction belongs to exactly one episode; every episode
binds one cycle and generation. Inventory is flat at this cut. It is not a current broker-position assertion.
November 17 is a partial session and must remain separate from the ten completed November 3–16 sessions.

| Cohort              | Episodes | Wins / losses | Gross realized USD | Gross profit factor |
| ------------------- | -------: | ------------: | -----------------: | ------------------: |
| November 3–12       |      147 |       78 / 69 |             323.40 |               1.260 |
| November 13 and 16  |       69 |       35 / 34 |            -291.37 |               0.684 |
| November 3–16       |      216 |     113 / 103 |              32.03 |               1.015 |
| November 17 partial |        9 |         6 / 3 |             -75.36 |               0.740 |

### What explains the losses

The completed two-week cohort has $2,198.35 of winning-episode gross P&L and $2,166.32 of losing-episode gross
P&L. Its remaining gross profit is only **$0.1483 per episode**, while posted broker fees average **$0.3752 per
episode** ($81.05 / 216). This is an accounting decomposition, not a claim that every episode incurred the average
fee. Fees more than consume the small observed gross edge: the known subtotal is **-$49.02**, before operating
and inference costs. Episode-level gains/losses group partial closes together and need not equal the report's
transaction-level positive and negative close amounts; their net reconciles exactly.

The recent negative sessions also have unfavorable realized payoff asymmetry. November 13 and 16 together
average $17.99 per winner against $27.08 per loser. In the November 17 partial cut, six wins total $213.98 but
three losses total $289.34: mean win $35.66, mean loss $96.45. A high observed hit rate does not establish
positive expectancy. These are sample outcomes, not calibrated probabilities or evidence of future performance.

November 17 broker-fee records had not arrived at this cut. Combined gross through the frozen occurrence cut is
-$43.33; subtracting only the $81.05 known prior fees gives **-$124.38 before unknown November 17 fees and operating
costs**. Neither the missing fees nor missing operating expenses are replaced with zero.

Original funded plans and actual fills were independently checked for all 78 filled cycles on November 13, 16
and the partial November 17 cohort. No BUY exceeded its original maximum entry price; no filled entry quantity
exceeded its original maximum quantity. Funded target/stop arithmetic reproduced without discrepancies. The
observed losses are not explained by an entry-cap, sizing or duplicate-fill accounting error in this cohort.

### Structural judgment is not a probability of profitable execution

Current entry questions assess an observed support recovery or base breakout and whether the proposed stop
structurally invalidates that setup. Their 0.70 threshold is not the probability that the target will beat the stop.
Ranking uses the weakest required structural judgment, then modeled loss; funded eligibility requires positive
modeled target proceeds after transaction fees, not demonstrated positive expected value.

For example, one retained November 16 AAPL plan acquired $18,734.98, modeled target gain $2.234006 and modeled
stop loss $42.285077. Its target-gain/stop-loss ratio is about 0.0528. The plan satisfies the existing funding
contract; that contract does not make a low-payoff scenario an independently profitable trade.

The timestamped November 13 exploratory research note froze original-plan `G = targetNet - acquisitionCost`,
`L = acquisitionCost - stopNet` and exact bins below 0.25, 0.25–below 0.5, 0.5–below 1 and at least 1. The
below-0.25 group lost $281.64 over 16 discovery episodes. Without retuning those bins, the corresponding
November 16 group lost $96.93 over 16 episodes and the partial November 17 group lost $124.92 over four episodes.
The other 20 later episodes made $34.57 gross. This descriptive association does not establish avoided loss,
a causal threshold or deployable strategy improvement: higher-ratio bins also lost, sessions are correlated,
partial quantities matter and the protocol changed.

November 13 used v40, protocol hash `140d646d825c1f77d3c5e1f21c425680f64d99226d2c2aacca97f70b11675dcf`.
November 16–17 use v41. The version, position policy, candidate/observation universes and entry-question policy
changed; the execution model and 15-minute holding policy did not. The later eligible universe adds long/short
support and changes candidate competition. Old eligible names gained $21.81 on November 16 but lost $182.10
in the partial November 17 cut; newly eligible names lost $133.73 and then gained $106.74. Outcome-selected
symbol exclusions, a new payoff floor or relabeling structural confidence as a win probability are not validated
repairs. The note is not a native economic registration or assessment receipt. Preserve separate protocol cohorts
and prospective economic acceptance.

### A demonstrated exit stall

NVDA cycle `0e57852b693befd35afd0511a663bdda92d9b447de562568dc733ce2544dcaae` filled 98 shares near
`2026-11-13T20:57:19Z` at $162.98. Its sealed stop was $162.45 and stop limit $162.29. A protective-stop exit
was durably requested at `20:59:10.073`; cancellation was observed by `20:59:37.516`. The broker-observation
continuation then waited through `21:00:09`; the first ordinary close attempt at `21:00:15.785` encountered
`CLOSE_MARKET_DATA_UNAVAILABLE` after regular market close. Repeated attempts remained blocked, including
after the first-fill-plus-15-minute deadline at `21:12:19`.

The retained native calendar explicitly ran 13:00–22:00 UTC. Its existing reconciled-position liquidation fallback
was restricted to the last five minutes of that window. A forced-close decision appeared at `21:55:02.496`;
the final SELL was created at `21:59:55.735` and filled at `21:59:59.462` at $161.78. The episode lasted
3,760,462 ms and lost **$117.60**. A stop-limit can legitimately remain unfilled through a price gap; that fact
does not remove the demonstrated post-cancellation close stall. No counterfactual fill price or avoided-loss
amount is inferred.

The corrective boundary is an already-committed, source-verified reducing exit after protection release. An
uncommitted price trigger must not become executable from a broker mark. Exact fresh reconciliation, settled
order/mutation state, source identity, remaining signed inventory, current authority, price bounds, profit floors
and original expiry remain necessary. The recovery must not authorize an entry, invent an archive quote or use
an unknown broker state.

### A separate market-session heap failure

On November 17 at `17:59:33 UTC`, the ARM controller exited 133 with V8's
`Ineffective mark-compacts near heap limit` / `JavaScript heap out of memory`. Its main-isolate heap was near the
configured 192 MiB old-space limit. This was not a cgroup OOM: retained cgroup peak was about 811 MB against
2 GiB. Main, projection and decision isolates had different working sets; a healthy idle replica was not a valid
active-owner capacity test.

The last successful native pass before the failure completed at `17:59:20.575`; the next success completed
at `18:02:12.706`, a **172.131-second success gap**. Native inventory was flat throughout that interval and no
episode spanned it, so the crash is a demonstrated reliability defect without demonstrated realized-loss
attribution. Closed-market report checks from the earlier rollout did not establish market-session stability.

Capacity validation must exercise representative retained working sets and repeated work inside the unchanged
container budget. A nominal sum of isolate heap allowances is not an RSS bound or evidence that all retention
is bounded. Keep the capacity repair distinct from the exit-stall repair and from economic qualification.

### Evidence and limits

The frozen episode artifact SHA-256 is
`c0fb2b42efbf0cc19888dcc095827e73c3fdebc6653ca3cadc0a73b93adf3423`; its executed export SQL SHA-256 is
`cb762117348149fdd704876fa0a5019faf95fdc0defdf14ecf06536c9c1a5e14`. The original-plan independent summary
SHA-256 is `aeffbceae08a18a7fa29ea6f71b1af2a3f07954ba02465dfcb9883c4005eca4c`.
Source ingestion advanced after an earlier 32-transaction/one-open-position cut; two NVDA SELLs with broker
times `18:40:21.498` and `18:40:22.723` arrived later. Those observations are not silently mixed into the frozen
225-episode reconstruction. Current broker observation, actual operating costs, immutable qualification receipts
and prospective strategy edge remain separate evidence requirements.

### Complete exit-path attribution and repairs

All 225 frozen episodes were classified by their actual ordinary intents and native parent/child/OCO identities;
all 561 SELL fills and their net P&L reconcile exactly once. The prior completed-session cohort decomposes as follows.
These outcome-defined paths are not ex-ante strategy choices or causal alternatives.

| Exit path                                   | Episodes | Gross USD |
| ------------------------------------------- | -------: | --------: |
| Native take-profit only                     |       73 |  1,362.66 |
| Native stop-loss only                       |       40 |   -944.72 |
| Jev latched protective stop                 |       63 |   -852.45 |
| Jev maximum hold                            |       17 |    149.75 |
| Native take-profit plus protection released |       10 |     95.19 |
| Native take-profit plus Jev profit target   |        8 |    255.97 |
| Native stop plus Jev protective stop        |        2 |    -31.86 |
| Jev profit target only                      |        3 |     -2.51 |

The partial November 17 cohort has six native take-profits totaling $213.98 and three latched protective stops
totaling -$289.34. The largest NVDA loss was $120.24 against original modeled risk $179.21; its fill at $155.24
was above the sealed $154.94 stop / $154.79 limit. INTC lost $93.96 against modeled risk $136.13, filling at $53.69
above its $53.65 stop / $53.60 limit. From trigger until the closing intent that eventually filled, intervals were
50.745 and 51.831 seconds; the remaining intent-to-final-fill intervals were 4.595 and 4.430 seconds. These are
not measurements of time until the first close attempt: earlier unfilled or replanned intents must remain visible.
The intervals do not prove an additional adverse loss attributable to delay.

Exactly 19 frozen episodes exceeded 900 seconds: 17 maximum-hold exits, one native take-profit and the 62-minute
protective-stop anomaly. Maximum-hold triggers occurred 900.146–903.864 seconds after first actual entry fill.
A trigger deadline is not a guarantee that the broker fills at that instant. Shortening holding limits from the
selected losses is not a supported repair; the maximum-hold group made $149.75 gross.

The protective-exit deadline defect is independent of pricing. The recovery driver already supplied a one-second
post-mutation continuation, but both broker-observation-pending deadline branches discarded it and scheduled the
30-second financial freshness cadence. The repair honors the existing shorter hint while retaining that cadence
as an upper bound, unchanged default behavior, earlier absolute deadlines and the minimum future timer. It does
not increase the broker's allowed request rate or bypass reconciliation. Two regression cases reproduced the
one-second-to-30-second mismatch before the repair.

The archive-gap repair permits the existing fresh reconciled-position liquidation binding before the final close
window only for a fully reproduced `ProtectionReleased` target with a durable, nonfuture, non-profit exit latch.
Original entry, account, cycle, session and sealed exit-policy identities must match. A profit latch remains on its
original quote/window path: a broker mark must not create a fresh stop trigger that releases its profit floor.
Pending known protection orders, unknown orders/mutations, inexact accounting/reconciliation, stale/missing marks,
foreign or malformed targets and expired leases remain blocked. The original target expiry is not extended.

### A live short-fill decoder failure

At `18:42:16.816 UTC`, the broker accepted a new NFLX short entry. It filled 315 shares across three activities,
with provider side `sell_short`. The account's first such fill poisoned the full-history capture: the provider wire
schema accepted only `buy` and `sell`, so repeated successful HTTP 200 activity responses failed strict decoding.
The last successful cached broker observation preceded the order. Flat accounting inventory was therefore not
evidence that the actual broker had no short exposure.

A bounded read-only same-account probe at `18:56:49` established that the attached BUY target had closed all
315 shares at `18:43:36.914`; fresh broker positions were empty. No manual liquidation, cancellation or capital
change was performed. The three opening fills were 10 and 32 shares at $59.63 and 273 at $59.62; the two covers
were 231 and 84 shares at $59.57. Their gross difference is $16.17 before fees, outside the frozen 225-episode cut.

The repair defines the provider's closed activity-side vocabulary separately from the canonical order side and
maps `sell_short` to canonical SELL at normalization. Unknown sides still fail; order submission still permits only
its existing order-side vocabulary. Account, order, cumulative/leaves quantity, partial/final status, cursor,
source-content hash and complete-page/history checks remain intact. No rejected row is skipped or made retryable
to hide malformed evidence.

Before deployment, the patched native adapter completed a GET-only full capture in 4.336 seconds, retaining
1,101 orders, 2,044 fills and 405 fee records in a 3,324,692-byte validated snapshot. This did not publish an
observer result, write financial state or submit an order. Normal deployed fenced capture must still catch up the
five missing short/cover fills and their accounting exactly once.

An independent capacity candidate used 320 MiB old space and 16 MiB semi-space on both architectures:
main plus two workers each have a 368 MiB V8 limit, totaling 1,104 MiB inside the unchanged 2 GiB container limit.
The nominal 944 MiB remainder is not an RSS guarantee. The real full-history snapshot passed 300 strict
decode/hash replacements at both 192 and 320 MiB on each architecture, with stable retained checkpoints and
approximately 11.2–11.4 MiB after collection. Both settings pass that component workload; it does not reproduce
the full active controller's heap failure.

Concurrent reviewed PR #15968 supplies the final provider-side correction and execution-capacity configuration:
384 MiB old space, 16 MiB semi-space and a four-core CPU burst ceiling, preserving the existing requests and
2 GiB shared memory limit. This investigation preserves that merged implementation rather than replacing it
with the 320 MiB candidate. Its three 432 MiB V8 ceilings total 1,296 MiB, leaving a nominal 752 MiB outside
V8; this is still not an RSS bound or proof of future full-session stability. The remaining exit-recovery and
continuation repairs build on that reviewed source and require their own complete validation and live acceptance.
