import { beforeAll, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Result } from 'effect'
import { ConstraintError, SqlError } from 'effect/sql/SqlError'

import { WriterFenceError, type WriterFenceService } from '../../execution/writer-fence'
import { decodeCycleDecisionDocument, type CycleDecisionDocument } from '../../shadow-decision-contract'
import { persistenceDocumentFixture } from '../../system-assessment/decision-persistence.test-support'
import { runCycleStore, CycleStoreError, type CycleStoreShape } from './model'
import { withWriterFenceCycleStore } from './postgres'

let decision: CycleDecisionDocument
beforeAll(async () => {
  decision = Result.getOrThrow(decodeCycleDecisionDocument(await Effect.runPromise(persistenceDocumentFixture)))
})

const unexpected = () => Effect.die('unexpected cycle store operation')
const bindingStore = (bindDecision: CycleStoreShape['bindDecision']): CycleStoreShape => ({
  acquire: unexpected,
  activate: unexpected,
  read: unexpected,
  readAuthoritySlot: unexpected,
  readDecisionDocument: unexpected,
  readOldestUnfinished: unexpected,
  finish: unexpected,
  block: unexpected,
  bindDecision,
})

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
    bindingStore(() => Effect.fail(expired)),
    fence,
    { commit: () => Effect.die('failed binding cannot commit an intent') },
  )
  const result = await Effect.runPromiseExit(store.bindDecision('a'.repeat(64), decision, '2026-10-21T00:00:00.000Z'))
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isSuccess(result)) throw new Error('failed rollback must propagate')
  expect(result.cause.reasons).toHaveLength(2)
  expect(result.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: { failure: 'entry-expired' } })
  expect(result.cause.reasons[1]).toMatchObject({ _tag: 'Fail', error: { failure: 'query', cause: rollback } })
})

test('binding retains the owned immutable validation receipt across the writer fence', async () => {
  let retained: CycleDecisionDocument | undefined
  const failure = new CycleStoreError({ operation: 'bind-decision', failure: 'query', message: 'fixture' })
  const store = withWriterFenceCycleStore(
    bindingStore((_cycleId, document) => {
      retained = document
      return Effect.fail(failure)
    }),
    { check: Effect.void, transaction: (effect) => effect },
    { commit: () => Effect.die('failed binding cannot commit an intent') },
  )
  const result = await Effect.runPromise(
    store.bindDecision('a'.repeat(64), decision, decision.createdAt).pipe(Effect.result),
  )
  expect(result).toEqual(Result.fail(failure))
  expect(retained).toBe(decision)
  expect(Object.isFrozen(retained)).toBe(true)
})

test('an unowned binding is verified and privately frozen before the fence can yield', async () => {
  const external = structuredClone(decision)
  let retained: CycleDecisionDocument | undefined
  const store = withWriterFenceCycleStore(
    bindingStore((_cycleId, document) => {
      retained = document
      return Effect.fail(new CycleStoreError({ operation: 'bind-decision', failure: 'query', message: 'fixture' }))
    }),
    {
      check: Effect.void,
      transaction: (effect) =>
        Effect.sync(() => Object.assign(external, { contentHash: '0'.repeat(64) })).pipe(Effect.andThen(effect)),
    },
    { commit: () => Effect.die('failed binding cannot commit an intent') },
  )
  await Effect.runPromise(store.bindDecision('a'.repeat(64), external, decision.createdAt).pipe(Effect.result))
  if (retained === undefined) throw new Error('valid document did not reach binding')
  expect(retained).not.toBe(external)
  expect(retained?.contentHash).toBe(decision.contentHash)
  expect(Object.isFrozen(retained)).toBe(true)
  expect(Object.isFrozen(retained?.bindings)).toBe(true)
  expect(Result.getOrThrow(decodeCycleDecisionDocument(retained))).toBe(retained)
})

test('a corrupt binding cannot acquire the writer fence or reach persistence', async () => {
  let fenced = false
  let persisted = false
  const store = withWriterFenceCycleStore(
    bindingStore(() => {
      persisted = true
      return Effect.die('corrupt document reached persistence')
    }),
    {
      check: Effect.void,
      transaction: (effect) => {
        fenced = true
        return effect
      },
    },
    { commit: () => Effect.die('corrupt document cannot commit an intent') },
  )
  const result = await Effect.runPromise(
    store
      .bindDecision('a'.repeat(64), { ...decision, contentHash: '0'.repeat(64) }, decision.createdAt)
      .pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure: { operation: 'bind-decision', failure: 'decode' } })
  expect(fenced).toBe(false)
  expect(persisted).toBe(false)
})
