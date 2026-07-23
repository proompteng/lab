import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
} from '../cycle'
import { CycleOperationsCondition, CycleOperationsReason, deriveCycleOperationsStatus } from '../cycle-observability'
import type { SignalSessionRow } from '../market-data'
import { Authority, KillState } from '../paper'
import type { IsoDate } from '../types'
import { CycleObservability, CycleObservabilityLive } from './cycle-observability'
import { CycleStore, CycleStoreLive } from './cycle-store'
import { PostgresClientLive } from './evidence-store'
import { migrationLoader } from './migrations'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const qualificationRunId = 'a'.repeat(64)
const accountId = 'paper-account-observability'
const reconciliationId = 'd'.repeat(64)
const reconciliationHash = 'e'.repeat(64)

const databaseConfig = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, CycleObservabilityLive).pipe(
      Layer.provideMerge(PostgresClientLive(databaseConfig)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

const signalSession = (
  sessionDate: IsoDate,
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'> => ({
  calendar_version: 'signal-XNYS-2026-v1',
  session_date: sessionDate,
  close_time: '16:00',
  timezone: 'America/New_York',
})

const makeDraft = (dedicatedAccountId = accountId) => {
  const executionPolicy = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'b'.repeat(64),
    submissionWindowMs: 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  const executionCalendar = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: '2026-03-09',
    openAt: '2026-03-09T13:30:00.000Z',
    closeAt: '2026-03-09T20:00:00.000Z',
  })
  const identity = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId,
    strategyProtocolHash: 'c'.repeat(64),
    accountId: dedicatedAccountId,
    signalSessionDate: '2026-03-06',
    signalCalendarVersion: 'signal-XNYS-2026-v1',
    executionSessionDate: executionCalendar.executionSessionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  return makeCycleDraft(identity, makeCycleWindow(signalSession('2026-03-06'), executionCalendar, executionPolicy))
}

const seedSafetyState = (reconciledAt = '2026-03-06T21:00:00.000Z') =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`
      INSERT INTO authority_generations (
        generation_hash, schema_version, previous_generation_hash, maximum,
        authority_version, activated_at
      ) VALUES (
        ${'f'.repeat(64)}, 'bayn.authority-generation-history.v1', NULL,
        'OBSERVE', 1, '2026-03-06T21:00:00.000Z'
      )
    `
    yield* sql`
    INSERT INTO authority_state (
      schema_version, generation_hash, maximum, effective, kill_state, reason, version, updated_at
    ) VALUES (
      'bayn.paper-authority.v1',
      ${'f'.repeat(64)},
      ${Authority.Observe},
      ${Authority.Observe},
      ${KillState.Clear},
      NULL,
      1,
      ${'2026-03-06T21:00:00.000Z'}
    )
  `
    yield* sql`
    INSERT INTO reconciliations (
      reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
      content_hash, status, discrepancies, reconciled_at
    ) VALUES (
      ${reconciliationId},
      'bayn.paper-reconciliation.v1',
      ${accountId},
      ${reconciliationHash},
      ${reconciliationHash},
      ${'1'.repeat(64)},
      'EXACT',
      ${sql.json(JSON.stringify([]))},
      ${reconciledAt}
    )
  `
  })

const seedUnresolvedMutation = (mutationAccountId = accountId) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const intentId = '2'.repeat(64)
    yield* sql`
    INSERT INTO intents (
      intent_id, schema_version, risk_decision_id, strategy_name, cycle_id,
      decision_hash, policy_hash, account_id, client_order_id,
      symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros,
      state, terminal_outcome, state_version, created_at, updated_at
    ) VALUES (
      ${intentId},
      'bayn.paper-intent.v2',
      NULL,
      'risk-balanced-trend',
      ${'8'.repeat(64)},
      ${'9'.repeat(64)},
      ${'a'.repeat(64)},
      ${mutationAccountId},
      'bayn-observability-test-order',
      'SPY',
      'BUY',
      'MARKET',
      'DAY',
      1000000,
      1000000,
      'PLANNED',
      NULL,
      1,
      ${'2026-03-06T21:02:00.000Z'},
      ${'2026-03-06T21:02:00.000Z'}
    )
  `
    yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES (
      ${'3'.repeat(64)},
      'bayn.paper-mutation-event.v1',
      ${'4'.repeat(64)},
      ${intentId},
      1,
      'SUBMIT',
      'SUBMIT_STARTED',
      ${'5'.repeat(64)},
      1000,
      NULL,
      NULL,
      NULL,
      NULL,
      ${'2026-03-06T21:02:00.000Z'}
    )
  `
  })

const seedAcceptedMutation = (occurredAt = '2026-03-06T21:03:00.000Z') =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`
    INSERT INTO mutation_events (
      event_id, schema_version, mutation_id, intent_id, sequence, operation,
      event_type, request_hash, consistency_delay_ms, broker_order_id,
      request_id, response_status, response_content_hash, occurred_at
    ) VALUES (
      ${'6'.repeat(64)},
      'bayn.paper-mutation-event.v1',
      ${'4'.repeat(64)},
      ${'2'.repeat(64)},
      2,
      'SUBMIT',
      'SUBMIT_ACCEPTED',
      ${'5'.repeat(64)},
      1000,
      'broker-order-observability',
      'broker-request-observability',
      200,
      ${'7'.repeat(64)},
      ${occurredAt}
    )
  `
  })

describePostgres('PostgreSQL cycle observability projection', () => {
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

  test('reads bounded current/last and safety state without changing durable counts', async () => {
    const draft = makeDraft()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()
        const empty = yield* observability.read(qualificationRunId, accountId)
        yield* store.acquire(draft, '2026-03-06T21:01:00.000Z')

        const current = yield* observability.read(qualificationRunId, accountId)
        yield* store.block(
          draft.identity.cycleId,
          CycleTerminalReason.MissedPublication,
          draft.window.publicationDeadlineAt,
        )
        yield* seedUnresolvedMutation()
        const blocked = yield* observability.read(qualificationRunId, accountId)
        const blockedReplay = yield* observability.read(qualificationRunId, accountId)
        const [counts] = yield* sql<{
          cycles: number
          intents: number
          mutations: number
          reconciliations: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM autonomous_cycles) AS cycles,
            (SELECT count(*)::integer FROM intents) AS intents,
            (SELECT count(*)::integer FROM mutation_events) AS mutations,
            (SELECT count(*)::integer FROM reconciliations) AS reconciliations
        `
        return { blocked, blockedReplay, counts, current, empty }
      }),
    )

    expect(result.empty).toMatchObject({
      current: null,
      last: null,
      reconciliation: { accountId, reconciliationId, status: 'EXACT', discrepancyCount: 0 },
    })
    expect(result.current).toMatchObject({
      current: {
        cycleId: draft.identity.cycleId,
        accountId,
        phase: CycleState.Pending,
        signalSessionDate: '2026-03-06',
        executionSessionDate: '2026-03-09',
        submissionCutoffAt: draft.window.submissionCutoffAt,
      },
      last: null,
      unfinishedCycleCount: 1,
      authority: {
        generationHash: 'f'.repeat(64),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      },
      reconciliation: {
        accountId,
        reconciliationId,
        status: 'EXACT',
        discrepancyCount: 0,
      },
      mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
    })
    expect(result.blocked).toMatchObject({
      current: null,
      last: {
        cycleId: draft.identity.cycleId,
        phase: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
        terminalAt: draft.window.publicationDeadlineAt,
      },
      unfinishedCycleCount: 0,
      mutations: {
        eventCount: 1,
        unresolvedCount: 1,
        oldestUnresolvedAt: '2026-03-06T21:02:00.000Z',
        latestOccurredAt: '2026-03-06T21:02:00.000Z',
      },
    })
    expect(result.blockedReplay).toEqual(result.blocked)
    expect(result.counts).toEqual({ cycles: 1, intents: 1, mutations: 1, reconciliations: 1 })
  })

  test('isolates mutation evidence by account and rejects an explicit account-to-cycle mismatch', async () => {
    const otherAccountId = 'paper-account-unrelated'
    const otherDraft = makeDraft(otherAccountId)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const observability = yield* CycleObservability
        yield* seedSafetyState()
        yield* seedUnresolvedMutation(otherAccountId)

        const isolated = yield* observability.read(qualificationRunId, accountId)
        yield* store.acquire(otherDraft, '2026-03-06T21:01:00.000Z')
        const mismatch = yield* Effect.flip(observability.read(qualificationRunId, accountId))
        return { isolated, mismatch }
      }),
    )

    expect(result.isolated).toMatchObject({
      current: null,
      last: null,
      reconciliation: { accountId },
      mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
    })
    expect(result.mismatch).toMatchObject({
      _tag: 'CycleObservabilityError',
      operation: 'read',
      failure: 'invariant',
      message: `configured account ${accountId} differs from the projected current or last cycle`,
    })
  })

  test('uses the canonical reconciliation-id tie-break for equal timestamps', async () => {
    const higherReconciliationId = 'f'.repeat(64)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        const sql = yield* PgClient.PgClient
        yield* seedSafetyState()
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${higherReconciliationId},
            'bayn.paper-reconciliation.v1',
            ${accountId},
            ${reconciliationHash},
            ${reconciliationHash},
            ${'2'.repeat(64)},
            'EXACT',
            ${sql.json(JSON.stringify([]))},
            ${'2026-03-06T21:00:00.000Z'}
          )
        `
        const projection = yield* observability.read(qualificationRunId, accountId)
        const [historyLatest] = yield* sql<{ reconciliation_id: string }>`
          SELECT reconciliation_id
          FROM reconciliations
          WHERE account_id = ${accountId}
          ORDER BY reconciled_at DESC, reconciliation_id DESC
          LIMIT 1
        `
        return { historyLatest, projection }
      }),
    )

    expect(result.historyLatest?.reconciliation_id).toBe(higherReconciliationId)
    expect(result.projection.reconciliation?.reconciliationId).toBe(result.historyLatest?.reconciliation_id)
  })

  test('keeps PAPER blocked when a sub-millisecond resolved mutation follows exact reconciliation', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const observability = yield* CycleObservability
        yield* seedSafetyState('2026-03-06T21:02:00.000000Z')
        yield* seedUnresolvedMutation()
        yield* seedAcceptedMutation('2026-03-06T21:02:00.000500Z')
        const projected = yield* observability.read(qualificationRunId, accountId)
        if (projected.authority === null) {
          return yield* Effect.die(new Error('authority projection is unavailable'))
        }
        const paperProjection = {
          ...projected,
          authority: {
            ...projected.authority,
            maximum: Authority.Paper,
            effective: Authority.Paper,
          },
        }
        const status = deriveCycleOperationsStatus(
          paperProjection,
          Date.parse('2026-03-06T21:03:30.000Z'),
          Authority.Paper,
          {
            cycleStallThresholdMs: 300_000,
            reconciliationStaleThresholdMs: 300_000,
            unknownMutationThresholdMs: 300_000,
          },
        )
        return { projected: paperProjection, status }
      }),
    )

    expect(result.projected).toMatchObject({
      reconciliation: {
        accountId,
        status: 'EXACT',
        reconciledAt: '2026-03-06T21:02:00.000Z',
        coversLatestMutation: false,
      },
      mutations: {
        eventCount: 2,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: '2026-03-06T21:02:00.000Z',
      },
    })
    expect(result.status).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationPredatesMutation,
      reconciliationCoversLatestMutation: false,
      alerts: { reconciliationBlocked: true, unknownMutationStale: false },
    })
  })
})
