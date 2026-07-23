import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Redacted } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  type CycleDraft,
} from '../cycle'
import type { SignalSessionRow } from '../market-data'
import type { IsoDate } from '../types'
import { CycleStore, CycleStoreLive } from './cycle-store'
import { PostgresClientLive } from './evidence-store'
import { migrationLoader } from './migrations'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const calendarVersion = 'XNYS-2026-v1'
const snapshotA = 'd'.repeat(64)
const snapshotB = 'e'.repeat(64)
const decisionHash = 'f'.repeat(64)

const databaseConfig = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    CycleStoreLive.pipe(Layer.provideMerge(PostgresClientLive(databaseConfig)), Layer.provideMerge(NodeServices.layer)),
  )

const session = (
  sessionDate: IsoDate,
  openTime = '09:30',
  closeTime = '16:00',
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'open_time' | 'close_time' | 'timezone'> => ({
  calendar_version: calendarVersion,
  session_date: sessionDate,
  open_time: openTime,
  close_time: closeTime,
  timezone: 'America/New_York',
})

const makeDraft = (accountId = 'paper-account-1'): CycleDraft => {
  const executionPolicy = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'c'.repeat(64),
    submissionWindowMs: 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  const identity = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: 'a'.repeat(64),
    strategyProtocolHash: 'b'.repeat(64),
    accountId,
    signalSessionDate: '2026-03-06',
    calendarVersion,
    executionPolicy,
  })
  return makeCycleDraft(
    identity,
    makeCycleWindow([session('2026-03-06'), session('2026-03-09')], '2026-03-06', executionPolicy),
  )
}

const acquireAt = '2026-03-06T21:01:00.000Z'
const snapshotAt = '2026-03-06T21:02:00.000Z'
const activeAt = '2026-03-06T21:03:00.000Z'
const decisionAt = '2026-03-06T21:04:00.000Z'
const terminalAt = '2026-03-06T21:05:00.000Z'

describePostgres('PostgreSQL autonomous cycle store', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await runtime.dispose()
    runtime = makeRuntime()
    await runtime.runPromise(PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' }))
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('concurrent deterministic acquisition creates exactly one durable cycle', async () => {
    const draft = makeDraft()
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const receipts = yield* Effect.all(
          [store.acquire(draft, acquireAt), store.acquire(structuredClone(draft), acquireAt)],
          { concurrency: 'unbounded' },
        )
        const sql = yield* PgClient.PgClient
        const [count] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM autonomous_cycles
        `
        return { count: count.count, receipts }
      }),
    )

    expect(
      observed.receipts.map((receipt) => receipt.created).sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true])
    expect(new Set(observed.receipts.map((receipt) => receipt.cycle.identity.cycleId)).size).toBe(1)
    expect(observed.receipts[0].cycle.state).toBe(CycleState.Pending)
    expect(observed.receipts[0].cycle.window.calendarVersion).toBe(calendarVersion)
    expect(observed.count).toBe(1)
  })

  test('serializes competing bindings and preserves terminal state across a new store runtime', async () => {
    const draft = makeDraft()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const acquired = yield* store.acquire(draft, acquireAt)
        const bindingExits = yield* Effect.all(
          [
            Effect.exit(store.bindSnapshot(draft.identity.cycleId, snapshotA, snapshotAt)),
            Effect.exit(store.bindSnapshot(draft.identity.cycleId, snapshotB, snapshotAt)),
          ],
          { concurrency: 'unbounded' },
        )
        const rebound = yield* store.bindSnapshot(
          draft.identity.cycleId,
          bindingExits.find(Exit.isSuccess)?.value.cycle.bindings.snapshotId ?? snapshotA,
          snapshotAt,
        )
        yield* store.activate(draft.identity.cycleId, activeAt)
        yield* store.bindDecision(draft.identity.cycleId, decisionHash, decisionAt)
        const finished = yield* store.finish(draft.identity.cycleId, CycleState.NoTrade, terminalAt)
        const retried = yield* store.finish(draft.identity.cycleId, CycleState.NoTrade, terminalAt)
        const rejectedRewrite = yield* Effect.exit(
          store.block(draft.identity.cycleId, CycleTerminalReason.Reconciliation, terminalAt),
        )
        const sql = yield* PgClient.PgClient
        const directUpdate = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET updated_at = ${'2026-03-06T21:06:00.000Z'}, state_version = state_version + 1
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directDelete = yield* Effect.exit(sql`
          DELETE FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
        `)
        return {
          acquired,
          bindingExits,
          directDelete,
          directUpdate,
          finished,
          rebound,
          rejectedRewrite,
          retried,
        }
      }),
    )

    const successes = result.bindingExits.filter(Exit.isSuccess)
    const failures = result.bindingExits.filter(Exit.isFailure)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(result.rebound.changed).toBe(false)
    expect(result.finished.cycle).toMatchObject({
      state: CycleState.NoTrade,
      bindings: { decisionHash },
      terminalAt,
    })
    expect(result.retried.changed).toBe(false)
    expect(Exit.isFailure(result.rejectedRewrite)).toBe(true)
    expect(Exit.isFailure(result.directUpdate)).toBe(true)
    expect(Exit.isFailure(result.directDelete)).toBe(true)
    if (failures[0] !== undefined && Exit.isFailure(failures[0])) {
      expect(Cause.pretty(failures[0].cause)).toContain('snapshot binding cannot be replaced')
    }

    const secondRuntime = makeRuntime()
    const durable = await secondRuntime.runPromise(
      Effect.flatMap(CycleStore, (store) => store.read(draft.identity.cycleId)),
    )
    await secondRuntime.dispose()
    expect(Option.isSome(durable)).toBe(true)
    if (Option.isSome(durable)) expect(durable.value).toEqual(result.finished.cycle)
  })

  test('blocks missed windows and derives completion only from canonical intents', async () => {
    const missedDraft = makeDraft('paper-account-missed')
    const blockedDraft = makeDraft('paper-account-blocked')
    const cutoffDraft = makeDraft('paper-account-cutoff')
    const completionDraft = makeDraft('paper-account-completed')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const missed = yield* store.acquire(missedDraft, missedDraft.window.publicationDeadlineAt)

        yield* store.acquire(blockedDraft, acquireAt)
        yield* store.bindSnapshot(blockedDraft.identity.cycleId, snapshotB, snapshotAt)
        yield* store.activate(blockedDraft.identity.cycleId, activeAt)
        const earlyActiveMiss = yield* Effect.exit(
          store.block(
            blockedDraft.identity.cycleId,
            CycleTerminalReason.MissedWindow,
            blockedDraft.window.publicationDeadlineAt,
          ),
        )
        const blocked = yield* store.block(
          blockedDraft.identity.cycleId,
          CycleTerminalReason.DataStale,
          blockedDraft.window.publicationDeadlineAt,
        )

        yield* store.acquire(cutoffDraft, acquireAt)
        yield* store.bindSnapshot(cutoffDraft.identity.cycleId, snapshotA, snapshotAt)
        yield* store.activate(cutoffDraft.identity.cycleId, activeAt)
        const atCutoff = yield* store.bindDecision(
          cutoffDraft.identity.cycleId,
          decisionHash,
          cutoffDraft.window.submissionCutoffAt,
        )

        yield* store.acquire(completionDraft, acquireAt)
        yield* store.bindSnapshot(completionDraft.identity.cycleId, snapshotA, snapshotAt)
        yield* store.activate(completionDraft.identity.cycleId, activeAt)
        yield* store.bindDecision(completionDraft.identity.cycleId, decisionHash, decisionAt)
        const withoutIntent = yield* Effect.exit(
          store.finish(completionDraft.identity.cycleId, CycleState.Completed, terminalAt),
        )

        const sql = yield* PgClient.PgClient
        yield* sql`
          INSERT INTO intents (
            intent_id, schema_version, strategy_name, cycle_id, decision_hash,
            policy_hash, account_id, client_order_id, symbol, side, order_type,
            time_in_force, quantity_micros, notional_limit_micros,
            state, created_at, updated_at
          ) VALUES (
            ${'1'.repeat(64)}, 'bayn.paper-intent.v2', 'risk-balanced-trend',
            ${completionDraft.identity.cycleId}, ${decisionHash}, ${'2'.repeat(64)},
            ${completionDraft.identity.accountId}, 'cycle-completion-intent', 'SPY',
            'BUY', 'MARKET', 'DAY', '1000000', '100000000',
            'PLANNED', ${decisionAt}, ${decisionAt}
          )
        `
        const completed = yield* store.finish(completionDraft.identity.cycleId, CycleState.Completed, terminalAt)
        return { atCutoff, blocked, completed, earlyActiveMiss, missed, withoutIntent }
      }),
    )

    expect(result.missed.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedWindow,
      terminalAt: missedDraft.window.publicationDeadlineAt,
    })
    expect(Exit.isFailure(result.earlyActiveMiss)).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.DataStale,
      terminalAt: blockedDraft.window.publicationDeadlineAt,
    })
    expect(result.atCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedWindow,
      terminalAt: cutoffDraft.window.submissionCutoffAt,
    })
    expect(result.atCutoff.cycle.bindings.decisionHash).toBeUndefined()
    expect(cutoffDraft.window.submissionCutoffAt < cutoffDraft.window.executionOpenAt).toBe(true)
    expect(Exit.isFailure(result.withoutIntent)).toBe(true)
    if (Exit.isFailure(result.withoutIntent)) {
      expect(Cause.pretty(result.withoutIntent.cause)).toContain('completed cycle requires canonical intents')
    }
    expect(result.completed.cycle).toMatchObject({
      state: CycleState.Completed,
      bindings: { decisionHash },
      terminalAt,
    })
  })
})
