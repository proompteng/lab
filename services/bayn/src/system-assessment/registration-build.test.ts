import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { withRegistrationCommitments } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'
import { controllerBuildMatchesRegistration, type ControllerPassEvidence } from './decision-work'
import { registrationBuildFixture } from './registration-build.test-support'

test('a prospective physical build retains the exact original mandate through its saved lineage', () => {
  const { base, registered, request, buildLineage, generation } = registrationBuildFixture()
  expect(Result.isSuccess(validateSystemRegistration(registered))).toBe(true)
  for (const changed of [
    { ...buildLineage, requestHash: 'f'.repeat(64) },
    {
      ...buildLineage,
      activation: { ...buildLineage.activation, imageRepository: 'registry.example.test/foreign/bayn' },
    },
    { ...buildLineage, authoredActivation: { ...request.activation, sourceRevision: 'f'.repeat(40) } },
    { ...buildLineage, activation: { ...buildLineage.activation, sourceRevision: 'f'.repeat(40) } },
    { ...buildLineage, activation: { ...buildLineage.activation, imageDigest: `sha256:${'f'.repeat(64)}` } },
  ]) {
    const invalid = withRegistrationCommitments({
      ...base,
      policies: base.policies.map((p) =>
        p.policy === 'JEV'
          ? {
              ...p,
              authorityGenerationHash: generation.generationHash,
              capitalAuthorization: { request, buildLineage: changed, generation },
            }
          : p,
      ),
    })
    expect(Result.isFailure(validateSystemRegistration(invalid))).toBe(true)
  }
  expect(Result.isSuccess(validateSystemRegistration(base))).toBe(true)
})

test('physical worker repository must match registered lineage while retained registrations remain compatible', () => {
  const { base, registered, buildLineage, broker } = registrationBuildFixture()
  const planHash = registered.obligations.configuration.controllerPlanHash
  if (planHash === null) throw new Error('Missing controller plan')
  const pass: ControllerPassEvidence = {
    controllerKey: broker.identityHash,
    planHash,
    epoch: 1,
    sequence: 1,
    receiptHash: 'c'.repeat(64),
    completedAt: registered.registeredAt,
    observation: {
      result: 'SUCCESS',
      outcome: 'WINDOW_CLOSED',
      observedAt: registered.registeredAt,
      executionBuild: buildLineage.activation,
    },
  }
  expect(controllerBuildMatchesRegistration(pass, registered)).toBe(true)
  const foreignRepository = {
    ...pass,
    observation: {
      ...pass.observation,
      executionBuild: { ...buildLineage.activation, imageRepository: 'registry.example.test/foreign/bayn' },
    },
  }
  expect(controllerBuildMatchesRegistration(foreignRepository, registered)).toBe(false)
  // Retained registrations have no repository commitment to compare.
  expect(controllerBuildMatchesRegistration(foreignRepository, base)).toBe(true)
})
