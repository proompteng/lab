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
