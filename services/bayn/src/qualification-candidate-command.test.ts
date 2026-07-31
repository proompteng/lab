import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import type { ApplicationIdentity } from './app'
import { config, fixtureLock, fixtureSnapshot, fixtureStrategy, provenance } from './app-test-support'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import type { LoadedRuntimeConfig } from './config'
import { BrokerAccess, noCapitalAuthority } from './execution/authority'
import { marketDataService } from './app-test-support'
import { verifyQualificationCandidateBinding } from './qualification-candidate-command'
import { fixtureProtocol } from './test-fixtures'

const inspection = Effect.runSync(marketDataService(Effect.succeed(fixtureSnapshot)).inspect)
const compiledBoundedContentHash = '2'.repeat(64)

const loadedConfig: LoadedRuntimeConfig = {
  ...config,
  runtimeMode: 'BrokerlessService',
  cyclePollIntervalMs: 30_000,
  alpaca: undefined,
  execution: {
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
}

const identity: ApplicationIdentity = {
  config: loadedConfig,
  protocol: fixtureProtocol,
  parameterHash: provenance.strategy.parameterHash,
  strategy: fixtureStrategy,
  strategyProtocolHash: fixtureLock.protocolHash,
}

const preregistration = (
  overrides: Partial<CandidateDevelopmentNextPreregistration> = {},
): CandidateDevelopmentNextPreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 1,
  priorTrialCount: 0,
  strategyProtocolHash: identity.strategyProtocolHash,
  modulePath: 'services/bayn/src/strategy/candidate-17.ts',
  moduleSha256: '1'.repeat(64),
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
  test('prepares the exact production lock from immutable metadata without loading bars or writing', () => {
    const result = verifyQualificationCandidateBinding(
      preregistration(),
      compiledBoundedContentHash,
      identity,
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
        committedBoundedContentHash: compiledBoundedContentHash,
        compiledBoundedContentHash,
        candidateRunId: fixtureLock.candidateRunId,
        lockId: fixtureLock.lockId,
      })
      expect(result.success.bindingHash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.success.lock).toEqual(fixtureLock)
    }
  })

  test('rejects a preregistered bounded dataset that differs from the compiled candidate protocol before lock preparation', () => {
    const result = verifyQualificationCandidateBinding(preregistration(), 'a'.repeat(64), identity, inspection, [])

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationCandidateBindingMismatch',
        field: 'marketData.boundedContentHash',
        expected: 'a'.repeat(64),
        observed: compiledBoundedContentHash,
      },
    })
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
      compiledBoundedContentHash,
      identity,
      inspection,
      priorTrials,
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'QualificationCandidateBindingMismatch', field },
    })
  })
})
