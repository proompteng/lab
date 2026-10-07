import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, Redacted, Schema, Stream, Tracer } from 'effect'
import { Statement } from 'effect/sql'

import { PostgresClientLive } from './postgres-client'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { baynTestPostgresUrl } from '../test-environment.test-support'

const postgresTest = baynTestPostgresUrl === undefined ? test.skip : test
const Rows = Schema.Tuple([Schema.Struct({ pid: Schema.Int })])
const Values = Schema.Tuple([Schema.Tuple([Schema.Int])])
const captureSpans = () => {
  const spans: Tracer.Span[] = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  return { spans, tracer }
}

const fixtureUrl = () => {
  if (baynTestPostgresUrl === undefined) throw new Error('Missing isolated PostgreSQL fixture')
  const url = new URL(baynTestPostgresUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
    throw new Error('Backend tracing tests require an isolated local _test database')
  return Redacted.make(url.toString())
}

postgresTest(
  'SQL statements and writer controls identify their actual backend without changing query results',
  async () => {
    const { spans, tracer } = captureSpans()
    const postgres = PostgresClientLive({
      operationTimeoutMs: 30_000,
      postgres: { url: fixtureUrl(), tls: false, caPath: '/unused' },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const query = sql`SELECT pg_backend_pid() AS pid`
        const start = spans.length
        const [[pid]] = yield* query.values.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Values)))
        expect(pid).toBeGreaterThan(0)
        const [[unpreparedPid]] = yield* query.valuesUnprepared.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Values)))
        expect(unpreparedPid).toBe(pid)
        for (const read of [query, query.withoutTransform, query.unprepared]) {
          const [row] = yield* read.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)))
          expect(row.pid).toBe(pid)
        }
        const raw = yield* query.raw.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ rows: Rows }))))
        expect(raw.rows[0].pid).toBe(pid)
        const [streamed] = yield* Stream.runCollect(query.stream).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)))
        expect(streamed.pid).toBe(pid)
        expect(Exit.isFailure(yield* Effect.exit(sql`SELECT 1 / 0`))).toBe(true)
        const statements = spans.slice(start).filter((span) => span.name === 'sql.execute')
        expect(statements).toHaveLength(8)
        for (const span of statements) expect(span.attributes.get('postgresql.pid')).toBe(pid)

        const fence = yield* WriterFence
        const controlsStart = spans.length
        yield* fence.transaction(query)
        expect(Exit.isFailure(yield* Effect.exit(fence.transaction(Effect.fail('fixture rollback'))))).toBe(true)
        const controls = spans
          .slice(controlsStart)
          .filter((span) =>
            ['bayn.postgres.begin', 'bayn.postgres.commit', 'bayn.postgres.rollback'].includes(span.name),
          )
        expect(controls.map((span) => span.name)).toEqual([
          'bayn.postgres.begin',
          'bayn.postgres.commit',
          'bayn.postgres.begin',
          'bayn.postgres.rollback',
        ])
        for (const span of controls) expect(span.attributes.get('postgresql.pid')).toBe(pid)
        const [withoutTracing] = yield* query.pipe(
          Effect.withTracerEnabled(false),
          Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
        )
        expect(withoutTracing.pid).toBe(pid)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(postgres, WriterFenceLive.pipe(Layer.provide(postgres)))),
        Effect.provide(NodeServices.layer),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    )
  },
)

postgresTest('pooled queries and separately acquired streams report the connection that executed them', async () => {
  const { spans, tracer } = captureSpans()
  const url = fixtureUrl()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const pids = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        (index) =>
          sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.02)`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
            Effect.map(([row]) => {
              const parent = spans.find((span) => span.name === `fixture.pooled.${index}`)
              const query = spans.find(
                (span) =>
                  span.name === 'sql.execute' &&
                  span.parent._tag === 'Some' &&
                  span.parent.value.spanId === parent?.spanId,
              )
              expect(query?.attributes.get('postgresql.pid')).toBe(row.pid)
              return row.pid
            }),
            Effect.withSpan(`fixture.pooled.${index}`),
          ),
        { concurrency: 4 },
      )
      expect(new Set(pids).size).toBeGreaterThan(1)
    }).pipe(
      Effect.scoped,
      Effect.provide(PgClient.layer({ url, ssl: false, maxConnections: 4 })),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    ),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [base] = yield* sql`SELECT pg_backend_pid() AS pid`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)))
      const start = spans.length
      const [streamed] = yield* Stream.runCollect(sql`SELECT pg_backend_pid() AS pid`.stream).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
      )
      expect(streamed.pid).not.toBe(base.pid)
      const [query] = spans.slice(start).filter((span) => span.name === 'sql.execute')
      expect(query?.attributes.get('postgresql.pid')).toBe(streamed.pid)
    }).pipe(
      Effect.scoped,
      Effect.provide(PgClient.layerFrom(PgClient.makeClient({ url, ssl: false, acquireForStream: true }))),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    ),
  )
})

postgresTest(
  'empty and failed SQL transactions retain their backend without attributing it to a concurrent parent',
  async () => {
    const { spans, tracer } = captureSpans()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* Effect.all(
          [sql.withTransaction(Effect.void), Effect.exit(sql.withTransaction(Effect.fail('fixture rollback')))],
          { concurrency: 2 },
        )
      }).pipe(
        Effect.scoped,
        Effect.withSpan('fixture.concurrent-transactions'),
        Effect.provide(PgClient.layer({ url: fixtureUrl(), ssl: false, maxConnections: 2 })),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    )
    const transactions = spans.filter((span) => span.name === 'sql.transaction')
    expect(transactions).toHaveLength(2)
    for (const span of transactions) expect(span.attributes.get('postgresql.pid')).toBeGreaterThan(0)
    const parent = spans.find((span) => span.name === 'fixture.concurrent-transactions')
    expect(parent?.attributes.has('postgresql.pid')).toBe(false)
  },
)

postgresTest('a client without SQL propagation leaves a shared caller unlabelled', async () => {
  const { spans, tracer } = captureSpans()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [row] = yield* sql`SELECT pg_backend_pid() AS pid`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)))
      expect(row.pid).toBeGreaterThan(0)
    }).pipe(
      Effect.scoped,
      Effect.withSpan('fixture.default-propagation'),
      Effect.provide(PgClient.layer({ url: fixtureUrl(), ssl: false })),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )
  expect(spans.some((span) => span.attributes.has('postgresql.pid'))).toBe(false)
})
