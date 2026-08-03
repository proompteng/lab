import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind } from './authority'
import {
  CapitalAuthoritySelection,
  decodePaperActivationRequestResult,
  makePaperActivationRequest,
  resolveExecutionPolicy,
} from './configuration'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const liveCapitalGrantHash = '2'.repeat(64)

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
    const capitals = [
      CapitalAuthoritySelection.None,
      CapitalAuthoritySelection.Sandbox,
      CapitalAuthoritySelection.LiveGrant,
    ] as const
    const results = identities.flatMap((brokerIdentity) =>
      accesses.flatMap((brokerAccess) =>
        capitals.map((capitalAuthority) => ({
          environment: brokerIdentity?.environment ?? 'none',
          brokerAccess,
          capitalAuthority,
          result: resolveExecutionPolicy({
            brokerIdentity,
            brokerAccess,
            capitalAuthority,
            authorityGenerationHash:
              capitalAuthority === CapitalAuthoritySelection.None ? undefined : authorityGenerationHash,
            liveCapitalGrantHash:
              capitalAuthority === CapitalAuthoritySelection.LiveGrant ? liveCapitalGrantHash : undefined,
          }),
        })),
      ),
    )

    expect(results).toHaveLength(18)
    expect(
      results
        .filter(({ result }) => Result.isSuccess(result))
        .map(({ environment, brokerAccess, capitalAuthority }) => [environment, brokerAccess, capitalAuthority]),
    ).toEqual([
      ['none', BrokerAccess.ReadOnly, CapitalAuthoritySelection.None],
      [BrokerEnvironment.Sandbox, BrokerAccess.ReadOnly, CapitalAuthoritySelection.None],
      [BrokerEnvironment.Sandbox, BrokerAccess.Mutation, CapitalAuthoritySelection.Sandbox],
      [BrokerEnvironment.Live, BrokerAccess.ReadOnly, CapitalAuthoritySelection.None],
      [BrokerEnvironment.Live, BrokerAccess.Mutation, CapitalAuthoritySelection.LiveGrant],
    ])
  })

  test('requires explicit bounded references for capital-bearing policies', () => {
    expect(
      resolveExecutionPolicy({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
        authorityGenerationHash: undefined,
        liveCapitalGrantHash: undefined,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SandboxCapitalRequiresAuthorityGeneration' } })
    expect(
      resolveExecutionPolicy({
        brokerIdentity: identity(BrokerEnvironment.Live),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.LiveGrant,
        authorityGenerationHash: undefined,
        liveCapitalGrantHash,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LiveCapitalRequiresAuthorityGeneration' } })
    expect(
      resolveExecutionPolicy({
        brokerIdentity: identity(BrokerEnvironment.Live),
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.LiveGrant,
        authorityGenerationHash,
        liveCapitalGrantHash: undefined,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LiveCapitalRequiresGrantHash' } })
  })

  test('produces no-capital, sandbox-capital, and live-grant requests without compatibility aliases', () => {
    expect(
      Result.getOrThrow(
        resolveExecutionPolicy({
          brokerIdentity: undefined,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: CapitalAuthoritySelection.None,
          authorityGenerationHash: undefined,
          liveCapitalGrantHash: undefined,
        }),
      ).capitalAuthority._tag,
    ).toBe(CapitalAuthorityKind.None)
    expect(
      Result.getOrThrow(
        resolveExecutionPolicy({
          brokerIdentity: identity(BrokerEnvironment.Sandbox),
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.Sandbox,
          authorityGenerationHash,
          liveCapitalGrantHash: undefined,
        }),
      ).capitalAuthority._tag,
    ).toBe(CapitalAuthorityKind.Sandbox)
    expect(
      Result.getOrThrow(
        resolveExecutionPolicy({
          brokerIdentity: identity(BrokerEnvironment.Live),
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.LiveGrant,
          authorityGenerationHash,
          liveCapitalGrantHash,
        }),
      ).capitalAuthority,
    ).toEqual({
      _tag: CapitalAuthorityKind.LiveGrant,
      grantHash: liveCapitalGrantHash,
      authorityGenerationHash,
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
    const request = Result.getOrThrow(makePaperActivationRequest(material))
    expect(decodePaperActivationRequestResult(request)).toMatchObject({ _tag: 'Success', success: request })
    expect(decodePaperActivationRequestResult({ ...request, requestHash: 'c'.repeat(64) })).toMatchObject({
      _tag: 'Failure',
    })
    expect(decodePaperActivationRequestResult({ ...request, unexpected: true })).toMatchObject({ _tag: 'Failure' })
  })
})
