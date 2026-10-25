import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'
import { ConfigProvider, Effect, Logger, Result } from 'effect'
import { PublicArtifactStore } from './public-information'
import { PublicInformationResources } from './public-information-resources'

const verify = async () => {
  const received: {
    method: string | undefined
    url: string | undefined
    hash: string | undefined
    body: Buffer
    signed: boolean
  }[] = []
  const objects = new Map<string, Buffer>()
  const publicAcl = process.argv.includes('--public-acl')
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push({
      method: request.method,
      url: request.url,
      hash: typeof request.headers['x-amz-meta-sha256'] === 'string' ? request.headers['x-amz-meta-sha256'] : undefined,
      body: Buffer.concat(chunks),
      signed: request.headers.authorization?.includes('Credential=test-access-key/') ?? false,
    })
    const path = request.url?.split('?')[0] ?? ''
    if (request.url?.includes('acl')) {
      const grantee = publicAcl
        ? '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee>'
        : '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>test-owner</ID><DisplayName>test-owner</DisplayName></Grantee>'
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>test-owner</ID><DisplayName>test-owner</DisplayName></Owner><AccessControlList><Grant>${grantee}<Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`,
        )
    } else if (request.method === 'PUT') {
      objects.set(path, Buffer.concat(chunks))
      response.writeHead(200, { etag: '"test-etag"' }).end()
    } else {
      const body = objects.get(path)
      if (body === undefined) response.writeHead(404).end()
      else
        response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' }).end(body)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing local storage address')
    const body = new TextEncoder().encode('public source bytes\n')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* PublicArtifactStore
          const qualified = yield* storage.qualify('a'.repeat(40)).pipe(Effect.result)
          if (publicAcl) {
            assert.equal(Result.isFailure(qualified), true)
            return
          }
          assert.equal(Result.isSuccess(qualified), true)
          yield* storage.put('captures/v1/public-information/test', body, 'text/plain', 'a'.repeat(64))
        }),
      ).pipe(
        Effect.provide(PublicInformationResources),
        Effect.provideService(Logger.CurrentLoggers, new Set()),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            BAYN_PUBLIC_INFORMATION_BUCKET: 'private-test-bucket',
            BAYN_PUBLIC_INFORMATION_STORAGE_ENDPOINT: `http://127.0.0.1:${address.port}`,
            AWS_ACCESS_KEY_ID: 'test-access-key',
            AWS_SECRET_ACCESS_KEY: 'test-secret-key',
            BAYN_PUBLIC_INFORMATION_PROXY: 'http://127.0.0.1:1',
            BAYN_PUBLIC_INFORMATION_SYMBOLS: '["AAPL"]',
          }),
        ),
      ),
    )
    if (publicAcl) {
      assert.equal(received.length, 1)
      return
    }
    assert.equal(received.length, 4)
    assert.equal(received[3]?.method, 'PUT')
    assert.equal(received[3]?.url, '/private-test-bucket/captures/v1/public-information/test?x-id=PutObject')
    assert.equal(received[3]?.hash, 'a'.repeat(64))
    assert.deepEqual(received[3]?.body, Buffer.from(body))
    assert.equal(received[3]?.signed, true)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }
}
await verify()
process.stdout.write('PUBLIC_STORAGE_VERIFIED\n')
