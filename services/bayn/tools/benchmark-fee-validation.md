# Fee validation benchmark

Run from the repository root:

```sh
bun services/bayn/tools/benchmark-fee-validation.ts
```

For the production runtime version, bundle the same fixture and run it with the pinned Node:

```sh
bun build services/bayn/tools/benchmark-fee-validation.ts --target=node --outfile=/tmp/bayn-fee-benchmark.mjs
node /tmp/bayn-fee-benchmark.mjs
```

This exercises the dated equity fee calculator and the complete entry-economics calculation, including both
break-even searches. It warms each case for 1,000 calls and reports seven sorted samples in microseconds per call.
The checksum covers successful fee and entry results and date validation results, including invalid dates and
New York fee-date boundaries. It is a small reproducible fixture, not complete financial equivalence proof.

On November 15, 2026, using Bun 1.4.2 on Linux x64, baseline `fc70d503c1c139b21cb8827eca7425d259079a9e` and
the optimized code produced these median measurements in separate sequential processes:

| Change                           | Single equity sale | Equity entry economics |
| -------------------------------- | -----------------: | ---------------------: |
| Baseline                         |           2.647 µs |             230.019 µs |
| Reuse schema predicates          |           2.482 µs |             225.349 µs |
| Also aggregate fills in one pass |           2.321 µs |             216.347 µs |

The final median reductions were 12.3% and 5.9%, respectively. All three runs emitted the same output checksum:
`c2a700cfb2b8415b30ae398b5867614ed49cc16a9afc8e9e7fef77a1eaf77f41`.
The mixed-fill regression test separately checks equity caps, scaled costs, and distinct crypto coin and cash fees
against exact values captured from the baseline.

Node 24.11.1, using the same fixture bundled with Bun's Node target, produced these medians:

| Revision  | Single equity sale | Equity entry economics |
| --------- | -----------------: | ---------------------: |
| Baseline  |           4.035 µs |             386.265 µs |
| Optimized |           3.783 µs |             370.851 µs |

The reductions were 6.3% and 4.0%. Both Node runs emitted the same checksum as the Bun runs. The baseline Node
bundle used a build-time source override containing `git show fc70d503c1c139b21cb8827eca7425d259079a9e:services/bayn/src/strategy/execution-model/fees.ts`;
all other sources and bundler options matched. The optimized run preceded the baseline run.

These are local microbenchmark results. They do not establish deployed quote-to-broker latency, deadline
reliability, lower charged costs, or improved trading profit. Shared-host noise and JIT warmup
affect samples. No fee schedule, rounding rule, strategy, accounting identifier, risk limit, or execution deadline
changes in this optimization.
