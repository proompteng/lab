# Decision quote projection benchmark

Execution-document validation previously replayed the complete current-protocol observation again for each selected
symbol to recover its original quote. The target schema had already verified that complete observation. The validator
now decodes and orders the retained quote rows once, using the same final-quote selection as snapshot construction.
The existing retained-protocol path already used this projection. This change introduces no cache and preserves
source verification, pricing ceilings, risk checks, original deadlines and financial identities.

## Reproduce

At baseline `0d31bbbbecaed54a9336d40d5e761777737f9ed3`, with the locked dependencies installed:

```sh
bun build services/bayn/src/forward-performance/postgres/projection.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outfile=/tmp/bayn-quote-projection-baseline.mjs
```

At the candidate revision, using that same baseline module:

```sh
bun build services/bayn/tools/benchmark-decision-quote-projection.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outfile=/tmp/bayn-quote-projection-benchmark.mjs
node /tmp/bayn-quote-projection-benchmark.mjs /tmp/bayn-quote-projection-baseline.mjs
```

The fixtures cover current equity and crypto candidate decisions, ablation and momentum controls. Fixture generation
and input cloning happen outside the timed regions. Five warmup rounds precede nine measured rounds, alternating
baseline and candidate order. Both implementations receive the same content. Every sample must return identical
complete verified rows, including document hashes. Rehashed corrupted quotes and source offsets must remain rejected.

## Observed measurements

Node 24.11.1, Bun 1.4.2 bundler, Linux x64, November 13, 2026. Median elapsed milliseconds:

| Synthetic decision | JSON bytes | Baseline | Candidate | Reduction |
| ------------------ | ---------: | -------: | --------: | --------: |
| Equity candidate   |  1,213,236 |  121.410 |    65.864 |     45.8% |
| Crypto candidate   |    191,345 |   19.523 |    10.976 |     43.8% |
| Ablation           |  1,211,505 |  459.617 |   405.837 |     11.7% |
| Momentum           |    784,787 |  167.050 |   112.860 |     32.4% |

These are repeated document-verification measurements with existing semantic caches warmed. They are not cold-start,
complete financial-report, live decision-to-submit or profitability measurements. Retained v38/v39 decoding uses the
unchanged projection and is not claimed to improve. Timing thresholds are not CI assertions.

The focused regression also compares projected quotes with full snapshot reconstruction and checks unchanged canonical
document bytes. Price, timestamp, source-offset and symbol mutations must fail even after recomputing the outer hash
and after a valid document was decoded in the same process.

## Canonical object assembly follow-up — November 15, 2026

At baseline `178edec0d2f4392aa3e12a2223031c78137a0015`, profiling this same benchmark identified canonical
serialization, hashing and garbage collection as substantial CPU work. The candidate builds each canonical object
string directly instead of allocating and joining an intermediate array of encoded properties. Array serialization,
key ordering, string escaping, descriptor checks, proxy traversal, failure paths and SHA-256 remain unchanged.
There is no new cache or trusted-input shortcut.

Use the reproduction commands above with that baseline revision and a freshly built candidate benchmark. A measured
comparison on Node 24.11.1, Bun 1.4.2 bundler, Linux x64 produced these medians, in milliseconds:

| Synthetic decision | JSON bytes | Baseline | Candidate | Reduction | Baseline CPU | Candidate CPU |
| ------------------ | ---------: | -------: | --------: | --------: | -----------: | ------------: |
| Equity candidate   |    839,385 |   45.423 |    40.529 |     10.8% |       48.478 |        44.477 |
| Crypto candidate   |    191,338 |   10.884 |     9.671 |     11.1% |       11.955 |         9.767 |
| Ablation           |    839,790 |  301.948 |   286.001 |      5.3% |      339.297 |       327.561 |
| Momentum           |    551,514 |   74.900 |    69.432 |      7.3% |       84.228 |        78.038 |

The benchmark checked identical complete verified rows and rejection of rehashed quote and source-offset corruption
for every scenario. The retained production-Node test separately reproduced all 14 v38/v39 financial cases with
their original bytes. Existing canonical tests cover UTF-16 ordering, escapes, empty and nested containers, invalid
values, proxies, reflection failures and reentrant calls.

A separate serialization-only check used those four complete fixture documents, parsed from the same exported JSON
in fresh Node processes. Both implementations serialized and hashed each document ten times for warmup, followed by
an explicit GC and sixty measured calls per document. Fixture generation was outside those processes. One
baseline/candidate pair measured 1,859.549/1,533.665 ms for the measured work and process-lifetime native peak RSS of
258,096/227,620 KiB. All four complete canonical body lengths and SHA-256 values matched. This single pair suggests
lower allocation pressure; it does not establish a memory bound or a general peak-memory improvement.

The serialization check can be repeated by bundling `src/hash.ts` from each revision, importing the chosen module in
a fresh `node --expose-gc` process, and calling `canonicalJsonWithHashV1Result` over the same exported documents.
Record `process.resourceUsage().maxRSS` after the calls; it includes parsing and warmup and cannot be reset by GC.

Reusing all scalar-string encodings within a call and concatenating array elements were also measured separately.
Neither improved this comparison over the smaller object-only change, so neither is included. Timing samples remain
subject to shared-host and JIT variation. These measurements do not establish cold-start, complete-report,
quote-to-submit, deadline-reliability or profitability improvements.
