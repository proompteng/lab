import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { decideArtifactPageRequest, decodeRunId } from './read-decisions'

const runId = 'a'.repeat(64)

describe('evidence read input decisions', () => {
  test('normalizes the first page and preserves an explicit continuation', () => {
    const first = decideArtifactPageRequest({ runId, artifactName: 'equity-series', limit: 64 })
    const continued = decideArtifactPageRequest({
      runId,
      artifactName: 'equity-series',
      afterOrdinal: 63,
      limit: 64,
    })

    expect(Result.isSuccess(first)).toBe(true)
    expect(Result.isSuccess(continued)).toBe(true)
    if (Result.isSuccess(first)) expect(first.success.afterOrdinal).toBe(-1)
    if (Result.isSuccess(continued)) expect(continued.success.afterOrdinal).toBe(63)
  })

  test('returns typed failures for every invalid SQL input before query execution', () => {
    const failures = [
      decodeRunId('not-a-run-id'),
      decideArtifactPageRequest({ runId, artifactName: '', limit: 1 }),
      decideArtifactPageRequest({ runId, artifactName: ' spaced ', limit: 1 }),
      decideArtifactPageRequest({ runId, artifactName: 'artifact', afterOrdinal: -2, limit: 1 }),
      decideArtifactPageRequest({ runId, artifactName: 'artifact', afterOrdinal: 1.5, limit: 1 }),
      decideArtifactPageRequest({ runId, artifactName: 'artifact', limit: 0 }),
      decideArtifactPageRequest({ runId, artifactName: 'artifact', limit: 257 }),
    ]

    expect(failures.every((result) => result._tag === 'Failure')).toBe(true)
    expect(failures.map((result) => (result._tag === 'Failure' ? result.failure._tag : 'success'))).toEqual([
      'InvalidRunId',
      'InvalidArtifactName',
      'InvalidArtifactName',
      'InvalidAfterOrdinal',
      'InvalidAfterOrdinal',
      'InvalidPageLimit',
      'InvalidPageLimit',
    ])
  })
})
