import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { makeResearchCapitalActivationRequest, makeResearchCapitalPlanHash } from '../execution/configuration'
import { registrationFixture, withRegistrationCommitments } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'

test('a prospective physical build retains the exact original mandate through its saved lineage', () => {
  const base = registrationFixture()
  const candidate = base.policies.find((p) => p.policy === 'JEV')
  if (candidate === undefined) throw new Error('Missing candidate')
  const broker = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: candidate.riskPolicy.accountId,
    }),
  )
  const material = {
    activation: {
      sourceRevision: '0'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${'0'.repeat(64)}`,
    },
    strategy: {
      name: 'jev',
      behaviorHash: candidate.strategyHash,
      parameterHash: candidate.parametersHash,
      parameterSchemaVersion: base.obligations.configuration.protocol.schemaVersion,
      protocolHash: candidate.protocolHash,
    },
    broker: { environment: broker.environment, accountId: broker.accountId, identityHash: broker.identityHash },
    riskPolicyHash: candidate.riskPolicyHash,
    limits: { maxOpenOrders: 0, maxPositions: 0 },
  } as const
  const planHash = Result.getOrThrow(
    makeResearchCapitalPlanHash({ schemaVersion: 'bayn.research-execution-plan.v1', ...material }),
  )
  const request = Result.getOrThrow(
    makeResearchCapitalActivationRequest({
      schemaVersion: 'bayn.research-execution-mandate.v1',
      grant: { _tag: 'Research', planHash },
      ...material,
    }),
  )
  const buildLineage = {
    schemaVersion: 'bayn.research-capital-build-lineage.v1' as const,
    requestHash: request.requestHash,
    authoredActivation: request.activation,
    activation: {
      sourceRevision: candidate.sourceRevision,
      imageRepository: request.activation.imageRepository,
      imageDigest: `sha256:${candidate.imageDigest}`,
    },
  }
  const registered = withRegistrationCommitments({
    ...base,
    policies: base.policies.map((p) =>
      p.policy === 'JEV' ? { ...p, capitalAuthorization: { request, buildLineage } } : p,
    ),
  })
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
        p.policy === 'JEV' ? { ...p, capitalAuthorization: { request, buildLineage: changed } } : p,
      ),
    })
    expect(Result.isFailure(validateSystemRegistration(invalid))).toBe(true)
  }
  expect(Result.isSuccess(validateSystemRegistration(base))).toBe(true)
})
