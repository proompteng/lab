import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  grantedCapitalAuthority,
  makeExecutionAuthority,
  makeCapitalGrantRecord,
  noCapitalAuthority,
  type CapitalAuthority,
  type ExecutionStrategyIdentity,
  type CapitalGrantRecord,
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

const persistedGrantRecord = (
  overrides: Partial<Parameters<typeof makeCapitalGrantRecord>[0]> = {},
): CapitalGrantRecord =>
  Result.getOrThrow(
    makeCapitalGrantRecord({
      schemaVersion: 'bayn.capital-grant.v2',
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

const construct = (environment: BrokerEnvironment, brokerAccess: BrokerAccess, capitalAuthority: CapitalAuthority) =>
  makeExecutionAuthority({
    brokerIdentity: environment === BrokerEnvironment.Sandbox ? sandboxIdentity : liveIdentity,
    brokerAccess,
    capitalAuthority,
    strategy,
    observedAt,
  })

describe('execution authority construction', () => {
  test('accepts the same safe access and capital combinations for both environments', () => {
    const cases = [BrokerEnvironment.Sandbox, BrokerEnvironment.Live].flatMap((environment) =>
      [BrokerAccess.ReadOnly, BrokerAccess.Mutation].flatMap((brokerAccess) =>
        [
          noCapitalAuthority,
          grantedCapitalAuthority(authorityGenerationHash),
          grantedCapitalAuthority(
            persistedGrantRecord({
              brokerIdentity: environment === BrokerEnvironment.Sandbox ? sandboxIdentity : liveIdentity,
            }),
          ),
        ].map((capitalAuthority) => ({
          environment,
          brokerAccess,
          capitalAuthority: capitalAuthority._tag,
          persisted:
            capitalAuthority._tag === CapitalAuthorityKind.Granted && capitalAuthority.persistedGrant !== undefined,
          result: construct(environment, brokerAccess, capitalAuthority),
        })),
      ),
    )

    expect(cases).toHaveLength(12)
    expect(
      cases
        .filter(({ result }) => Result.isSuccess(result))
        .map(({ environment, brokerAccess, capitalAuthority, persisted }) => [
          environment,
          brokerAccess,
          capitalAuthority,
          persisted,
        ]),
    ).toEqual([
      [BrokerEnvironment.Sandbox, BrokerAccess.ReadOnly, CapitalAuthorityKind.None, false],
      [BrokerEnvironment.Sandbox, BrokerAccess.Mutation, CapitalAuthorityKind.Granted, false],
      [BrokerEnvironment.Sandbox, BrokerAccess.Mutation, CapitalAuthorityKind.Granted, true],
      [BrokerEnvironment.Live, BrokerAccess.ReadOnly, CapitalAuthorityKind.None, false],
      [BrokerEnvironment.Live, BrokerAccess.Mutation, CapitalAuthorityKind.Granted, false],
      [BrokerEnvironment.Live, BrokerAccess.Mutation, CapitalAuthorityKind.Granted, true],
    ])
  })

  test('makes mutation authority impossible to obtain from a read-only broker', () => {
    expect(
      construct(BrokerEnvironment.Sandbox, BrokerAccess.ReadOnly, grantedCapitalAuthority(authorityGenerationHash)),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'ReadOnlyBrokerRequiresNoCapital',
        capitalAuthority: CapitalAuthorityKind.Granted,
      },
    })
  })

  test('uses one persisted grant contract for sandbox and live broker identities', () => {
    expect(
      makeExecutionAuthority({
        brokerIdentity: sandboxIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: grantedCapitalAuthority(persistedGrantRecord({ brokerIdentity: sandboxIdentity })),
        strategy,
        observedAt,
      }),
    ).toMatchObject({ _tag: 'Success', success: { brokerIdentity: sandboxIdentity } })
    expect(
      makeExecutionAuthority({
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: grantedCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    ).toMatchObject({ _tag: 'Success', success: { brokerIdentity: liveIdentity } })
  })

  test('decodes legacy live-only grant rows without widening their environment', () => {
    const neutral = persistedGrantRecord({ brokerIdentity: sandboxIdentity })
    expect(
      makeCapitalGrantRecord({
        schemaVersion: 'bayn.live-capital-grant.v1',
        brokerIdentity: sandboxIdentity,
        authorityGenerationHash: neutral.authorityGenerationHash,
        strategy: neutral.strategy,
        limits: neutral.limits,
        validFrom: neutral.validFrom,
        validUntil: neutral.validUntil,
        issuedAt: neutral.issuedAt,
        issuedBy: neutral.issuedBy,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'CapitalGrantRecordSchemaInvalid' } })
  })

  test('fails closed for revoked, expired, not-yet-valid, and mismatched persisted capital grants', () => {
    const generationMismatch = makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: {
        ...grantedCapitalAuthority(persistedGrantRecord()),
        authorityGenerationHash: '9'.repeat(64),
      },
      strategy,
      observedAt,
    })
    const revoked = makeExecutionAuthority({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: grantedCapitalAuthority(persistedGrantRecord(), {
        schemaVersion: 'bayn.capital-grant-revocation.v2',
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
      capitalAuthority: grantedCapitalAuthority(
        persistedGrantRecord({
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
      capitalAuthority: grantedCapitalAuthority(
        persistedGrantRecord({
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
      capitalAuthority: grantedCapitalAuthority(persistedGrantRecord()),
      strategy: { ...strategy, parameterHash: '4'.repeat(64) },
      observedAt,
    })
    const otherLiveIdentity = identity(BrokerEnvironment.Live, '99ae87fc-a13b-47b4-a502-cbb980bc07de')
    const mismatchedAccount = makeExecutionAuthority({
      brokerIdentity: otherLiveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: grantedCapitalAuthority(persistedGrantRecord()),
      strategy,
      observedAt,
    })

    expect(generationMismatch).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'PersistedGrantAuthorityGenerationMismatch',
        authorityGenerationHash: '9'.repeat(64),
        grantAuthorityGenerationHash: authorityGenerationHash,
      },
    })
    expect(revoked).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PersistedGrantRevoked' } })
    expect(expired).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PersistedGrantExpired' } })
    expect(notYetValid).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PersistedGrantNotYetValid' } })
    expect(mismatchedStrategy).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PersistedGrantStrategyMismatch' } })
    expect(mismatchedAccount).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'PersistedGrantBrokerIdentityMismatch' },
    })
  })
})
