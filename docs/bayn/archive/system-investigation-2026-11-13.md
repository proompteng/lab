# BAYN performance, reliability and profitability investigation — 2026-11-13

## Conclusion

The inspected PAPER account is executing and reconciling exactly, but the evidence does not establish positive
all-in expectancy. The current generation lost $171.79 gross at the retained report cut. Its 56% episode win rate
does not offset losses that average more than twice the average win. Raising throughput or deploying more capital
on this evidence would be an unsupported profitability claim.

This investigation fixes one independently reproduced reporting defect: the execution-quality reader selected
protective bracket children in place of their entry parent. It does not change strategy judgments, authority,
fees, order protection, deadlines, accounting, or qualification requirements. Other findings below retain their
own acceptance criteria; a reporting repair does not resolve them.

## Scope and provenance

Evidence was collected directly through agents-shell-tunnel, without delegated workers, on November 13,
approximately 18:29–18:44 UTC. Source and deployment matched:

- Source: `0d31bbbbecaed54a9336d40d5e761777737f9ed3`.
- Runtime image: `registry.ide-newton.ts.net/lab/bayn@sha256:ce27d3553824d051139f73ae6931afa9a0aa1a23b3d1735cdcd259ee2d7ed381`.
- Current generation: `5e7b236defeba4fb5f0bf2cf68f9aae61586389a5c3a660051a811e9262fd635`.
- Strategy contract: `bayn.jev.protocol.v40`; authority maximum/effective PAPER, kill CLEAR; broker environment sandbox.
- Generation activation: 08:23:14.294019 UTC, activation source `c9e4616a8e66fae93d124cb4ff9fe9fcb2c1db43`.
- Report window: 13:00:00 through 18:32:35.888 UTC. Inference source cut: 18:32:46.825 UTC.
- Read-only report hash: `237cbedda65272d8fef48a5093f85425e6c66ed9ef28e704c20e37a5340d14d5`.
- Financial receipt hash: `1d4c0d929273a37cdc139c192ffb5c3934a01b0941bc9e31dc351cdc3a84f19d`.

The initial cloud checkout and shared remote checkout were older than deployed main. They were not treated as
deployment evidence. Focused context was retrieved again with the matching current commit. Historical memory
was used only for navigation.

The evidence paths were Kubernetes pod/image readback; PostgreSQL read-only bounded statements; Mimir queries;
Loki log queries; Tempo search; and the deployed read-only forward-performance command. No broker mutation,
paid inference, capital activation, public-table update, or production configuration change was requested by the
investigation. A diagnostic report did cause a controller OOM restart, documented below.

This is a bounded engineering and empirical investigation, not exhaustive proof over every failure mode or
market regime. The active generation, source clocks and sample size prevent a final profitability verdict.
Private raw payloads, credentials and account identifiers are omitted.

## Economic result

| Measure at the retained report cut |       Observed result | Interpretation                                               |
| ---------------------------------- | --------------------: | ------------------------------------------------------------ |
| Starting capital                   |            $94,518.12 | Generation report denominator                                |
| Gross realized P&L                 |              -$171.79 | Includes realized closes, excludes unknown operating charges |
| Accounting execution transactions  |                   118 | Not 118 independent trades                                   |
| Realized close transactions        |                    57 | Partial executions are not independent samples               |
| Completed position episodes        |                    25 | 14 gross winners, 11 gross losers                            |
| Gross episode win rate             |                   56% | Descriptive, one partial trading session                     |
| Episode winning P&L                |               $240.11 | Episode aggregation differs from fill-level gains            |
| Episode losing P&L                 |              -$411.90 | Average loss $37.45 versus average win $17.15                |
| Episode gross profit factor        |                 0.583 | $240.11 / $411.90; below break-even                          |
| Open episodes                      |                     1 | Window remains financially incomplete                        |
| Metered inference estimate         |          $0.110874288 | Frozen tariff estimate, not invoice reconciliation           |
| Operating-cost coverage            |            INCOMPLETE | Full net profit and return remain null                       |
| Financial qualification            | INSUFFICIENT_EVIDENCE | Profitability remains UNDETERMINED                           |

Do not subtract the inference estimate and label the result fully net. Data, compute, storage and other required
operating-cost evidence are absent. The report does not have an attached system assessment. The database contained
zero `system_assessment_receipts` and seven operational assessment receipts; those are different evidence classes.

The report's inference subtotal has 381 claimed requests, no coverage gaps, complete metered coverage and an exact
session ledger. Raw quote rows also contain earlier UNKNOWN_USAGE snapshots. Summing or counting those rows as
current costs would misclassify retained history; use the report's source-matched coverage and quote identities.
Separately, the research worker metric reported 69 unpriced attempts. That metric is not the current generation's
metered coverage.

| Symbol | Completed episodes | Gross winners / losers | Gross episode P&L | Worst episode |
| ------ | -----------------: | ---------------------: | ----------------: | ------------: |
| AAPL   |                  5 |                  1 / 4 |           -$30.64 |       -$22.14 |
| AMZN   |                  1 |                  0 / 1 |           -$39.05 |       -$39.05 |
| IWM    |                  7 |                  7 / 0 |           +$67.14 |        +$0.90 |
| NVDA   |                 11 |                  5 / 6 |          -$177.34 |       -$94.50 |
| QQQ    |                  1 |                  1 / 0 |            +$8.10 |        +$8.10 |

These are diagnostics, not grounds to exclude NVDA or promote IWM. Those choices would be selected on the same
small evaluation sample. The proper next comparison freezes a hypothesis, measures both retained and alternative
policies on matched arrivals and costs, and evaluates on untouched later sessions.

An earlier generation (`5fcc26…cdf0f`, November 12) had 196 accounting transactions and +$75.88 gross realized
P&L in a direct ledger query. It is a separate generation, not a control group or evidence of repeatable profit.

Account-history gauges around 18:30 UTC showed approximately -$1.2k gross realized P&L and $4,437.08 execution
fees, yielding approximately -$5.6k after execution fees before operating costs. Replicas sampled different
projection instants. These cumulative gauges span retired strategies; neither summing replicas nor attributing
the history to v40 is valid.

## Verified defect and repair

### Parent and protective child order identity

The report's order query chose `DISTINCT ON (intent_id)` by descending broker source sequence. Broker bracket
children retain their entry intent, so the latest child cancellation could replace the filled BUY parent.

One inspected entry had a filled parent with 52 shares and two SELL children with zero fills. The parent's source
sequence was 259367; later child cancellation sequences were 259382 and 259383. The reader selected a canceled
child and then compared it with a FILLED BUY intent. This explains false terminal-order and fill-identity failures
without implying ledger corruption.

The repaired production query restricts selection to `parent_broker_order_id IS NULL` before choosing the latest
observation. Generation, account, completed-cycle, reconciliation-cut, ordering and full downstream identity
validation remain in place. Fill and accounting rows are not removed.

A read-only same-snapshot comparison of retained order rows, bounded to the report's source clock, measured:

| Query       | Selected intents | Child orders incorrectly selected | Terminal identity matches |
| ----------- | ---------------: | --------------------------------: | ------------------------: |
| Original    |               54 |                                37 |                        17 |
| Parent-only |               54 |                                 0 |                        54 |

This later SQL snapshot is not the original report transaction: mutable lifecycle rows can have advanced. These
54 rows therefore must not be equated to the report's 50 execution-evidence inputs. The two SQL alternatives
were compared inside one read-only transaction.

The PostgreSQL regression uses the real production query. It covers later canceled and filled children, a
child-only intent, a standalone SELL parent, future observations beyond the source cut, the newest valid parent
observation, and both account and generation scopes. It failed before the predicate and passed afterward.
It does not weaken financial qualification or manufacture protective-exit execution evidence.

## Remaining findings and required completion evidence

| Priority | Finding                                                                                                                                                         | Action and acceptance criterion                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Protective exit fills are still represented under the original BUY intent. In the inspected generation, 16 SELL accounting transactions referenced BUY intents. | Add explicit source-bound protective execution evidence, verifying the parent/child relationship, actual fill identity, protection terms and accounting allocation. Test partial child fills, cancel/fill races and tampered linkage. Preserve current failures until that evidence exists.                |
| P1       | Current report contains genuine open-window, cash-yield and cost gaps as well as the repaired order-selection defect.                                           | Close the evidence window naturally, retain exact cash and fee posting cuts, attach complete operating-cost evidence, and rerun. Do not delete blocked cycles, discard loss history or change sufficient-evidence rules to obtain a PASS.                                                                  |
| P1       | Prior generation report misses the 30-second budget.                                                                                                            | Continue existing issue #15928. Benchmark complete fixed cuts, not only hashing helpers; profile SQL, reproduction and ledger phases; require canonical report parity and bounded memory.                                                                                                                  |
| P1       | Report execution can exhaust the trading controller's memory budget.                                                                                            | Keep report processes outside execution-controller pods. Size an isolated reporting runtime using measured peak memory and cancellation cleanup. Verify no controller restart during report load. No memory or CPU limit was raised on this investigation's evidence alone.                                |
| P2       | Many unused entry windows expire.                                                                                                                               | Trace exclusions, source availability, dispatch, selection and submission separately before changing throughput. Prove improved eligible-candidate handoff latency on matched source arrivals with unchanged risk and expiry checks. Expiration itself does not establish a missed profitable opportunity. |
| P2       | Observed holding durations exceed 15 minutes in four completed episodes.                                                                                        | Trace maximumHoldDueAt through reconciliation, close intent, submit and broker fill clocks; distinguish decision timing from fill completion. Set and test an exit-tail SLO. Do not claim the configured hold is a guaranteed broker-fill deadline.                                                        |
| P2       | Loss magnitude outweighs the observed win frequency.                                                                                                            | Pre-register an alternative based on a specific loss mechanism, retain the unchanged strategy control, and evaluate on untouched later sessions with execution and operating costs. Retain adverse outcomes and all attempted variants.                                                                    |
| P2       | Research cost coverage remains incomplete despite complete current-generation metering.                                                                         | Resolve the 69 unpriced research attempts from retained provider evidence or leave explicit uncertainty; reconcile actual invoices before claiming all-in profitability. Do not invent zero costs.                                                                                                         |
| P2       | Raw arrival history dominates storage.                                                                                                                          | Measure growth, required replay horizon, archive ownership and restore behavior before designing retention. Preserve immutable financial and source evidence. No cleanup or retention deletion is authorized by a size observation alone.                                                                  |
| P2       | Sparse candidate bars and occasional stale candidate quotes limit opportunities.                                                                                | Attribute exclusion rates by symbol/session and source, then evaluate a suitable entitled feed or candidate universe on independent evidence. Keep missing-minute and freshness guards. Transport health does not imply complete candidate evidence.                                                       |

The remaining work is intentionally not marked fixed. Profitability, storage policy and protective execution
contracts require evidence beyond a parent-order reader correction.

The remaining acceptance criteria are tracked in [#15936](https://github.com/proompteng/lab/issues/15936),
with the existing full-report performance work in [#15928](https://github.com/proompteng/lab/issues/15928).

### Entry funnel

At approximately 18:30 UTC, a trailing 24-hour database query found 237 BLOCKED_UNUSED_ENTRY_EXPIRED,
80 NO_TRADE, 55 COMPLETED and one ACTIVE cycle. Those 373 cycles span generation changes.
About 63.5% were blocked unused; this is not an inference-failure rate.

For cycles created since the current activation, the later bounded query found 122 blocked unused, 52 no-trade,
33 completed and one active cycle. All 381 current-generation evaluation resolutions inspected were RECORDED.
That status means durable resolution; it does not mean an accepted setup or submitted order.

The latest 2,000 controller observations, sampled separately, contained 1,652 JEV_POSITION_HELD,
114 BROKER_OBSERVATION_PENDING and 74 POST_MUTATION_RECONCILIATION observations, plus other outcomes.
They are state samples with unequal spacing, not elapsed-time percentages or independent entry attempts.

### Exit timing

Completed episode holding durations above 900,000 ms were IWM 925,672 ms, NVDA 930,810 ms,
AAPL 951,192 ms and another NVDA episode 916,974 ms. These are first-fill-to-flat durations.
The evidence does not by itself identify which part of the exit path caused each excess.

### Resource and report budget observations

An initial invocation of the deployed read-only report inside the execution controller exited 137 and caused
an OOMKilled restart at 18:31:39 UTC. The pod had a 1 GiB memory limit. This diagnostic caused a real interruption;
it must not be presented as a spontaneous production outage or a successful report run.

The same current-generation command subsequently succeeded in a 4 GiB API pod. That single success establishes
neither a general memory bound nor a performance improvement. Further report diagnostics were kept outside the
controller. Subsequent source-bound controller status showed position management had resumed, and reconciliation
was EXACT at 18:41:48.852 UTC with the original PAPER authority intact.

A separate prior-generation invocation used `--deadline-ms 30000`. It exited nonzero after 31,503.67 ms,
published zero stdout bytes and reported ForwardPerformanceDeadlineExceeded. The supervisor correctly discarded
incomplete capture. Cleanup time is outside a strict 30-second exit guarantee as documented by the command;
the failed completion budget remains an unresolved performance requirement.

The database was about 261 GB; native_arrival_chunks occupied about 240 GB. Approximate relation totals included
6.35 GB of shadow decisions, 5.31 GB of controller observations and 4.56 GB of candidate observations.
These are allocated relation sizes, not logical live payload sizes or a measured daily growth rate.

At a primary read, the synchronous standby was streaming in quorum state with about 5.6 ms replay lag.
This one sample does not characterize p99 replication or WAL latency.

Mimir's ten-minute CPU samples were approximately 0.46–0.47 cores per controller and 0.10–0.24 cores per database.
Controller working sets before the diagnostic were roughly 0.53 and 0.75 GB. Pod-level throttled-period ratios
were about 3.4% for controllers. Valkey pod aggregation showed larger ratios, but that mixes containers and does
not establish throttling of the main Valkey server; inspect container-level series before changing limits.

### Observability and source quality

- Loki returned three autonomous-cycle failure records between 17:00 and 18:30 UTC for unavailable or
  mutation-invalidated broker observations. This interval precedes the diagnostic OOM. The query limit was 100;
  three returned records is the bounded query result, not an unlimited historical count.
- BaynCycleFailed and BaynResearchCostCoverageIncomplete were firing in the sampled Mimir response.
  Both API replicas exposed forward_performance_receipt_available=0 and runtime_ready=0 while their Kubernetes
  probes passed. Trading readiness, qualification and process health must remain distinct.
- Tempo yielded native controller and broker-observation traces. Some broker-capture root traces were about
  34 seconds, but contained Restate scheduling time; they are not 34-second broker HTTP calls.
- The 8,000-line bounded controller log sample included 78 diagnostic threshold warnings. These are selected
  warnings, not an unbiased latency distribution. Long observed stages included reconciliation persistence,
  writer-fence waits and broker reads. Phase correlation is needed before attributing an entry expiry.
- One projection sample had bootstrap complete, zero queued records and zero reported lag across partitions.
  Candidate bars were nevertheless sparse: CRDO 17/30, LITE 19/30 and MRVL 23/30. Other candidates had complete
  windows, and one WDC quote-age sample exceeded ten seconds. Zero Kafka lag is not a complete input contract.
- Required benchmark, malformed input, source clock, uniqueness and stale-evidence checks were not relaxed.

## Reproduction and validation

Use the exact generation above with the documented read-only command in a separately budgeted runtime:

```sh
node dist/forward-performance-command.js --authority-generation <generation-hash> --deadline-ms 30000
```

Do not pass `--persist-receipt` for provisional diagnostics. The retained report remained
`receiptPersistence=NOT_CHECKED`; no receipt was appended by this investigation.

For the regression, point BAYN_TEST_POSTGRES_URL only at an isolated local database whose name ends in \_test:

```sh
bun test services/bayn/src/forward-performance/postgres/read.integration.test.ts \
  --test-name-pattern 'entry order evidence excludes'
```

Local reproduction used Bun 1.4.0 and isolated PostgreSQL 17.11; the new regression failed before the fix and passed
afterward. The repository's PostgreSQL CI uses PostgreSQL 18 and remains the version-matched integration gate.
The pinned remote runtime uses Bun 1.4.2. Full service test, type, formatting, lint and build results are recorded
in the delivery PR; a skipped integration test is not a passed database check.

No latency reduction, improved trading return, complete financial qualification or deployed repair is claimed
by the source patch alone.
