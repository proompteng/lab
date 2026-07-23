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
  makeExecutionCalendarObservation,
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
const signalCalendarVersion = 'signal-XNYS-2026-v1'
const snapshotA = 'd'.repeat(64)
const snapshotB = 'e'.repeat(64)
const staleSnapshot = '6'.repeat(64)
const wrongCalendarSnapshot = '7'.repeat(64)
const missingSnapshot = '9'.repeat(64)
const decisionHash = 'f'.repeat(64)

const databaseConfig = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    CycleStoreLive.pipe(Layer.provideMerge(PostgresClientLive(databaseConfig)), Layer.provideMerge(NodeServices.layer)),
  )

const signalSession = (
  sessionDate: IsoDate,
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'> => ({
  calendar_version: signalCalendarVersion,
  session_date: sessionDate,
  close_time: '16:00',
  timezone: 'America/New_York',
})

const makeDraft = (
  accountId = 'paper-account-1',
  options: { readonly executionCloseAt?: string; readonly submissionWindowMs?: number } = {},
): CycleDraft => {
  const executionPolicy = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'c'.repeat(64),
    submissionWindowMs: options.submissionWindowMs ?? 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  const executionCalendar = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: '2026-03-09',
    openAt: '2026-03-09T13:30:00.000Z',
    closeAt: options.executionCloseAt ?? '2026-03-09T20:00:00.000Z',
  })
  const identity = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: 'a'.repeat(64),
    strategyProtocolHash: 'b'.repeat(64),
    accountId,
    signalSessionDate: '2026-03-06',
    signalCalendarVersion,
    executionSessionDate: executionCalendar.executionSessionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  return makeCycleDraft(identity, makeCycleWindow(signalSession('2026-03-06'), executionCalendar, executionPolicy))
}

const insertSnapshotReference = (
  snapshotId: string,
  options: {
    readonly calendarVersion?: string
    readonly lastSession?: IsoDate
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const lastSession = options.lastSession ?? '2026-03-06'
    yield* sql`
      INSERT INTO snapshot_references (
        snapshot_id, schema_version, database_name, table_name, dataset_version,
        source, source_feed, adjustment, content_hash, row_count,
        first_session, last_session, manifest
      ) VALUES (
        ${snapshotId}, 'bayn.finalized-snapshot.v3', 'signal', 'adjusted_daily_bars_v2',
        'signal.adjusted-daily-snapshot.v2', 'alpaca', 'sip', 'all',
        ${snapshotId}, 1, ${lastSession}, ${lastSession},
        ${sql.json({
          schemaVersion: 'bayn.finalized-snapshot.v3',
          snapshotId,
          contentHash: snapshotId,
          calendarVersion: options.calendarVersion ?? signalCalendarVersion,
          firstSession: lastSession,
          lastSession,
          rowCount: 1,
        })}
      )
    `
  })

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
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* insertSnapshotReference(snapshotA)
        yield* insertSnapshotReference(snapshotB)
        yield* insertSnapshotReference(staleSnapshot, { lastSession: '2026-03-05' })
        yield* insertSnapshotReference(wrongCalendarSnapshot, {
          calendarVersion: 'signal-XNYS-2026-revised',
        })
      }),
    )
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('concurrent deterministic acquisition creates one cycle with separate calendar provenance', async () => {
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
    expect(observed.receipts[0].cycle).toMatchObject({
      state: CycleState.Pending,
      identity: {
        signalCalendarVersion,
        executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
        executionCalendarSource: 'alpaca-v2-calendar',
      },
      window: {
        signalCalendarVersion,
        executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
        executionCalendarSource: 'alpaca-v2-calendar',
        executionOpenAt: '2026-03-09T13:30:00.000Z',
        executionCloseAt: '2026-03-09T20:00:00.000Z',
      },
    })
    expect(observed.count).toBe(1)
  })

  test('reserves one capital-authority slot across changed calendar and policy inputs', async () => {
    const accountId = 'paper-account-authority-slot'
    const original = makeDraft(accountId)
    const changedCalendar = makeDraft(accountId, { executionCloseAt: '2026-03-09T19:00:00.000Z' })
    const changedPolicy = makeDraft(accountId, { submissionWindowMs: 15 * 60 * 1_000 })

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const acquired = yield* store.acquire(original, acquireAt)
        const conflicts = yield* Effect.all(
          [
            Effect.exit(store.acquire(changedCalendar, acquireAt)),
            Effect.exit(store.acquire(changedPolicy, acquireAt)),
          ],
          { concurrency: 'unbounded' },
        )
        const sql = yield* PgClient.PgClient
        const [count] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM autonomous_cycles
          WHERE qualification_run_id = ${original.identity.qualificationRunId}
            AND account_id = ${accountId}
            AND signal_session_date = ${original.identity.signalSessionDate}
        `
        return { acquired, conflicts, count: count.count }
      }),
    )

    expect(changedCalendar.identity.cycleId).not.toBe(original.identity.cycleId)
    expect(changedPolicy.identity.cycleId).not.toBe(original.identity.cycleId)
    expect(result.acquired.created).toBe(true)
    expect(result.conflicts.every(Exit.isFailure)).toBe(true)
    for (const conflict of result.conflicts) {
      if (Exit.isFailure(conflict)) {
        expect(Cause.pretty(conflict.cause)).toContain('stored cycle differs from deterministic acquisition input')
      }
    }
    expect(result.count).toBe(1)
  })

  test('requires durable snapshots, rejects pre-close binding, and serializes competing bindings', async () => {
    const temporalDraft = makeDraft('paper-account-temporal')
    const bindingDraft = makeDraft('paper-account-binding')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore

        yield* store.acquire(temporalDraft, '2026-03-06T20:58:00.000Z')
        const preClose = yield* Effect.exit(
          store.bindSnapshot(temporalDraft.identity.cycleId, snapshotA, '2026-03-06T20:59:00.000Z'),
        )
        const atClose = yield* store.bindSnapshot(
          temporalDraft.identity.cycleId,
          snapshotA,
          temporalDraft.window.signalCloseAt,
        )

        yield* store.acquire(bindingDraft, acquireAt)
        const missingReference = yield* Effect.exit(
          store.bindSnapshot(bindingDraft.identity.cycleId, missingSnapshot, snapshotAt),
        )
        const staleReference = yield* Effect.exit(
          store.bindSnapshot(bindingDraft.identity.cycleId, staleSnapshot, snapshotAt),
        )
        const wrongCalendarReference = yield* Effect.exit(
          store.bindSnapshot(bindingDraft.identity.cycleId, wrongCalendarSnapshot, snapshotAt),
        )
        const bindingExits = yield* Effect.all(
          [
            Effect.exit(store.bindSnapshot(bindingDraft.identity.cycleId, snapshotA, snapshotAt)),
            Effect.exit(store.bindSnapshot(bindingDraft.identity.cycleId, snapshotB, snapshotAt)),
          ],
          { concurrency: 'unbounded' },
        )
        const selectedSnapshot = bindingExits.find(Exit.isSuccess)?.value.cycle.bindings.snapshotId ?? snapshotA
        const rebound = yield* store.bindSnapshot(bindingDraft.identity.cycleId, selectedSnapshot, snapshotAt)
        return {
          atClose,
          bindingExits,
          missingReference,
          preClose,
          rebound,
          staleReference,
          wrongCalendarReference,
        }
      }),
    )

    expect(Exit.isFailure(result.preClose)).toBe(true)
    if (Exit.isFailure(result.preClose)) {
      expect(Cause.pretty(result.preClose.cause)).toContain('snapshot binding cannot precede the Signal session close')
    }
    expect(result.atClose.changed).toBe(true)
    expect(Exit.isFailure(result.missingReference)).toBe(true)
    expect(Exit.isFailure(result.staleReference)).toBe(true)
    if (Exit.isFailure(result.staleReference)) {
      expect(Cause.pretty(result.staleReference.cause)).toContain(
        'autonomous cycle snapshot does not match signal session and calendar',
      )
    }
    expect(Exit.isFailure(result.wrongCalendarReference)).toBe(true)
    if (Exit.isFailure(result.wrongCalendarReference)) {
      expect(Cause.pretty(result.wrongCalendarReference.cause)).toContain(
        'autonomous cycle snapshot does not match signal session and calendar',
      )
    }
    expect(result.bindingExits.filter(Exit.isSuccess)).toHaveLength(1)
    expect(result.bindingExits.filter(Exit.isFailure)).toHaveLength(1)
    expect(result.rebound.changed).toBe(false)
  })

  test('keeps completion unreachable and preserves blocked terminal history across runtimes', async () => {
    const draft = makeDraft()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, snapshotA, snapshotAt)
        yield* store.activate(draft.identity.cycleId, activeAt)
        yield* store.bindDecision(draft.identity.cycleId, decisionHash, decisionAt)

        const sql = yield* PgClient.PgClient
        const directCompleted = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Completed},
            state_version = state_version + 1,
            updated_at = ${terminalAt},
            terminal_at = ${terminalAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directNoTrade = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.NoTrade},
            state_version = state_version + 1,
            updated_at = ${terminalAt},
            terminal_at = ${terminalAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)

        const blocked = yield* store.block(draft.identity.cycleId, CycleTerminalReason.DataStale, terminalAt)
        const retried = yield* store.block(draft.identity.cycleId, CycleTerminalReason.DataStale, terminalAt)
        const rejectedRewrite = yield* Effect.exit(
          store.block(draft.identity.cycleId, CycleTerminalReason.Reconciliation, terminalAt),
        )
        const directUpdate = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET updated_at = ${'2026-03-06T21:06:00.000Z'}, state_version = state_version + 1
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directDelete = yield* Effect.exit(sql`
          DELETE FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
        `)
        return {
          blocked,
          directCompleted,
          directDelete,
          directNoTrade,
          directUpdate,
          rejectedRewrite,
          retried,
        }
      }),
    )

    expect(Exit.isFailure(result.directCompleted)).toBe(true)
    expect(Exit.isFailure(result.directNoTrade)).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      bindings: { snapshotId: snapshotA, decisionHash },
      terminalReason: CycleTerminalReason.DataStale,
      terminalAt,
    })
    expect(result.retried.changed).toBe(false)
    expect(Exit.isFailure(result.rejectedRewrite)).toBe(true)
    expect(Exit.isFailure(result.directUpdate)).toBe(true)
    expect(Exit.isFailure(result.directDelete)).toBe(true)

    const secondRuntime = makeRuntime()
    const durable = await secondRuntime.runPromise(
      Effect.flatMap(CycleStore, (store) => store.read(draft.identity.cycleId)),
    )
    await secondRuntime.dispose()
    expect(Option.isSome(durable)).toBe(true)
    if (Option.isSome(durable)) expect(durable.value).toEqual(result.blocked.cycle)
  })

  test('enforces initial lifecycle state and distinct publication and submission deadlines', async () => {
    const initialDraft = makeDraft('paper-account-initial')
    const missedDraft = makeDraft('paper-account-missed-publication')
    const activationDraft = makeDraft('paper-account-activation-cutoff')
    const afterCutoffDraft = makeDraft('paper-account-after-cutoff')
    const decisionDraft = makeDraft('paper-account-decision-cutoff')
    const lateBindingDraft = makeDraft('paper-account-late-snapshot')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(initialDraft, acquireAt)
        yield* store.bindSnapshot(initialDraft.identity.cycleId, snapshotA, snapshotAt)
        const sql = yield* PgClient.PgClient
        const invalidInitialActive = yield* Effect.exit(sql`
          INSERT INTO autonomous_cycles (
            cycle_id, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, account_id,
            signal_session_date, signal_calendar_version,
            execution_policy_schema_version, execution_policy_hash,
            strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
            window_schema_version, execution_calendar_schema_version,
            execution_calendar_source, execution_calendar_hash, execution_session_date,
            signal_close_at, publication_deadline_at, submission_open_at,
            execution_open_at, execution_close_at, submission_cutoff_at,
            state, snapshot_id, decision_hash, terminal_reason, state_version,
            created_at, updated_at, terminal_at
          )
          SELECT
            ${'8'.repeat(64)}, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, 'paper-account-invalid-initial',
            signal_session_date, signal_calendar_version,
            execution_policy_schema_version, execution_policy_hash,
            strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
            window_schema_version, execution_calendar_schema_version,
            execution_calendar_source, execution_calendar_hash, execution_session_date,
            signal_close_at, publication_deadline_at, submission_open_at,
            execution_open_at, execution_close_at, submission_cutoff_at,
            ${CycleState.Active}, snapshot_id, NULL, NULL, 1,
            updated_at, updated_at, NULL
          FROM autonomous_cycles
          WHERE cycle_id = ${initialDraft.identity.cycleId}
        `)

        const missed = yield* store.acquire(missedDraft, missedDraft.window.publicationDeadlineAt)

        yield* store.acquire(lateBindingDraft, acquireAt)
        const directLateBinding = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            snapshot_id = ${snapshotA},
            state_version = state_version + 1,
            updated_at = ${lateBindingDraft.window.publicationDeadlineAt}
          WHERE cycle_id = ${lateBindingDraft.identity.cycleId}
        `)

        yield* store.acquire(activationDraft, acquireAt)
        yield* store.bindSnapshot(activationDraft.identity.cycleId, snapshotA, snapshotAt)
        const earlySubmissionMiss = yield* Effect.exit(
          store.block(
            activationDraft.identity.cycleId,
            CycleTerminalReason.MissedSubmission,
            activationDraft.window.submissionOpenAt,
          ),
        )
        const activationAtCutoff = yield* store.activate(
          activationDraft.identity.cycleId,
          activationDraft.window.submissionCutoffAt,
        )

        yield* store.acquire(afterCutoffDraft, acquireAt)
        yield* store.bindSnapshot(afterCutoffDraft.identity.cycleId, snapshotA, snapshotAt)
        const activationAfterCutoff = yield* store.activate(
          afterCutoffDraft.identity.cycleId,
          new Date(Date.parse(afterCutoffDraft.window.submissionCutoffAt) + 1).toISOString(),
        )

        yield* store.acquire(decisionDraft, acquireAt)
        yield* store.bindSnapshot(decisionDraft.identity.cycleId, snapshotB, snapshotAt)
        yield* store.activate(decisionDraft.identity.cycleId, activeAt)
        const decisionAtCutoff = yield* store.bindDecision(
          decisionDraft.identity.cycleId,
          decisionHash,
          decisionDraft.window.submissionCutoffAt,
        )

        return {
          activationAfterCutoff,
          activationAtCutoff,
          decisionAtCutoff,
          directLateBinding,
          earlySubmissionMiss,
          invalidInitialActive,
          missed,
        }
      }),
    )

    expect(Exit.isFailure(result.invalidInitialActive)).toBe(true)
    expect(result.missed.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedPublication,
      terminalAt: missedDraft.window.publicationDeadlineAt,
    })
    expect(Exit.isFailure(result.earlySubmissionMiss)).toBe(true)
    expect(Exit.isFailure(result.directLateBinding)).toBe(true)
    if (Exit.isFailure(result.directLateBinding)) {
      expect(Cause.pretty(result.directLateBinding.cause)).toContain(
        'autonomous cycle snapshot missed publication deadline',
      )
    }
    expect(result.activationAtCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
      terminalAt: activationDraft.window.submissionCutoffAt,
    })
    expect(result.activationAfterCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
    })
    expect(result.activationAfterCutoff.cycle.terminalAt).toBeDefined()
    if (result.activationAfterCutoff.cycle.terminalAt !== undefined) {
      expect(result.activationAfterCutoff.cycle.terminalAt > afterCutoffDraft.window.submissionCutoffAt).toBe(true)
    }
    expect(result.decisionAtCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
      terminalAt: decisionDraft.window.submissionCutoffAt,
    })
    expect(result.decisionAtCutoff.cycle.bindings.decisionHash).toBeUndefined()
    expect(decisionDraft.window.submissionCutoffAt < decisionDraft.window.executionOpenAt).toBe(true)
  })
})
