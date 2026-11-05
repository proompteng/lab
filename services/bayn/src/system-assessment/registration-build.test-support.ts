import { Result } from 'effect'

import { Authority, makeResearchCapitalGrantGenerationResult } from '../execution/contracts'
import { researchCapitalGrantProof } from '../execution/configuration'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { makeResearchCapitalActivationRequest, makeResearchCapitalPlanHash } from '../execution/configuration'
import { registrationFixture, withRegistrationCommitments } from './fixtures.test-support'

export const registrationBuildFixture = () => {
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
  const { schemaVersion: _proofSchema, ...proof } = researchCapitalGrantProof(request)
  const generation = Result.getOrThrow(
    makeResearchCapitalGrantGenerationResult({
      ...proof,
      schemaVersion: 'bayn.paper-authority-generation.v3',
      maximum: Authority.Execution,
      previousGenerationHash: '1'.repeat(64),
      reconciliationId: '2'.repeat(64),
      reconciliationContentHash: '3'.repeat(64),
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
      p.policy === 'JEV'
        ? {
            ...p,
            authorityGenerationHash: generation.generationHash,
            capitalAuthorization: { request, buildLineage, generation },
          }
        : p,
    ),
  })
  return { base, registered, request, buildLineage, generation, broker }
}
