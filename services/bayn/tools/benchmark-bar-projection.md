# Streaming bar projection benchmark

This is an offline benchmark of `incorporateMarketRecord`, including raw schema decoding,
hashing, immutable map updates and bounded bar retention. It does not contact Kafka,
ClickHouse, PostgreSQL, a broker or a model. Records are synthetic and prepared before timing.
It measures a bar-update optimization, not whole-service throughput or trading profitability.

## Reproduce

From the repository root, with the pinned Bun dependencies installed:

```sh
mkdir -p .tmp/bayn-bar-benchmark
baseline=services/bayn/src/market-data/streaming/.projection-baseline.ts
git show 050f40a8dc7078ce54f6e5825c48f5f250cbfec2:services/bayn/src/market-data/streaming/projection.ts > "$baseline"
bun build "$baseline" --target=node --outfile=.tmp/bayn-bar-benchmark/baseline.mjs
rm "$baseline"
bun build services/bayn/tools/benchmark-bar-projection.ts --target=node --outfile=.tmp/bayn-bar-benchmark/benchmark.mjs
node .tmp/bayn-bar-benchmark/benchmark.mjs .tmp/bayn-bar-benchmark/baseline.mjs
```

Keep the temporary baseline out of commits. The baseline module is bundled against the same
unchanged dependencies as the candidate. Each scenario verifies exact complete projection
state and unchanged-state/history identity after every input, then warms both implementations
with ten complete fixture passes. Seven alternating-order samples process 5,120 records each
(20,000 for the mixed feed). The output includes wall-clock and process CPU microseconds per
record, medians and ranges. No fixed latency threshold is asserted in CI.

The separate `src/market-data/streaming/bar-history.test.ts` property compares production raw
and recorded reducers against the previous full-sort retention reference. It covers correction
chains, stable revision precedence, first-publication identity, three/nine-digit timestamps,
large offsets, midnight rollover, extreme out-of-order bars, carried eviction floors and
frozen earlier cuts. Named regressions cover duplicate/conflicting delivery and invalid offsets.

## Measured evidence

Two serial runs on Node 24.11.1 / Bun 1.4.2 on 2026-10-14 used:

- Baseline commit: `050f40a8dc7078ce54f6e5825c48f5f250cbfec2`
- Baseline projection Git blob: `8de8c72c31a42bcdf266e8fb651cc826dde75243`
- Candidate projection Git blob: `645374bee6c58b6740e2ac52a4b920f93a773a3c`
- Baseline bundle SHA-256: `80cfbd123ef988757e9ae6463506403ffb441d46fe7e059ea368aafc992949bb`
- Benchmark/candidate bundle SHA-256: `86d7f91fe0c0f9c9796d1085b2702827c9958e762ae4f7216282701c118bab23`

Second-run medians, in microseconds per input record:

| Synthetic scenario                        | Baseline wall | Candidate wall | Baseline CPU | Candidate CPU | Wall speedup across both runs |
| ----------------------------------------- | ------------: | -------------: | -----------: | ------------: | ----------------------------: |
| Append, starting with 61 bars             |         26.87 |          19.96 |        32.58 |         24.02 |                    1.35–1.44× |
| Corrections, starting with 244 revisions  |         55.01 |          26.26 |        57.30 |         28.50 |                    2.09–2.15× |
| Out-of-order, starting with 244 revisions |         33.63 |          21.52 |        35.94 |         23.46 |                    1.56–1.61× |
| Duplicate delivery                        |          8.62 |           8.66 |         8.64 |          8.66 |                    0.99–1.02× |
| 90% quotes / 9% trades / 1% bars          |         14.52 |          14.43 |        16.54 |         16.85 |                    1.01–1.02× |

The duplicate and mixed-feed cases are effectively unchanged within run-to-run variation.
The feed mix is a declared synthetic control, not measured production traffic. Gains are
localized to accepted bar updates; they do not establish improved live trading throughput.
