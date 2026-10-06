import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import type { Statement } from 'effect/sql/Statement'

import { encodeResearchCapture, type ResearchCaptureChunk } from '../research-capture/capture'
import { captureEvent } from '../research-capture/capture.test-support'
import { makeResearchCapturePostgresStore } from './research-capture-postgres'

const chunk: ResearchCaptureChunk = {
  schemaVersion: 'bayn.research-capture-chunk.v1',
  captureId: 'query-contract',
  sourceRevision: 'a'.repeat(40),
  chunkOrdinal: 0,
  previousContentHash: null,
  receipts: [{ sequence: 1, observedAtMs: 100, event: captureEvent('STARTED') }],
}
const bytes = encodeResearchCapture(chunk)
const inserted = { inserted: true, content_hash: null, payload: null, frontier: null }
const exercise = (rows: readonly unknown[]) => {
  const statements: { query: string; parameters: readonly unknown[] }[] = []
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SqlClient.make({
          acquirer: Effect.die('Query contract tests must never connect to PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        })
        const sql = new Proxy(client, {
          apply(target, receiver, args) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, args)
            return Effect.suspend(() => {
              const [query, parameters] = statement.compile()
              statements.push({ query, parameters })
              return Effect.succeed(query.includes('WITH candidate AS MATERIALIZED') ? rows : [])
            })
          },
          get(target, property, receiver) {
            if (property === 'withTransaction') return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
            return Reflect.get(target, property, receiver)
          },
        }) as PgClient.PgClient
        const result = yield* Effect.exit(makeResearchCapturePostgresStore(sql).append(bytes))
        return { result, statements }
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
}

test('append uses two application statements and binds its payload only once', async () => {
  const { result, statements } = await exercise([inserted])
  expect(Exit.isSuccess(result)).toBe(true)
  expect(statements).toHaveLength(2)
  expect(statements[0]?.parameters).toEqual([chunk.captureId])
  expect(statements[1]?.parameters.filter((value) => value === bytes.payload)).toHaveLength(1)
})

test('append distinguishes inserted, exact duplicate, conflicting bytes and rejected prefix outcomes', async () => {
  const duplicate = { inserted: false, content_hash: bytes.contentHash, payload: bytes.payload, frontier: null }
  expect(Exit.isSuccess((await exercise([duplicate])).result)).toBe(true)
  for (const rows of [
    [],
    [{ ...duplicate, payload: bytes.payload + '\n' }],
    [{ ...duplicate, content_hash: 'b'.repeat(64) }],
    [{ ...inserted, content_hash: bytes.contentHash }],
    [inserted, inserted],
  ])
    expect(Exit.isFailure((await exercise(rows)).result)).toBe(true)
})

test('new append retains typed frontier validation while exact duplicates skip it', async () => {
  const frontier = { ordinal: 0, sequence: 1, content_hash: bytes.contentHash }
  expect(Exit.isSuccess((await exercise([{ ...inserted, frontier }])).result)).toBe(true)
  for (const sequence of [null, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(Exit.isFailure((await exercise([{ ...inserted, frontier: { ...frontier, sequence } }])).result)).toBe(true)
})
