import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import {
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from '../index'
import { PostgresClientLive } from '../../db/postgres-client'
import { postgresMigrations } from '../../db/postgres-migrations'
import { Authority, KillState } from '../../execution/contracts'
import { canonicalHashV1 } from '../../hash'
import { intradayMomentumExecutionModel } from '../../strategy/intraday-momentum/protocol'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import { CycleObservability, CycleObservabilityLive, CycleStore, CycleStoreLive } from '.'

const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const qualificationRunId = '1'.repeat(64)
const accountId = 'paper-account-intraday-observability'
const authorityGenerationHash = '2'.repeat(64)
const reconciliationId = '3'.repeat(64)
const stateHash = '4'.repeat(64)
const reconciliationHash = '5'.repeat(64)
const sessionDate = '2026-08-28' as const
const acquiredAt = '2026-08-28T13:00:00.000Z'
const activatedAt = '2026-08-28T14:31:00.000Z'
const reconciledAt = '2026-08-28T14:30:00.000Z'
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const draft = () => {
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: sessionDate,
      openAt: '2026-08-28T13:30:00.000Z',
      closeAt: '2026-08-28T20:00:00.000Z',
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId,
      strategyProtocolHash: canonicalHashV1({ strategy: 'intraday-momentum', version: 1 }),
      accountId,
      executionSessionDate: sessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const candidate = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, executionPolicy))))
  if (!isIntradayCycleDraft(candidate)) throw new Error('expected the active intraday cycle contract')
  return candidate
}

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, CycleObservabilityLive).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
})

const seedSafetyState = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`
    INSERT INTO authority_generations (
      generation_hash, schema_version, previous_generation_hash, maximum,
      authority_version, activated_at
    ) VALUES (
      ${authorityGenerationHash}, 'bayn.authority-generation-history.v1', NULL,
      ${Authority.Observe}, 1, ${reconciledAt}
    )
  `
  yield* sql`
    INSERT INTO authority_state (
      schema_version, generation_hash, maximum, effective, kill_state, reason, version, updated_at
    ) VALUES (
      'bayn.paper-authority.v1', ${authorityGenerationHash}, ${Authority.Observe}, ${Authority.Observe},
      ${KillState.Clear}, NULL, 1, ${reconciledAt}
    )
  `
  yield* sql`
    INSERT INTO reconciliations (
      reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
      content_hash, status, discrepancies, reconciled_at
    ) VALUES (
      ${reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId}, ${stateHash}, ${stateHash},
      ${reconciliationHash}, 'EXACT', ${sql.json(encodeSqlJson([]))}, ${reconciledAt}
    )
  `
})

const seedUnresolvedMutation = (cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const intentId = '6'.repeat(64)
    yield* sql`
      INSERT INTO intents (
        intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
        decision_hash, policy_hash, account_id, client_order_id, symbol, side, order_type, time_in_force,
        quantity_micros, notional_limit_micros, state, terminal_outcome, state_version, created_at, updated_at
      ) VALUES (
        ${intentId}, 'bayn.paper-intent.v3', ${authorityGenerationHash}, NULL, 'intraday-momentum', ${cycleId},
        ${'7'.repeat(64)}, ${'8'.repeat(64)}, ${accountId}, 'bayn-observability-unresolved', 'SPY', 'BUY',
        'LIMIT', 'IOC', 1000000, 1000000, 'PLANNED', NULL, 1,
        '2026-08-28T14:32:00.000Z', '2026-08-28T14:32:00.000Z'
      )
    `
    yield* sql`
      INSERT INTO mutation_events (
        event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
        request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
        response_content_hash, occurred_at
      ) VALUES (
        ${'9'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'a'.repeat(64)}, ${intentId}, 1,
        'SUBMIT', 'SUBMIT_STARTED', ${'b'.repeat(64)}, 1000, NULL, NULL, NULL, NULL,
        '2026-08-28T14:32:00.000Z'
      )
    `
  })

const seedAccountSnapshots = (
  snapshots: ReadonlyArray<{
    readonly eventId: string
    readonly sourceSequence: number
    readonly observedAt: string
    readonly cashMicros: string
  }>,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    for (const snapshot of snapshots) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO broker_events (
              event_id, schema_version, content_hash, event_kind, broker, account_id,
              source_event_id, source_sequence, occurred_at, observed_at
            ) VALUES (
              ${snapshot.eventId}, 'bayn.paper-broker-event.v1', ${snapshot.eventId}, 'ACCOUNT', 'ALPACA',
              ${accountId}, ${`account-${snapshot.sourceSequence}`}, ${snapshot.sourceSequence},
              ${snapshot.observedAt}, ${snapshot.observedAt}
            )
          `
          yield* sql`
            INSERT INTO account_snapshots (
              event_id, account_id, schema_version, status, currency,
              cash_micros, equity_micros, buying_power_micros
            ) VALUES (
              ${snapshot.eventId}, ${accountId}, 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD',
              ${snapshot.cashMicros}, ${snapshot.cashMicros}, ${snapshot.cashMicros}
            )
          `
        }),
      )
    }
  })

const seedPositionSnapshots = (
  snapshots: ReadonlyArray<{
    readonly snapshotId: string
    readonly observedAt: string
    readonly positionCount: number
    readonly trusted?: boolean
  }>,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    for (const snapshot of snapshots) {
      yield* sql`
        INSERT INTO position_snapshots (
          snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash,
          ingestion_order_trusted
        ) VALUES (
          ${snapshot.snapshotId}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${snapshot.snapshotId},
          ${snapshot.observedAt}, ${snapshot.positionCount}, ${snapshot.snapshotId}, ${snapshot.trusted ?? true}
        )
      `
    }
  })

describePostgres('PostgreSQL intraday observability projection', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(resetDatabase)
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('projects the active intraday cycle with exact safety and zero execution facts', async () => {
    const candidate = draft()
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        yield* store.activate(candidate.identity.cycleId, activatedAt)
        yield* seedSafetyState
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.current).toMatchObject({
      cycleId: candidate.identity.cycleId,
      accountId,
      executionSessionDate: sessionDate,
      phase: 'ACTIVE',
    })
    expect(projection.last).toBeNull()
    expect(projection.unfinishedCycleCount).toBe(1)
    expect(projection.authority).toMatchObject({
      generationHash: authorityGenerationHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
    })
    expect(projection.reconciliation).toMatchObject({
      reconciliationId,
      accountId,
      status: 'EXACT',
      coversLatestMutation: true,
    })
    expect(projection.mutations).toMatchObject({ eventCount: 0, unresolvedCount: 0 })
    expect(projection.execution).toMatchObject({ decision: null, intentCount: 0, fillCount: 0 })
    expect(projection.economics?.accounting).toMatchObject({
      fillCount: 0,
      transactionCount: 0,
      netRealizedPnlAfterExecutionFeesMicros: '0',
    })
  })

  test('selects account snapshots by durable broker sequence', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedSafetyState
        yield* seedAccountSnapshots([
          {
            eventId: 'c'.repeat(64),
            sourceSequence: 1,
            observedAt: '2026-08-28T14:32:00.000Z',
            cashMicros: '1000000',
          },
          {
            eventId: 'd'.repeat(64),
            sourceSequence: 2,
            observedAt: '2026-08-28T14:32:00.000Z',
            cashMicros: '2000000',
          },
        ])
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      accountObservedAt: '2026-08-28T14:32:00.000Z',
      cashMicros: '2000000',
      equityMicros: '2000000',
      buyingPowerMicros: '2000000',
    })
  })

  test('fails closed when a newer account snapshot regresses its observation clock', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedSafetyState
        yield* seedAccountSnapshots([
          {
            eventId: 'c'.repeat(64),
            sourceSequence: 1,
            observedAt: '2026-08-28T14:32:01.000Z',
            cashMicros: '1000000',
          },
          {
            eventId: 'd'.repeat(64),
            sourceSequence: 2,
            observedAt: '2026-08-28T14:32:00.000Z',
            cashMicros: '2000000',
          },
        ])
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      accountObservedAt: null,
      cashMicros: null,
      equityMicros: null,
      buyingPowerMicros: null,
    })
  })

  test('selects tied position snapshots by durable ingestion sequence', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedSafetyState
        yield* seedPositionSnapshots([
          {
            snapshotId: 'c'.repeat(64),
            observedAt: '2026-08-28T14:32:00.000Z',
            positionCount: 1,
          },
          {
            snapshotId: 'd'.repeat(64),
            observedAt: '2026-08-28T14:32:00.000Z',
            positionCount: 0,
          },
        ])
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      positionSnapshotObservedAt: '2026-08-28T14:32:00.000Z',
      positionCount: 0,
      grossExposureMicros: '0',
      netExposureMicros: '0',
      unrealizedPnlMicros: '0',
    })
  })

  test('fails closed when a later trusted position snapshot regresses its observation clock', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedSafetyState
        yield* seedPositionSnapshots([
          {
            snapshotId: 'c'.repeat(64),
            observedAt: '2026-08-28T14:32:01.000Z',
            positionCount: 1,
          },
          {
            snapshotId: 'd'.repeat(64),
            observedAt: '2026-08-28T14:32:00.000Z',
            positionCount: 0,
          },
        ])
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      positionSnapshotObservedAt: null,
      positionCount: null,
      grossExposureMicros: null,
      netExposureMicros: null,
      unrealizedPnlMicros: null,
    })
  })

  test('fails closed when the first trusted position snapshot regresses the legacy clock', async () => {
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedSafetyState
        yield* seedPositionSnapshots([
          {
            snapshotId: 'c'.repeat(64),
            observedAt: '2026-08-28T14:32:01.000Z',
            positionCount: 1,
            trusted: false,
          },
          {
            snapshotId: 'd'.repeat(64),
            observedAt: '2026-08-28T14:32:00.000Z',
            positionCount: 0,
          },
        ])
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      positionSnapshotObservedAt: null,
      positionCount: null,
      grossExposureMicros: null,
      netExposureMicros: null,
      unrealizedPnlMicros: null,
    })
  })

  test('indexes recurring snapshot lookups by durable sequence', async () => {
    const indexes = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql<{ indexname: string; indexdef: string }>`
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'position_snapshots_account_ingestion_sequence_idx',
              'broker_events_account_snapshot_order_idx',
              'broker_events_account_snapshot_clock_idx'
            )
        `
      }),
    )
    const byName = Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]))

    expect(byName.broker_events_account_snapshot_order_idx).toContain(
      '(account_id, source_sequence DESC, observed_at DESC, event_id DESC)',
    )
    expect(byName.broker_events_account_snapshot_clock_idx).toContain(
      '(account_id, observed_at DESC, source_sequence DESC, event_id DESC)',
    )
    expect(byName.position_snapshots_account_ingestion_sequence_idx).toContain('(account_id, ingestion_sequence DESC)')
  })

  test('ignores future-dated broker snapshots when selecting observable state', async () => {
    const candidate = draft()
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        yield* store.activate(candidate.identity.cycleId, activatedAt)
        yield* seedSafetyState

        const insertAccountSnapshot = (
          eventId: string,
          sourceSequence: number,
          observedAt: string,
          cashMicros: string,
        ) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO broker_events (
                  event_id, schema_version, content_hash, event_kind, broker, account_id,
                  source_event_id, source_sequence, occurred_at, observed_at
                ) VALUES (
                  ${eventId}, 'bayn.paper-broker-event.v1', ${eventId}, 'ACCOUNT', 'ALPACA',
                  ${accountId}, ${`account-${eventId}`}, ${sourceSequence}, ${observedAt}, ${observedAt}
                )
              `
              yield* sql`
                INSERT INTO account_snapshots (
                  event_id, account_id, schema_version, status, currency,
                  cash_micros, equity_micros, buying_power_micros
                ) VALUES (
                  ${eventId}, ${accountId}, 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD',
                  ${cashMicros}, ${cashMicros}, ${cashMicros}
                )
              `
            }),
          )

        yield* insertAccountSnapshot('a'.repeat(64), 1, '2026-08-28T14:32:00.000Z', '2000000')
        yield* insertAccountSnapshot('b'.repeat(64), 2, '2099-08-28T14:32:00.000Z', '9000000')
        yield* sql`
          INSERT INTO position_snapshots (
            snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
          ) VALUES
            (
              ${'c'.repeat(64)}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${'d'.repeat(64)},
              '2026-08-28T14:32:00.000Z', 0, ${'e'.repeat(64)}
            ),
            (
              ${'f'.repeat(64)}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${'0'.repeat(64)},
              '2099-08-28T14:32:00.000Z', 0, ${'1'.repeat(64)}
            )
        `

        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.execution).toMatchObject({
      accountObservedAt: '2026-08-28T14:32:00.000Z',
      cashMicros: '2000000',
      positionSnapshotObservedAt: '2026-08-28T14:32:00.000Z',
      positionCount: 0,
    })
  })

  test('exposes unresolved broker mutation pressure and stale reconciliation without ambiguity', async () => {
    const candidate = draft()
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        yield* store.activate(candidate.identity.cycleId, activatedAt)
        yield* seedSafetyState
        yield* seedUnresolvedMutation(candidate.identity.cycleId)
        return yield* (yield* CycleObservability).read(qualificationRunId, accountId)
      }),
    )

    expect(projection.mutations).toMatchObject({
      eventCount: 1,
      unresolvedCount: 1,
      oldestUnresolvedAt: '2026-08-28T14:32:00.000Z',
      latestOccurredAt: '2026-08-28T14:32:00.000Z',
    })
    expect(projection.reconciliation).toMatchObject({ status: 'EXACT', coversLatestMutation: false })
    expect(projection.execution).toMatchObject({ intentCount: 1, plannedIntentCount: 1 })
  })

  test('rejects a configured account that differs from the durable cycle', async () => {
    const candidate = draft()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        return yield* (yield* CycleObservability).read(qualificationRunId, 'different-account').pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({ operation: 'read', failure: 'invariant' })
  })
})
