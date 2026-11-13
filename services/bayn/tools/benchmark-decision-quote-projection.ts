import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { Effect, Result } from 'effect'

import { verifyPerformanceDecisions } from '../src/forward-performance/postgres/projection'
import { canonicalHashV1Result } from '../src/hash'
import { controlDocumentFixture } from '../src/jev/control-document.test-support'
import { isProtectedEntryTarget } from '../src/strategy/runtime-decision'
import {
  cryptoPersistenceDocumentFixture,
  persistenceDocumentFixture,
} from '../src/system-assessment/decision-persistence.test-support'

const baselinePath = process.argv[2]
assert(baselinePath !== undefined, 'Usage: benchmark-decision-quote-projection <baseline-projection.mjs>')
const baseline: { readonly verifyPerformanceDecisions: typeof verifyPerformanceDecisions } = await import(
  pathToFileURL(resolve(baselinePath)).href
)
assert.equal(typeof baseline.verifyPerformanceDecisions, 'function')
const implementations = { baseline: baseline.verifyPerformanceDecisions, candidate: verifyPerformanceDecisions }
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

for (const { name, fixture } of [
  { name: 'equity candidate', fixture: persistenceDocumentFixture },
  { name: 'crypto candidate', fixture: cryptoPersistenceDocumentFixture },
  { name: 'ablation', fixture: controlDocumentFixture('ablation') },
  { name: 'momentum', fixture: controlDocumentFixture('momentum') },
]) {
  const document = await Effect.runPromise(fixture)
  const row = {
    cycle_id: document.bindings.cycleId,
    decision_hash: document.contentHash,
    created_at: new Date(document.createdAt),
    document,
  }
  const expected = baseline.verifyPerformanceDecisions([row])
  assert.equal(expected.verifiedRows.length, 1)
  assert.deepEqual(verifyPerformanceDecisions([row]), expected)
  const target = document.strategyDecision
  assert(isProtectedEntryTarget(target))
  for (const mutation of [{ ask_price: '999999.123456' }, { source_offset: '9223372036854775807' }]) {
    const changed = structuredClone(document)
    assert(isProtectedEntryTarget(changed.strategyDecision))
    const quote = changed.strategyDecision.evidence.observation.rows.quotes[0]
    assert(typeof quote === 'object' && quote !== null)
    Object.assign(quote, mutation)
    const { contentHash: _hash, ...material } = changed
    Object.assign(changed, { contentHash: Result.getOrThrow(canonicalHashV1Result(material)) })
    const input = { ...row, document: changed }
    assert.deepEqual(verifyPerformanceDecisions([input]), baseline.verifyPerformanceDecisions([input]))
    assert.equal(verifyPerformanceDecisions([input]).verifiedRows.length, 0)
  }

  const timings = { baseline: [] as number[], candidate: [] as number[] }
  const cpu = { baseline: [] as number[], candidate: [] as number[] }
  for (let round = 0; round < 14; round++) {
    for (const implementation of round % 2 === 0
      ? (['baseline', 'candidate'] as const)
      : (['candidate', 'baseline'] as const)) {
      const input = structuredClone(row)
      const startedCpu = process.cpuUsage()
      const started = performance.now()
      const output = implementations[implementation]([input])
      const elapsed = performance.now() - started
      const consumed = process.cpuUsage(startedCpu)
      assert.deepEqual(output, expected)
      if (round >= 5) {
        timings[implementation].push(elapsed)
        cpu[implementation].push((consumed.user + consumed.system) / 1000)
      }
    }
  }
  console.log(
    JSON.stringify({
      scenario: name,
      runtime: process.version,
      documentBytes: Buffer.byteLength(JSON.stringify(document)),
      samples: timings.baseline.length,
      baselineMedianMs: median(timings.baseline),
      candidateMedianMs: median(timings.candidate),
      baselineMedianCpuMs: median(cpu.baseline),
      candidateMedianCpuMs: median(cpu.candidate),
      reductionPercent: (1 - median(timings.candidate) / median(timings.baseline)) * 100,
      equivalence: 'Complete verified decision rows and rejected identities, including original content hashes',
      limitation:
        'Synthetic repeated decision verification with existing semantic caches warmed; not live latency or complete report performance',
    }),
  )
}
