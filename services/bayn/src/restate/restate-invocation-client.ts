import { Data, Duration, Effect, Result, Schema } from 'effect'

export interface RestateInvocationRequestOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface RestateInvocationCompletionOptions {
  readonly maximumAttempts: number
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
}

export type RestateHttpRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class RestateInvocationClientError extends Data.TaggedError('RestateInvocationClientError')<{
  readonly operation: 'await' | 'send'
  readonly message: string
  readonly cause?: unknown
}> {}

export const restateInvocationMaximumResponseBytes = 16 * 1024
export const restateInvocationAcceptTimeoutMs = 30_000
export const restateInvocationOutputRequestTimeoutMs = 10_000
export const restateInvocationCompletionPollIntervalMs = 3_000

export const restateInvocationCompletionMaximumAttempts = (
  completionWindowMs: number,
  pollIntervalMs = restateInvocationCompletionPollIntervalMs,
): number => Math.ceil(completionWindowMs / pollIntervalMs) + 1

export enum RestateSendStatus {
  Accepted = 'Accepted',
  PreviouslyAccepted = 'PreviouslyAccepted',
}

const RestateAcceptedInvocationSchema = Schema.Struct({
  invocationId: Schema.Trim.check(Schema.isPattern(/^inv_[A-Za-z0-9]+$/)),
  executionTime: Schema.optional(
    Schema.Trim.check(
      Schema.makeFilter((candidate: string) => !Number.isNaN(Date.parse(candidate)), {
        expected: 'a valid Restate execution timestamp',
      }),
    ),
  ),
  status: Schema.Enum(RestateSendStatus),
})

export const decodeRestateAcceptedInvocation = Schema.decodeUnknownResult(RestateAcceptedInvocationSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

const requestSignal = (interruptionSignal: AbortSignal, timeoutMs: number): AbortSignal =>
  AbortSignal.any([interruptionSignal, AbortSignal.timeout(timeoutMs)])

const readBoundedJson = async (response: Response, description: string): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error(`${description} returned a non-JSON response`)
  }
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(declaredLength) && declaredLength > restateInvocationMaximumResponseBytes) {
    throw new Error(`${description} returned an oversized response`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > restateInvocationMaximumResponseBytes) {
    throw new Error(`${description} returned an oversized response`)
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

export const sendRestateInvocation = (
  url: string,
  body: unknown,
  options: RestateInvocationRequestOptions,
  request: RestateHttpRequest = fetch,
): Effect.Effect<typeof RestateAcceptedInvocationSchema.Type, RestateInvocationClientError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: requestSignal(signal, options.timeoutMs),
      })
      if (!response.ok) throw new Error(`Restate invocation send returned HTTP ${response.status}`)
      const candidate = await readBoundedJson(response, 'Restate invocation send')
      const decoded = decodeRestateAcceptedInvocation(candidate)
      if (Result.isFailure(decoded)) throw new Error('Restate invocation send returned an invalid receipt')
      return decoded.success
    },
    catch: (cause) =>
      new RestateInvocationClientError({
        operation: 'send',
        message: 'Restate invocation send failed',
        cause,
      }),
  })

export const awaitRestateInvocation = (
  ingressOrigin: string,
  invocationId: string,
  options: RestateInvocationCompletionOptions,
  request: RestateHttpRequest = fetch,
): Effect.Effect<unknown, RestateInvocationClientError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
      const output = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await request(`${ingressOrigin}/restate/invocation/${invocationId}/output`, {
            method: 'GET',
            signal: requestSignal(signal, options.requestTimeoutMs),
          })
          if (response.status === 470) {
            await response.body?.cancel()
            return undefined
          }
          if (!response.ok) throw new Error(`Restate invocation output returned HTTP ${response.status}`)
          if (response.headers.get('x-restate-id') !== invocationId) {
            throw new Error('Restate invocation output identity does not match the accepted invocation')
          }
          return readBoundedJson(response, 'Restate invocation output')
        },
        catch: (cause) =>
          new RestateInvocationClientError({
            operation: 'await',
            message: 'Restate invocation completion check failed',
            cause,
          }),
      })
      if (output !== undefined) return output
      if (attempt < options.maximumAttempts) yield* Effect.sleep(Duration.millis(options.pollIntervalMs))
    }
    return yield* new RestateInvocationClientError({
      operation: 'await',
      message: 'Restate invocation remains incomplete after the bounded completion check',
    })
  })
