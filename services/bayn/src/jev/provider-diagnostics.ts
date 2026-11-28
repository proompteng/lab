import { Result, Schema } from 'effect'

import { UtcInstantSchema } from '../schemas'

const RequestId = Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/))
const ErrorIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isPattern(/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/))
const RetryAfter = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('DELAY'),
    seconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
  }),
  Schema.Struct({ kind: Schema.Literal('AT'), at: UtcInstantSchema }),
])

export const JevProviderDiagnosticsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-provider-diagnostics.v1'),
  requestId: Schema.optionalKey(RequestId),
  errorCode: Schema.optionalKey(ErrorIdentifier),
  errorType: Schema.optionalKey(ErrorIdentifier),
  retryAfter: Schema.optionalKey(RetryAfter),
}).check(Schema.makeFilter((value) => Object.keys(value).length > 1))

export type JevProviderDiagnostics = typeof JevProviderDiagnosticsSchema.Type

const ErrorBody = Schema.Struct({
  request_id: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.Unknown),
  type: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
})
const ErrorFields = Schema.Struct({
  code: Schema.optionalKey(Schema.Unknown),
  type: Schema.optionalKey(Schema.Unknown),
})

const token = (schema: typeof RequestId, value: unknown, credential: string) => {
  const decoded = Schema.decodeUnknownResult(schema)(value)
  return Result.isSuccess(decoded) && (credential.length === 0 || !decoded.success.includes(credential))
    ? decoded.success
    : undefined
}

const retryAfter = (value: string | undefined): typeof RetryAfter.Type | undefined => {
  if (value === undefined || value.trim() !== value) return undefined
  if (/^(0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= 86_400) return { kind: 'DELAY', seconds: Number(value) }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value))
    return undefined
  const at = new Date(value)
  return Number.isFinite(at.getTime()) && at.toUTCString() === value ? { kind: 'AT', at: at.toISOString() } : undefined
}

/** Diagnostic identifiers only: never copy messages, echoed inputs, arbitrary headers or credentials. */
export const projectJevProviderDiagnostics = (
  headers: Readonly<Record<string, string>>,
  body: unknown,
  credential: string,
): JevProviderDiagnostics | undefined => {
  const decodedBody = Schema.decodeUnknownResult(ErrorBody)(body)
  const envelope = Result.isSuccess(decodedBody) ? decodedBody.success : undefined
  const decodedError = Schema.decodeUnknownResult(ErrorFields)(envelope?.error)
  const error = Result.isSuccess(decodedError) ? decodedError.success : undefined
  const requestId = [headers['request-id'], headers['x-request-id'], envelope?.request_id]
    .map((value) => token(RequestId, value, credential))
    .find((value) => value !== undefined)
  const errorCode = token(ErrorIdentifier, error?.code ?? envelope?.code, credential)
  const errorType = token(ErrorIdentifier, error?.type ?? envelope?.type, credential)
  const retry = retryAfter(headers['retry-after'])
  if (requestId === undefined && errorCode === undefined && errorType === undefined && retry === undefined)
    return undefined
  return {
    schemaVersion: 'bayn.jev-provider-diagnostics.v1',
    ...(requestId === undefined ? {} : { requestId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(retry === undefined ? {} : { retryAfter: retry }),
  }
}
