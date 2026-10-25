import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, Redacted, Schema, Stream, Tracer } from 'effect'
import { Statement } from 'effect/sql'
import { SqlError } from 'effect/sql/SqlError'

import { PostgresClientLive } from './postgres-client'
import { PostgresMigrationsLive } from './postgres-migrations'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { baynTestPostgresUrl } from '../test-environment.test-support'

const postgresTest = baynTestPostgresUrl === undefined ? test.skip : test
const Rows = Schema.Tuple([Schema.Struct({ pid: Schema.Int })])
const Values = Schema.Tuple([Schema.Tuple([Schema.Int])])
const captureSpans = () => {
  const spans: Tracer.NativeSpan[] = []
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
  'startup migrations own a bounded connection without extending trading query deadlines',
  async () => {
    const config = { operationTimeoutMs: 100, postgres: { url: fixtureUrl(), tls: false, caPath: '/unused' } }
    const runtimeClient = PostgresClientLive({ ...config, operationTimeoutMs: 30_000 })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE TABLE migration_timeout_probe (statement_timeout text, application_name text)`
        yield* sql`
        CREATE FUNCTION delay_first_fixture_index() RETURNS event_trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM migration_timeout_probe) THEN
            INSERT INTO migration_timeout_probe VALUES (
              current_setting('statement_timeout'), current_setting('application_name')
            );
            PERFORM pg_sleep(0.2);
          END IF;
        END
        $body$
      `
        yield* sql`
        CREATE EVENT TRIGGER delay_first_fixture_index ON ddl_command_start
        WHEN TAG IN ('CREATE INDEX') EXECUTE FUNCTION delay_first_fixture_index()
      `
        yield* Effect.scoped(Layer.build(PostgresMigrationsLive(config).pipe(Layer.provide(runtimeClient)))).pipe(
          Effect.ensuring(sql`DROP EVENT TRIGGER delay_first_fixture_index`.pipe(Effect.orDie)),
        )
        const decode = Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ statement_timeout: Schema.String, application_name: Schema.String })]),
        )
        const probe = yield* sql`SELECT * FROM migration_timeout_probe`.pipe(Effect.flatMap(decode))
        expect(probe).toEqual([{ statement_timeout: '895s', application_name: 'bayn-migrations' }])
        const ordinary = yield* sql`
        SELECT current_setting('statement_timeout') AS statement_timeout,
          current_setting('application_name') AS application_name
      `.pipe(Effect.flatMap(decode))
        expect(ordinary).toEqual([{ statement_timeout: '25s', application_name: 'bayn' }])
        const [remaining] = yield* sql`
        SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'bayn-migrations'
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ count: Schema.Int })]))))
        expect(remaining.count).toBe(0)
        yield* sql`UPDATE schema_migrations SET name = 'legacy_fixture' WHERE migration_id = 1`
        const rejected = yield* Effect.exit(Effect.scoped(Layer.build(PostgresMigrationsLive(config))))
        expect(Exit.isFailure(rejected)).toBe(true)
        if (Exit.isFailure(rejected))
          expect(Cause.squash(rejected.cause)).toMatchObject({
            operation: 'migrate',
            message: 'legacy migration history is unsupported after the hard cut',
          })
        const [afterFailure] = yield* sql`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'bayn-migrations'
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ count: Schema.Int })]))))
        expect(afterFailure.count).toBe(0)
        yield* sql`UPDATE schema_migrations SET name = 'initial_schema' WHERE migration_id = 1`
        yield* sql`DROP FUNCTION delay_first_fixture_index()`
        yield* sql`DROP TABLE migration_timeout_probe`
      }).pipe(Effect.provide(runtimeClient), Effect.provide(NodeServices.layer)),
    )
  },
  30_000,
)

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

postgresTest(
  'native commit, rollback and aborted commit report completion before releasing their backend',
  async () => {
    const { spans, tracer } = captureSpans()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const [committed] = yield* sql
          .withTransaction(sql`SELECT pg_backend_pid() AS pid`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)))
        const bodyFailure = new Error('native transaction fixture failure')
        const rolledBack = yield* Effect.exit(sql.withTransaction(Effect.fail(bodyFailure)))
        expect(Exit.isFailure(rolledBack)).toBe(true)
        if (Exit.isFailure(rolledBack)) expect(Cause.squash(rolledBack.cause)).toBe(bodyFailure)
        const abortedCommit = yield* Effect.exit(sql.withTransaction(Effect.exit(sql`SELECT 1 / 0`)))
        expect(Exit.isFailure(abortedCommit)).toBe(true)
        if (Exit.isFailure(abortedCommit)) expect(Cause.squash(abortedCommit.cause)).toBeInstanceOf(SqlError)
        const [after] = yield* sql`SELECT pg_backend_pid() AS pid`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
        )
        expect(after.pid).toBe(committed.pid)
        const transactions = spans.filter((span) => span.name === 'sql.transaction')
        expect(transactions).toHaveLength(3)
        const phases = [
          ['commit', 'succeeded'],
          ['rollback', 'succeeded'],
          ['commit', 'failed'],
        ] as const
        for (const [index, [phase, outcome]] of phases.entries()) {
          const span = transactions[index]
          if (span === undefined) throw new Error('Native transaction trace is missing')
          expect(span.attributes.get('postgresql.pid')).toBe(committed.pid)
          expect(span.events.map(([name, , attributes]) => ({ name, attributes }))).toEqual([
            { name: `db.transaction.${phase}`, attributes: {} },
            { name: `db.transaction.${phase}.completed`, attributes: { 'db.transaction.outcome': outcome } },
            { name: 'db.transaction.connection.release.started', attributes: {} },
            {
              name: 'db.transaction.connection.release.completed',
              attributes: { 'db.transaction.outcome': 'succeeded' },
            },
          ])
          const times = span.events.map(([, time]) => time)
          for (const [eventIndex, time] of times.entries()) {
            if (eventIndex > 0) expect(time).toBeGreaterThanOrEqual(times[eventIndex - 1])
          }
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(PgClient.layer({ url: fixtureUrl(), ssl: false, maxConnections: 1 })),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    )
  },
)
