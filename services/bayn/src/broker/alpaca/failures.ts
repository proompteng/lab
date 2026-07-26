import { Data, Schema } from 'effect'
import { HttpClientError } from 'effect/unstable/http'

export enum BrokerReadErrorKind {
  Configuration = 'CONFIGURATION',
  Transport = 'TRANSPORT',
  Timeout = 'TIMEOUT',
  Authentication = 'AUTHENTICATION',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  RateLimited = 'RATE_LIMITED',
  Server = 'SERVER',
  HttpStatus = 'HTTP_STATUS',
  InvalidRequest = 'INVALID_REQUEST',
  InvalidResponse = 'INVALID_RESPONSE',
  AccountMismatch = 'ACCOUNT_MISMATCH',
}

export type BrokerReadOperation =
  | 'configuration'
  | 'proxy'
  | 'preflight'
  | 'account'
  | 'account-configuration'
  | 'positions'
  | 'orders'
  | 'order-by-id'
  | 'order-by-client-id'
  | 'fill-activities'
  | 'asset-by-symbol'
  | 'market-calendar'

export class BrokerReadError extends Data.TaggedError('BrokerReadError')<{
  readonly operation: BrokerReadOperation
  readonly kind: BrokerReadErrorKind
  readonly message: string
  readonly retryable: boolean
  readonly status?: number
  readonly requestId?: string
  readonly contentHash?: string
  readonly observedAt?: string
  readonly cause?: unknown
}> {}

export type BrokerReadContractFailureReason =
  | 'ACCOUNT_BINDING'
  | 'ASSET_BINDING'
  | 'ASSET_CLASS'
  | 'CALENDAR_DUPLICATE'
  | 'CALENDAR_HOURS'
  | 'CALENDAR_INSTANT'
  | 'CALENDAR_RANGE'
  | 'CANONICAL_HASH'
  | 'DECIMAL_FORMAT'
  | 'DECIMAL_PRECISION'
  | 'DECIMAL_RANGE'
  | 'DECIMAL_SIGN'
  | 'DECIMAL_ZERO'
  | 'FILL_ACCOUNT_BINDING'
  | 'FILL_SHAPE'
  | 'ORDER_SHAPE'
  | 'RATE_LIMIT'

export class BrokerReadContractFailure extends Data.TaggedError('BrokerReadContractFailure')<{
  readonly reason: BrokerReadContractFailureReason
  readonly message: string
  readonly field?: string
  readonly expected?: string
  readonly actual?: string
}> {}

export const contractFailure = (
  reason: BrokerReadContractFailureReason,
  message: string,
  facts: {
    readonly field?: string
    readonly expected?: string
    readonly actual?: string
  } = {},
): BrokerReadContractFailure => new BrokerReadContractFailure({ reason, message, ...facts })

interface ReadEvidenceLike {
  readonly status?: number
  readonly requestId?: string
  readonly contentHash?: string
  readonly observedAt?: string
}

const redactDiagnostic = (value: string, sensitiveValues: readonly string[]): string =>
  sensitiveValues.reduce(
    (redacted, sensitive) => (sensitive.length === 0 ? redacted : redacted.replaceAll(sensitive, '<redacted>')),
    value,
  )

export const safeCause = (
  cause: unknown,
  sensitiveValues: readonly string[] = [],
): Readonly<Record<string, string>> => {
  if (Schema.isSchemaError(cause)) {
    return { tag: cause._tag, message: redactDiagnostic(cause.message, sensitiveValues) }
  }
  if (HttpClientError.isHttpClientError(cause)) {
    const detail =
      'cause' in cause.reason && cause.reason.cause instanceof Error ? cause.reason.cause.message : undefined
    return {
      tag: cause._tag,
      reason: cause.reason._tag,
      message: redactDiagnostic(cause.message, sensitiveValues),
      ...(detail === undefined ? {} : { detail: redactDiagnostic(detail, sensitiveValues) }),
    }
  }
  if (cause instanceof Error) {
    const message = typeof cause.message === 'string' ? redactDiagnostic(cause.message, sensitiveValues) : undefined
    const code =
      'code' in cause && (typeof cause.code === 'string' || typeof cause.code === 'number')
        ? String(cause.code)
        : undefined
    return {
      tag: cause.name,
      ...(message === undefined ? {} : { message }),
      ...(code === undefined ? {} : { code }),
    }
  }
  if (typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string') {
    const message =
      'message' in cause && typeof cause.message === 'string'
        ? redactDiagnostic(cause.message, sensitiveValues)
        : undefined
    return { tag: cause._tag, ...(message === undefined ? {} : { message }) }
  }
  return { tag: typeof cause }
}

export const configurationError = (
  operation: 'configuration' | 'proxy',
  message: string,
  cause?: unknown,
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Configuration,
    message,
    retryable: false,
    cause: cause === undefined ? undefined : safeCause(cause),
  })

export const invalidResponse = (
  operation: BrokerReadOperation,
  message: string,
  evidence?: ReadEvidenceLike,
  cause?: unknown,
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.InvalidResponse,
    message,
    retryable: false,
    status: evidence?.status,
    requestId: evidence?.requestId,
    contentHash: evidence?.contentHash,
    observedAt: evidence?.observedAt,
    cause: cause === undefined ? undefined : safeCause(cause),
  })

export const invalidRequest = (operation: BrokerReadOperation, message: string, cause: unknown): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.InvalidRequest,
    message,
    retryable: false,
    cause: safeCause(cause),
  })

export const transportError = (
  operation: BrokerReadOperation,
  cause: unknown,
  sensitiveValues: readonly string[],
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Transport,
    message: `Alpaca ${operation} request failed before a response was available`,
    retryable: true,
    cause: safeCause(cause, sensitiveValues),
  })

export const statusError = (
  operation: BrokerReadOperation,
  status: number,
  requestId: string,
  contentHash: string,
  observedAt: string,
  code: string | number,
  detail: string,
): BrokerReadError => {
  const kind =
    status === 401
      ? BrokerReadErrorKind.Authentication
      : status === 403
        ? BrokerReadErrorKind.Forbidden
        : status === 404
          ? BrokerReadErrorKind.NotFound
          : status === 429
            ? BrokerReadErrorKind.RateLimited
            : status >= 500
              ? BrokerReadErrorKind.Server
              : BrokerReadErrorKind.HttpStatus
  return new BrokerReadError({
    operation,
    kind,
    message: `Alpaca ${operation} returned HTTP ${status} (${String(code)}): ${detail}`,
    retryable: status === 429 || status >= 500,
    status,
    requestId,
    contentHash,
    observedAt,
  })
}

export const timeoutError = (
  operation: BrokerReadOperation,
  timeoutMs: number,
  cause: unknown,
  sensitiveValues: readonly string[],
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Timeout,
    message: `Alpaca ${operation} exceeded its ${timeoutMs}ms deadline`,
    retryable: true,
    cause: safeCause(cause, sensitiveValues),
  })
