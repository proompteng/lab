import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'
import { Statement } from 'effect/sql'
import type { Connection } from 'effect/sql/SqlConnection'

import { openSnapshotRows } from './snapshot-rows'

const fixture = (count: number, oversized = false) => {
  const records = Array.from({ length: count }, (_, id) => ({ id }))
  const commands: string[] = []
  const fetches: number[] = []
  let offset = 0
  const execute = (command: string) =>
    Effect.sync(() => {
      commands.push(command)
      if (command.startsWith('DECLARE ') || command.startsWith('CLOSE ')) return []
      const fetch = /^FETCH (?:NEXT|FORWARD (\d+)) FROM /.exec(command)
      if (fetch === null) throw new Error(`Unexpected cursor command: ${command}`)
      const size = Number(fetch[1] ?? 1)
      fetches.push(size)
      const rows = records.slice(offset, offset + size + (oversized && fetches.length > 1 ? 1 : 0))
      offset += rows.length
      return rows
    })
  const connection = { execute } as unknown as Connection
  const sql = Statement.make(Effect.succeed(connection), PgClient.makeCompiler(), [], undefined)
  return { sql, commands, fetches, records }
}

test('consumes a complete expense-sized snapshot in bounded batches after its opening fetch', async () => {
  const f = fixture(4567)
  const seen: unknown[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const consume = yield* openSnapshotRows(f.sql, f.sql`SELECT id FROM entries ORDER BY id`, 64)
      expect(f.fetches).toEqual([1])
      expect(seen).toEqual([])
      yield* consume((row) =>
        Effect.sync(() => {
          seen.push(row)
        }),
      )
    }),
  )
  expect(seen).toEqual(f.records)
  expect(f.fetches).toHaveLength(74)
  expect(f.fetches.slice(1).every((size) => size === 64)).toBe(true)
  expect(f.commands.at(-1)?.startsWith('CLOSE ')).toBe(true)
})

test('retains one-row buffering by default for large decision records', async () => {
  const f = fixture(130)
  const seen: unknown[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const consume = yield* openSnapshotRows(f.sql, f.sql`SELECT id FROM entries ORDER BY id`)
      yield* consume((row) =>
        Effect.sync(() => {
          seen.push(row)
        }),
      )
    }),
  )
  expect(seen).toEqual(f.records)
  expect(f.fetches).toHaveLength(131)
  expect(f.fetches.every((size) => size === 1)).toBe(true)
})

test.each([0, -1, 1.5, 65, NaN, Infinity])('rejects an invalid fetch size %s before opening a cursor', async (size) => {
  const f = fixture(1)
  const exit = await Effect.runPromiseExit(openSnapshotRows(f.sql, f.sql`SELECT id FROM entries`, size))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(f.commands).toEqual([])
})

test('rejects an oversized database batch before its rows reach the consumer', async () => {
  const f = fixture(130, true)
  const seen: unknown[] = []
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const consume = yield* openSnapshotRows(f.sql, f.sql`SELECT id FROM entries`, 64)
      yield* consume((row) =>
        Effect.sync(() => {
          seen.push(row)
        }),
      )
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(seen).toEqual([f.records[0]])
})

test('does not fetch ahead of a suspended consumer and stops on interruption inside a batch', async () => {
  const f = fixture(130)
  const seen: unknown[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const blocked = yield* Deferred.make<void>()
        const fiber = yield* Effect.gen(function* () {
          const consume = yield* openSnapshotRows(f.sql, f.sql`SELECT id FROM entries`, 64)
          yield* consume((row) =>
            Effect.gen(function* () {
              seen.push(row)
              if (seen.length === 2) {
                yield* Deferred.succeed(blocked, undefined)
                return yield* Effect.never
              }
            }),
          )
        }).pipe(Effect.forkChild)
        yield* Deferred.await(blocked)
        expect(f.fetches).toEqual([1, 64])
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }),
    ),
  )
  expect(seen).toEqual(f.records.slice(0, 2))
  expect(f.fetches).toEqual([1, 64])
})
