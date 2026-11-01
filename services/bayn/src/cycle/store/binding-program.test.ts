import { expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import { Effect, Exit } from 'effect'

import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import { makeCycleBindingPrograms } from './binding-program'
import type { CycleMutationPrimitives } from './mutations'
import type { CycleQueries } from './queries'

test('malformed decision binding fails before any database work', async () => {
  let databaseCalls = 0
  const sql = (() => {
    databaseCalls += 1
    return Effect.die('Unexpected database work before decision validation')
  }) as unknown as PgClient.PgClient
  const programs = makeCycleBindingPrograms(sql, {} as CycleQueries, {} as CycleMutationPrimitives)
  const result = await Effect.runPromise(
    programs.bindDecision('a'.repeat(64), {} as CycleDecisionDocument, '2026-10-14T00:00:00.000Z').pipe(Effect.exit),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(databaseCalls).toBe(0)
})
