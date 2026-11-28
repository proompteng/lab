# Report performance investigation — November 13, 2026

The report remains above its 30-second completion budget. This change removes repeated canonical encodings from
equality checks and retains more reproducible chart images within explicit bounds. It does not change canonical
bytes, financial qualification, source validation, receipt identity or strategy authority.

End-to-end verification also exposed that the Nix research image omitted the locally available equity-screen
command. The image now compiles and installs that bundle plus its `bayn-equity-edge-screen` wrapper, checks help
during the build, requires both artifacts in archive verification and rejects either in the trading image.

## Measured changes

Four complete retained decision documents contain 14,583,415 bytes. They were the first four complete rows of a
bounded capture, not the complete generation or a random sample. Independent clones were used for comparisons.
The sample SHA-256 is `8ac5509ee4d8de0f307f920f727d2376e09643007c69ee854c2b2862e7cbb8ca`.

| Experiment                                                      |   Baseline |  Candidate | Scope                                                                                                      |
| --------------------------------------------------------------- | ---------: | ---------: | ---------------------------------------------------------------------------------------------------------- |
| Equality, median of seven alternating samples after two warmups | 339.088 ms | 125.955 ms | Four actual documents, double canonical hash versus validated structural equality                          |
| Complete contract decode, median of five samples                | 920.679 ms | 878.251 ms | Same four documents, exact decoded-output parity and corrupt-hash rejection                                |
| Inference expense phase in separate full API runs               |  16,767 ms |  11,339 ms | Larger chart cache; source and I/O cuts differ, so this is an observation, not a controlled system speedup |

The equality helper inspects every compared property, rejects invalid canonical evidence, and has no reference
identity shortcut. Proxies defer to the original complete serializers before any reflection traps run. Actual
canonical hashing retains the original serializer and golden identities. Tests cover 2,000 generated comparisons,
key order, aliases, negative zero, null prototypes, accessors, hidden/symbol properties, sparse arrays, cycles,
invalid Unicode, non-finite values and stateful/revoked proxies.

The prior 64-image FIFO churned during inference-cost reconstruction. The replacement retains at most 1,024
entries and charges at most 16 MiB for UTF-16 string content, including keys, image hashes and images. These are
retention bounds, not a whole-process RSS guarantee. Oversized images are rendered but not retained; complete
oldest entries are evicted. Stored values are copied and frozen. Source decoding, volume scale and hashing of the
actual complete bar array still precede every lookup; the cache cannot authenticate evidence.

A trial retained 854 images containing 5,560,912 image characters. Its process peak was 712,528 KiB. The final
bounded implementation captured a complete report input in 61,958 ms with a 692,612 KiB process-lifetime peak.
Other profiled API runs took 61,472–62,741 ms. Market-volume I/O varied substantially. Do not describe the
operation-level 2.69-times equality improvement as an equivalent end-to-end speedup.

A flat-token serializer was slower (231.567 versus 169.895 ms) and was reverted. Always using JSON.stringify for
string escaping also failed to improve the sample (173.476 versus 169.364 ms) and was not applied.

## Complete financial parity

An independently frozen complete report input contains 107 cycles, 73 execution-evidence inputs, 174 generation
transactions and 1,863 account transactions. Its 2,955,747 bytes have SHA-256
`8c99cafe72db5b12a76b524104ef5f456e5c3189d68414029d72404b164dd350`.
Baseline and candidate bundles produced exactly equal complete report values, including all financial evidence
and inference costs, with report hash
`fe5d9de4b16c5d009f68354e67070261b5cd9f5a8863c373b882f329362766d7`.
This fixed-input check establishes parity; it is not a measurement of database retrieval latency.

The frozen diagnostic cut ends at 23:43:02.899 UTC for generation
`5e7b236defeba4fb5f0bf2cf68f9aae61586389a5c3a660051a811e9262fd635`.
Gross realized P&L was -$179.45, comprising $430.59 gains and $610.04 losses. There were 87 realized-close
transactions, 38 completed position episodes and no open episodes. Nevertheless, 192 unclosed cycles and missing
operating-cost evidence keep qualification INSUFFICIENT_EVIDENCE. Exact ledger reconciliation does not close
these evidence gaps. Inference estimates were $0.256883466 across 854 claimed requests, with 20 UNKNOWN_USAGE
coverage gaps. All-in profit and return remain null; profitability remains UNDETERMINED.

This is development-provenance diagnostic output, not a deployed financial receipt. Raw documents, frozen input,
full output and profiles remain private, outside Git and CI artifacts. The earlier system report is a separate
18:32 cut; its then-complete inference coverage must not be substituted for this later incomplete cut.

A later read-only database trace binds those twenty gaps to ten v3 requests: five observed at 20:47:02.258 and
five at 20:48:02.187 UTC. They expired after ten seconds and were durably ABANDONED at 20:47:12.674 and
20:48:12.511 respectively. Each retains one staged dispatch claim and no staged terminal or evaluation receipt.
Two missing stage-cost lines per request do not mean twenty distinct failed calls. A dispatch claim with no
terminal evidence cannot establish zero provider consumption; these costs remain unknown.

## Remaining acceptance criteria

The reviewed performance and packaging changes shipped through [#15943](https://github.com/proompteng/lab/pull/15943)
as main `f0710f9ff4a59db53d283908117b141b72d9c77d`, publication run `43533283146`, native image
`sha256:8ba81622e44bccf483dbab069b8e136c2e1686bf89eec0b4d3b8617d82fa5025`.
Kargo promoted Freight `26a864a4cda90239bb4da010b180e0e83a0ab2f5` into generated commit
`d46c6bbefca3578e09819f773d7312e64bc37f63`; Argo synced it successfully.

A post-release API invocation with a 120-second diagnostic budget completed in 57,085 ms wall time, measured
55,815 ms within the report worker and peaked at 754,792 KiB process-lifetime RSS. Its report hash is
`544b4079153daa1033dceb0b1292c741ef3e89fecd914918d5615948dd1e2ba5`, with receipt hash
`6c3a9cf224b78838634e39bd94546d1ec0635387f7b8ea186ca5e67fe1263906`.
The source cut closes at November 14 00:45:37.166 UTC. Counts and financial values remain 174 execution
transactions, 87 realized closes, 38 completed episodes, no open episodes and -$179.45 gross; inference remains
854 claims with twenty coverage gaps. These later mutable source clocks differ from the profiled baseline, so
the lower wall time is not a controlled end-to-end improvement estimate. No receipt was persisted.

The separate 30-second check exited after 31,139 ms including cleanup, emitted zero stdout bytes and reported
ForwardPerformanceDeadlineExceeded. Its worker peak was 678,468 KiB. The 30-second requirement is still unmet.
Before and after both reports, authority remained PAPER, kill CLEAR, unresolved mutations zero and reconciliation
EXACT. Both execution controllers retained zero restarts; no report ran in a controller. The shipped research
wrapper independently reproduced all ten historical study report hashes.

The post-report Mimir read still shows BaynResearchCostCoverageIncomplete firing. Research-wide coverage and the
current generation's twenty stage-cost gaps remain distinct evidence scopes. Sampled ten-minute maximum container
working sets were 332,759,040 and 437,399,552 bytes for the two new controllers, and 926,281,728 bytes for the API
pod running the report. These container samples are different from the report worker's process-lifetime peak;
they establish neither a general memory bound nor complete financial evidence.

The full-report SLO remains [#15928](https://github.com/proompteng/lab/issues/15928). PostgreSQL retrieval plus
pure decoding still consumed about 39–40 seconds in profiled runs; that phase is not solely database I/O. Further
work needs fixed-cut measurements and full parity rather than speculative serializer changes or weaker evidence.
Production commands retain deadline enforcement, discard incomplete stdout, and reject reporting in execution
controller workloads. Keep diagnostics in the separately budgeted API runtime and verify controller continuity.

Protective execution identity, operating-cost receipts, unclosed windows, entry expiry attribution, exit tails,
source completeness and storage evidence remain tracked in
[#15936](https://github.com/proompteng/lab/issues/15936) and
[the original investigation](system-investigation-2026-11-13.md). None is resolved by this performance change.
The [stock short investigation](../stock-short-research-2026-11-13.md) separately records failed numerical controls,
native accounting tests and the contracts still required before short exposure can be considered.

## November 15 complete-report work

The concrete goal remains a complete generation report within 30 seconds, exact ledger reconciliation, and explicit
known and missing operating costs. This is an engineering target, not a claim of economic qualification.

On deployed `0601a22a91900642c0283210ebfb704fa379b53e`, a supervised 30-second report failed after 32,662 ms
including cleanup and emitted no stdout. A separate bounded diagnostic spent 91,090 ms in PostgreSQL retrieval
and decision verification, 9,304 ms in market-volume reads, and exceeded its 120-second deadline during expenses.
CPU profiling identified repeated pure decision and inference reconstruction as the primary work.

A development-provenance candidate with six native verification workers completed the same retained generation
under the existing two-core API limit in 116,952 ms wall time. Its measured report interval was 113,107 ms, and
process-lifetime peak RSS was 1,817,556 KiB. Phase times were 71,364 ms for PostgreSQL and decision verification,
9,498 ms for market volume, 734 ms for the execution ledger, 525 ms for expense snapshot acquisition, and
29,967 ms for expense reconstruction and reconciliation. Different mutable source cuts prevent treating these
separate runs as a controlled end-to-end speedup. The 30-second target was not met by this trial.

That complete cut retained 107 cycles, 174 execution transactions, 87 realized closes, 38 complete episodes,
-$179.45 gross realized P&L, $13.61 execution fees, exact accounting receipts and exact ledger reconciliation.
It still retained 192 unclosed cycles and incomplete operating costs. Fully costed profit and return remained null;
profitability remained UNDETERMINED. No receipt was persisted.

The first released candidate bounds the read-only CLI pool at eight workers, keeps complete source verification and all
session-ledger checks, and raises only the API CPU burst limit from two to eight cores. CPU reservations and the
4 GiB container limit remain unchanged. Intraday archive reads are bounded at four concurrent groups. Native
worker tests compare genuine retained projections and inference coverage with the original verifier; lifecycle
tests exercise successful reuse without accumulating listeners, failure, defects, timeout and interruption.
Partition tests retain conflicting duplicates, orphan quotes, foreign accounts and other-generation validation.

For repeated-window volume fixtures (117 decisions and 390 minute bars), alternating Node trials showed median
verification times of 2,085 to 780 ms for intraday snapshots, 2,288 to 899 ms for streaming snapshots, and 1,934 to
825 ms for partitioned snapshots, with exact complete output parity including sparse and missing closing bars.
These are synthetic component measurements, not a complete-report latency claim. Global schema JIT and frozen
canonical serialization memoization experiments were discarded after negligible improvement or regression.
Raw retained documents, outputs and CPU profiles remain private temporary diagnostics, outside Git and CI.

### Released x64 result and ARM64 follow-up

PR [#15952](https://github.com/proompteng/lab/pull/15952) merged as
`c65251c7dacac08079b3d221fd9f70896453e0e1` after all 67 reported checks completed without blocking failures.
Publication run `43710238239` succeeded after retrying one truncated Attic NAR download. Kargo promoted Freight
`9e8b2a0c963e9c1dea0c5136bfa0f340a7fd771c` through generated commit
`1a6afd9b26fb3f0fb59ba1dd242d9849845ba913`; Argo reported Synced/Healthy. The native image is
`sha256:e550a0a1c14d92e9cc66d66e97f66abee85959b4800e9ef7d9aef98581152be0`.

The deployed x64 command completed within the unchanged 30-second supervisor budget in **26,633 ms wall time**
(25,338 ms measured report interval), at 1,252,592 KiB process-lifetime peak RSS. An earlier complete x64 run of
`0601a22a91900642c0283210ebfb704fa379b53e` took 57,796 ms wall time at a two-core limit and 726,660 KiB peak RSS.
The new allocation was eight cores; source clocks and build bindings differ. These are separate runtime observations,
not a controlled estimate of algorithmic speedup or lower cost.

ARM64 exceeded the 30-second budget, exited after 31,951 ms including cleanup and emitted zero stdout. A private
instrumented 120-second diagnostic completed in 57,391 ms wall time at 1,334,388 KiB peak RSS. PostgreSQL plus
decision verification took 33,485 ms, market volume 8,509 ms, and expenses 9,546 ms. Its 73 decision jobs accounted
for 108,621 ms summed worker wall time over a 26,178 ms job span: about 4.1 busy workers despite an eight-worker
limit. Batch barriers leave capacity idle while larger documents and the cursor finish.

The released x64 report and ARM64 diagnostic produced the same financial receipt hash,
`f8d74be86633c0a9dcb7edba83bccd5e9897a25b584fac709da82e4d8af239ae`, with exact accounting and ledger reconciliation,
107 cycles, 174 execution transactions, 87 realized closes and 38 completed episodes. Known inference estimates
remain $0.256883466 with twenty usage gaps. Gross P&L remains -$179.45, fees $13.61, and fully costed profit/return
remain null. No receipt was persisted. Both API replicas and execution controllers retained readiness and zero restarts.

The ARM follow-up replaces batch barriers with bounded ordered lookahead, fills freed inference slots immediately,
and overlaps independent external reads after releasing the same PostgreSQL source cut. Intraday volume verification
uses the same bounded pool; grouping yields between manifest checks so worker replies can make progress. Native concurrency is bounded
at eight on x64 and sixteen on ARM64; the API burst ceiling becomes sixteen cores and 6 GiB, while reservations and
execution-controller limits remain unchanged. Tests cover ordering, raw lookahead bounds, prompt failure propagation,
defects, timeouts, interruption, source consistency and completed cleanup. This proposal still requires its own
reviewed release and runtime proof; the x64 success does not establish the ARM64 target.

A private development build with ordered lookahead and sixteen workers completed on the still-eight-core ARM64
allocation in 48,403 ms wall time (44,786 ms measured interval), using 2,575,492 KiB peak RSS. It preserved the
financial receipt hash above. This diagnostic preceded volume offload and does not establish the proposed sixteen-core
release target.

### Released continuous scheduling and grouping follow-up

PR [#15953](https://github.com/proompteng/lab/pull/15953) merged as `b582178d648a0132359707d1d3dc65481fbc0327`
after all 36 reported checks passed or were skipped and review approved the change. Release run `43722229151`
succeeded after retrying a GitHub HTTP 403 download of the pinned TLC checker. Freight
`fafa02864aab5f5e7e8899b958bf96d82a2b0f2c` promoted through generated commit
`d3512dcb18b8b6d51cc3b43174558e8654d0377b`; Argo reported Synced/Healthy. The native image digest is
`sha256:a01131cf745039f020891a06f8b2319af6412da07de9c0a7b2f24519afd63341`.

At the deployed sixteen-core/six-GiB ceiling, the packaged x64 command succeeded within the original 30-second
budget in 17,932 ms wall time (16,600 ms measured interval), with 1,508,396 KiB peak RSS. ARM64 still exceeded
the budget, exiting in 32,086 ms with zero stdout. A bounded instrumented ARM diagnostic completed in
31,350 ms wall time (27,645 ms measured interval), using 2,254,964 KiB peak RSS. PostgreSQL took 16,624 ms;
volume took 8,898 ms while expenses took 8,723 ms concurrently. Manifest grouping alone occupied the
coordinating thread for 3,685 ms. The next change moves that authentication into the existing pool without
changing its pure verifier, original watermark bounds, grouping keys, or the sixteen-worker ceiling.

Both completed reports produced financial receipt hash
`e35e898c9de21ff4459a74d1f1190f4f70aade67355694ffa4e3a914a152e9d3` for this runtime binding. Counts, gross
P&L, fees, known inference estimates, twenty gaps and exact ledger proofs remain unchanged. Costs remain
incomplete and profitability undetermined; no receipt was persisted. API readiness and exact accounting
were retained before and after every run. The ARM deadline target remains open.

The then-private grouping candidate completed ARM64 in 28,948 ms wall time under the unchanged 30-second deadline
(25,199 ms measured interval), using 2,233,344 KiB peak RSS. It ran on the existing sixteen-core/six-GiB API
allocation with development provenance and produced the same financial receipt hash as the released x64 report
above. The grouping offload subsequently merged in PR [#15954](https://github.com/proompteng/lab/pull/15954),
commit `fc70d503c1`, and is already present in deployed source `178edec0d2f4392aa3e12a2223031c78137a0015`.
The private timing remains candidate evidence for that November 13 cut with **174 transactions**; it does not
establish the packaged runtime budget for a different retained cut.

### November 16 retained-cut transport diagnostic

The current retained generation is `5fcc26b3a8aeaa80033862db9dbb265b79e0a2b4e67c87a336d1a192af4cdf0f`,
with **196 transactions**, 117 cycles and 102 realized closes from the November 12 cohort. On the ARM64 API
pod at source `178edec0d2f4392aa3e12a2223031c78137a0015`, image
`sha256:e7038c0e6d28cc819d4ea86bed7f5b1c6f5dfd99376479d27e96311dd9cfb543`, the original 30-second command
still exceeded its budget. A read-only CPU diagnostic with a separately labeled 60-second deadline completed
in 37,889 ms wall time (32,576 ms measured interval), at 2,834,072 KiB peak RSS. Its financial receipt hash was
`813c0f882328b2efeead62677064118e00a91688f85f9cec9a42d7afd3218ba6`, matching the completed x64 report.
No receipt was persisted, and uniquely named temporary CPU profiles were removed after extracting timings.

The coordinator spent 3,167 ms of sampled self CPU in `postMessage`; workers also spent substantial aggregate
CPU serializing full decision graphs. Aggregate worker CPU is not elapsed report time. The focused follow-up
keeps PostgreSQL JSONB documents as text until their owning verification worker, preserving standard JSON
number/string parsing, all document verification, cursor ordering and bounded lookahead. Group authentication
already uses the worker pool. The original 30-second packaged ARM64 acceptance remains open until this
transport change is released and measured against this exact 196-transaction cut.

### ARM transport component verification — November 16

The same fixed benchmark also ran with Node v24.11.1 in the existing ARM64 status runtime (six GiB, sixteen-core
ceiling), using sixteen workers, 196 repetitions of the 1,523,926-byte retained fixture, one warm-up pair and three
alternating measured pairs. Median elapsed time was 2,575.9 ms with coordinator parsing and object transport,
versus 338.0 ms with JSON text transport and worker parsing. Every returned parsed-document SHA-256 matched.
This isolates transport and parsing; it does not establish the complete retained-report deadline. Acceptance
still requires the reviewed packaged release to complete the original 196-transaction report within 30 seconds
on both architectures, with exact financial totals and explicit incomplete evidence preserved.
