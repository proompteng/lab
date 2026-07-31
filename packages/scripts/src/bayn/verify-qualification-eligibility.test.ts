import { describe, expect, test } from 'bun:test'

import {
  evaluateQualificationEligibility,
  type QualificationEligibilityInput,
} from './verify-qualification-eligibility'

const h = (value: string) => value.repeat(64).slice(0, 64)
const r = (value: string) => value.repeat(40).slice(0, 40)

const fixture = (): QualificationEligibilityInput => ({
  eventName: 'schedule',
  repository: 'proompteng/lab',
  currentMainSha: r('a'),
  workflowSha: r('a'),
  sourceSha: r('a'),
  imageRepository: 'registry.example/bayn',
  imageDigest: `sha256:${h('b')}`,
  strategyBehaviorHash: h('c'),
  strategyParameterHash: h('d'),
  preregistrationBlobOid: r('e'),
  preregistration: {
    schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
    candidateOrdinal: 17,
    priorTrialCount: 16,
    strategyProtocolHash: h('f'),
    modulePath: 'services/bayn/src/strategy/candidate-17.ts',
    moduleSha256: h('1'),
    marketData: {
      schemaVersion: 'bayn.candidate-development-market-data-source.v1',
      snapshotId: h('2'),
      finalizedSnapshotContentHash: h('3'),
      inputManifestHash: h('4'),
      boundedContentHash: h('5'),
    },
    preregistration: { sourceRevision: r('6'), path: 'candidate.json', blobOid: r('e') },
  },
  publication: {
    natural: true,
    completed: true,
    publicationDate: '2026-08-01',
    sourceSha: r('a'),
    imageDigest: `sha256:${h('b')}`,
    snapshotId: h('2'),
    finalizedSnapshotContentHash: h('3'),
    inputManifestHash: h('4'),
    boundedContentHash: h('5'),
  },
  attempts: [],
  database: { lockCount: 0, resultCount: 0, trialCount: 16 },
})

describe('qualification eligibility', () => {
  test('is safely dormant before a reviewed preregistration exists', () => {
    expect(evaluateQualificationEligibility({ ...fixture(), preregistration: null })).toEqual({
      status: 'dormant',
      code: 'preregistration-missing',
    })
  })

  test('accepts one exact pristine natural publication', () => {
    const result = evaluateQualificationEligibility(fixture())
    expect(result.status).toBe('eligible')
    if (result.status === 'eligible') expect(result.eligibilityHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects manual dispatch before qualification access', () => {
    expect(evaluateQualificationEligibility({ ...fixture(), eventName: 'workflow_dispatch' })).toMatchObject({
      status: 'hold',
      code: 'manual-dispatch-rejected',
    })
  })

  test.each([
    ['changed head', { currentMainSha: r('9') }, 'source-head-mismatch'],
    ['changed preregistration', { preregistrationBlobOid: r('9') }, 'preregistration-invalid'],
    [
      'stale publication source',
      { publication: { ...fixture().publication!, sourceSha: r('9') } },
      'publication-source-mismatch',
    ],
    [
      'changed data',
      { publication: { ...fixture().publication!, boundedContentHash: h('9') } },
      'publication-data-mismatch',
    ],
    ['prior lock', { database: { lockCount: 1, resultCount: 0, trialCount: 16 } }, 'database-state-not-pristine'],
    ['prior result', { database: { lockCount: 0, resultCount: 1, trialCount: 16 } }, 'database-state-not-pristine'],
    [
      'in-flight run',
      { attempts: [{ candidateOrdinal: 17, status: 'in_progress' as const, conclusion: null }] },
      'prior-or-inflight-attempt',
    ],
    [
      'duplicate completed run',
      { attempts: [{ candidateOrdinal: 17, status: 'completed' as const, conclusion: 'failure' }] },
      'prior-or-inflight-attempt',
    ],
  ])('rejects %s', (_name, patch, code) => {
    expect(evaluateQualificationEligibility({ ...fixture(), ...patch })).toMatchObject({ status: 'hold', code })
  })
})
