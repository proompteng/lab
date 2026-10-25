import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { GetBucketAclCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { NodeHttpClient } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { Config, Effect, Layer, Redacted, Result, Schema } from 'effect'

import { decodeBrokerProxyUrl } from './broker/connection'
import {
  PublicArtifactStore,
  PublicInformationError,
  collectPublicInformation,
  type PublicInformationSource,
  type PublicInformationRun,
} from './public-information'
import { SymbolSchema } from './schemas'

const sdkStatus = Schema.Struct({
  $metadata: Schema.Struct({ httpStatusCode: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })) }),
})
const storageError = (stage: string, message: string, cause: unknown) => {
  const status = Schema.decodeUnknownResult(sdkStatus)(cause)
  return new PublicInformationError({
    stage,
    message,
    ...(Result.isSuccess(status) ? { status: status.success.$metadata.httpStatusCode } : {}),
  })
}

export const publicInformationConfig = Config.all({
  bucket: Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_BUCKET'),
  endpoint: Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_STORAGE_ENDPOINT'),
  region: Config.String('BAYN_PUBLIC_INFORMATION_STORAGE_REGION').pipe(Config.withDefault('us-east-1')),
  accessKey: Config.Redacted('AWS_ACCESS_KEY_ID'),
  secretKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
  proxy: Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_PROXY'),
  symbols: Config.schema(
    Schema.fromJsonString(Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100))),
    'BAYN_PUBLIC_INFORMATION_SYMBOLS',
  ),
})

export const PublicInformationResources = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* publicInformationConfig
    const proxy = yield* Effect.fromResult(decodeBrokerProxyUrl(config.proxy))
    const endpoint = yield* Effect.fromResult(decodeBrokerProxyUrl(config.endpoint))
    const storage = Layer.effect(
      PublicArtifactStore,
      Effect.gen(function* () {
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
        return PublicArtifactStore.of({
          qualify: (sourceRevision) =>
            Effect.tryPromise({
              try: async (signal) => {
                const acl = await client.send(new GetBucketAclCommand({ Bucket: config.bucket }), {
                  abortSignal: signal,
                })
                const owner = acl.Owner?.ID
                if (
                  owner === undefined ||
                  acl.Grants?.length !== 1 ||
                  acl.Grants[0]?.Grantee?.Type !== 'CanonicalUser' ||
                  acl.Grants[0]?.Grantee?.ID !== owner ||
                  acl.Grants[0]?.Permission !== 'FULL_CONTROL'
                )
                  throw new Error('Research bucket is not private to its unique owner')
                const body = Buffer.from(`bayn.public-information.storage-proof.v1:${sourceRevision}`)
                const sha256 = createHash('sha256').update(body).digest('hex')
                const key = `captures/v1/public-information/qualification/${sourceRevision}`
                await client.send(
                  new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    Body: body,
                    ContentLength: body.byteLength,
                    ContentType: 'application/octet-stream',
                    Metadata: { sha256 },
                  }),
                  { abortSignal: signal },
                )
                const read = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
                  abortSignal: signal,
                })
                if (!(read.Body instanceof Readable) || read.ContentLength !== body.byteLength)
                  throw new Error('Research storage proof has different bytes')
                const chunks: Uint8Array[] = []
                let count = 0
                for await (const chunk of read.Body) {
                  if (!(chunk instanceof Uint8Array)) throw new Error('Research storage proof is not binary')
                  count += chunk.byteLength
                  if (count > body.byteLength) throw new Error('Research storage proof exceeds its size')
                  chunks.push(chunk)
                }
                if (!Buffer.concat(chunks).equals(body)) throw new Error('Research storage proof SHA-256 differs')
                return { bucketOwnerHash: createHash('sha256').update(owner).digest('hex'), sha256 }
              },
              catch: () =>
                new PublicInformationError({
                  stage: 'storage-qualification',
                  message: 'Research bucket ownership, privacy or exact readback verification failed',
                }),
            }).pipe(
              Effect.timeout('30 seconds'),
              Effect.tap((proof) =>
                Effect.logInfo('Public information private storage verified').pipe(Effect.annotateLogs(proof)),
              ),
              Effect.asVoid,
              Effect.mapError((error) =>
                error instanceof PublicInformationError
                  ? error
                  : new PublicInformationError({
                      stage: 'storage-qualification',
                      message: 'Research storage qualification exceeded its deadline',
                    }),
              ),
            ),
          put: (key, body, contentType, sha256) =>
            Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    Body: body,
                    ContentLength: body.byteLength,
                    ContentType: contentType,
                    Metadata: { sha256 },
                  }),
                  { abortSignal: signal },
                ),
              catch: (cause) => storageError('storage', 'Public artifact upload failed', cause),
            }).pipe(
              Effect.asVoid,
              Effect.timeoutOrElse({
                duration: '10 seconds',
                orElse: () =>
                  Effect.fail(
                    new PublicInformationError({
                      stage: 'storage-deadline',
                      message: 'Public artifact upload exceeded 10 seconds',
                    }),
                  ),
              }),
              Effect.withSpan('bayn.public-information.upload'),
            ),
        })
      }),
    )
    const http = NodeHttpClient.layerUndiciNoDispatcher.pipe(
      Layer.provide(
        Layer.effect(
          NodeHttpClient.Dispatcher,
          Effect.acquireRelease(
            Effect.sync(() => new Undici.ProxyAgent({ uri: proxy })),
            (dispatcher) => Effect.promise(() => dispatcher.destroy()),
          ),
        ),
      ),
    )
    return Layer.mergeAll(storage, http)
  }),
)

export const runPublicInformation = (
  source: PublicInformationSource,
  sourceRevision: string,
  previous: PublicInformationRun | null,
) =>
  Effect.gen(function* () {
    const config = yield* publicInformationConfig
    if (new Set(config.symbols).size !== config.symbols.length)
      return yield* new PublicInformationError({
        stage: 'configuration',
        message: 'Public information symbols must be unique',
      })
    if (previous?.sourceRevision !== sourceRevision) yield* (yield* PublicArtifactStore).qualify(sourceRevision)
    return yield* collectPublicInformation(source, sourceRevision, config.symbols, previous)
  }).pipe(
    Effect.timeoutOrElse({
      duration: '10 minutes',
      orElse: () =>
        Effect.fail(
          new PublicInformationError({ stage: 'deadline', message: 'Public collection exceeded ten minutes' }),
        ),
    }),
    // @effect-diagnostics-next-line strictEffectProvide:off -- each independent Restate job owns its public HTTP and object-store clients
    Effect.provide(PublicInformationResources),
    Effect.tapError((error) =>
      Effect.logWarning('Public information collection failed').pipe(
        Effect.annotateLogs({
          source,
          errorTag: error._tag,
          ...(error instanceof PublicInformationError ? { stage: error.stage, status: error.status ?? null } : {}),
        }),
      ),
    ),
    Effect.scoped,
  )
