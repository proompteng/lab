import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { inspect } from 'node:util'

import { ConfigProvider, Deferred, Effect, Fiber, Result } from 'effect'

import { sha256 } from '../../src/hash'
import { type ArchiveReader, countArchiveLines, readGzipLines, S3ArchiveError, withS3Archive } from './s3-archive'

const key = 'bayn-research-datasets/fixture/MANIFEST.json'
const json = '{"rows":2}'
const accessKey = 'fixture-access-key'
const secretKey = 'fixture-never-logged'
const credentials = { AWS_ACCESS_KEY_ID: accessKey, AWS_SECRET_ACCESS_KEY: secretKey }
const config = (values: Record<string, string> = credentials) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))
const readJson = (reader: ArchiveReader) => reader.readJson(key, sha256(json))

test('signs a read-only request for the bound archive and verifies metadata before decoding', async () => {
  const read = withS3Archive(readJson, (url, init) => {
    const signed = new URL(url)
    expect(signed.origin).toBe('http://rook-ceph-rgw-objectstore.rook-ceph.svc')
    expect(signed.pathname).toBe(`/agents-artifacts/${key}`)
    expect(signed.searchParams.get('X-Amz-Credential')).toContain(`${accessKey}/`)
    expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(init).toMatchObject({ redirect: 'error', decompress: false })
    return Promise.resolve(new Response(json))
  }).pipe(config())
  expect(await Effect.runPromise(read)).toEqual({ rows: 2 })
  await rejects(
    Effect.runPromise(
      withS3Archive(readJson, () => Promise.resolve(new Response('unverified content'))).pipe(config()),
    ),
    /SHA-256 mismatch: bayn-research-datasets\/fixture\/MANIFEST\.json/,
  )
})

test('does not fetch on missing credentials, a source override, or an invalid key', async () => {
  let requests = 0
  const request = () => {
    requests++
    return Promise.resolve(new Response(json))
  }
  await rejects(
    Effect.runPromise(withS3Archive(readJson, request).pipe(config({ ...credentials, AWS_ACCESS_KEY_ID: '' }))),
    /AWS_ACCESS_KEY_ID/,
  )
  await rejects(
    Effect.runPromise(withS3Archive(readJson, request).pipe(config({ ...credentials, AWS_ACCESS_KEY_ID: ' ' }))),
    /credentials must not be empty/,
  )
  await rejects(
    Effect.runPromise(
      withS3Archive(readJson, request).pipe(config({ ...credentials, AGENTS_ARTIFACTS_BUCKET: 'other' })),
    ),
    /Expected the Rook-Ceph agents-artifacts source/,
  )
  await rejects(
    Effect.runPromise(
      withS3Archive((reader) => reader.readJson('s3://other/key', sha256(json)), request).pipe(config()),
    ),
    /Invalid archive object key/,
  )
  expect(requests).toBe(0)
})

test('redacts transport causes and cancels failed HTTP response bodies', async () => {
  const cause = new Error(`presigned URL: X-Amz-Signature=${secretKey}`)
  const transportFailure = withS3Archive(readJson, () => Promise.reject(cause)).pipe(config())
  const outcome = await Effect.runPromise(Effect.result(transportFailure))
  if (!Result.isFailure(outcome)) throw new Error('Expected the transport error')
  const error = outcome.failure
  expect(error).toBeInstanceOf(S3ArchiveError)
  expect(error.message).toBe(`S3 transport failed: ${key}`)
  expect(inspect(error)).not.toContain(secretKey)
  expect(JSON.stringify(error)).not.toContain(secretKey)

  let canceled = 0
  const body = new ReadableStream({
    cancel: () => {
      canceled++
    },
  })
  const httpFailure = withS3Archive(readJson, () => Promise.resolve(new Response(body, { status: 403 }))).pipe(config())
  await rejects(Effect.runPromise(httpFailure), /S3 read failed \(HTTP 403\)/)
  expect(canceled).toBe(1)
})

test('interrupting the Effect aborts a streaming read and releases its body once', async () => {
  const receipt = { key, bytes: 32, sha256: '0'.repeat(64) }
  let canceled = 0
  let requestSignal: AbortSignal | null | undefined
  await Effect.runPromise(
    Effect.gen(function* () {
      const streaming = yield* Deferred.make<void>()
      const exited = yield* Deferred.make<void>()
      const read = withS3Archive(
        async (reader) => {
          try {
            await reader.readGzip(receipt, async (batches) => {
              Deferred.doneUnsafe(streaming, Effect.void)
              return countArchiveLines(() => {})(batches)
            })
          } finally {
            Deferred.doneUnsafe(exited, Effect.void)
          }
        },
        (_url, init) => {
          requestSignal = init.signal
          const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
            cancel: () => {
              canceled++
            },
          })
          return Promise.resolve(new Response(body))
        },
      ).pipe(config())
      const fiber = yield* Effect.forkScoped(read)
      yield* Deferred.await(streaming)
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(exited)
    }).pipe(Effect.scoped),
  )
  expect(requestSignal?.aborted).toBe(true)
  expect(canceled).toBe(1)
})

const signal = new AbortController().signal

test('streams UTF-8 lines from the bound gzip member but hashes the entire object and decoded bytes', async () => {
  const raw = new TextEncoder().encode('first\nlast é')
  const member = Bun.gzipSync(raw)
  const object = new Uint8Array(member.length + 3)
  object.set(member)
  object.fill(0xff, member.length)
  const receipt = {
    key,
    bytes: object.length,
    memberBytes: member.length,
    sha256: sha256(object),
    raw: { bytes: raw.length, sha256: sha256(raw) },
  }
  const input = (bytes: Uint8Array<ArrayBuffer>) =>
    new ReadableStream({
      start(controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>) {
        controller.enqueue(bytes.subarray(0, member.length - 1))
        controller.enqueue(bytes.subarray(member.length - 1))
        controller.close()
      },
    })
  const lines: [string, number][] = []
  const collect = countArchiveLines((line, index) => lines.push([line, index]))
  expect(await readGzipLines(input(object), receipt, signal, collect)).toBe(2)
  expect(lines).toEqual([
    ['first', 0],
    ['last é', 1],
  ])

  await rejects(
    readGzipLines(input(object), { ...receipt, raw: { ...receipt.raw, sha256: 'a'.repeat(64) } }, signal, collect),
    /Decoded byte receipt mismatch/,
  )
  await rejects(
    readGzipLines(input(object), { ...receipt, bytes: object.length - 1 }, signal, collect),
    /Compressed byte receipt mismatch/,
  )
  await rejects(
    readGzipLines(input(object), receipt, signal, () => Promise.resolve('unused')),
    /Gzip was not fully consumed/,
  )
  object[object.length - 1] ^= 1
  await rejects(readGzipLines(input(object), receipt, signal, collect), /Compressed byte receipt mismatch/)
})
