# Forward-performance cycle identity benchmark

The execution-quality report previously searched the complete cycle array for
every execution. It now indexes completed cycle IDs once per report call. An ID
still matches when **any** duplicate cycle has state `COMPLETED`; neither the
first nor last duplicate can override that condition. The index is not reused
between calls and does not grant trading authority.

The lookup changes from O(executions × cycles) to O(cycles + executions), with
O(distinct completed cycles) temporary Set entries. Report hashing, ordering,
accounting calculations and validation are unchanged.

## Reproduce

In a clean checkout of baseline `83cfc75daf0c13ba2d613f33fb69bcd8a5dbdbe5`,
with dependencies installed:

```sh
bun build services/bayn/src/forward-performance/report.ts --target=node --outfile=/tmp/forward-report-baseline.mjs
```

Then, in a checkout containing the candidate, using that same baseline artifact:

```sh
bun build services/bayn/tools/benchmark-forward-performance.ts --target=node --outfile=/tmp/forward-report-benchmark.mjs
node /tmp/forward-report-benchmark.mjs /tmp/forward-report-baseline.mjs
```

This is offline synthetic data, not recorded trading evidence. Fixture creation
is outside the timed region. Each timed call builds the complete report, including
execution evidence, receipt and report hashing. The fixture has exact completed
fills but intentionally unavailable position history and market-volume evidence;
it does not demonstrate profitability or complete economic evidence.

Before timing, 24 comparisons assert exact report or typed-error equality across
account and generation scopes, reordered inputs, duplicate/missing/non-completed
cycle IDs, invalid execution identity, absent intent, unverified decisions and
canonical-hash failure. Every timed sample also checks complete report equality.
There are three warmups and seven alternating baseline/candidate samples. The
small case uses twenty calls per sample; larger cases use one. CPU time is emitted
alongside elapsed time. Timing thresholds are deliberately not CI assertions.

## Observed result

Node 24.11.1, Bun 1.4.2 bundler, Linux x64, 2026-10-25. Full-report median elapsed
milliseconds from one run:

| Cycles | Executions | Baseline | Candidate | Ratio |
| --- | ---: | ---: | ---: | ---: |
| 10 completed | 10 | 0.621 | 0.546 | 1.14× |
| 1,000 completed | 1,000 | 51.232 | 47.275 | 1.08× |
| 5,000 completed | 5,000 | 309.030 | 261.389 | 1.18× |
| 10,000 completed | 10,000 | 724.005 | 550.954 | 1.31× |
| 1 completed + 9,999 no-trade | 1 | 4.477 | 4.477 | 1.00× |

An earlier independent run measured 1.22× and 1.30× at 5,000 and 10,000 executions.
The ten-execution case varied from 0.936× to 1.14×, so there is no claimed small-
report improvement. Sparse reports still scan cycles once and do not benefit
materially. The additional Set stores references to existing strings, not copied
cycle records; memory allocation was not separately measured.

The deterministic regression counts 100 cycle-ID reads for 100 executions instead
of 5,050 on the baseline. All report hashes and output values were identical.
