# Report performance investigation — November 13, 2026

The report remains above its 30-second completion budget. This change removes repeated canonical encodings from
equality checks and retains more reproducible chart images within explicit bounds. It does not change canonical
bytes, financial qualification, source validation, receipt identity or strategy authority.

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

## Remaining acceptance criteria

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
