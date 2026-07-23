import { describe, expect, test } from 'bun:test'

import { Schema } from 'effect'

import {
  defaultQualificationStatisticsPolicyDocument,
  makeQualificationLock,
  makeQualificationPolicyDocument,
  makeQualificationResult,
  QualificationLockSchema,
  type QualificationLockMaterial,
} from './qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  type QualificationSeries,
} from './qualification-statistics'

const policy = (name: string) => makeQualificationPolicyDocument(`bayn.${name}.v1`, { name, enabled: true })

const material: QualificationLockMaterial = {
  schemaVersion: 'bayn.qualification-lock.v3' as const,
  candidateRunId: 'a'.repeat(64),
  protocolHash: '1'.repeat(64),
  sourceRevision: '2'.repeat(40),
  image: {
    repository: 'registry.example.test/lab/bayn',
    digest: `sha256:${'3'.repeat(64)}`,
  },
  universeId: 'cross-asset-taa-v1',
  universeSymbolHash: 'c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8',
  universe: ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'],
  universeRationale: 'Precommitted five-sleeve cross-asset universe selected without inspecting candidate returns.',
  data: {
    snapshotId: '4'.repeat(64),
    publicationId: '5'.repeat(64),
    inputManifestHash: '0'.repeat(64),
    contentHash: '6'.repeat(64),
    sessionsContentHash: '7'.repeat(64),
    provider: 'alpaca',
    sourceFeed: 'sip',
    adjustment: 'all',
    calendarVersion: 'alpaca-us-equity-calendar-v1',
    firstSession: '2016-01-04',
    lastSession: '2026-07-21',
    selectedSessionCount: 2266,
    selectedRebalanceCount: 108,
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1' as const,
      dataStart: '2016-01-04',
      dataEnd: '2026-07-21',
      lookbackStart: '2016-01-04',
      evaluationStart: '2017-01-03',
      evaluationEnd: '2026-07-21',
    },
  },
  policies: {
    benchmark: policy('benchmark-policy'),
    thresholds: policy('threshold-policy'),
    uncertainty: policy('uncertainty-policy'),
    execution: policy('execution-policy'),
  },
  priorTrialRunIds: ['8'.repeat(64), '9'.repeat(64)],
}

describe('qualification lock', () => {
  test('binds the exact default statistical policy as a canonical lock document', () => {
    expect(defaultQualificationStatisticsPolicyDocument).toMatchObject({
      schemaVersion: 'bayn.qualification-statistics-policy.v1',
      content: {
        schemaVersion: 'bayn.qualification-statistics-policy.v1',
        bootstrap: { method: 'paired-complete-rebalance-blocks', samples: 5_000 },
      },
    })
  })

  test('builds a deterministic identity from the complete precommit', () => {
    const first = makeQualificationLock(material)
    const second = makeQualificationLock(structuredClone(material))

    expect(second).toEqual(first)
    expect(first.lockId).toMatch(/^[0-9a-f]{64}$/)
  })

  test('changes identity for every authority-bearing input group', () => {
    const baseline = makeQualificationLock(material).lockId
    const variants = [
      { ...material, sourceRevision: 'a'.repeat(40) },
      { ...material, candidateRunId: 'b'.repeat(64) },
      { ...material, protocolHash: 'b'.repeat(64) },
      { ...material, image: { ...material.image, digest: `sha256:${'c'.repeat(64)}` } },
      { ...material, universeRationale: `${material.universeRationale} No substitutions.` },
      {
        ...material,
        data: { ...material.data, selectedSessionCount: material.data.selectedSessionCount + 1 },
      },
      {
        ...material,
        policies: { ...material.policies, execution: policy('execution-policy-v2') },
      },
      { ...material, priorTrialRunIds: [...material.priorTrialRunIds, 'a'.repeat(64)].sort() },
    ]

    for (const variant of variants) expect(makeQualificationLock(variant).lockId).not.toBe(baseline)
  })

  test('rejects weak windows, unordered lineage, divergent policy hashes, and forged lock ids', () => {
    expect(() =>
      makeQualificationLock({
        ...material,
        data: { ...material.data, selectedSessionCount: 503 },
      }),
    ).toThrow()
    expect(() =>
      makeQualificationLock({ ...material, priorTrialRunIds: [...material.priorTrialRunIds].reverse() }),
    ).toThrow()
    expect(() =>
      makeQualificationLock({
        ...material,
        policies: {
          ...material.policies,
          benchmark: { ...material.policies.benchmark, contentHash: 'f'.repeat(64) },
        },
      }),
    ).toThrow()

    const lock = makeQualificationLock(material)
    expect(() =>
      Schema.decodeUnknownSync(QualificationLockSchema)({ ...lock, universeId: 'equity-infrastructure-v1' }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(QualificationLockSchema)({ ...lock, lockId: '0'.repeat(64) })).toThrow()
  })
})

const qualificationSeries = (): QualificationSeries => {
  const sessionDate = (index: number): `${number}-${number}-${number}` => {
    const date = new Date('2000-01-01T00:00:00.000Z')
    date.setUTCDate(date.getUTCDate() + index)
    return date.toISOString().slice(0, 10) as `${number}-${number}-${number}`
  }
  const blockCount = 90
  return {
    schemaVersion: 'bayn.qualification-series.v1',
    runId: material.candidateRunId,
    observations: Array.from({ length: blockCount * 21 + 10 }, (_, index) => {
      const noise = (((index * 17) % 23) - 11) / 100_000
      return {
        sessionDate: sessionDate(index),
        strategyReturn: 0.0005 + noise,
        cashReturn: 0,
        buyAndHoldReturn: 0.00015 + noise * 1.1,
        directVolatilityReturn: 0.0001 + noise * 0.8,
      }
    }),
    rebalanceExecutionDates: Array.from({ length: blockCount + 1 }, (_, index) => sessionDate(index * 21)),
  }
}

describe('qualification result', () => {
  test('qualifies only when both locked economic and statistical gates pass', () => {
    const lock = makeQualificationLock(material)
    const analysis = analyzeQualification(
      qualificationSeries(),
      defaultQualificationStatisticsPolicy,
      material.priorTrialRunIds,
    )
    const passingVerdict = {
      status: 'PASS' as const,
      gates: [{ name: 'benchmark_sharpe_improvement', passed: true, actual: 0.1, required: '>0' }],
    }
    const qualified = makeQualificationResult(lock, passingVerdict, analysis)
    const rejected = makeQualificationResult(
      lock,
      {
        status: 'FAIL_CLOSED',
        gates: [{ name: 'benchmark_sharpe_improvement', passed: false, actual: -0.1, required: '>0' }],
      },
      analysis,
    )

    expect(analysis.status).toBe('PASS')
    expect(qualified).toMatchObject({ verdict: 'QUALIFIED', reasonCodes: [] })
    expect(rejected).toMatchObject({
      verdict: 'REJECTED',
      reasonCodes: ['EVALUATION_BENCHMARK_SHARPE_IMPROVEMENT_FAILED'],
    })
    expect(qualified.resultHash).toMatch(/^[0-9a-f]{64}$/)
    expect(() => makeQualificationResult(lock, { ...passingVerdict, status: 'FAIL_CLOSED' }, analysis)).toThrow(
      'must match every economic gate outcome',
    )
  })

  test('rejects analysis from a different candidate or prior-trial lineage', () => {
    const lock = makeQualificationLock(material)
    const wrongLineage = analyzeQualification(qualificationSeries(), defaultQualificationStatisticsPolicy, [])
    const wrongCandidate = analyzeQualification(
      { ...qualificationSeries(), runId: 'b'.repeat(64) },
      defaultQualificationStatisticsPolicy,
      material.priorTrialRunIds,
    )

    const passingVerdict = {
      status: 'PASS' as const,
      gates: [{ name: 'benchmark_sharpe_improvement', passed: true, actual: 0.1, required: '>0' }],
    }
    expect(() => makeQualificationResult(lock, passingVerdict, wrongLineage)).toThrow('prior-trial lineage')
    expect(() => makeQualificationResult(lock, passingVerdict, wrongCandidate)).toThrow('run IDs must match')
  })
})
