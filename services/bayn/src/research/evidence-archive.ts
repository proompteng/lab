import { Readable } from 'node:stream'
import { GetBucketAclCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Config, Data, Effect, Option, Redacted, Result, Schema } from 'effect'

import { decodeBrokerProxyUrl } from '../broker/connection'
import { sha256 } from '../hash'

export class EvidenceArchiveFailure extends Data.TaggedError('EvidenceArchiveFailure')<{
  readonly message: string
  readonly status?: number
}> {}

export interface ArchivedBytes {
  readonly body: Uint8Array
  readonly etag: string
}
export interface EvidenceObject {
  readonly key: string
  readonly sha256: string
  readonly bytes: number
}
export interface EvidenceArchive {
  readonly read: (
    key: string,
    maximumBytes: number,
  ) => Effect.Effect<Option.Option<ArchivedBytes>, EvidenceArchiveFailure>
  readonly retain: (key: string, body: Uint8Array) => Effect.Effect<EvidenceObject, EvidenceArchiveFailure>
  readonly checkpoint: (
    key: string,
    body: Uint8Array,
    previousEtag: string | null,
  ) => Effect.Effect<string, EvidenceArchiveFailure>
}

export const evidenceArchiveConfig = Config.all({
  bucket: Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_BUCKET'),
  endpoint: Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_STORAGE_ENDPOINT'),
  region: Config.String('BAYN_PUBLIC_INFORMATION_STORAGE_REGION').pipe(Config.withDefault('us-east-1')),
  accessKey: Config.Redacted('AWS_ACCESS_KEY_ID'),
  secretKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
})
const statusSchema = Schema.Struct({ $metadata: Schema.Struct({ httpStatusCode: Schema.Int }) })
const failure = (message: string, cause: unknown) => {
  const status = Schema.decodeUnknownResult(statusSchema)(cause)
  return new EvidenceArchiveFailure({
    message,
    ...(Result.isSuccess(status) ? { status: status.success.$metadata.httpStatusCode } : {}),
  })
}
export const evidenceObjectMaximumBytes = 64 * 1024 * 1024
const bounded = <A, R>(effect: Effect.Effect<A, EvidenceArchiveFailure, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () =>
        Effect.fail(new EvidenceArchiveFailure({ message: 'Evidence storage operation exceeded 30 seconds' })),
    }),
  )

export const makeEvidenceArchive = (config: Config.Success<typeof evidenceArchiveConfig>) =>
  Effect.gen(function* () {
    const endpoint = yield* Effect.fromResult(decodeBrokerProxyUrl(config.endpoint))
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new S3Client({
            endpoint,
            region: config.region,
            forcePathStyle: true,
            maxAttempts: 1,
            requestChecksumCalculation: 'WHEN_REQUIRED',
            credentials: {
              accessKeyId: Redacted.value(config.accessKey),
              secretAccessKey: Redacted.value(config.secretKey),
            },
          }),
      ),
      (client) => Effect.sync(() => client.destroy()),
    )
    yield* Effect.tryPromise({
      try: async (signal) => {
        const acl = await client.send(new GetBucketAclCommand({ Bucket: config.bucket }), { abortSignal: signal })
        const owner = acl.Owner?.ID
        if (
          owner === undefined ||
          acl.Grants?.length !== 1 ||
          acl.Grants[0]?.Grantee?.Type !== 'CanonicalUser' ||
          acl.Grants[0]?.Grantee?.ID !== owner ||
          acl.Grants[0]?.Permission !== 'FULL_CONTROL'
        )
          throw new Error('Evidence bucket must be private to its unique owner')
      },
      catch: (cause) => failure('Evidence bucket ownership or privacy could not be verified', cause),
    }).pipe(bounded)
    const read: EvidenceArchive['read'] = (key, maximumBytes) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
            abortSignal: signal,
          })
          if (!(response.Body instanceof Readable)) throw new Error('Evidence read is not a byte stream')
          const stream = response.Body
          const cancel = () => stream.destroy()
          signal.addEventListener('abort', cancel, { once: true })
          if (signal.aborted) cancel()
          try {
            if (
              !Number.isSafeInteger(maximumBytes) ||
              maximumBytes < 0 ||
              maximumBytes > evidenceObjectMaximumBytes ||
              response.ContentLength === undefined ||
              response.ContentLength > maximumBytes ||
              response.ETag === undefined ||
              response.ETag.length === 0
            )
              throw new Error('Evidence object exceeds its declared byte bound or lacks an ETag')
            const chunks: Uint8Array[] = []
            let bytes = 0
            for await (const chunk of stream) {
              if (!(chunk instanceof Uint8Array)) throw new Error('Evidence read is not binary')
              bytes += chunk.byteLength
              if (bytes > maximumBytes) throw new Error('Evidence stream exceeded its byte bound')
              chunks.push(chunk)
            }
            if (bytes !== response.ContentLength) throw new Error('Evidence read length differs')
            return Option.some({ body: Buffer.concat(chunks), etag: response.ETag })
          } finally {
            signal.removeEventListener('abort', cancel)
            stream.destroy()
          }
        },
        catch: (cause) => failure('Evidence read failed', cause),
      }).pipe(
        bounded,
        Effect.catchTag('EvidenceArchiveFailure', (error) =>
          error.status === 404 ? Effect.succeed(Option.none()) : Effect.fail(error),
        ),
      )
    const put = (key: string, body: Uint8Array, previousEtag: string | null) =>
      Effect.gen(function* () {
        if (!key.startsWith('native-evidence/v1/') || body.byteLength > evidenceObjectMaximumBytes)
          return yield* new EvidenceArchiveFailure({ message: 'Evidence write is outside its prefix or byte bound' })
        yield* Effect.tryPromise({
          try: (signal) =>
            client.send(
              new PutObjectCommand({
                Bucket: config.bucket,
                Key: key,
                Body: body,
                ContentLength: body.byteLength,
                ContentType: 'application/octet-stream',
                ACL: 'private',
                Metadata: { sha256: sha256(body) },
                ...(previousEtag === null ? { IfNoneMatch: '*' } : { IfMatch: previousEtag }),
              }),
              { abortSignal: signal },
            ),
          catch: (cause) => failure('Conditional evidence write failed', cause),
        }).pipe(bounded)
      })
    const archive: EvidenceArchive = {
      read,
      retain: (key, body) =>
        Effect.gen(function* () {
          yield* put(key, body, null).pipe(
            Effect.catchTag('EvidenceArchiveFailure', (error) =>
              error.status === 412 ? Effect.void : Effect.fail(error),
            ),
          )
          const stored = yield* read(key, body.byteLength)
          if (Option.isNone(stored) || !Buffer.from(stored.value.body).equals(body))
            return yield* new EvidenceArchiveFailure({ message: 'Retained evidence failed exact GET readback' })
          return { key, sha256: sha256(body), bytes: body.byteLength }
        }),
      checkpoint: (key, body, previousEtag) =>
        Effect.gen(function* () {
          yield* put(key, body, previousEtag)
          const stored = yield* read(key, body.byteLength)
          if (Option.isNone(stored) || !Buffer.from(stored.value.body).equals(body))
            return yield* new EvidenceArchiveFailure({ message: 'Evidence checkpoint failed exact GET readback' })
          return stored.value.etag
        }),
    }
    return archive
  })
