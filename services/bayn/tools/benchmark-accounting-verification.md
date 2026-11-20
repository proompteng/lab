# Accounting verification measurements

`benchmark-accounting-verification.ts` compares complete baseline reconstruction with reuse in a warm accounting
verifier. Bundle a baseline revision that exports `verifyAccountingHistory` using the instructions at the top of
the script. Run the candidate bundle with the baseline directory as its argument. Use the pinned production Node
version for production-runtime comparisons.
The fixture contains 1,104 synthetic buys, profitable and losing sells, fractional rounding cases, three accounts,
and twenty symbols. Both arms receive freshly copied rows. Row copying and full result comparisons run outside the
timed region.

## November 16 hashing measurement

The hashing change uses the runtime's one-shot SHA-256 function instead of creating a streaming hash object.
For ledger identifiers, parsing the first 32 hexadecimal characters replaces sixteen repeated bigint shifts and
byte conversions. These are the same first sixteen digest bytes in big-endian order. The separator, 64-bit mask,
non-zero remapping, canonical validation, accounting reconstruction, and complete stored-record comparisons remain
unchanged. Both arms of this historical measurement reconstructed every row on each pass.

On November 16, 2026, baseline `13f85e995fb53f62f198b8b51ca6e6ea4db2a283` and the candidate were measured
using Node 24.11.1 on Linux x64 in three separate processes. Each process ran ten warmup pairs and thirty measured
pairs, alternating which implementation ran first within each pair. All complete results matched the baseline.

| Process | Baseline median (ms) | Candidate median (ms) | Baseline p95 (ms) | Candidate p95 (ms) |
| ------: | -------------------: | --------------------: | ----------------: | -----------------: |
|       1 |               78.448 |                59.109 |            82.025 |             63.594 |
|       2 |               78.016 |                58.639 |            80.234 |             62.140 |
|       3 |               79.403 |                59.673 |            82.337 |             62.657 |

Median reductions ranged from 24.65% to 24.85%. Every run produced the same complete-output digest:
`c8ebbdfcc557c754fff7fefc69580ca956c96bd660661cb48331fe6caa680ab6`.

A separate seeded comparison (`0x5df35fdf`) checked 10,000 generated inputs against the baseline on both
Node 24.11.1 and Bun 1.4.2. Each input checked SHA-256 strings, sliced binary views, and both identifier widths:
40,000 exact comparisons per runtime. Inputs included empty parts, embedded separators, NUL, non-ASCII text,
and unpaired UTF-16 surrogates. Committed golden cases also retain leading-zero digest bytes and exact binary-view
boundaries. Canonical JSON continues to reject malformed Unicode under its existing rules.

These measurements cover synthetic pure computation. They exclude PostgreSQL, TigerBeetle, broker I/O, and complete
execution passes. Shared-host activity and JIT behavior affect timing. They do not establish deployed
quote-to-broker latency, reduced charged costs, or improved trading profit.
