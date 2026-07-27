import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from './hash'
import { pinnedEvaluation, pinnedQualification } from './app-test-support'
import { makeQualificationDiagnosis } from './qualification-diagnosis'
import { summarizeEvaluation } from './risk-balanced-trend'

describe('qualification diagnosis', () => {
  test('summarizes statistical distance and economic costs deterministically', () => {
    const evaluation = summarizeEvaluation(pinnedEvaluation)
    const first = makeQualificationDiagnosis(evaluation, pinnedQualification)
    const second = makeQualificationDiagnosis(evaluation, pinnedQualification)
    const { diagnosisHash, ...material } = first

    expect(second).toEqual(first)
    expect(diagnosisHash).toBe(canonicalHashV1(material))
    expect(first.runId).toBe(pinnedQualification.runId)
    expect(first.candidateOrdinal).toBe(pinnedQualification.analysis.candidateOrdinal)
    expect(first.benchmark.name).toBe(pinnedQualification.analysis.bootstrap.selectedBenchmark)
    expect(first.bootstrap.sharpeDifference.sampleCount).toBe(pinnedQualification.analysis.bootstrap.producedSamples)
    expect(first.bootstrap.sharpeDifference.lowerBound).toBe(
      pinnedQualification.analysis.bootstrap.sharpeDifferenceLowerBound,
    )
    expect(first.bootstrap.sharpeDifference.positiveFraction).toBeGreaterThanOrEqual(0)
    expect(first.bootstrap.sharpeDifference.positiveFraction).toBeLessThanOrEqual(1)
    expect(first.candidate.totalTransactionCostMicros).toMatch(/^[0-9]+$/)
  })
})
