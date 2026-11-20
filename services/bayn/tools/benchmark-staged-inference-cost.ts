import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Result } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import {
  entryCompletionFixture,
  entryEvaluationRequestFixture,
  stagedCheckpointFixture,
} from '../src/jev/entry-inference.test-support'
import { JevOutcome, makeJevEvaluationReceipt } from '../src/jev/evidence'
import { readStagedInferenceCostEvidence } from '../src/jev/staged-inference-cost-evidence'

// Bundle the unchanged staged-inference-cost-evidence.ts first, then pass its module here.
// Both implementations receive the same synthetic source; fixture construction is not timed.
const baselinePath = process.argv[2]
assert(baselinePath !== undefined, 'Usage: benchmark-staged-inference-cost <baseline-module.mjs>')
const baseline: { readonly readStagedInferenceCostEvidence: typeof readStagedInferenceCostEvidence } = await import(
  pathToFileURL(resolve(baselinePath)).href
)
const request = entryEvaluationRequestFixture()
const completion = entryCompletionFixture(request)
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v3',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    outcome: { status: JevOutcome.Completed, completion },
  }),
)
const source = {
  request,
  receipt,
  resolution: null,
  handoff: completion.handoff,
  stagedCheckpoint: stagedCheckpointFixture(request),
}
const { receiptHash: _, ...changedMaterial } = { ...receipt, requestId: 'f'.repeat(64) }
const cases = [
  source,
  { ...source, receipt: null },
  { ...source, receipt: null, handoff: null },
  { ...source, receipt: null, handoff: null, stagedCheckpoint: { claims: [], terminals: [], skips: [] } },
  { ...source, handoff: null },
  { ...source, handoff: { ...completion.handoff, handoffHash: 'f'.repeat(64) } },
  {
    ...source,
    receipt: { ...changedMaterial, receiptHash: Result.getOrThrow(canonicalHashV1Result(changedMaterial)) },
  },
]
for (const input of cases) {
  const before = baseline.readStagedInferenceCostEvidence(input)
  const after = readStagedInferenceCostEvidence(input)
  assert.equal(Result.isSuccess(after), Result.isSuccess(before))
  if (Result.isSuccess(before)) {
    assert(Result.isSuccess(after))
    assert.deepEqual(after.success, before.success)
  }
}
const timings = { baseline: [] as number[], candidate: [] as number[] }
for (let sample = 0; sample < 60; sample++) {
  for (const name of sample % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)) {
    const start = performance.now()
    Result.getOrThrow(
      name === 'baseline' ? baseline.readStagedInferenceCostEvidence(source) : readStagedInferenceCostEvidence(source),
    )
    if (sample >= 10) timings[name].push(performance.now() - start)
  }
}
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const before = median(timings.baseline)
const after = median(timings.candidate)
console.log(
  JSON.stringify({
    parityCases: cases.length,
    samples: timings.baseline.length,
    baselineMedianMs: before,
    candidateMedianMs: after,
    reductionPercent: (1 - after / before) * 100,
    limitation: 'Synthetic current-protocol completed request, not an end-to-end live report measurement',
  }),
)
