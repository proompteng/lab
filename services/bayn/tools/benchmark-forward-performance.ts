import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Result } from 'effect'

import { executionQualityFixture } from '../src/forward-performance/execution-quality.test-support'
import type { ForwardPerformanceEvidenceInput } from '../src/forward-performance/model'
import { makeForwardPerformanceReport } from '../src/forward-performance/report'

// Bundle the unchanged report.ts before applying the candidate, then pass that
// module here. Fixture creation is outside the timed region; complete receipt,
// execution evidence, position evidence and report hashing are included.
const baselinePath = process.argv[2]
if (baselinePath === undefined) throw new Error('Usage: benchmark-forward-performance <baseline-report.mjs>')
const baseline: { readonly makeForwardPerformanceReport: typeof makeForwardPerformanceReport } = await import(
  pathToFileURL(resolve(baselinePath)).href
)
if (typeof baseline.makeForwardPerformanceReport !== 'function') throw new Error('Baseline must export the report')
const implementations = { baseline: baseline.makeForwardPerformanceReport, candidate: makeForwardPerformanceReport }
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const fixture = executionQualityFixture(2)
const cycle = fixture.cycles[0]
assert(cycle !== undefined)
const parityCases: readonly ForwardPerformanceEvidenceInput[] = [
  executionQualityFixture(0),
  fixture,
  {
    ...fixture,
    cycles: fixture.cycles.toReversed(),
    transactions: fixture.transactions.toReversed(),
    executionEvidence: fixture.executionEvidence?.toReversed(),
  },
  { ...fixture, cycles: [] },
  { ...fixture, cycles: fixture.cycles.map((item) => ({ ...item, state: 'NO_TRADE' })) },
  { ...fixture, cycles: [{ ...cycle, state: 'NO_TRADE' }, ...fixture.cycles] },
  { ...fixture, cycles: [...fixture.cycles, { ...cycle, state: 'NO_TRADE' }] },
  { ...fixture, cycles: [...fixture.cycles, cycle] },
  { ...fixture, executionEvidence: fixture.executionEvidence?.map(({ intent: _, ...item }) => item) },
  { ...fixture, executionEvidence: fixture.executionEvidence?.map((item) => ({ ...item, cycleId: 'invalid' })) },
  { ...fixture, unverifiedDecisionHashes: ['a'.repeat(64)] },
  { ...fixture, account: { ...fixture.account, accountId: '\ud800' } },
]
for (const input of parityCases) {
  for (const scope of [undefined, 'f'.repeat(64)]) {
    const before = baseline.makeForwardPerformanceReport(input, [], scope)
    const after = makeForwardPerformanceReport(input, [], scope)
    if (Result.isFailure(before)) {
      assert(Result.isFailure(after))
      assert.deepEqual(after.failure, before.failure)
    } else {
      assert(Result.isSuccess(after))
      assert.deepEqual(after.success, before.success)
    }
  }
}
console.log(
  JSON.stringify({
    parityCases: parityCases.length * 2,
    equivalence: 'exact full reports or typed errors, account and generation scopes',
  }),
)
const sparse = executionQualityFixture(10000)
const scenarios = [
  ...[10, 1000, 5000, 10000].map((count) => ({
    name: `${count} completed cycles`,
    input: executionQualityFixture(count),
  })),
  {
    name: '1 completed cycle and 9999 no-trade cycles',
    input: {
      ...sparse,
      cycles: sparse.cycles.map((item, index) => (index === 0 ? item : { ...item, state: 'NO_TRADE' as const })),
      transactions: sparse.transactions.slice(0, 1),
      executionEvidence: sparse.executionEvidence?.slice(0, 1),
    },
  },
]
for (const { name, input } of scenarios) {
  const before = Result.getOrThrow(baseline.makeForwardPerformanceReport(input, []))
  const after = Result.getOrThrow(makeForwardPerformanceReport(input, []))
  assert.deepEqual(after, before)
  assert.equal(after.receipt.executionQuality.status, 'MEASURED')
  for (let warmup = 0; warmup < 3; warmup++) {
    baseline.makeForwardPerformanceReport(input, [])
    makeForwardPerformanceReport(input, [])
  }
  const samples = { baseline: [] as number[], candidate: [] as number[] }
  const cpuSamples = { baseline: [] as number[], candidate: [] as number[] }
  const iterations = input.transactions.length === 10 ? 20 : 1
  for (let round = 0; round < 7; round++) {
    const order = round % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)
    for (const name of order) {
      const cpu = process.cpuUsage()
      const started = performance.now()
      let last = before
      for (let iteration = 0; iteration < iterations; iteration++)
        last = Result.getOrThrow(implementations[name](input, []))
      samples[name].push((performance.now() - started) / iterations)
      const consumed = process.cpuUsage(cpu)
      cpuSamples[name].push((consumed.user + consumed.system) / iterations / 1000)
      assert.deepEqual(last, before)
    }
  }
  console.log(
    JSON.stringify({
      scenario: name,
      cycleCount: input.cycles.length,
      executionCount: input.executionEvidence?.length ?? 0,
      runtime: process.version,
      samples: 7,
      baselineMs: median(samples.baseline),
      candidateMs: median(samples.candidate),
      baselineCpuMs: median(cpuSamples.baseline),
      candidateCpuMs: median(cpuSamples.candidate),
      speedup: median(samples.baseline) / median(samples.candidate),
      reportHash: before.reportHash,
      equivalence: 'exact full report including all hashes, values and ordering',
    }),
  )
}
