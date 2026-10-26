// Synthetic only: run with `bun services/bayn/tools/benchmark-normalization.ts`.
// Compare the same fixture/runtime on the base and candidate revisions; timings are not test assertions.
import { Result } from 'effect'

import { normalizeSnapshot } from '../src/simulation-reconciliation/broker-normalization'
import { normalizationFixture } from '../src/simulation-reconciliation/broker-normalization.test-support'

for (const size of [500, 2_000, 10_000]) {
  const { snapshot, bindings } = normalizationFixture(size)
  for (let warmup = 0; warmup < 3; warmup++) Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
  const samples: number[] = []
  for (let repeat = 0; repeat < 10; repeat++) {
    const start = performance.now()
    const output = Result.getOrThrow(normalizeSnapshot(snapshot, bindings))
    samples.push(performance.now() - start)
    if (output.orderEvents.length !== size * 3) throw new Error('Unexpected normalized order count')
  }
  const ordered = [...samples].sort((left, right) => left - right)
  const lower = ordered[4]
  const upper = ordered[5]
  if (lower === undefined || upper === undefined) throw new Error('Missing benchmark samples')
  console.log(
    JSON.stringify({
      parents: size,
      warmups: 3,
      samplesMs: samples,
      medianMs: (lower + upper) / 2,
      minMs: ordered[0],
      maxMs: ordered.at(-1),
    }),
  )
}
