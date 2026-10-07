import assert from 'node:assert/strict'
import * as actualNet from 'node:net'
import { mock } from 'bun:test'
import * as actualPostgres from '@effect/sql-pg'
import { Effect, Exit, FileSystem, Redacted } from 'effect'

const netExports = { ...actualNet }
const postgresExports = { ...actualPostgres }
const configured: actualPostgres.PgClient.PgClientConfig[] = []
const sockets: TestSocket[] = []

class TestSocket {
  readonly calls: string[] = []
  destination: unknown
  timeout: (() => void) | undefined
  destroyedWith: Error | undefined

  constructor() {
    sockets.push(this)
  }

  setNoDelay(enabled: boolean) {
    this.calls.push(`no-delay:${enabled}`)
    return this
  }

  setTimeout(milliseconds: number, timeout: () => void) {
    this.calls.push(`deadline:${milliseconds}`)
    this.timeout = timeout
    return this
  }

  connect(destination: unknown) {
    this.calls.push('connect')
    this.destination = destination
    return this
  }

  destroy(cause: Error) {
    this.calls.push('destroy')
    this.destroyedWith = cause
    return this
  }
}

await mock.module('node:net', () => ({ ...netExports, Socket: TestSocket }))
await mock.module('@effect/sql-pg', () => ({
  ...postgresExports,
  PgClient: {
    ...postgresExports.PgClient,
    make: (options: actualPostgres.PgClient.PgClientConfig) => {
      configured.push(options)
      return Effect.fail(new Error('Fixture stops before acquiring a PostgreSQL connection'))
    },
  },
}))

try {
  const { PostgresClientLive } = await import('./postgres-client')
  const cases = [
    {
      name: 'tcp',
      url: 'postgresql://fixture@postgres.example:5433/database?options=-c%20lock_timeout%3D1000',
      tls: false,
      budgetMs: 30_000,
      statementTimeoutMs: 25_000,
      socketTimeoutMs: 27_500,
      destination: { host: 'postgres.example', port: 5433 },
      clientTarget: { host: 'postgres.example', port: 5433, username: 'fixture', database: 'database' },
      options: '-c lock_timeout=1000 -c statement_timeout=25000',
    },
    {
      name: 'tls',
      url: 'postgresql://fixture@secure-postgres.example/database',
      tls: true,
      budgetMs: 6_000,
      statementTimeoutMs: 3_000,
      socketTimeoutMs: 4_500,
      destination: { host: 'secure-postgres.example', port: 5432 },
      clientTarget: { host: 'secure-postgres.example', port: 5432, username: 'fixture', database: 'database' },
      options: '-c statement_timeout=3000',
    },
    {
      name: 'unix',
      url: 'postgresql://fixture@localhost/database?host=%2Ftmp%2Ffixture-pg&port=5544',
      tls: false,
      budgetMs: 10_000,
      statementTimeoutMs: 5_000,
      socketTimeoutMs: 7_500,
      destination: { path: '/tmp/fixture-pg/.s.PGSQL.5544' },
      clientTarget: { host: '/tmp/fixture-pg', port: 5544, username: 'fixture', database: 'database' },
      options: '-c statement_timeout=5000',
    },
    {
      name: 'target-overrides',
      url: 'postgresql://ignored@original.example:5433/path%20database?host=first.example&host=selected.example&port=5434&port=5545&user=first-user&user=selected-user&dbname=first-db&dbname=selected-db',
      tls: false,
      budgetMs: 10_000,
      statementTimeoutMs: 5_000,
      socketTimeoutMs: 7_500,
      destination: { host: 'selected.example', port: 5545 },
      clientTarget: { host: 'selected.example', port: 5545, username: 'selected-user', database: 'selected-db' },
      options: '-c statement_timeout=5000',
    },
    {
      name: 'encoded-target',
      url: 'postgresql://fixture%20owner@[::1]:5546/path%20database',
      tls: false,
      budgetMs: 10_000,
      statementTimeoutMs: 5_000,
      socketTimeoutMs: 7_500,
      destination: { host: '::1', port: 5546 },
      clientTarget: { host: '::1', port: 5546, username: 'fixture owner', database: 'path database' },
      options: '-c statement_timeout=5000',
    },
  ] as const

  for (const fixture of cases) {
    const certificateReads: string[] = []
    const exit = await Effect.runPromiseExit(
      Effect.void.pipe(
        Effect.provide(
          PostgresClientLive({
            operationTimeoutMs: fixture.budgetMs,
            postgres: { url: Redacted.make(fixture.url), tls: fixture.tls, caPath: '/fixture/ca.pem' },
          }),
        ),
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: (path) =>
              Effect.sync(() => {
                certificateReads.push(path)
                return 'fixture-ca'
              }),
          }),
        ),
      ),
    )
    assert.equal(Exit.isFailure(exit), true)
    const options = configured.shift()
    assert.ok(options?.stream)
    assert.ok(options.url)
    assert.deepEqual(
      { host: options.host, port: options.port, username: options.username, database: options.database },
      fixture.clientTarget,
    )
    assert.equal(options.connectTimeout, fixture.statementTimeoutMs)
    assert.equal(new URL(Redacted.value(options.url)).searchParams.get('options'), fixture.options)
    assert.deepEqual(options.ssl, fixture.tls ? { ca: 'fixture-ca', rejectUnauthorized: true } : undefined)
    assert.deepEqual(certificateReads, fixture.tls ? ['/fixture/ca.pem'] : [])

    // The adapter uses this same factory for ordinary and cancellation connections.
    for (let connection = 0; connection < 2; connection++) {
      const socket: unknown = options.stream()
      assert.ok(socket instanceof TestSocket)
      assert.deepEqual(socket.calls, ['no-delay:true', `deadline:${fixture.socketTimeoutMs}`, 'connect'])
      assert.deepEqual(socket.destination, fixture.destination)
      assert.ok(socket.timeout)
      socket.timeout()
      assert.equal(socket.destroyedWith?.message, 'PostgreSQL connection exceeded its inactivity deadline')
      assert.equal(socket.calls.at(-1), 'destroy')
    }
  }
  assert.equal(configured.length, 0)
  process.stdout.write(
    `POSTGRES_SOCKET_RESULT=${JSON.stringify({ cases: cases.map(({ name }) => name), sockets: sockets.length })}\n`,
  )
} finally {
  await mock.module('node:net', () => netExports)
  await mock.module('@effect/sql-pg', () => postgresExports)
}
