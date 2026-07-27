import { describe, expect, test } from 'bun:test'

import { Redacted, Result } from 'effect'

import { BrokerEnvironment } from '../execution/authority'
import {
  BrokerProvider,
  alpacaLiveBaseUrl,
  alpacaSandboxBaseUrl,
  decodeBrokerConnection,
  type BrokerConnectionInput,
} from './connection'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const key = 'alpaca-key-must-remain-redacted'
const secret = 'alpaca-secret-must-remain-redacted'

const input = (overrides: Partial<BrokerConnectionInput> = {}): BrokerConnectionInput => ({
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  baseUrl: alpacaSandboxBaseUrl,
  expectedAccountId: accountId,
  key: Redacted.make(key),
  secret: Redacted.make(secret),
  proxyUrl: 'http://bayn-egress-proxy:3128',
  operationTimeoutMs: 30_000,
  retryAttempts: 2,
  ...overrides,
})

describe('BrokerConnection decoding', () => {
  test('decodes and freezes the approved Alpaca sandbox connection once', () => {
    const result = decodeBrokerConnection(input({ baseUrl: `${alpacaSandboxBaseUrl}/` }))

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      proxyUrl: 'http://bayn-egress-proxy:3128',
      operationTimeoutMs: 30_000,
      retryAttempts: 2,
    })
    expect(Object.isFrozen(result.success)).toBe(true)
    expect(Redacted.isRedacted(result.success.key)).toBe(true)
    expect(Redacted.isRedacted(result.success.secret)).toBe(true)
    expect(JSON.stringify(result.success)).not.toContain(key)
    expect(JSON.stringify(result.success)).not.toContain(secret)
  })

  test('rejects the approved Alpaca live endpoint until durable identities encode the environment', () => {
    const result = decodeBrokerConnection(input({ environment: BrokerEnvironment.Live, baseUrl: alpacaLiveBaseUrl }))

    expect(result).toMatchObject({
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

  for (const [environment, baseUrl, approvedBaseUrl] of [
    [BrokerEnvironment.Sandbox, alpacaLiveBaseUrl, alpacaSandboxBaseUrl],
    [BrokerEnvironment.Live, alpacaSandboxBaseUrl, alpacaLiveBaseUrl],
  ] as const) {
    test(`rejects ${environment} credentials paired with ${baseUrl}`, () => {
      const result = decodeBrokerConnection(input({ environment, baseUrl }))

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'BrokerEndpointEnvironmentMismatch',
          provider: BrokerProvider.Alpaca,
          environment,
          baseUrl,
          approvedBaseUrl,
        },
      })
    })
  }

  for (const [baseUrl, reason] of [
    ['not a URL', 'INVALID_URL'],
    ['http://paper-api.alpaca.markets', 'HTTPS_REQUIRED'],
    ['https://user:secret@paper-api.alpaca.markets', 'ORIGIN_REQUIRED'],
    ['https://paper-api.alpaca.markets/v2', 'ORIGIN_REQUIRED'],
    ['https://paper-api.alpaca.markets?environment=paper', 'ORIGIN_REQUIRED'],
    ['https://paper-api.alpaca.markets#paper', 'ORIGIN_REQUIRED'],
  ] as const) {
    test(`rejects unsafe broker base URL ${baseUrl}`, () => {
      expect(decodeBrokerConnection(input({ baseUrl }))).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidBrokerBaseUrl', reason },
      })
    })
  }

  for (const [proxyUrl, reason] of [
    ['not a URL', 'INVALID_URL'],
    ['socks5://proxy.test:1080', 'HTTP_OR_HTTPS_REQUIRED'],
    ['http://user:secret@proxy.test:3128', 'CREDENTIALS_FORBIDDEN'],
    ['http://proxy.test:3128/route', 'ORIGIN_REQUIRED'],
    ['http://proxy.test:3128?route=paper', 'ORIGIN_REQUIRED'],
    ['http://proxy.test:3128#paper', 'ORIGIN_REQUIRED'],
  ] as const) {
    test(`rejects unsafe broker proxy URL ${proxyUrl}`, () => {
      expect(decodeBrokerConnection(input({ proxyUrl }))).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidBrokerProxyUrl', reason },
      })
    })
  }

  for (const [name, overrides, invalid] of [
    ['empty key', { key: Redacted.make('') }, ['key']],
    ['padded key', { key: Redacted.make(' key ') }, ['key']],
    ['empty secret', { secret: Redacted.make('') }, ['secret']],
    ['padded secret', { secret: Redacted.make(' secret ') }, ['secret']],
    [
      'both malformed credentials',
      { key: Redacted.make(' key '), secret: Redacted.make(' secret ') },
      ['key', 'secret'],
    ],
  ] as const) {
    test(`rejects ${name} without exposing credential values`, () => {
      const result = decodeBrokerConnection(input(overrides))

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidBrokerCredentials', invalid },
      })
      expect(JSON.stringify(result)).not.toContain(' key ')
      expect(JSON.stringify(result)).not.toContain(' secret ')
    })
  }

  for (const [name, overrides, path] of [
    ['unknown provider', { provider: 'other' }, '["provider"]'],
    ['unknown environment', { environment: 'paper' }, '["environment"]'],
    ['malformed account identity', { expectedAccountId: 'account-1' }, '["expectedAccountId"]'],
    ['zero timeout', { operationTimeoutMs: 0 }, '["operationTimeoutMs"]'],
    ['excess retries', { retryAttempts: 4 }, '["retryAttempts"]'],
  ] as const) {
    test(`rejects ${name} as typed connection material`, () => {
      const result = decodeBrokerConnection(input(overrides))

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidBrokerConnectionMaterial' },
      })
      if (Result.isFailure(result) && result.failure._tag === 'InvalidBrokerConnectionMaterial') {
        expect(result.failure.cause.message).toContain(path)
      }
    })
  }
})
