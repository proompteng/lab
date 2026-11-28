import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted } from 'effect'

import { sha256 } from '../../src/hash'

const rgwEndpoint = 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'
export const archiveBucket = 'agents-artifacts'

export class S3ArchiveError extends Data.TaggedError('S3ArchiveError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

export interface GzipReceipt {
  readonly key: string
  readonly bytes: number
  readonly sha256: string
  readonly memberBytes?: number
  readonly raw?: { readonly bytes: number; readonly sha256: string }
}

type ConsumeLines<A> = (batches: AsyncIterable<readonly string[]>) => Promise<A>

export interface ArchiveReader {
  readonly readJson: (key: string, digest: string) => Promise<unknown>
  readonly readGzip: <A>(receipt: GzipReceipt, consume: ConsumeLines<A>) => Promise<A>
}

export const decodeArchiveJson = (bytes: Uint8Array, label: string, digest: string): unknown => {
  if (sha256(bytes) !== digest) throw new S3ArchiveError({ message: `SHA-256 mismatch: ${label}` })
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw archiveError(`Invalid archive JSON: ${label}`, cause)
  }
}

const archiveError = (message: string, cause: unknown) => new S3ArchiveError({ message, cause: Redacted.make(cause) })

export const readGzipLines = async <A>(
  input: ReadableStream<Uint8Array<ArrayBuffer>>,
  receipt: GzipReceipt,
  signal: AbortSignal,
  consume: ConsumeLines<A>,
): Promise<A> => {
  const { key, bytes, memberBytes = bytes, raw } = receipt
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(memberBytes) || memberBytes <= 0 || memberBytes > bytes) {
    await input.cancel().catch(() => undefined)
    throw new S3ArchiveError({ message: `Invalid gzip member size: ${key}` })
  }
  const compressedHash = new Bun.CryptoHasher('sha256')
  let compressedBytes = 0
  const reader = input
    .pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, out) {
          if (compressedBytes + chunk.length > bytes)
            throw new S3ArchiveError({ message: `Compressed byte receipt mismatch: ${key}` })
          compressedHash.update(chunk)
          // Some receipts bind a gzip member followed by non-tape bytes. Authenticate the entire object.
          if (compressedBytes < memberBytes) out.enqueue(chunk.subarray(0, memberBytes - compressedBytes))
          compressedBytes += chunk.length
        },
        flush() {
          if (compressedBytes !== bytes || compressedHash.digest('hex') !== receipt.sha256)
            throw new S3ArchiveError({ message: `Compressed byte receipt mismatch: ${key}` })
        },
      }),
    )
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader()
  const cancel = () => reader.cancel().catch(() => undefined)
  const abort = () => {
    void cancel()
  }
  signal.addEventListener('abort', abort, { once: true })

  let verified = false
  async function* lines() {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const rawHash = raw === undefined ? undefined : new Bun.CryptoHasher('sha256')
    let rawBytes = 0
    let rest = ''
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read().catch((cause) => {
        throw cause instanceof S3ArchiveError ? cause : archiveError(`Unable to decode gzip: ${key}`, cause)
      })
      signal.throwIfAborted()
      if (done) break
      rawHash?.update(value)
      rawBytes += value.length
      if (raw !== undefined && rawBytes > raw.bytes)
        throw new S3ArchiveError({ message: `Decoded byte receipt mismatch: ${key}` })
      const chunk = (rest + decoder.decode(value, { stream: true })).split('\n')
      rest = chunk.pop() ?? ''
      if (chunk.length > 0) yield chunk
    }
    if (raw !== undefined && (rawBytes !== raw.bytes || rawHash?.digest('hex') !== raw.sha256))
      throw new S3ArchiveError({ message: `Decoded byte receipt mismatch: ${key}` })
    rest += decoder.decode()
    if (rest.length > 0) yield [rest]
    verified = true
  }

  try {
    signal.throwIfAborted()
    const result = await consume(lines())
    signal.throwIfAborted()
    if (!verified) throw new S3ArchiveError({ message: `Gzip was not fully consumed: ${key}` })
    return result
  } finally {
    signal.removeEventListener('abort', abort)
    await cancel()
    reader.releaseLock()
  }
}

export const countArchiveLines =
  (onLine: (line: string, index: number) => void): ConsumeLines<number> =>
  async (batches) => {
    let rows = 0
    for await (const batch of batches) {
      for (const line of batch) onLine(line, rows++)
    }
    return rows
  }

type RequestObject = (url: string, init: BunFetchRequestInit) => Promise<Response>
const objectKey = /^(?:[\w-]+(?:\.[\w-]+)*\/)*[\w-]+(?:\.[\w-]+)*$/

export const withS3Archive = <A>(
  use: (archive: ArchiveReader, signal: AbortSignal) => Promise<A>,
  request: RequestObject = fetch,
) =>
  Effect.gen(function* () {
    const config = yield* Config.all({
      endpoint: Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(Config.withDefault(rgwEndpoint)),
      bucket: Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault(archiveBucket)),
      accessKeyId: Config.Redacted('AWS_ACCESS_KEY_ID'),
      secretAccessKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
    })
    if (config.endpoint !== rgwEndpoint || config.bucket !== archiveBucket)
      return yield* new S3ArchiveError({ message: 'Expected the Rook-Ceph agents-artifacts source' })

    const client = yield* Effect.try({
      try: () => {
        const accessKeyId = Redacted.value(config.accessKeyId)
        const secretAccessKey = Redacted.value(config.secretAccessKey)
        if (accessKeyId.trim() === '' || secretAccessKey.trim() === '')
          throw new S3ArchiveError({ message: 'Archive credentials must not be empty' })
        return new S3Client({
          endpoint: rgwEndpoint,
          bucket: archiveBucket,
          region: 'us-east-1',
          accessKeyId,
          secretAccessKey,
        })
      },
      catch: (cause) =>
        cause instanceof S3ArchiveError ? cause : archiveError('Unable to initialize archive authentication', cause),
    })
    return yield* Effect.tryPromise({
      try: (signal) => {
        const open = async (key: string) => {
          if (!objectKey.test(key)) throw new S3ArchiveError({ message: 'Invalid archive object key' })
          const response = await Promise.resolve()
            .then(() =>
              request(client.presign(key, { expiresIn: 60 }), { signal, redirect: 'error', decompress: false }),
            )
            .catch((cause) => {
              // Fetch and signing errors can embed the presigned URL.
              throw archiveError(`S3 transport failed: ${key}`, cause)
            })
          if (!response.ok || response.body === null) {
            await response.body?.cancel().catch(() => undefined)
            throw new S3ArchiveError({ message: `S3 read failed (HTTP ${response.status}): ${key}` })
          }
          return { response, body: response.body }
        }
        return use(
          {
            readJson: async (key, digest) => {
              const { response } = await open(key)
              const bytes = await response.bytes().catch((cause) => {
                throw archiveError(`Unable to read S3 body: ${key}`, cause)
              })
              return decodeArchiveJson(bytes, key, digest)
            },
            readGzip: async (receipt, consume) =>
              readGzipLines((await open(receipt.key)).body, receipt, signal, consume),
          },
          signal,
        )
      },
      catch: (cause) =>
        cause instanceof S3ArchiveError
          ? cause
          : archiveError(cause instanceof Error ? cause.message : 'Research archive processing failed', cause),
    })
  })
