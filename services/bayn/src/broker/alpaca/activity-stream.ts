import { Effect, Redacted, Result, Schema, Stream } from 'effect'
import { Headers, HttpClient, HttpClientRequest } from 'effect/http'

import { canonicalHashV1Result } from '../../hash'
import { currentUtcInstant } from '../../time'
import type { BrokerConnection } from '../connection'
import { decodeFeeActivityWitness } from './activity-fees'
import { activityReplayStart, decodeFillExecution } from './activity-fills'
import { BrokerReadError, BrokerReadErrorKind, statusError, transportError } from './failures'
import { redactedHeaders, type FillActivity, type Observed, type ReadEvidence } from './model'
import { observationUnavailable } from './observed-snapshot'

const operation = 'activity-stream'
const invalidStream = (message: string) =>
  new BrokerReadError({ operation, kind: BrokerReadErrorKind.InvalidResponse, retryable: true, message })

const eventHeader = Schema.decodeUnknownResult(
  Schema.Struct({
    event_id: Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/)),
    account_id: Schema.optionalKey(Schema.String),
    activity_type: Schema.String.check(Schema.isMinLength(1)),
  }),
)

const maximumFrameCharacters = 128 * 1024

type Frame = { readonly type: 'Heartbeat' } | { readonly type: 'Data'; readonly value: unknown }

export const activityFrames = (stream: Stream.Stream<Uint8Array, BrokerReadError>) =>
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const data: string[] = []
      let dataLength = 0
      let pending = ''
      return stream.pipe(
        Stream.mapEffect((chunk) =>
          Effect.try({
            try: () => {
              pending += decoder.decode(chunk, { stream: true })
              const frames: Frame[] = []
              let offset = 0
              for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', offset)) {
                const line = pending.slice(offset, end).replace(/\r$/, '')
                offset = end + 1
                if (line === '') {
                  if (data.length > 0) frames.push({ type: 'Data', value: JSON.parse(data.join('\n')) })
                  data.length = 0
                  dataLength = 0
                } else if (line === ': heartbeat' || line === ':heartbeat') {
                  frames.push({ type: 'Heartbeat' })
                } else if (line.startsWith('data:')) {
                  dataLength += line.length
                  if (dataLength > maximumFrameCharacters) throw Error()
                  data.push(line.slice(5).replace(/^ /, ''))
                } else if (line !== ': welcome to the Alpaca events') {
                  // Alpaca sends slow-reader drops and internal errors as SSE comments.
                  throw Error()
                }
              }
              pending = pending.slice(offset)
              if (pending.length + dataLength > maximumFrameCharacters) throw Error()
              return frames
            },
            catch: () => invalidStream('Alpaca sent a malformed activity frame or reported lost data'),
          }),
        ),
        Stream.flattenIterable,
        Stream.onEnd(
          Effect.try({
            try: () => {
              if (decoder.decode() !== '' || pending !== '' || data.length !== 0) throw Error()
            },
            catch: () => invalidStream('Alpaca ended the activity response inside a frame'),
          }),
        ),
      )
    }),
  )

const easternClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export const fillActivityIdentity = (executionId: string, executedAt: string) => {
  const wholeSecond = Date.parse(`${executedAt.slice(0, 19)}Z`)
  const nanoseconds = Number(executedAt.slice(20, -1).padEnd(9, '0'))
  const microseconds = Math.floor(nanoseconds / 1000)
  const remainder = nanoseconds % 1000
  const rounded = microseconds + Number(remainder > 500 || (remainder === 500 && microseconds % 2 === 1))
  // Alpaca's REST identity uses the Eastern execution clock with truncated milliseconds.
  const eastern = easternClock.format(wholeSecond).replace(/\D/g, '')
  const milliseconds = String(Math.floor(nanoseconds / 1_000_000)).padStart(3, '0')
  const transactionTime =
    new Date(wholeSecond + Math.floor(rounded / 1000)).toISOString().slice(0, -1) +
    String(rounded % 1000).padStart(3, '0') +
    '000Z'
  return { activityId: `${eastern}${milliseconds}::${executionId}`, transactionTime }
}

export interface AccountActivityCut {
  readonly fills: readonly Observed<FillActivity>[]
  readonly feeCounts: ReadonlyMap<string, number>
  readonly evidence: ReadEvidence
}

export const startAccountActivityStream = (
  connection: BrokerConnection,
  verifiedAccount: Effect.Effect<unknown, BrokerReadError>,
) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const key = Redacted.value(connection.key)
    const secret = Redacted.value(connection.secret)
    let checkpoint: { readonly id: string; readonly hash: string } | undefined
    let bootstrapped = false
    let reconnectMs = 2_000
    let connected = false
    let evidence: ReadEvidence | undefined
    let fills: Observed<FillActivity>[] = []
    let view: readonly Observed<FillActivity>[] = []
    const executionIds = new Set<string>()
    const feeRefs = new Set<string>()
    const feeCounts = new Map<string, number>()
    let feeView: ReadonlyMap<string, number> | undefined
    const fetchFrames = (params: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const url = new URL('/v2beta1/events/activities', connection.baseUrl)
        url.search = new URLSearchParams(params).toString()
        const response = yield* client
          .execute(
            HttpClientRequest.get(url, {
              headers: { accept: 'text/event-stream', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
            }),
          )
          .pipe(
            Effect.timeout(connection.operationTimeoutMs),
            Effect.mapError((cause) => transportError(operation, cause, [key, secret])),
            Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
          )
        const requestId = response.headers['x-request-id']
        const status = response.status
        if (status !== 200)
          return yield* statusError(
            operation,
            status,
            requestId ?? 'unavailable',
            emptyHash,
            yield* currentUtcInstant,
            status,
            'Activity SSE connection rejected',
          )
        if (
          response.headers['content-type']?.split(';')[0] !== 'text/event-stream' ||
          requestId === undefined ||
          requestId === ''
        )
          return yield* invalidStream('Alpaca activity response is missing its stream or request identity')
        return {
          requestId,
          frames: activityFrames(
            response.stream.pipe(Stream.mapError((cause) => transportError(operation, cause, [key, secret]))),
          ),
        }
      })

    const apply = (raw: unknown, requestId: string, anchor: typeof checkpoint, resume: boolean) =>
      Effect.gen(function* () {
        const header = yield* Effect.fromResult(eventHeader(raw)).pipe(
          Effect.mapError(() => invalidStream('Alpaca activity event has an invalid cursor')),
        )
        if (header.account_id !== undefined && header.account_id !== connection.expectedAccountId)
          return yield* invalidStream('Alpaca activity event belongs to a different account')
        const id = header.event_id
        const hash = yield* Effect.fromResult(canonicalHashV1Result(raw)).pipe(
          Effect.mapError(() => invalidStream('Alpaca activity event cannot be hashed')),
        )
        if (resume) {
          if (id !== anchor?.id || hash !== anchor.hash)
            return yield* invalidStream('Alpaca activity replay skipped or changed its inclusive checkpoint')
          return
        }
        if (checkpoint !== undefined && id <= checkpoint.id)
          return yield* invalidStream('Alpaca activity cursor did not advance')
        if (header.activity_type === 'FEE' || header.activity_type === 'CFEE') {
          const { refId, key } = yield* Effect.fromResult(decodeFeeActivityWitness(raw)).pipe(
            Effect.mapError(() => invalidStream('Alpaca activity cannot be applied as an ordinary fee')),
          )
          if (feeRefs.has(refId)) return yield* invalidStream('Alpaca activity repeated a fee reference')
          feeRefs.add(refId)
          feeCounts.set(key, (feeCounts.get(key) ?? 0) + 1)
          feeView = undefined
        } else if (header.activity_type === 'TRD') {
          const execution = yield* Effect.fromResult(decodeFillExecution(raw, connection.expectedAccountId)).pipe(
            Effect.mapError(() => invalidStream('Alpaca activity cannot be applied as an ordinary execution')),
          )
          const { executionId, ...body } = execution
          if (executionIds.has(executionId)) return yield* invalidStream('Alpaca activity repeated an execution ID')
          const observedAt = yield* currentUtcInstant
          const proof = { status: 200, requestId, contentHash: hash, observedAt }
          const identity = fillActivityIdentity(executionId, body.transactionTime)
          fills.push({ value: { ...body, ...identity }, evidence: proof })
          executionIds.add(executionId)
        }
        checkpoint = { id, hash }
      })

    const bootstrap = Effect.scoped(
      Effect.gen(function* () {
        const until = yield* currentUtcInstant
        const { requestId, frames } = yield* fetchFrames({ since: activityReplayStart, until })
        yield* frames.pipe(
          Stream.runForEach((frame) =>
            frame.type === 'Data' ? apply(frame.value, requestId, undefined, false) : Effect.void,
          ),
        )
        bootstrapped = true
      }),
    ).pipe(Effect.timeout(connection.operationTimeoutMs))

    const connect = Effect.scoped(
      Effect.gen(function* () {
        yield* verifiedAccount
        if (!bootstrapped) {
          checkpoint = undefined
          fills = []
          view = []
          executionIds.clear()
          feeRefs.clear()
          feeCounts.clear()
          feeView = undefined
          yield* bootstrap
        }
        const anchor = checkpoint
        const { requestId, frames } = yield* fetchFrames(
          anchor === undefined ? { since: activityReplayStart } : { since_id: anchor.id },
        )
        let resume = anchor !== undefined
        yield* frames.pipe(
          Stream.timeout('25 seconds'),
          Stream.runForEach((frame) =>
            Effect.gen(function* () {
              if (frame.type === 'Data') {
                yield* apply(frame.value, requestId, anchor, resume)
                resume = false
              }
              if (!resume && (connected || frame.type === 'Heartbeat')) {
                evidence = {
                  status: 200,
                  requestId,
                  contentHash: checkpoint?.hash ?? emptyHash,
                  observedAt: yield* currentUtcInstant,
                }
                connected = true
                reconnectMs = 2_000
              }
            }),
          ),
        )
        return yield* invalidStream('Alpaca activity connection closed or stopped emitting')
      }),
    )

    yield* connect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          connected = false
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning('Alpaca activity stream unavailable; reconnecting').pipe(
          Effect.annotateLogs(
            cause instanceof BrokerReadError
              ? { 'broker.failure_kind': cause.kind }
              : { 'broker.failure_kind': 'BOOTSTRAP_TIMEOUT' },
          ),
        ),
      ),
      Effect.andThen(
        Effect.suspend(() => {
          const delay = reconnectMs
          reconnectMs = Math.min(reconnectMs * 2, 60_000)
          return Effect.sleep(delay)
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    const read: Effect.Effect<AccountActivityCut, BrokerReadError> = Effect.gen(function* () {
      const observedAt = yield* currentUtcInstant
      if (!connected || evidence === undefined)
        return yield* observationUnavailable('Alpaca activity stream is not connected')
      if (fills.length !== view.length) view = fills.slice()
      feeView ??= new Map(feeCounts)
      return { fills: view, feeCounts: feeView, evidence: { ...evidence, observedAt } }
    })
    return { read }
  })

const emptyHash = Result.getOrThrow(canonicalHashV1Result([]))
