import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { JevResearchPolicy } from '../jev/acceptance'
import { validateSystemRegistration } from './policy'
import { registrationFixture } from './fixtures.test-support'

test('prospective registration rejects a relabeled ablation identity, prompts or execution model', () => {
  const registration = registrationFixture()
  expect(Result.isSuccess(validateSystemRegistration(registration))).toBe(true)
  const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
  if (candidate === undefined) throw new Error('Fixture must have a candidate')
  for (const field of [
    'strategyHash',
    'parametersHash',
    'protocolHash',
    'promptsHash',
    'executionModelHash',
  ] as const) {
    const result = validateSystemRegistration({
      ...registration,
      policies: registration.policies.map((policy) =>
        policy.policy === JevResearchPolicy.Ablation ? { ...policy, [field]: candidate[field] } : policy,
      ),
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        message: 'Ablation must bind its complete source-defined policy and the candidate execution model',
      })
  }
})
