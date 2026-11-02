import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, decodePersistedBrokerIdentity, makeBrokerIdentity } from './identity'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'

const identity = (environment: BrokerEnvironment) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId,
    }),
  )

describe('durable broker identity', () => {
  test('binds provider, environment, and account into one versioned identity', () => {
    const sandbox = identity(BrokerEnvironment.Sandbox)
    const live = identity(BrokerEnvironment.Live)

    expect(sandbox).toMatchObject({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId,
    })
    expect(live.identityHash).not.toBe(sandbox.identityHash)
  })

  test('decodes new persisted identities with exact versioned round trips', () => {
    const expected = identity(BrokerEnvironment.Live)
    expect(
      decodePersistedBrokerIdentity({
        broker_identity_schema_version: expected.schemaVersion,
        broker_identity_hash: expected.identityHash,
        broker_provider: expected.provider,
        broker_environment: expected.environment,
        account_id: expected.accountId,
      }),
    ).toEqual(Result.succeed(expected))
  })

  test('isolates historical account-only PAPER evidence at the decoder boundary', () => {
    expect(
      decodePersistedBrokerIdentity({
        broker_identity_schema_version: null,
        broker_identity_hash: null,
        broker_provider: null,
        broker_environment: null,
        account_id: accountId,
      }),
    ).toEqual(
      Result.succeed({
        schemaVersion: 'bayn.broker-account.v1',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId,
      }),
    )
  })

  test('fails closed for partial or forged versioned identity rows', () => {
    const expected = identity(BrokerEnvironment.Live)
    expect(
      decodePersistedBrokerIdentity({
        broker_identity_schema_version: expected.schemaVersion,
        broker_identity_hash: null,
        broker_provider: expected.provider,
        broker_environment: expected.environment,
        account_id: expected.accountId,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PersistedBrokerIdentityIncomplete' } })
    expect(
      decodePersistedBrokerIdentity({
        broker_identity_schema_version: expected.schemaVersion,
        broker_identity_hash: '0'.repeat(64),
        broker_provider: expected.provider,
        broker_environment: expected.environment,
        account_id: expected.accountId,
      }),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PersistedBrokerIdentityHashMismatch' } })
  })
})
