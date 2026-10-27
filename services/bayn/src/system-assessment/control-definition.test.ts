import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { JevResearchPolicy } from '../jev/acceptance'
import { defaultIntradayMomentumProtocolDocument } from '../strategy/intraday-momentum/protocol'
import { registrationFixture, testHash } from './fixtures.test-support'
import { frozenDeployedControlIdentity, validateSystemRegistration } from './policy'

test('the registered deployed control retains its original identity when the candidate changes', () => {
  const original = registrationFixture()
  const revised = {
    ...original,
    policies: original.policies.map((policy) =>
      policy.policy === JevResearchPolicy.Candidate
        ? { ...policy, strategyHash: testHash('another prospective candidate') }
        : policy,
    ),
  }
  expect(Result.isSuccess(validateSystemRegistration(original))).toBe(true)
  expect(Result.isSuccess(validateSystemRegistration(revised))).toBe(true)
  expect(revised.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)).toMatchObject(
    frozenDeployedControlIdentity,
  )
})

test('a candidate or unrelated strategy cannot be relabeled as the deployed matched control', () => {
  const registration = registrationFixture()
  const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
  if (candidate === undefined) throw new Error('Missing candidate fixture')
  for (const fields of [
    { strategyHash: candidate.strategyHash },
    { parametersHash: candidate.parametersHash },
    { protocolHash: candidate.protocolHash },
    { ...frozenDeployedControlIdentity, strategyHash: testHash('unrelated control') },
  ]) {
    const result = validateSystemRegistration({
      ...registration,
      policies: registration.policies.map((policy) =>
        policy.policy === JevResearchPolicy.Deployed ? { ...policy, ...fields } : policy,
      ),
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({ message: expect.stringContaining('frozen pre-Jev') })
  }
})

test('the current retained momentum protocol cannot substitute for the frozen deployed parameters', () => {
  const registration = registrationFixture()
  const currentParameters = testHash(defaultIntradayMomentumProtocolDocument)
  expect(currentParameters).not.toBe(frozenDeployedControlIdentity.parametersHash)
  const result = validateSystemRegistration({
    ...registration,
    policies: registration.policies.map((policy) =>
      policy.policy === JevResearchPolicy.Deployed ? { ...policy, parametersHash: currentParameters } : policy,
    ),
  })
  expect(Result.isFailure(result)).toBe(true)
})
