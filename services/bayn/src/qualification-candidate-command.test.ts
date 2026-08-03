import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { config, fixtureLock, fixtureRuntime, fixtureSnapshot, provenance } from './app-test-support'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import { marketDataService } from './app-test-support'
import { verifyQualificationCandidateBinding } from './qualification-candidate-command'
import { makeStrategyProtocolHash } from './contracts'
import { fixtureProtocol, makeTestProvenance } from './test-fixtures'

const inspection = Effect.runSync(marketDataService(Effect.succeed(fixtureSnapshot)).inspect)
const compiledBoundedContentHash = '2'.repeat(64)

const preregistration = (
  overrides: Partial<CandidateDevelopmentNextPreregistration> = {},
): CandidateDevelopmentNextPreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 1,
  priorTrialCount: 0,
  strategyProtocolHash: fixtureLock.protocolHash,
  modulePath: 'services/bayn/src/strategy/candidate-17.ts',
  moduleSha256: provenance.strategy.behaviorHash,
  priorTrialsHash: '9'.repeat(64),
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
    finalizedSnapshotContentHash: fixtureSnapshot.manifest.finalizedSnapshot.contentHash,
    inputManifestHash: fixtureSnapshot.manifest.hash,
    boundedContentHash: compiledBoundedContentHash,
  },
  preregistration: {
    sourceRevision: '3'.repeat(40),
    path: 'services/bayn/candidates/candidate-17-preregistration.json',
    blobOid: '4'.repeat(40),
  },
  ...overrides,
})

describe('qualification candidate metadata binding', () => {
  const candidate = {
    definition: fixtureRuntime.definition,
    provenance,
    moduleSha256: provenance.strategy.behaviorHash,
    trialHistoryHash: '9'.repeat(64),
    boundedContentHash: compiledBoundedContentHash,
  } as const

  test('prepares the exact production lock from immutable metadata without loading bars or writing', () => {
    const result = verifyQualificationCandidateBinding(
      preregistration(),
      candidate,
      {
        sourceRevision: config.build.sourceRevision,
        image: { repository: config.build.imageRepository, digest: config.build.imageDigest },
      },
      inspection,
      [],
    )

    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(result.success).toMatchObject({
        schemaVersion: 'bayn.qualification-candidate-binding.v1',
        candidateOrdinal: 1,
        priorTrialCount: 0,
        sourceRevision: config.build.sourceRevision,
        imageRepository: config.build.imageRepository,
        imageDigest: config.build.imageDigest,
        snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
        inputManifestHash: fixtureSnapshot.manifest.hash,
        finalizedSnapshotContentHash: fixtureSnapshot.manifest.finalizedSnapshot.contentHash,
        boundedContentHash: compiledBoundedContentHash,
        moduleSha256: provenance.strategy.behaviorHash,
        trialHistoryHash: '9'.repeat(64),
        candidateRunId: fixtureLock.candidateRunId,
        lockId: fixtureLock.lockId,
      })
      expect(result.success.bindingHash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.success.lock).toEqual(fixtureLock)
    }
  })

  test('rejects a preregistered bounded dataset that differs from the compiled candidate protocol before lock preparation', () => {
    const result = verifyQualificationCandidateBinding(
      preregistration(),
      { ...candidate, boundedContentHash: 'a'.repeat(64) },
      {
        sourceRevision: config.build.sourceRevision,
        image: { repository: config.build.imageRepository, digest: config.build.imageDigest },
      },
      inspection,
      [],
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationCandidateBindingMismatch',
        field: 'marketData.boundedContentHash',
        expected: compiledBoundedContentHash,
        observed: 'a'.repeat(64),
      },
    })
  })

  test('uses the preregistered candidate definition and provenance rather than the live plan definition', () => {
    const candidateProvenance = makeTestProvenance(fixtureProtocol, { behaviorHash: 'e'.repeat(64) })
    const candidateRuntime = {
      ...candidate,
      provenance: candidateProvenance,
      moduleSha256: 'e'.repeat(64),
    }
    const registration = preregistration({
      strategyProtocolHash: makeStrategyProtocolHash(candidateProvenance.strategy),
      moduleSha256: 'e'.repeat(64),
    })
    const result = verifyQualificationCandidateBinding(
      registration,
      candidateRuntime,
      {
        sourceRevision: config.build.sourceRevision,
        image: { repository: config.build.imageRepository, digest: config.build.imageDigest },
      },
      inspection,
      [],
    )

    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(result.success.lock.protocolHash).toBe(makeStrategyProtocolHash(candidateProvenance.strategy))
      expect(result.success.lock.protocolHash).not.toBe(fixtureLock.protocolHash)
    }
  })

  test.each([
    ['ordinal lineage', preregistration({ candidateOrdinal: 2 }), [], 'preregistration.candidateOrdinal'],
    ['database trial lineage', preregistration(), ['5'.repeat(64)], 'database.priorTrialCount'],
    ['strategy protocol', preregistration({ strategyProtocolHash: '6'.repeat(64) }), [], 'strategyProtocolHash'],
    [
      'snapshot identity',
      preregistration({
        marketData: { ...preregistration().marketData, snapshotId: '0'.repeat(64) },
      }),
      [],
      'marketData.snapshotId',
    ],
    [
      'finalized content',
      preregistration({
        marketData: { ...preregistration().marketData, finalizedSnapshotContentHash: '8'.repeat(64) },
      }),
      [],
      'marketData.finalizedSnapshotContentHash',
    ],
    [
      'input manifest',
      preregistration({
        marketData: { ...preregistration().marketData, inputManifestHash: '9'.repeat(64) },
      }),
      [],
      'marketData.inputManifestHash',
    ],
  ] as const)('rejects changed %s before a lock can be requested', (_name, registration, priorTrials, field) => {
    const result = verifyQualificationCandidateBinding(
      registration,
      candidate,
      {
        sourceRevision: config.build.sourceRevision,
        image: { repository: config.build.imageRepository, digest: config.build.imageDigest },
      },
      inspection,
      priorTrials,
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'QualificationCandidateBindingMismatch', field },
    })
  })
})
