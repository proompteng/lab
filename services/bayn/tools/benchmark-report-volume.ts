import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import {
  makeIntradayPerformanceFixture,
  makeStreamingPerformanceFixture,
  makeStreamingPartitionPerformanceFixture,
} from '../src/forward-performance/intraday-cycle.test-support'
import {
  makeIntradayPerformanceVolumeEvidenceBatch,
  type makeIntradayPerformanceVolumeEvidence,
} from '../src/forward-performance/intraday-volume'

// Bundle intraday-volume.ts from the baseline before editing it; pass that artifact here.
// Both implementations receive the same source cut. Fixture construction is not timed.
const baselinePath = process.argv[2]
assert(baselinePath !== undefined, 'Usage: benchmark-report-volume <baseline-module.mjs>')
const baseline: { readonly makeIntradayPerformanceVolumeEvidence: typeof makeIntradayPerformanceVolumeEvidence } =
  await import(pathToFileURL(resolve(baselinePath)).href)
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

for (const makeFixture of [
  makeIntradayPerformanceFixture,
  makeStreamingPerformanceFixture,
  makeStreamingPartitionPerformanceFixture,
]) {
  const fixture = makeFixture()
  const requests = Array.from({ length: 117 }, (_, index) => ({
    ...fixture.request,
    cycleId: Result.getOrThrow(canonicalHashV1Result(index)),
  }))
  const before = (bars: readonly unknown[]) =>
    Result.all(
      requests.map((request) => baseline.makeIntradayPerformanceVolumeEvidence(request, fixture.archive, bars)),
    )
  const after = (bars: readonly unknown[]) =>
    makeIntradayPerformanceVolumeEvidenceBatch(requests, fixture.archive, bars)
  for (const bars of [fixture.bars, fixture.bars.slice(1), fixture.bars.slice(0, -1), []])
    assert.deepEqual(Result.getOrThrow(after(bars)), Result.getOrThrow(before(bars)))
  const expected = Result.getOrThrow(before(fixture.bars))
  const samples = { baseline: [] as number[], candidate: [] as number[] }
  const cpu = { baseline: [] as number[], candidate: [] as number[] }
  for (let round = 0; round < 7; round++) {
    for (const name of round % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)) {
      const started = performance.now()
      const cpuStarted = process.cpuUsage()
      const actual = Result.getOrThrow((name === 'baseline' ? before : after)(fixture.bars))
      const elapsed = performance.now() - started
      const used = process.cpuUsage(cpuStarted)
      assert.deepEqual(actual, expected)
      if (round > 1) {
        samples[name].push(elapsed)
        cpu[name].push((used.user + used.system) / 1_000)
      }
    }
  }
  console.log(
    JSON.stringify({
      node: process.version,
      fixture: makeFixture.name,
      requests: requests.length,
      bars: fixture.bars.length,
      samples: samples.baseline.length,
      baselineMedianMs: median(samples.baseline),
      candidateMedianMs: median(samples.candidate),
      baselineCpuMedianMs: median(cpu.baseline),
      candidateCpuMedianMs: median(cpu.candidate),
      exactOutputEquality: true,
      limitation: 'Synthetic full-session volume verification; no production report deadline or profitability claim',
    }),
  )
}
