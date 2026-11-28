import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { Schema } from 'effect'

import type { verifyPerformanceDecisions } from '../src/forward-performance/postgres/projection'

const InputRow = Schema.Struct({
  cycle_id: Schema.String,
  decision_hash: Schema.String,
  created_at: Schema.String,
  document: Schema.Unknown,
})
const DocumentIdentity = Schema.Struct({
  bindings: Schema.Struct({ cycleId: Schema.String }),
  contentHash: Schema.String,
  createdAt: Schema.String,
})
const Sample = Schema.Struct({
  elapsedMs: Schema.Finite,
  cpuMs: Schema.Finite,
  setupMs: Schema.Finite,
  heapLimitBytes: Schema.Finite,
  outputHash: Schema.String,
  verifiedCounts: Schema.Array(Schema.Finite),
  inputBytes: Schema.Array(Schema.Finite),
  decisionHashes: Schema.Array(Schema.String),
})
type Sample = typeof Sample.Type
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

assert.equal(process.versions.bun, undefined, 'Run this benchmark with native Node')
if (process.argv[2] === '--child') {
  const modulePath = process.argv[3],
    inputPath = process.argv[4]
  assert(modulePath !== undefined && inputPath !== undefined)
  const setupStarted = performance.now()
  const implementation: { readonly verifyPerformanceDecisions: typeof verifyPerformanceDecisions } = await import(
    pathToFileURL(resolve(modulePath)).href
  )
  const rows = readFileSync(inputPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const row = Schema.decodeUnknownSync(InputRow)(JSON.parse(line))
      const document = Schema.decodeUnknownSync(DocumentIdentity)(row.document)
      assert.equal(row.decision_hash, document.contentHash)
      assert.equal(row.cycle_id, document.bindings.cycleId)
      assert.equal(new Date(row.created_at).toISOString(), new Date(document.createdAt).toISOString())
      return { ...row, created_at: new Date(row.created_at) }
    })
  assert(rows.length > 0)
  assert.equal(new Set(rows.map((row) => row.decision_hash)).size, rows.length, 'Use distinct immutable decisions')
  const setupMs = performance.now() - setupStarted
  const startedCpu = process.cpuUsage(),
    started = performance.now()
  const output = implementation.verifyPerformanceDecisions(rows)
  const elapsedMs = performance.now() - started,
    consumed = process.cpuUsage(startedCpu)
  assert.equal(output.verifiedRows.length, rows.length)
  assert.equal(output.unverifiedDecisionHashes.length, 0)
  assert.deepEqual(
    output.verifiedRows.map((row) => row.decision_hash),
    rows.map((row) => row.decision_hash),
  )
  console.log(
    JSON.stringify({
      elapsedMs,
      cpuMs: (consumed.user + consumed.system) / 1000,
      setupMs,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      outputHash: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      verifiedCounts: output.verifiedRows.map(() => 1),
      inputBytes: rows.map((row) => Buffer.byteLength(JSON.stringify(row.document))),
      decisionHashes: rows.map((row) => row.decision_hash),
    }),
  )
} else {
  const baselinePath = process.argv[2],
    candidatePath = process.argv[3],
    inputPath = process.argv[4]
  assert(
    baselinePath !== undefined && candidatePath !== undefined && inputPath !== undefined,
    'Usage: benchmark-report-decision-verification <baseline-projection.mjs> <candidate-projection.mjs> <distinct-rows.jsonl>',
  )
  const implementations = { baseline: baselinePath, candidate: candidatePath }
  const samples = { baseline: [] as Sample[], candidate: [] as Sample[] }
  let expectedHash: string | undefined
  for (let round = 0; round < 9; round++) {
    for (const name of round % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)) {
      // Each native process owns an empty target cache. Repeated warm targets bypass reconstruction.
      const child = spawnSync(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), '--child', implementations[name], inputPath],
        { encoding: 'utf8', timeout: 45_000, maxBuffer: 1_048_576 },
      )
      assert.equal(child.status, 0, child.stderr)
      const proof = Schema.decodeUnknownSync(Sample)(JSON.parse(child.stdout))
      expectedHash ??= proof.outputHash
      assert.equal(proof.outputHash, expectedHash)
      if (round >= 2) samples[name].push(proof)
    }
  }
  const metric = (name: 'baseline' | 'candidate', key: 'elapsedMs' | 'cpuMs' | 'setupMs') =>
    median(samples[name].map((sample) => sample[key]))
  console.log(
    JSON.stringify({
      runtime: process.version,
      samples: samples.baseline.length,
      outputHash: expectedHash,
      verifiedCounts: samples.baseline[0]?.verifiedCounts,
      inputBytes: samples.baseline[0]?.inputBytes,
      decisionHashes: samples.baseline[0]?.decisionHashes,
      heapLimitBytes: samples.baseline[0]?.heapLimitBytes,
      baselineMedianMs: metric('baseline', 'elapsedMs'),
      candidateMedianMs: metric('candidate', 'elapsedMs'),
      baselineMedianCpuMs: metric('baseline', 'cpuMs'),
      candidateMedianCpuMs: metric('candidate', 'cpuMs'),
      baselineSetupMs: metric('baseline', 'setupMs'),
      candidateSetupMs: metric('candidate', 'setupMs'),
      reductionPercent: (1 - metric('candidate', 'elapsedMs') / metric('baseline', 'elapsedMs')) * 100,
      limitation:
        'Alternating fresh native Node processes verify each distinct decision once; not a full report deadline proof',
    }),
  )
}
