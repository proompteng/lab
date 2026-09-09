import { describe, expect, test } from 'bun:test'

import { Redacted, Result } from 'effect'

import {
  alpacaLiveBaseUrl,
  alpacaSandboxBaseUrl,
  BrokerProvider,
  decodeBrokerConnection,
  type BrokerConnectionInput,
} from './broker/connection'
import { BrokerEnvironment } from './execution/authority'

const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const input = (overrides: Partial<BrokerConnectionInput> = {}): BrokerConnectionInput => ({
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  baseUrl: alpacaSandboxBaseUrl,
  expectedAccountId: accountId,
  key: Redacted.make('paper-key'),
  secret: Redacted.make('paper-secret'),
  proxyUrl: 'http://bayn-egress-proxy:3128',
  operationTimeoutMs: 30_000,
  retryAttempts: 2,
  ...overrides,
})

describe('committed broker sandbox contract', () => {
  test('admits a frozen, redacted Alpaca sandbox connection without mutation capability', () => {
    const result = decodeBrokerConnection(input())

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      identity: {
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId,
      },
    })
    expect(Object.isFrozen(result.success)).toBe(true)
    expect(Redacted.isRedacted(result.success.key)).toBe(true)
    expect(Redacted.isRedacted(result.success.secret)).toBe(true)
    expect(Object.hasOwn(result.success, 'maximumAuthority')).toBe(false)
    expect(Object.hasOwn(result.success, 'mutation')).toBe(false)
  })

  test('binds a live endpoint to a distinct durable identity without creating mutation capability', () => {
    const sandbox = Result.getOrThrow(decodeBrokerConnection(input()))
    const live = Result.getOrThrow(
      decodeBrokerConnection(input({ environment: BrokerEnvironment.Live, baseUrl: alpacaLiveBaseUrl })),
    )

    expect(live).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Live,
      baseUrl: alpacaLiveBaseUrl,
      identity: {
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Live,
        accountId,
      },
    })
    expect(live.identity.identityHash).not.toBe(sandbox.identity.identityHash)
    expect(Object.hasOwn(live, 'mutation')).toBe(false)
  })

  test('rejects incomplete or unsafe credential material without exposing secrets', () => {
    const result = decodeBrokerConnection(input({ secret: Redacted.make('') }))

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'InvalidBrokerCredentials',
        invalid: ['secret'],
      },
    })
    expect(JSON.stringify(result)).not.toContain('paper-key')
    expect(JSON.stringify(result)).not.toContain('paper-secret')
  })
})
