import { Redacted, Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerEnvironmentSchema } from '../execution/authority'
import {
  PositiveIntegerSchema as PositiveInteger,
  StrictNonEmptyStringSchema as NonEmptyString,
  strictParseOptions as StrictParseOptions,
} from '../schemas'

export enum BrokerProvider {
  Alpaca = 'alpaca',
}

export const alpacaSandboxBaseUrl = 'https://paper-api.alpaca.markets' as const
export const alpacaLiveBaseUrl = 'https://api.alpaca.markets' as const

const BrokerProviderSchema = Schema.Enum(BrokerProvider)
const AccountId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const RetryAttempts = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
const BrokerConnectionMaterialSchema = Schema.Struct({
  provider: BrokerProviderSchema,
  environment: BrokerEnvironmentSchema,
  baseUrl: NonEmptyString,
  expectedAccountId: AccountId,
  proxyUrl: NonEmptyString,
  operationTimeoutMs: PositiveInteger,
  retryAttempts: RetryAttempts,
})

export interface BrokerConnectionInput {
  readonly provider: unknown
  readonly environment: unknown
  readonly baseUrl: unknown
  readonly expectedAccountId: unknown
  readonly key: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
  readonly proxyUrl: unknown
  readonly operationTimeoutMs: unknown
  readonly retryAttempts: unknown
}

export interface BrokerConnection {
  readonly provider: BrokerProvider.Alpaca
  readonly environment: BrokerEnvironment
  readonly baseUrl: string
  readonly expectedAccountId: string
  readonly key: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
  readonly proxyUrl: string
  readonly operationTimeoutMs: number
  readonly retryAttempts: number
}

export type BrokerConnectionDecodeFailure =
  | {
      readonly _tag: 'InvalidBrokerConnectionMaterial'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'InvalidBrokerCredentials'
      readonly invalid: readonly ('key' | 'secret')[]
    }
  | {
      readonly _tag: 'InvalidBrokerBaseUrl'
      readonly reason: 'INVALID_URL' | 'HTTPS_REQUIRED' | 'ORIGIN_REQUIRED'
    }
  | {
      readonly _tag: 'BrokerEndpointEnvironmentMismatch'
      readonly provider: BrokerProvider.Alpaca
      readonly environment: BrokerEnvironment
      readonly baseUrl: string
      readonly approvedBaseUrl: string
    }
  | {
      readonly _tag: 'BrokerEnvironmentUnsupported'
      readonly provider: BrokerProvider.Alpaca
      readonly environment: BrokerEnvironment.Live
      readonly baseUrl: string
      readonly reason: 'DURABLE_IDENTITY_UNAVAILABLE'
    }
  | {
      readonly _tag: 'InvalidBrokerProxyUrl'
      readonly reason: 'INVALID_URL' | 'HTTP_OR_HTTPS_REQUIRED' | 'CREDENTIALS_FORBIDDEN' | 'ORIGIN_REQUIRED'
    }

const decodeBrokerConnectionMaterial = Schema.decodeUnknownResult(BrokerConnectionMaterialSchema, StrictParseOptions)

const parseUrl = (value: string): Result.Result<URL, 'INVALID_URL'> =>
  Result.try({
    try: () => new URL(value),
    catch: () => 'INVALID_URL' as const,
  })

const invalidBrokerBaseUrl = (
  reason: Extract<BrokerConnectionDecodeFailure, { readonly _tag: 'InvalidBrokerBaseUrl' }>['reason'],
): Extract<BrokerConnectionDecodeFailure, { readonly _tag: 'InvalidBrokerBaseUrl' }> => ({
  _tag: 'InvalidBrokerBaseUrl',
  reason,
})

const validateBrokerBaseUrl = (
  value: string,
): Result.Result<string, Extract<BrokerConnectionDecodeFailure, { readonly _tag: 'InvalidBrokerBaseUrl' }>> =>
  Result.flatMap(parseUrl(value), (url) => {
    if (url.protocol !== 'https:') {
      return Result.fail(invalidBrokerBaseUrl('HTTPS_REQUIRED'))
    }
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return Result.fail(invalidBrokerBaseUrl('ORIGIN_REQUIRED'))
    }
    return Result.succeed(url.origin)
  }).pipe(Result.mapError((failure) => (failure === 'INVALID_URL' ? invalidBrokerBaseUrl(failure) : failure)))

const approvedAlpacaBaseUrl = (environment: BrokerEnvironment): string =>
  environment === BrokerEnvironment.Sandbox ? alpacaSandboxBaseUrl : alpacaLiveBaseUrl

const validateEndpointPairing = (
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment,
  baseUrl: string,
): Result.Result<string, BrokerConnectionDecodeFailure> => {
  const approvedBaseUrl = approvedAlpacaBaseUrl(environment)
  return baseUrl === approvedBaseUrl
    ? Result.succeed(baseUrl)
    : Result.fail({
        _tag: 'BrokerEndpointEnvironmentMismatch',
        provider,
        environment,
        baseUrl,
        approvedBaseUrl,
      })
}

const validateSupportedEnvironment = (
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment,
  baseUrl: string,
): Result.Result<BrokerEnvironment.Sandbox, BrokerConnectionDecodeFailure> =>
  environment === BrokerEnvironment.Sandbox
    ? Result.succeed(BrokerEnvironment.Sandbox)
    : Result.fail({
        _tag: 'BrokerEnvironmentUnsupported',
        provider,
        environment: BrokerEnvironment.Live,
        baseUrl,
        reason: 'DURABLE_IDENTITY_UNAVAILABLE',
      })

const invalidBrokerProxyUrl = (
  reason: Extract<BrokerConnectionDecodeFailure, { readonly _tag: 'InvalidBrokerProxyUrl' }>['reason'],
): Extract<BrokerConnectionDecodeFailure, { readonly _tag: 'InvalidBrokerProxyUrl' }> => ({
  _tag: 'InvalidBrokerProxyUrl',
  reason,
})

export const decodeBrokerProxyUrl = (
  value: string,
): Result.Result<string, Extract<BrokerConnectionDecodeFailure, { readonly _tag: 'InvalidBrokerProxyUrl' }>> =>
  Result.flatMap(parseUrl(value), (url) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Result.fail(invalidBrokerProxyUrl('HTTP_OR_HTTPS_REQUIRED'))
    }
    if (url.username !== '' || url.password !== '') {
      return Result.fail(invalidBrokerProxyUrl('CREDENTIALS_FORBIDDEN'))
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return Result.fail(invalidBrokerProxyUrl('ORIGIN_REQUIRED'))
    }
    return Result.succeed(url.origin)
  }).pipe(Result.mapError((failure) => (failure === 'INVALID_URL' ? invalidBrokerProxyUrl(failure) : failure)))

const invalidCredentials = (
  key: Redacted.Redacted<string>,
  secret: Redacted.Redacted<string>,
): readonly ('key' | 'secret')[] => {
  const invalid: Array<'key' | 'secret'> = []
  const keyValue = Redacted.value(key)
  const secretValue = Redacted.value(secret)
  if (keyValue.length === 0 || keyValue.trim() !== keyValue) invalid.push('key')
  if (secretValue.length === 0 || secretValue.trim() !== secretValue) invalid.push('secret')
  return invalid
}

export const decodeBrokerConnection = (
  input: BrokerConnectionInput,
): Result.Result<BrokerConnection, BrokerConnectionDecodeFailure> => {
  const material = decodeBrokerConnectionMaterial({
    provider: input.provider,
    environment: input.environment,
    baseUrl: input.baseUrl,
    expectedAccountId: input.expectedAccountId,
    proxyUrl: input.proxyUrl,
    operationTimeoutMs: input.operationTimeoutMs,
    retryAttempts: input.retryAttempts,
  })
  if (Result.isFailure(material)) {
    return Result.fail({ _tag: 'InvalidBrokerConnectionMaterial', cause: material.failure })
  }

  const invalid = invalidCredentials(input.key, input.secret)
  if (invalid.length > 0) return Result.fail({ _tag: 'InvalidBrokerCredentials', invalid })

  return Result.gen(function* () {
    const baseUrl = yield* validateBrokerBaseUrl(material.success.baseUrl)
    yield* validateEndpointPairing(material.success.provider, material.success.environment, baseUrl)
    const environment = yield* validateSupportedEnvironment(
      material.success.provider,
      material.success.environment,
      baseUrl,
    )
    const proxyUrl = yield* decodeBrokerProxyUrl(material.success.proxyUrl)
    return Object.freeze({
      provider: material.success.provider,
      environment,
      baseUrl,
      expectedAccountId: material.success.expectedAccountId,
      key: input.key,
      secret: input.secret,
      proxyUrl,
      operationTimeoutMs: material.success.operationTimeoutMs,
      retryAttempts: material.success.retryAttempts,
    })
  })
}

export const renderBrokerConnectionDecodeFailure = (failure: BrokerConnectionDecodeFailure): string => {
  switch (failure._tag) {
    case 'InvalidBrokerConnectionMaterial':
      return `invalid broker connection material: ${failure.cause.message}`
    case 'InvalidBrokerCredentials':
      return `invalid broker credentials: ${failure.invalid.join(', ')} must be non-empty without surrounding whitespace`
    case 'InvalidBrokerBaseUrl':
      return `invalid broker base URL: ${failure.reason}`
    case 'BrokerEndpointEnvironmentMismatch':
      return `broker endpoint ${failure.baseUrl} is not approved for ${failure.environment}; expected ${failure.approvedBaseUrl}`
    case 'BrokerEnvironmentUnsupported':
      return `broker environment ${failure.environment} is unsupported until durable broker identities encode the environment`
    case 'InvalidBrokerProxyUrl':
      return `invalid broker proxy URL: ${failure.reason}`
  }
  const exhaustive: never = failure
  return exhaustive
}
