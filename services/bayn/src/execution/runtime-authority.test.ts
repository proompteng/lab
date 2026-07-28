import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  liveCapitalAuthority,
  makeLiveCapitalGrant,
  type ExecutionStrategyIdentity,
} from './authority'
import type { ExecutionPolicy } from './configuration'
import { resolveRuntimeAuthority } from './runtime-authority'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const observedAt = '2026-07-28T08:00:00.000Z'
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const identity = <Environment extends BrokerEnvironment>(environment: Environment) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId,
    }),
  )

const sandboxPolicy = {
  brokerIdentity: identity(BrokerEnvironment.Sandbox),
  brokerAccess: BrokerAccess.Mutation,
  capitalAuthority: { _tag: CapitalAuthorityKind.Sandbox, authorityGenerationHash },
} satisfies ExecutionPolicy

const liveIdentity = identity(BrokerEnvironment.Live)
const grant = Result.getOrThrow(
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
  }),
)
const livePolicy = {
  brokerIdentity: liveIdentity,
  brokerAccess: BrokerAccess.Mutation,
  capitalAuthority: { _tag: CapitalAuthorityKind.LiveGrant, grantHash: grant.grantHash },
} satisfies ExecutionPolicy

describe('runtime authority resolution', () => {
  test('constructs sandbox authority without consulting the live grant store', async () => {
    let reads = 0
    const authority = await Effect.runPromise(
      resolveRuntimeAuthority(
        { policy: sandboxPolicy, strategy, observedAt },
        {
          liveCapitalGrants: {
            read: () => {
              reads += 1
              return Effect.succeed(undefined)
            },
          },
        },
      ),
    )

    expect(reads).toBe(0)
    expect(authority).toMatchObject({
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: { _tag: CapitalAuthorityKind.Sandbox },
    })
  })

  test('requires the exact persisted live grant and applies revocation and expiry checks', async () => {
    const active = await Effect.runPromise(
      resolveRuntimeAuthority(
        { policy: livePolicy, strategy, observedAt },
        { liveCapitalGrants: { read: () => Effect.succeed(liveCapitalAuthority(grant)) } },
      ),
    )
    expect(active.capitalAuthority._tag).toBe(CapitalAuthorityKind.LiveGrant)

    const missing = await Effect.runPromise(
      Effect.flip(
        resolveRuntimeAuthority(
          { policy: livePolicy, strategy, observedAt },
          { liveCapitalGrants: { read: () => Effect.succeed(undefined) } },
        ),
      ),
    )
    expect(missing).toMatchObject({ _tag: 'LiveCapitalGrantMissing' })

    const revoked = await Effect.runPromise(
      Effect.flip(
        resolveRuntimeAuthority(
          { policy: livePolicy, strategy, observedAt },
          {
            liveCapitalGrants: {
              read: () =>
                Effect.succeed(
                  liveCapitalAuthority(grant, {
                    schemaVersion: 'bayn.live-capital-grant-revocation.v1',
                    revokedAt: '2026-07-28T07:30:00.000Z',
                    revokedBy: 'operator:test',
                    reason: 'containment',
                  }),
                ),
            },
          },
        ),
      ),
    )
    expect(revoked).toMatchObject({
      _tag: 'ExecutionAuthorityInvalid',
      cause: { _tag: 'LiveGrantRevoked' },
    })
  })
})
