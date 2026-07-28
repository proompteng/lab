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
import { Authority } from './paper'

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
  test('admits only a frozen, redacted Alpaca sandbox connection without capital authority', () => {
    const result = decodeBrokerConnection(input())

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
    })
    expect(Object.isFrozen(result.success)).toBe(true)
    expect(Redacted.isRedacted(result.success.key)).toBe(true)
    expect(Redacted.isRedacted(result.success.secret)).toBe(true)
    expect(Object.hasOwn(result.success, 'maximumAuthority')).toBe(false)
    expect(String(Authority.Observe)).toBe('OBSERVE')
  })

  test('rejects the live endpoint before any broker client or mutation capability exists', () => {
    expect(
      decodeBrokerConnection(
        input({
          environment: BrokerEnvironment.Live,
          baseUrl: alpacaLiveBaseUrl,
        }),
      ),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'BrokerEnvironmentUnsupported',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Live,
        baseUrl: alpacaLiveBaseUrl,
        reason: 'DURABLE_IDENTITY_UNAVAILABLE',
      },
    })
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
