import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { Clock, Effect, Redacted, Result, Schema } from 'effect'

import { sha256 } from '../hash'
import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'
import { ResearchCaptureFailure, maximumResearchCaptureChunkBytes } from './capture'
import { researchCaptureObjectKey, type ResearchCaptureObjectStore } from './export'

const CaptureS3OptionsSchema = Schema.Struct({
  endpoint: StrictNonEmptyStringSchema,
  bucket: StrictNonEmptyStringSchema,
  region: Schema.String,
  accessKeyId: Schema.Redacted(StrictNonEmptyStringSchema),
  secretAccessKey: Schema.Redacted(StrictNonEmptyStringSchema),
  timeoutMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1000)),
})
const ReadbackSchema = Schema.Struct({
  ContentLength: NonNegativeIntegerSchema,
  Body: Schema.instanceOf(Readable),
  $metadata: Schema.Struct({ httpStatusCode: Schema.Literal(200) }),
})
const failure = (message: string) => new ResearchCaptureFailure({ message })
enum CaptureObjectPhase {
  Validating = 'VALIDATING',
  ConditionalPut = 'CONDITIONAL_PUT',
  Readback = 'READBACK',
  VerifyBytes = 'VERIFY_BYTES',
  Verified = 'VERIFIED',
}
const maximumSdkResponseBytes = 8 * 1024
const collectSdkResponse = async (input: unknown): Promise<Uint8Array> => {
  if (input === undefined) return Buffer.alloc(0)
  if (!(input instanceof Readable)) throw failure('Capture SDK response is not a bounded Node stream')
  const bytes = Buffer.alloc(maximumSdkResponseBytes)
  let length = 0
  try {
    for await (const part of input) {
      if (!(part instanceof Uint8Array) || length + part.byteLength > maximumSdkResponseBytes)
        throw failure('Capture SDK response exceeded its byte bound')
      bytes.set(part, length)
      length += part.byteLength
    }
    return bytes.subarray(0, length)
  } finally {
    if (!input.destroyed) input.destroy()
  }
}
const responseBodySchema = Schema.Struct({ body: Schema.Unknown })
const cancelResponseWith = (response: unknown, signal: AbortSignal): void => {
  const decoded = Schema.decodeUnknownResult(responseBodySchema)(response)
  if (Result.isFailure(decoded)) throw failure('Capture SDK returned an invalid response')
  const body = decoded.success.body
  if (!(body instanceof Readable)) {
    if (body === undefined || (body instanceof Uint8Array && body.byteLength <= maximumSdkResponseBytes)) return
    throw failure('Capture SDK response has an unsupported or oversized body')
  }
  const abort = () => {
    if (!body.destroyed) body.destroy()
  }
  const cleanup = () => {
    signal.removeEventListener('abort', abort)
    body.removeListener('end', cleanup)
    body.removeListener('close', cleanup)
  }
  body.once('end', cleanup)
  body.once('close', cleanup)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
}
const safeFailure = (cause: unknown) =>
  cause instanceof ResearchCaptureFailure
    ? cause
    : new ResearchCaptureFailure({
        message: 'Capture object write or readback failed',
        cause:
          cause instanceof S3ServiceException
            ? { name: 'S3ServiceFailure', httpStatusCode: cause.$metadata.httpStatusCode }
            : { name: 'TransportFailure' },
      })

/** Explicit construction only. No ambient credential provider, environment reader, or live composition. */
export const makeS3ResearchCaptureObjectStore = (
  input: typeof CaptureS3OptionsSchema.Type,
  requestHandler?: S3ClientConfig['requestHandler'],
) =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(CaptureS3OptionsSchema, strictParseOptions)(input)
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new S3Client({
            endpoint: options.endpoint,
            region: options.region === '' ? 'us-east-1' : options.region,
            credentials: {
              accessKeyId: Redacted.value(options.accessKeyId),
              secretAccessKey: Redacted.value(options.secretAccessKey),
            },
            forcePathStyle: true,
            maxAttempts: 1,
            followRegionRedirects: false,
            requestChecksumCalculation: 'WHEN_REQUIRED',
            streamCollector: collectSdkResponse,
            ...(requestHandler === undefined ? {} : { requestHandler }),
          }),
        catch: safeFailure,
      }),
      (resource) =>
        Effect.sync(() => {
          Result.try(() => resource.destroy())
        }),
    )
    return {
      putVerified: (object) =>
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan.pipe(Effect.orDie)
          const clock = yield* Clock.Clock
          return yield* Effect.tryPromise({
            try: async (signal) => {
              if (
                object.payload.byteLength > maximumResearchCaptureChunkBytes ||
                sha256(object.payload) !== object.contentHash
              )
                throw failure('Capture object exceeds its byte limit or differs from its content address')
              span.attribute('bayn.capture.object.sha256', object.contentHash)
              const location = { Bucket: options.bucket, Key: researchCaptureObjectKey(object.contentHash) }
              const put = new PutObjectCommand({
                ...location,
                Body: object.payload,
                ContentLength: object.payload.byteLength,
                ContentType: 'application/octet-stream',
                IfNoneMatch: '*',
              })
              put.middlewareStack.add(
                (next) => async (args) => {
                  const result = await next(args)
                  cancelResponseWith(result.response, signal)
                  return result
                },
                { step: 'deserialize', priority: 'low', name: 'captureResponseCancellation' },
              )
              span.attribute('bayn.capture.object.phase', CaptureObjectPhase.ConditionalPut)
              span.event('bayn.capture.object.put.started', clock.currentTimeNanosUnsafe())
              const putStatus = await client.send(put, { abortSignal: signal }).then(
                (response) => response.$metadata.httpStatusCode,
                (cause: unknown) => {
                  if (!(cause instanceof S3ServiceException) || cause.$metadata.httpStatusCode !== 412) throw cause
                  return 412
                },
              )
              if (signal.aborted) throw failure('Capture object operation was cancelled before readback')
              span.event(
                'bayn.capture.object.put.acknowledged',
                clock.currentTimeNanosUnsafe(),
                putStatus === undefined ? {} : { 'http.response.status_code': putStatus },
              )
              span.attribute('bayn.capture.object.phase', CaptureObjectPhase.Readback)
              span.event('bayn.capture.object.readback.started', clock.currentTimeNanosUnsafe())
              const get = new GetObjectCommand(location)
              get.middlewareStack.add(
                (next) => async (args) => {
                  const result = await next(args)
                  cancelResponseWith(result.response, signal)
                  return result
                },
                { step: 'deserialize', priority: 'low', name: 'captureResponseCancellation' },
              )
              const response = await client.send(get, { abortSignal: signal })
              if (signal.aborted) {
                if (response.Body instanceof Readable && !response.Body.destroyed) response.Body.destroy()
                throw failure('Capture object operation was cancelled during readback')
              }
              span.event('bayn.capture.object.readback.headers_received', clock.currentTimeNanosUnsafe())
              const decoded = Schema.decodeUnknownResult(ReadbackSchema)(response)
              const body = response.Body
              if (
                Result.isFailure(decoded) ||
                response.ContentRange !== undefined ||
                response.ContentLength !== object.payload.byteLength
              ) {
                if (body instanceof Readable && !body.destroyed) body.destroy()
                throw failure('Capture readback lacks the exact full-object byte length or stream')
              }
              const stream = decoded.success.Body
              span.attribute('bayn.capture.object.phase', CaptureObjectPhase.VerifyBytes)
              const abort = () => {
                if (!stream.destroyed) stream.destroy(new Error('Capture readback cancelled'))
              }
              signal.addEventListener('abort', abort, { once: true })
              try {
                if (signal.aborted) abort()
                let length = 0
                const digest = createHash('sha256')
                for await (const part of stream) {
                  if (!(part instanceof Uint8Array) || length + part.byteLength > object.payload.byteLength)
                    throw failure('Capture readback exceeded its exact byte bound')
                  const expected = object.payload.subarray(length, length + part.byteLength)
                  if (!Buffer.from(part.buffer, part.byteOffset, part.byteLength).equals(expected))
                    throw failure('Capture readback changed original bytes')
                  digest.update(part)
                  length += part.byteLength
                }
                if (
                  signal.aborted ||
                  length !== object.payload.byteLength ||
                  digest.digest('hex') !== object.contentHash
                )
                  throw failure('Capture readback was interrupted, truncated, or has a different hash')
                span.attribute('bayn.capture.object.phase', CaptureObjectPhase.Verified)
                span.event('bayn.capture.object.verified', clock.currentTimeNanosUnsafe())
              } finally {
                signal.removeEventListener('abort', abort)
                if (!stream.destroyed) stream.destroy()
              }
            },
            catch: safeFailure,
          })
        }).pipe(
          Effect.timeoutOrElse({
            duration: options.timeoutMs,
            orElse: () => Effect.fail(failure('Capture object operation has an unknown outcome')),
          }),
          Effect.withSpan(
            'bayn.capture.object.put_verified',
            {
              kind: 'client',
              attributes: {
                'bayn.dependency': 'object-storage',
                'bayn.operation': 'PUT_VERIFIED',
                'bayn.capture.object.bytes': object.payload.byteLength,
                'bayn.capture.object.phase': CaptureObjectPhase.Validating,
              },
            },
            { captureStackTrace: false },
          ),
        ),
    } satisfies ResearchCaptureObjectStore
  })
