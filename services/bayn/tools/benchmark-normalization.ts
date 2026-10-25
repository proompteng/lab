// Synthetic only: run with `bun services/bayn/tools/benchmark-normalization.ts`.
// Compare the same fixture/runtime on the base and candidate revisions; timings are not test assertions.
import { Result } from 'effect'

import { normalizeSnapshot } from '../src/simulation-reconciliation/broker-normalization'
import { normalizationFixture } from '../src/simulation-reconciliation/broker-normalization.test-support'

for (const size of [500, 2_000, 10_000]) {
  const { snapshot, bindings } = normalizationFixture(size)
  for (let repeat = 0; repeat < 4; repeat++) {
    const start = performance.now()
    const output = Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
    console.log(
      JSON.stringify({
        parents: size,
        repeat,
        elapsedMs: performance.now() - start,
        orderEvents: output.orderEvents.length,
      }),
    )
  }
}
