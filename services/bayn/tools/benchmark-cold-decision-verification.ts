import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Schema } from 'effect'

import type { verifyPerformanceDecisions } from '../src/forward-performance/postgres/projection'

const Measurement = Schema.Struct({
  documents: Schema.Int,
  elapsedMs: Schema.Finite,
  cpuMs: Schema.Finite,
  exactOutputHash: Schema.String,
})
const Row = Schema.Struct({
  cycle_id: Schema.String,
  decision_hash: Schema.String,
  created_at: Schema.String,
  document: Schema.Unknown,
})
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

if (process.argv[2] === '--worker') {
  const modulePath = process.argv[3]
  const inputPath = process.argv[4]
  assert(modulePath !== undefined && inputPath !== undefined, 'Worker requires a verifier module and private input')
  const module: { readonly verifyPerformanceDecisions: typeof verifyPerformanceDecisions } = await import(
    pathToFileURL(resolve(modulePath)).href
  )
  assert.equal(typeof module.verifyPerformanceDecisions, 'function')
  const rows = readFileSync(inputPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const row = Schema.decodeUnknownSync(Row)(JSON.parse(line))
      const created_at = new Date(row.created_at)
      assert(Number.isFinite(created_at.getTime()), 'Input contains an invalid observation clock')
      return { ...row, created_at }
    })
  assert(rows.length > 0, 'Input requires at least one decision')
  const started = performance.now()
  const cpu = process.cpuUsage()
  const outputs = rows.map((row) => module.verifyPerformanceDecisions([row]))
  const elapsedMs = performance.now() - started
  const consumed = process.cpuUsage(cpu)
  assert(
    outputs.every((output) => output.verifiedRows.length === 1),
    'A captured decision failed verification',
  )
  console.log(
    JSON.stringify({
      documents: rows.length,
      elapsedMs,
      cpuMs: (consumed.user + consumed.system) / 1000,
      exactOutputHash: createHash('sha256').update(JSON.stringify(outputs)).digest('hex'),
    }),
  )
} else {
  const [baseline, candidate, input] = process.argv.slice(2)
  assert(
    baseline !== undefined && candidate !== undefined && input !== undefined,
    'Usage: benchmark-cold-decision-verification <baseline.mjs> <candidate.mjs> <private-rows.ndjson>',
  )
  const samples: Record<'baseline' | 'candidate', (typeof Measurement.Type)[]> = { baseline: [], candidate: [] }
  let expectedHash: string | undefined
  for (let round = 0; round < 3; round++) {
    for (const implementation of round % 2 === 0
      ? (['baseline', 'candidate'] as const)
      : (['candidate', 'baseline'] as const)) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), '--worker', implementation === 'baseline' ? baseline : candidate, input],
        { encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576 },
      )
      assert.equal(child.status, 0, 'Isolated verifier failed; private evidence is not printed')
      const measured = Schema.decodeUnknownSync(Measurement)(JSON.parse(child.stdout))
      expectedHash ??= measured.exactOutputHash
      assert.equal(measured.exactOutputHash, expectedHash, 'Complete verified outputs differ')
      samples[implementation].push(measured)
    }
  }
  const before = median(samples.baseline.map((sample) => sample.elapsedMs))
  const after = median(samples.candidate.map((sample) => sample.elapsedMs))
  console.log(
    JSON.stringify({
      runtime: process.version,
      coldProcessPairs: 3,
      documents: samples.baseline[0]?.documents,
      baselineMedianMs: before,
      candidateMedianMs: after,
      reductionPercent: 100 * (1 - after / before),
      completeVerifiedOutputsEqual: true,
      samples,
      limitation: 'Bounded captured document verification, not complete report latency or profitability',
    }),
  )
}
