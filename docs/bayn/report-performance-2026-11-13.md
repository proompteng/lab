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
The [stock short investigation](stock-short-research-2026-11-13.md) separately records failed numerical controls,
native accounting tests and the contracts still required before short exposure can be considered.
