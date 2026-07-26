import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  acceptQualificationLocks,
  compareReplicaObservations,
  makeCandidateRuntime,
  validateCandidateEndpoints,
} from './domain'
import {
  candidateEndpoints,
  candidateInput,
  candidateObservations,
  candidateReplicaEndpoints,
  candidateSnapshot,
} from './test-fixtures'

const resultValue = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error(`expected Success, received ${String(result.failure)}`)
  return result.success
}

const resultFailure = <A, E>(result: Result.Result<A, E>): E => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('expected Failure')
  return result.failure
}

describe('qualification candidate decisions', () => {
  test.each([
    {
      name: 'wrong count',
      urls: [candidateEndpoints[0]],
      expected: { _tag: 'ReplicaEndpointCountMismatch', observed: 1 },
    },
    {
      name: 'duplicate endpoint',
      urls: [candidateEndpoints[0], candidateEndpoints[0]],
      expected: { _tag: 'ReplicaEndpointDuplicate' },
    },
    {
      name: 'duplicate host',
      urls: [candidateEndpoints[0], new URL('https://signal-clickhouse-0.signal.svc:8443')],
      expected: { _tag: 'ReplicaEndpointHostDuplicate' },
    },
    {
      name: 'credential-bearing origin',
      urls: [new URL('http://signal_publisher:secret@signal-clickhouse-0.signal.svc:8123'), candidateEndpoints[1]],
      expected: { _tag: 'ReplicaEndpointInvalidOrigin' },
    },
  ])('returns a concrete failure for $name', ({ urls, expected }) => {
    expect(resultFailure(validateCandidateEndpoints(urls))).toMatchObject(expected)
  })

  test('returns the exact validated endpoint pair', () => {
    expect(resultValue(validateCandidateEndpoints(candidateEndpoints))).toEqual(candidateReplicaEndpoints)
  })

  test.each([
    {
      name: 'cluster ID',
      overrides: { tigerBeetleClusterId: '0' },
      expected: 'TigerBeetleClusterIdOutOfRange',
    },
    {
      name: 'transport addresses',
      overrides: { tigerBeetleAddresses: 'ledger-0:3000, ledger-1:3000' },
      expected: 'TigerBeetleAddressesInvalidFormat',
    },
    {
      name: 'ledger',
      overrides: { tigerBeetleLedger: String(2 ** 32) },
      expected: 'TigerBeetleLedgerOutOfRange',
    },
  ])('rejects invalid $name without throwing', ({ overrides, expected }) => {
    expect(resultFailure(makeCandidateRuntime(candidateInput(overrides), candidateSnapshot))._tag).toBe(expected)
  })

  test('reports every snapshot contract mismatch as data', () => {
    const changed = {
      ...candidateSnapshot,
      manifest: {
        ...candidateSnapshot.manifest,
        bounds: {
          ...candidateSnapshot.manifest.bounds,
          dataEnd: '2020-01-02' as const,
          evaluationEnd: '2020-01-02' as const,
        },
      },
    }

    expect(resultFailure(makeCandidateRuntime(candidateInput(), changed))).toMatchObject({
      _tag: 'SnapshotContractMismatch',
      fields: [
        { field: 'dataEnd', observed: '2020-01-02' },
        { field: 'evaluationEnd', observed: '2020-01-02' },
      ],
    })
  })

  test.each([
    {
      name: 'duplicate physical identity',
      observations: candidateObservations([{}, { replica: 'chi-torghut-clickhouse-default-0-0-0' }]),
      expected: 'ReplicaIdentityDuplicate',
    },
    {
      name: 'unexpected physical identity',
      observations: candidateObservations([{}, { replica: 'chi-another-clickhouse-default-0-1-0' }]),
      expected: 'ReplicaIdentitySetMismatch',
    },
    {
      name: 'wrong principal',
      observations: candidateObservations([{}, { principal: 'bayn' }]),
      expected: 'ReplicaPrincipalMismatch',
    },
  ])('rejects $name before candidate runtime construction', ({ observations, expected }) => {
    expect(
      resultFailure(compareReplicaObservations(candidateInput(), candidateReplicaEndpoints, observations))._tag,
    ).toBe(expected)
  })

  test('returns deterministic consensus for two identical physical snapshots', () => {
    const consensus = resultValue(
      compareReplicaObservations(candidateInput(), candidateReplicaEndpoints, candidateObservations()),
    )

    expect(consensus.snapshotCanonicalHash).toHaveLength(64)
    expect(consensus.replicas.map(({ replica }) => replica)).toEqual([
      'chi-torghut-clickhouse-default-0-0-0',
      'chi-torghut-clickhouse-default-0-1-0',
    ])
    expect(new Set(consensus.replicas.map(({ snapshotCanonicalHash }) => snapshotCanonicalHash)).size).toBe(1)
  })

  test('turns canonicalization defects into a concrete failure', () => {
    const malformed = {
      ...candidateSnapshot,
      manifest: {
        ...candidateSnapshot.manifest,
        finalizedSnapshot: {
          ...candidateSnapshot.manifest.finalizedSnapshot,
          calendarVersion: '\ud800',
        },
      },
    }

    expect(
      resultFailure(
        compareReplicaObservations(
          candidateInput(),
          candidateReplicaEndpoints,
          candidateObservations([{ snapshot: malformed }, { snapshot: malformed }]),
        ),
      ),
    ).toMatchObject({ _tag: 'CanonicalizationFailed', subject: 'snapshot' })
  })

  test('accepts only an unused snapshot observed through a read-only transaction', () => {
    const consensus = resultValue(
      compareReplicaObservations(candidateInput(), candidateReplicaEndpoints, candidateObservations()),
    )

    expect(resultValue(acceptQualificationLocks(consensus, { transactionReadOnly: true, count: 0 }))).toMatchObject({
      qualificationLockCount: 0,
    })
    expect(resultFailure(acceptQualificationLocks(consensus, { transactionReadOnly: false, count: 0 }))._tag).toBe(
      'QualificationLockCheckNotReadOnly',
    )
    expect(resultFailure(acceptQualificationLocks(consensus, { transactionReadOnly: true, count: 1 }))).toMatchObject({
      _tag: 'SnapshotAlreadyConsumed',
      count: 1,
    })
  })
})
