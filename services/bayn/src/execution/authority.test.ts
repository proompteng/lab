import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  liveCapitalAuthority,
  makeExecutionAuthority,
  makeLiveCapitalGrant,
  noCapitalAuthority,
  sandboxCapitalAuthority,
  type CapitalAuthority,
  type ExecutionStrategyIdentity,
  type LiveCapitalGrant,
} from './authority'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const observedAt = '2026-07-28T08:00:00.000Z'
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}

const identity = (environment: BrokerEnvironment, identityAccountId = accountId) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId: identityAccountId,
    }),
  )

const liveIdentity = identity(BrokerEnvironment.Live)
const sandboxIdentity = identity(BrokerEnvironment.Sandbox)

const liveGrant = (overrides: Partial<Parameters<typeof makeLiveCapitalGrant>[0]> = {}): LiveCapitalGrant =>
  Result.getOrThrow(
    makeLiveCapitalGrant({
      schemaVersion: 'bayn.live-capital-grant.v1',
      brokerIdentity: liveIdentity,
      authorityGenerationHash,
      strategy,
      limits: {
        maxGrossNotionalMicros: '100000000000',
        maxOrderNotionalMicros: '10000000000',
        maxPositionNotionalMicros: '25000000000',
        maxDailyLossMicros: '1000000000',
        maxOpenOrders: 5,
      },
      validFrom: '2026-07-28T07:00:00.000Z',
      validUntil: '2026-07-28T09:00:00.000Z',
      issuedAt: '2026-07-28T06:00:00.000Z',
      issuedBy: 'operator:test',
      ...overrides,
    }),
  )

const authorities = [
  noCapitalAuthority,
  sandboxCapitalAuthority(authorityGenerationHash),
  liveCapitalAuthority(liveGrant()),
] as const satisfies readonly CapitalAuthority[]

const construct = (environment: BrokerEnvironment, brokerAccess: BrokerAccess, capitalAuthority: CapitalAuthority) =>
  makeExecutionAuthority({
    brokerIdentity: environment === BrokerEnvironment.Sandbox ? sandboxIdentity : liveIdentity,
    brokerAccess,
    capitalAuthority,
    strategy,
    observedAt,
  })

describe('execution authority construction', () => {
  test('accepts only the four safe environment, access, and capital combinations', () => {
    const cases = [BrokerEnvironment.Sandbox, BrokerEnvironment.Live].flatMap((environment) =>
      [BrokerAccess.ReadOnly, BrokerAccess.Mutation].flatMap((brokerAccess) =>
        authorities.map((capitalAuthority) => ({
          environment,
          brokerAccess,
          capitalAuthority: capitalAuthority._tag,
          result: construct(environment, brokerAccess, capitalAuthority),
        })),
      ),
    )

    expect(cases).toHaveLength(12)
    expect(
      cases
        .filter(({ result }) => Result.isSuccess(result))
        .map(({ environment, brokerAccess, capitalAuthority }) => [environment, brokerAccess, capitalAuthority]),
    ).toEqual([
      [BrokerEnvironment.Sandbox, BrokerAccess.ReadOnly, CapitalAuthorityKind.None],
      [BrokerEnvironment.Sandbox, BrokerAccess.Mutation, CapitalAuthorityKind.Sandbox],
      [BrokerEnvironment.Live, BrokerAccess.ReadOnly, CapitalAuthorityKind.None],
      [BrokerEnvironment.Live, BrokerAccess.Mutation, CapitalAuthorityKind.LiveGrant],
    ])
  })

  test('makes mutation authority impossible to obtain from a read-only broker', () => {
    expect(
      construct(BrokerEnvironment.Sandbox, BrokerAccess.ReadOnly, sandboxCapitalAuthority(authorityGenerationHash)),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'ReadOnlyBrokerRequiresNoCapital',
        capitalAuthority: CapitalAuthorityKind.Sandbox,
      },
    })
  })

  test('makes a sandbox identity incapable of satisfying a live grant', () => {
    expect(
      makeExecutionAuthority({
        brokerIdentity: sandboxIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: liveCapitalAuthority(liveGrant()),
        strategy,
        observedAt,
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'SandboxBrokerRequiresSandboxCapital',
        capitalAuthority: CapitalAuthorityKind.LiveGrant,
      },
    })
  })

  test('fails closed for revoked, expired, not-yet-valid, and mismatched live grants', () => {
    const revoked = makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: liveCapitalAuthority(liveGrant(), {
        schemaVersion: 'bayn.live-capital-grant-revocation.v1',
        revokedAt: '2026-07-28T07:30:00.000Z',
        revokedBy: 'operator:test',
        reason: 'manual containment',
      }),
      strategy,
      observedAt,
    })
    const expired = makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: liveCapitalAuthority(
        liveGrant({
          issuedAt: '2026-07-28T04:00:00.000Z',
          validFrom: '2026-07-28T05:00:00.000Z',
          validUntil: '2026-07-28T07:00:00.000Z',
        }),
      ),
      strategy,
      observedAt,
    })
    const notYetValid = makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: liveCapitalAuthority(
        liveGrant({
          issuedAt: '2026-07-28T08:30:00.000Z',
          validFrom: '2026-07-28T09:00:00.000Z',
          validUntil: '2026-07-28T10:00:00.000Z',
        }),
      ),
      strategy,
      observedAt,
    })
    const mismatchedStrategy = makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: liveCapitalAuthority(liveGrant()),
      strategy: { ...strategy, parameterHash: '4'.repeat(64) },
      observedAt,
    })
    const otherLiveIdentity = identity(BrokerEnvironment.Live, '99ae87fc-a13b-47b4-a502-cbb980bc07de')
    const mismatchedAccount = makeExecutionAuthority({
      brokerIdentity: otherLiveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: liveCapitalAuthority(liveGrant()),
      strategy,
      observedAt,
    })

    expect(revoked).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LiveGrantRevoked' } })
    expect(expired).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LiveGrantExpired' } })
    expect(notYetValid).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LiveGrantNotYetValid' } })
    expect(mismatchedStrategy).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LiveGrantStrategyMismatch' } })
    expect(mismatchedAccount).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'LiveGrantBrokerIdentityMismatch' },
    })
  })
})
