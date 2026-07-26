import { expect, test } from 'bun:test'

import { Result } from 'effect'

import { canonicalHashResult, type PaperCandidateDiscoveryError } from './failure'

test('paper candidate hashing retains closed canonical failure facts', () => {
  const result = canonicalHashResult(
    { cycleId: '\ud800' },
    (cause): PaperCandidateDiscoveryError => ({
      _tag: 'BindingHashFailed',
      failure: 'output',
      cycleId: 'cycle-1',
      documentContentHash: 'a'.repeat(64),
      cause,
    }),
  )

  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toEqual({
      _tag: 'BindingHashFailed',
      failure: 'output',
      cycleId: 'cycle-1',
      documentContentHash: 'a'.repeat(64),
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.cycleId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
  }
})
