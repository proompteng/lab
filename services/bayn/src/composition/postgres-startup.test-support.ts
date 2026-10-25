import assert from 'node:assert/strict'
import { createServer, Socket } from 'node:net'
import { spyOn } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, Redacted, Result } from 'effect'
import { isSqlError } from 'effect/sql/SqlError'

import { PostgresClientResourceLive } from './resources'

const server = createServer()
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address !== null && typeof address !== 'string')
await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
const connections = spyOn(Socket.prototype, 'connect')
try {
  const result = await Effect.runPromise(
    Effect.void.pipe(
      Effect.provide(
        PostgresClientResourceLive({
          operationTimeoutMs: 10_000,
          postgres: {
            url: Redacted.make(`postgresql://fixture@127.0.0.1:${address.port}/fixture`),
            tls: false,
            caPath: '',
          },
        }),
      ),
      Effect.provide(NodeServices.layer),
      Effect.result,
    ),
  )
  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.failure, 'unavailable')
  assert.equal(result.failure.operation, 'connect')
  assert.ok(isSqlError(result.failure.cause))
  assert.equal(result.failure.cause.reason._tag, 'ConnectionError')
  process.stdout.write(`POSTGRES_STARTUP_RESULT=${JSON.stringify({ attempts: connections.mock.calls.length })}\n`)
} finally {
  connections.mockRestore()
}
