import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Result } from 'effect'
import { ConstraintError, SqlError } from 'effect/sql/SqlError'

import { WriterFenceError, type WriterFenceService } from '../../execution/writer-fence'
import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import { runCycleStore, CycleStoreError, type CycleStoreShape } from './model'
import { withWriterFenceCycleStore } from './postgres'

test.each([
  {
    operation: 'bind-decision',
    code: '23514',
    constraint: 'autonomous_cycles_entry_admission_deadline',
    failure: 'entry-expired',
  },
  { operation: 'bind-decision', code: '23514', constraint: 'another_constraint', failure: 'conflict' },
  {
    operation: 'bind-decision',
    code: '23503',
    constraint: 'autonomous_cycles_entry_admission_deadline',
    failure: 'conflict',
  },
  { operation: 'finish', code: '23514', constraint: 'autonomous_cycles_entry_admission_deadline', failure: 'conflict' },
] as const)(
  'classifies $operation / $code / $constraint as $failure',
  async ({ operation, code, constraint, failure }) => {
    const cause = new SqlError({
      reason: new ConstraintError({
        cause: Object.assign(new Error('PostgreSQL rejected a write'), { code, constraint }),
      }),
    })
    const result = await Effect.runPromise(runCycleStore(operation, Effect.fail(cause)).pipe(Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) throw new Error('Expected a durable write rejection')
    expect(result.failure).toMatchObject({
      operation,
      failure,
      persistenceFailure: 'constraint',
    } satisfies Partial<CycleStoreError>)
    expect(result.failure.cause).toBe(cause)
  },
)

test('cycle store classification preserves a lease rejection combined with a rollback defect', async () => {
  const sql = new SqlError({
    reason: new ConstraintError({
      cause: {
        code: '23514',
        constraint: 'autonomous_cycles_entry_admission_deadline',
      },
    }),
  })
  const defect = new Error('savepoint rollback failed')
  const result = await Effect.runPromiseExit(
    runCycleStore('bind-decision', Effect.failCause(Cause.combine(Cause.fail(sql), Cause.die(defect)))),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isSuccess(result)) throw new Error('combined rollback failure must propagate')
  expect(result.cause.reasons).toHaveLength(2)
  expect(result.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: { failure: 'entry-expired' } })
  expect(result.cause.reasons[1]).toMatchObject({ _tag: 'Die', defect })
})

test('writer-fenced cycle classification retains both the rejected binding and failed rollback', async () => {
  const rollback = new WriterFenceError({
    operation: 'transaction',
    failure: 'unavailable',
    message: 'rollback failed',
  })
  const fence: WriterFenceService = {
    check: Effect.void,
    transaction: (effect) =>
      effect.pipe(Effect.catchCause((cause) => Effect.failCause(Cause.combine(cause, Cause.fail(rollback))))),
  }
  const expired = new CycleStoreError({
    operation: 'bind-decision',
    failure: 'entry-expired',
    message: 'lease expired',
  })
  const store = withWriterFenceCycleStore(
    { bindDecision: () => Effect.fail(expired) } as unknown as CycleStoreShape,
    fence,
  )
  const result = await Effect.runPromiseExit(
    store.bindDecision('a'.repeat(64), {} as CycleDecisionDocument, '2026-10-21T00:00:00.000Z'),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isSuccess(result)) throw new Error('failed rollback must propagate')
  expect(result.cause.reasons).toHaveLength(2)
  expect(result.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: { failure: 'entry-expired' } })
  expect(result.cause.reasons[1]).toMatchObject({ _tag: 'Fail', error: { failure: 'query', cause: rollback } })
})
