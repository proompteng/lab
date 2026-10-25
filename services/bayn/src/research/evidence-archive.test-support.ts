import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { Effect, Exit, Fiber, Layer, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'

import { makeEvidenceArchive, evidenceObjectMaximumBytes } from './evidence-archive'
import { auditNativeArrivalArchive } from './native-arrival-archive-audit'
import { exportNativeArrivalPrefix } from './native-arrival-export'
import { nativeArrivalArchiveFixture } from './native-arrival-export.test-support'

const mode = process.argv[2]
const objects = new Map<string, { body: Buffer; etag: string }>()
let version = 0
let entered: (() => void) | undefined
let closed: (() => void) | undefined
const pendingEntered = new Promise<void>((resolve) => {
  entered = resolve
})
const pendingClosed = new Promise<void>((resolve) => {
  closed = resolve
})
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture')
  if (url.searchParams.has('acl')) {
    const grantee =
      mode === 'public'
        ? '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee>'
        : '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>fixture-owner</ID></Grantee>'
    response
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>fixture-owner</ID></Owner><AccessControlList><Grant>${grantee}<Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`,
      )
    return
  }
  const existing = objects.get(url.pathname)
  if (request.method === 'PUT') {
    if (
      (request.headers['if-none-match'] === '*' && existing !== undefined) ||
      (request.headers['if-match'] !== undefined && request.headers['if-match'] !== existing?.etag)
    ) {
      request.resume()
      response
        .writeHead(412, { 'content-type': 'application/xml' })
        .end('<Error><Code>PreconditionFailed</Code></Error>')
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const etag = `"version-${++version}"`
    assert.equal(request.headers['x-amz-acl'], 'private')
    assert.equal(typeof request.headers['x-amz-meta-sha256'], 'string')
    objects.set(url.pathname, { body, etag })
    response.writeHead(200, { etag }).end()
  } else if (url.pathname.endsWith('/pending')) {
    response.on('close', () => closed?.())
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '16', etag: '"pending"' })
    response.write('a')
    entered?.()
  } else if (existing === undefined) {
    response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>')
  } else {
    const body = mode === 'corrupt' ? Buffer.alloc(existing.body.length, 1) : existing.body
    response
      .writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        etag: existing.etag,
      })
      .end(body)
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Storage fixture did not bind TCP')
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        makeEvidenceArchive({
          bucket: 'evidence',
          endpoint: `http://127.0.0.1:${address.port}`,
          region: 'us-east-1',
          accessKey: Redacted.make('fixture-access'),
          secretKey: Redacted.make('fixture-secret'),
        }),
      )
      if (mode === 'public') {
        assert(Exit.isFailure(result))
        assert.equal(objects.size, 0)
        return
      }
      if (Exit.isFailure(result)) throw new Error('Private storage fixture was rejected')
      const archive = result.value
      if (mode === 'audit') {
        const fixture = nativeArrivalArchiveFixture()
        const receipt = yield* exportNativeArrivalPrefix(fixture.source, archive, 20)
        const report = yield* auditNativeArrivalArchive(archive, {
          captureId: receipt.captureId,
          receiptHash: receipt.receiptHash,
          maximumPages: 3,
          auditSourceRevision: 'f'.repeat(40),
        })
        assert.equal(report.records, 20)
        assert.equal(report.pages, 3)
        assert.equal(report.completeRetainedPrefixBytesVerified, true)
        assert.equal(report.completeSessionCoverage, false)
        assert.equal(report.qualification, 'UNQUALIFIED')
        return
      }
      const key = 'native-evidence/v1/fixture/original'
      const body = new TextEncoder().encode('original native bytes: 你好\n')
      if (mode === 'cancel' || mode === 'deadline') {
        const fiber = yield* archive
          .read('native-evidence/v1/fixture/pending', 16)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.promise(() => pendingEntered)
        if (mode === 'cancel') yield* Fiber.interrupt(fiber)
        else {
          yield* TestClock.adjust(30_000)
          assert(Exit.isFailure(yield* Fiber.await(fiber)))
        }
        yield* Effect.promise(() => pendingClosed).pipe(Effect.timeout('2 seconds'))
        return
      }
      const retained = yield* Effect.exit(archive.retain(key, body))
      if (mode === 'corrupt') {
        assert(Exit.isFailure(retained))
        return
      }
      assert(Exit.isSuccess(retained))
      yield* archive.retain(key, body)
      assert.equal(objects.size, 1)
      assert(Exit.isFailure(yield* Effect.exit(archive.retain(key, new TextEncoder().encode('substitution')))))
      assert(Exit.isFailure(yield* Effect.exit(archive.read(key, 1))))
      assert(Option.isNone(yield* archive.read('native-evidence/v1/missing', 100)))
      assert(Exit.isFailure(yield* Effect.exit(archive.retain('other-prefix', body))))
      assert(Exit.isFailure(yield* Effect.exit(archive.retain(key, new Uint8Array(evidenceObjectMaximumBytes + 1)))))
      const checkpoint = 'native-evidence/v1/fixture/cursor'
      const first = yield* archive.checkpoint(checkpoint, body, null)
      const second = yield* archive.checkpoint(checkpoint, new TextEncoder().encode('next'), first)
      assert.notEqual(first, second)
      assert(Exit.isFailure(yield* Effect.exit(archive.checkpoint(checkpoint, body, first))))
      assert.equal(objects.get('/evidence/' + checkpoint)?.body.toString(), 'next')
    }).pipe(Effect.scoped, Effect.provide(mode === 'deadline' ? TestClock.layer() : Layer.empty)),
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
  )
}
process.stdout.write('EVIDENCE_STORAGE_VERIFIED\n')
