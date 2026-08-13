import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  grantedCapitalAuthority,
  makeLiveCapitalGrant,
  noCapitalAuthority,
  type ExecutionStrategyIdentity,
} from './authority'
import type { ExecutionPolicy } from './configuration'
import {
  resolvePreparedExecutionAuthority,
  resolvePreparedExecutionPolicy,
  resolvePreparedSandboxAuthority,
} from './runtime-authority'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const generationHash = '1'.repeat(64)
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)
const liveIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Live,
    accountId,
  }),
)

const readOnlyPolicy: ExecutionPolicy = {
  brokerIdentity: identity,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: noCapitalAuthority,
}

const sandboxPolicy: ExecutionPolicy = {
  brokerIdentity: identity,
  brokerAccess: BrokerAccess.Mutation,
  capitalAuthority: { _tag: CapitalAuthorityKind.Granted, authorityGenerationHash: generationHash },
}

describe('runtime authority resolution', () => {
  test('constructs sandbox authority from the exact realized PREPARE generation', async () => {
    const authority = await Effect.runPromise(
      resolvePreparedSandboxAuthority({
        brokerIdentity: identity,
        strategy,
        generationHash,
        observedAt: '2026-07-28T08:00:00.000Z',
      }),
    )

    expect(authority).toMatchObject({
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: { _tag: CapitalAuthorityKind.Granted, authorityGenerationHash: generationHash },
    })
  })

  test('adapts legacy read-only sandbox activation and preserves configured granted capital', () => {
    expect(
      resolvePreparedExecutionPolicy({
        configured: readOnlyPolicy,
        brokerIdentity: identity,
        preparedGenerationHash: generationHash,
      }),
    ).toEqual(Result.succeed(sandboxPolicy))
    expect(
      resolvePreparedExecutionPolicy({
        configured: sandboxPolicy,
        brokerIdentity: identity,
        preparedGenerationHash: generationHash,
      }),
    ).toEqual(Result.succeed(sandboxPolicy))
  })

  test('binds configured granted capital to the prepared episode generation', () => {
    expect(
      resolvePreparedExecutionPolicy({
        configured: sandboxPolicy,
        brokerIdentity: identity,
        preparedGenerationHash: '9'.repeat(64),
      }),
    ).toEqual(
      Result.succeed({
        ...sandboxPolicy,
        capitalAuthority: {
          _tag: CapitalAuthorityKind.Granted,
          authorityGenerationHash: '9'.repeat(64),
        },
      }),
    )
  })

  test('preserves the configured live grant while binding the prepared episode generation', () => {
    const persistedGrantHash = '8'.repeat(64)
    expect(
      resolvePreparedExecutionPolicy({
        configured: {
          brokerIdentity: liveIdentity,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: {
            _tag: CapitalAuthorityKind.Granted,
            authorityGenerationHash: generationHash,
            persistedGrantHash,
          },
        },
        brokerIdentity: liveIdentity,
        preparedGenerationHash: '9'.repeat(64),
      }),
    ).toEqual(
      Result.succeed({
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: {
          _tag: CapitalAuthorityKind.Granted,
          authorityGenerationHash: '9'.repeat(64),
          persistedGrantHash,
        },
      }),
    )
  })

  test('loads and validates live capital through the same prepared authority boundary', async () => {
    const grant = Result.getOrThrow(
      makeLiveCapitalGrant({
        schemaVersion: 'bayn.live-capital-grant.v1',
        brokerIdentity: liveIdentity,
        authorityGenerationHash: generationHash,
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
    const livePolicy = Result.getOrThrow(
      resolvePreparedExecutionPolicy({
        configured: {
          brokerIdentity: liveIdentity,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: {
            _tag: CapitalAuthorityKind.Granted,
            authorityGenerationHash: generationHash,
            persistedGrantHash: grant.grantHash,
          },
        },
        brokerIdentity: liveIdentity,
        preparedGenerationHash: generationHash,
      }),
    )
    let readHash: string | undefined
    const authority = await Effect.runPromise(
      resolvePreparedExecutionAuthority({
        executionPolicy: livePolicy,
        brokerIdentity: liveIdentity,
        strategy,
        observedAt: '2026-07-28T08:00:00.000Z',
        readLiveGrant: (grantHash) => {
          readHash = grantHash
          return Effect.succeed(grantedCapitalAuthority(grant))
        },
      }),
    )

    expect(readHash).toBe(grant.grantHash)
    expect(authority).toMatchObject({
      brokerIdentity: liveIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: {
        authorityGenerationHash: generationHash,
        persistedGrant: { grant: { grantHash: grant.grantHash } },
      },
    })
  })
})
