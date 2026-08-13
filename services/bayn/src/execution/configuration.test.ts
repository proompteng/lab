import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind } from './authority'
import { Authority, makeResearchCapitalGrantGenerationResult } from './contracts'
import {
  CapitalAuthoritySelection,
  decodeCapitalActivationConfigurationResult,
  decodeCapitalActivationRequestResult,
  makeCapitalActivationRequest,
  makeResearchCapitalActivationRequest,
  makeResearchCapitalBuildContinuation,
  makeResearchCapitalPlanHash,
  researchCapitalBuildContinuationIsBound,
  researchCapitalGrantProof,
  researchCapitalGenerationIsBoundToRequest,
  resolveExecutionPolicy,
} from './configuration'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const persistedCapitalGrantHash = '2'.repeat(64)

const identity = (environment: BrokerEnvironment) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId,
    }),
  )

describe('execution policy configuration', () => {
  test('constructs only the behaviorally valid broker and capital combinations', () => {
    const identities = [undefined, identity(BrokerEnvironment.Sandbox), identity(BrokerEnvironment.Live)] as const
    const accesses = [BrokerAccess.ReadOnly, BrokerAccess.Mutation] as const
    const capitals = [CapitalAuthoritySelection.None, CapitalAuthoritySelection.Granted] as const
    const persistedGrantHashes = [undefined, persistedCapitalGrantHash] as const
    const results = identities.flatMap((brokerIdentity) =>
      accesses.flatMap((brokerAccess) =>
        capitals.flatMap((capitalAuthority) =>
          persistedGrantHashes.map((persistedGrantHash) => ({
            environment: brokerIdentity?.environment ?? 'none',
            brokerAccess,
            capitalAuthority,
            persistedGrantHash,
            result: resolveExecutionPolicy({
              brokerIdentity,
              brokerAccess,
              capitalAuthority,
              authorityGenerationHash:
                capitalAuthority === CapitalAuthoritySelection.None ? undefined : authorityGenerationHash,
              persistedCapitalGrantHash: persistedGrantHash,
            }),
          })),
        ),
      ),
    )

    expect(results).toHaveLength(24)
    expect(
      results
        .filter(({ result }) => Result.isSuccess(result))
        .map(({ environment, brokerAccess, capitalAuthority, persistedGrantHash }) => [
          environment,
          brokerAccess,
          capitalAuthority,
          persistedGrantHash,
        ]),
    ).toEqual([
      ['none', BrokerAccess.ReadOnly, CapitalAuthoritySelection.None, undefined],
      [BrokerEnvironment.Sandbox, BrokerAccess.ReadOnly, CapitalAuthoritySelection.None, undefined],
      [BrokerEnvironment.Sandbox, BrokerAccess.Mutation, CapitalAuthoritySelection.Granted, undefined],
      [BrokerEnvironment.Sandbox, BrokerAccess.Mutation, CapitalAuthoritySelection.Granted, persistedCapitalGrantHash],
      [BrokerEnvironment.Live, BrokerAccess.ReadOnly, CapitalAuthoritySelection.None, undefined],
      [BrokerEnvironment.Live, BrokerAccess.Mutation, CapitalAuthoritySelection.Granted, persistedCapitalGrantHash],
    ])
  })

  test('requires explicit bounded references for capital-bearing policies', () => {
    expect(
      resolveExecutionPolicy({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Granted,
        authorityGenerationHash: undefined,
        persistedCapitalGrantHash: undefined,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'GrantedCapitalRequiresAuthorityGeneration' } })
    expect(
      resolveExecutionPolicy({
        brokerIdentity: identity(BrokerEnvironment.Live),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Granted,
        authorityGenerationHash: undefined,
        persistedCapitalGrantHash,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'GrantedCapitalRequiresAuthorityGeneration' } })
    expect(
      resolveExecutionPolicy({
        brokerIdentity: identity(BrokerEnvironment.Live),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Granted,
        authorityGenerationHash,
        persistedCapitalGrantHash: undefined,
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'PersistedCapitalGrantRequired', environment: BrokerEnvironment.Live },
    })
  })

  test('produces one no-capital or granted-capital request for either broker environment', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionPolicy({
          brokerIdentity: undefined,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: CapitalAuthoritySelection.None,
          authorityGenerationHash: undefined,
          persistedCapitalGrantHash: undefined,
        }),
      ).capitalAuthority._tag,
    ).toBe(CapitalAuthorityKind.None)
    expect(
      Result.getOrThrow(
        resolveExecutionPolicy({
          brokerIdentity: identity(BrokerEnvironment.Sandbox),
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.Granted,
          authorityGenerationHash,
          persistedCapitalGrantHash: undefined,
        }),
      ).capitalAuthority._tag,
    ).toBe(CapitalAuthorityKind.Granted)
    expect(
      Result.getOrThrow(
        resolveExecutionPolicy({
          brokerIdentity: identity(BrokerEnvironment.Live),
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.Granted,
          authorityGenerationHash,
          persistedCapitalGrantHash,
        }),
      ).capitalAuthority,
    ).toEqual({
      _tag: CapitalAuthorityKind.Granted,
      authorityGenerationHash,
      persistedGrantHash: persistedCapitalGrantHash,
    })
  })

  test('decodes only a canonical immutable activation request', () => {
    const material = {
      schemaVersion: 'bayn.paper-activation-request.v1' as const,
      qualification: {
        runId: '4'.repeat(64),
        lockId: '5'.repeat(64),
        resultHash: '6'.repeat(64),
        sourceRevision: 'a'.repeat(40),
        imageRepository: 'ghcr.io/proompteng/bayn',
        imageDigest: `sha256:${'7'.repeat(64)}`,
      },
      activation: {
        sourceRevision: 'b'.repeat(40),
        imageRepository: 'ghcr.io/proompteng/bayn',
        imageDigest: `sha256:${'8'.repeat(64)}`,
      },
      strategy: {
        name: 'risk-balanced-trend' as const,
        behaviorHash: '9'.repeat(64),
        parameterHash: 'a'.repeat(64),
        parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4' as const,
        protocolHash: 'b'.repeat(64),
      },
      limits: { maxOpenOrders: 0 as const, maxPositions: 0 as const },
      cutoffAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-28T09:30:00.000Z',
    }
    const request = Result.getOrThrow(makeCapitalActivationRequest(material))
    expect(decodeCapitalActivationRequestResult(request)).toMatchObject({ _tag: 'Success', success: request })
    expect(decodeCapitalActivationRequestResult({ ...request, requestHash: 'c'.repeat(64) })).toMatchObject({
      _tag: 'Failure',
    })
    expect(decodeCapitalActivationRequestResult({ ...request, unexpected: true })).toMatchObject({ _tag: 'Failure' })
  })

  test('decodes a canonical research grant without qualification aliases', () => {
    const sourceGenerationHash = '0'.repeat(64)
    const plan = {
      schemaVersion: 'bayn.paper-research-plan.v1' as const,
      activation: {
        sourceRevision: 'a'.repeat(40),
        imageRepository: 'ghcr.io/proompteng/bayn',
        imageDigest: `sha256:${'3'.repeat(64)}`,
      },
      strategy: {
        name: 'risk-balanced-trend',
        behaviorHash: '4'.repeat(64),
        parameterHash: '5'.repeat(64),
        parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
        protocolHash: '6'.repeat(64),
      },
      broker: {
        environment: BrokerEnvironment.Sandbox,
        accountId,
        identityHash: '7'.repeat(64),
      },
      riskPolicyHash: '8'.repeat(64),
      limits: { maxOpenOrders: 0 as const, maxPositions: 0 as const },
      cutoffAt: '2026-09-01T13:00:00.000Z',
      expiresAt: '2026-09-03T20:00:00.000Z',
      maximumCloseSessions: 3 as const,
    } as const
    const planHash = Result.getOrThrow(makeResearchCapitalPlanHash(plan))
    const { schemaVersion: _planSchemaVersion, ...planFields } = plan
    const generation = Result.getOrThrow(
      makeResearchCapitalGrantGenerationResult({
        schemaVersion: 'bayn.paper-authority-generation.v3',
        maximum: Authority.Execution,
        previousGenerationHash: sourceGenerationHash,
        grant: { _tag: 'Research', planHash },
        activationSourceRevision: 'a'.repeat(40),
        activationImageRepository: 'ghcr.io/proompteng/bayn',
        activationImageDigest: `sha256:${'3'.repeat(64)}`,
        strategyName: 'risk-balanced-trend',
        strategyBehaviorHash: '4'.repeat(64),
        strategyParameterHash: '5'.repeat(64),
        strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
        strategyProtocolHash: '6'.repeat(64),
        accountId,
        brokerIdentityHash: '7'.repeat(64),
        riskPolicyHash: '8'.repeat(64),
        proofPlanHash: planHash,
        reconciliationId: '9'.repeat(64),
        reconciliationContentHash: 'a'.repeat(64),
      }),
    )
    const request = Result.getOrThrow(
      makeResearchCapitalActivationRequest({
        schemaVersion: 'bayn.paper-research-activation-request.v1',
        grant: { _tag: 'Research', planHash },
        ...planFields,
      }),
    )
    expect(decodeCapitalActivationRequestResult(request)).toMatchObject({ _tag: 'Success', success: request })
    expect(decodeCapitalActivationRequestResult({ ...request, grant: { _tag: 'Qualified' } })).toMatchObject({
      _tag: 'Failure',
    })
    expect(decodeCapitalActivationRequestResult({ ...request, maximumCloseSessions: 4 })).toMatchObject({
      _tag: 'Failure',
    })
    expect(
      makeResearchCapitalActivationRequest({
        schemaVersion: 'bayn.paper-research-activation-request.v1',
        grant: { _tag: 'Research', planHash },
        ...planFields,
        cutoffAt: '2026-09-02T13:00:00.000Z',
      }),
    ).toEqual(Result.fail('ResearchCapitalPlanHashMismatch'))
    expect(researchCapitalGrantProof(request)).toMatchObject({
      grant: request.grant,
      proofPlanHash: request.grant.planHash,
    })
    expect(researchCapitalGenerationIsBoundToRequest(request, sourceGenerationHash, generation)).toEqual(
      Result.succeed(undefined),
    )
    expect(researchCapitalGenerationIsBoundToRequest(request, 'f'.repeat(64), generation)).toMatchObject({
      _tag: 'Failure',
    })

    const currentActivation = {
      sourceRevision: 'b'.repeat(40),
      imageRepository: request.activation.imageRepository,
      imageDigest: `sha256:${'c'.repeat(64)}`,
    }
    const continuation = Result.getOrThrow(
      makeResearchCapitalBuildContinuation({
        schemaVersion: 'bayn.paper-research-build-continuation.v1',
        request,
        generationHash: generation.generationHash,
        activation: currentActivation,
      }),
    )
    expect(decodeCapitalActivationConfigurationResult(continuation)).toEqual(Result.succeed(continuation))
    expect(
      researchCapitalBuildContinuationIsBound(continuation, sourceGenerationHash, generation, currentActivation),
    ).toEqual(Result.succeed(undefined))
    expect(
      researchCapitalBuildContinuationIsBound(continuation, sourceGenerationHash, generation, {
        ...currentActivation,
        imageDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).toMatchObject({ _tag: 'Failure' })
    const wrongGenerationContinuation = Result.getOrThrow(
      makeResearchCapitalBuildContinuation({
        schemaVersion: 'bayn.paper-research-build-continuation.v1',
        request,
        generationHash: 'e'.repeat(64),
        activation: currentActivation,
      }),
    )
    expect(
      researchCapitalBuildContinuationIsBound(
        wrongGenerationContinuation,
        sourceGenerationHash,
        generation,
        currentActivation,
      ),
    ).toMatchObject({ _tag: 'Failure' })
    expect(
      decodeCapitalActivationConfigurationResult({
        ...continuation,
        generationHash: 'e'.repeat(64),
      }),
    ).toMatchObject({ _tag: 'Failure' })
    expect(
      makeResearchCapitalBuildContinuation({
        schemaVersion: 'bayn.paper-research-build-continuation.v1',
        request,
        generationHash: generation.generationHash,
        activation: { ...currentActivation, imageRepository: 'ghcr.io/other/bayn' },
      }),
    ).toEqual(Result.fail('ResearchCapitalBuildContinuationCanonicalizationFailed'))
  })
})
