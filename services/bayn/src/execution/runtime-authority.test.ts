import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind, type ExecutionStrategyIdentity } from './authority'
import { resolvePreparedSandboxAuthority } from './runtime-authority'

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
      capitalAuthority: { _tag: CapitalAuthorityKind.Sandbox, authorityGenerationHash: generationHash },
    })
  })
})
