import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result } from 'effect'

import observationWindowIndex from '../../migrations/0163_jev_observation_window_index'
import entryWindowIndex from '../../migrations/0180_jev_entry_window_index'
import { nativeJevFixture } from '../jev/native.test-support'
import { loadNativeEntryObservation } from '../jev/runtime'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { formalModelExecutable, runFormalModel } from '../system-assessment/formal-model.test-support'
import { JevPurpose } from '../jev/portfolio'
import { continuousMarketHours, continuousExecutionPolicy, tradingWindow } from '../market-hours'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { makeInitialCycle } from '../cycle/store/decisions'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { jevObservationQuery } from '../jev/runtime'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { makeCandidateObservationStore, latestJevObservationWindowQuery } from './candidate-observation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const runtime = ManagedRuntime.make(
  PostgresClientLive({
    operationTimeoutMs: 10_000,
    postgres: {
      url: Redacted.make(baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'),
      tls: false,
      caPath: '/unused',
    },
  }).pipe(Layer.provideMerge(NodeServices.layer)),
)

describePostgres('PostgreSQL consumed Jev window lookup', () => {
  beforeAll(async () => {
    const url = new URL(baynTestPostgresUrl ?? '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Consumed-window tests require an isolated local _test database')
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
  }, 30_000)
  afterAll(() => runtime.dispose())

  test('indexes the exact maximum window without rewriting retained payloads or mixing scopes', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE intraday_candidate_observations (
              content_hash text, cycle_id text, observed_at timestamptz, payload jsonb
            ) ON COMMIT DROP`
            yield* sql`CREATE INDEX probe_cycle_time ON intraday_candidate_observations(cycle_id, observed_at)`
            const cycleId = '1'.repeat(64)
            const otherCycleId = '2'.repeat(64)
            const peerCycleId = '3'.repeat(64)
            const scope = {
              schema_version: 'bayn.autonomous-cycle.v4',
              identity_schema_version: 'bayn.autonomous-cycle-identity.v4',
              strategy_name: 'jev',
              strategy_protocol_hash: '7'.repeat(64),
              qualification_run_id: '8'.repeat(64),
              account_id: 'window-account',
              execution_policy_hash: '9'.repeat(64),
              execution_calendar_schema_version: 'bayn.alpaca-market-calendar-observation.v2',
              execution_calendar_source: 'alpaca-v2-calendar',
              execution_calendar_hash: 'a'.repeat(64),
              execution_session_date: '2026-09-04',
            }
            yield* sql`CREATE TEMP TABLE autonomous_cycles (
              cycle_id text PRIMARY KEY, schema_version text, identity_schema_version text, strategy_name text,
              strategy_protocol_hash text, qualification_run_id text, account_id text, execution_policy_hash text,
              execution_calendar_schema_version text, execution_calendar_source text, execution_calendar_hash text,
              execution_session_date date
            ) ON COMMIT DROP`
            yield* sql`CREATE INDEX probe_cycle_scope ON autonomous_cycles(qualification_run_id,account_id,execution_session_date)`
            const foreignScopes = Object.keys(scope).map((key, index) => ({
              cycle_id: String(index + 5).padStart(64, '0'),
              ...scope,
              [key]:
                key === 'execution_session_date'
                  ? '2026-09-03'
                  : key.endsWith('_hash') || key === 'qualification_run_id'
                    ? 'f'.repeat(64)
                    : `foreign-${key}`,
            }))
            const rollingNative = nativeJevFixture()
            const rollingPolicy = Result.getOrThrow(
              makeCycleExecutionPolicyFromModel(rollingNative.protocol.executionModel),
            )
            if (rollingPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
              throw new Error('Expected the current native policy')
            const rolling = ['2026-09-04T23:59:50.000Z', '2026-09-04T23:59:55.000Z', '2026-09-05T00:00:01.000Z'].map(
              (at) => {
                const lease = Result.getOrThrow(
                  tradingWindow(continuousMarketHours, at, {
                    ...continuousExecutionPolicy,
                    sessionEntryCutoffMs: 0,
                  }),
                )
                if (lease === null) throw new Error('Expected a continuous lease')
                const draft = Result.getOrThrow(
                  makeIntradayCycleDraft(
                    {
                      cycleBindingId: scope.qualification_run_id,
                      strategyName: 'jev',
                      strategyProtocolHash: scope.strategy_protocol_hash,
                      accountId: scope.account_id,
                      executionPolicy: rollingPolicy,
                    },
                    continuousMarketHours,
                    lease,
                  ),
                )
                const query = Result.getOrThrow(
                  jevObservationQuery(
                    makeInitialCycle(draft, at),
                    rollingNative.protocol,
                    continuousMarketHours,
                    at,
                    JevPurpose.Entry,
                  ),
                )
                return {
                  at,
                  query,
                  draft,
                  scope: {
                    ...scope,
                    cycle_id: draft.identity.cycleId,
                    execution_calendar_schema_version: draft.identity.executionCalendarSchemaVersion,
                    execution_calendar_source: draft.identity.executionCalendarSource,
                    execution_calendar_hash: draft.identity.executionCalendarHash,
                    execution_session_date: draft.identity.executionSessionDate,
                  },
                }
              },
            )
            expect(new Set(rolling.map((r) => r.scope.execution_calendar_hash)).size).toBe(3)
            expect(rolling.map((r) => r.scope.execution_session_date)).toEqual([
              '2026-09-04',
              '2026-09-04',
              '2026-09-05',
            ])
            expect(rolling.map((r) => r.query.rangeEndAt)).toEqual(Array(3).fill('2026-09-04T23:59:00.000Z'))
            const firstRolling = rolling[0]
            if (firstRolling === undefined) throw new Error('Missing continuous source')
            const cycles = [
              { cycle_id: cycleId, ...scope },
              { cycle_id: peerCycleId, ...scope },
              { cycle_id: otherCycleId, ...scope, account_id: 'different-account' },
              { cycle_id: '4'.repeat(64), ...scope, account_id: 'empty-account' },
              ...foreignScopes,
              ...rolling.map((r) => r.scope),
            ] as const
            yield* sql`INSERT INTO autonomous_cycles ${sql.insert(cycles)}`
            const rows = [
              [cycleId, JevPurpose.Entry, '2026-09-04T14:30:00.000Z', '2026-09-04T14:31:00.000Z'],
              [cycleId, JevPurpose.Entry, '2026-09-04T14:29:00.000Z', '2026-09-04T14:35:00.000Z'],
              [cycleId, JevPurpose.Manage, '2026-09-04T15:00:00.000Z', '2026-09-04T15:01:00.000Z'],
              [otherCycleId, JevPurpose.Entry, '2026-09-04T16:00:00.000Z', '2026-09-04T16:01:00.000Z'],
              [peerCycleId, JevPurpose.Entry, '2026-09-04T14:31:00.000Z', '2026-09-04T14:32:00.000Z'],
              [firstRolling.scope.cycle_id, JevPurpose.Entry, firstRolling.query.rangeEndAt, firstRolling.at],
              [firstRolling.scope.cycle_id, JevPurpose.Manage, firstRolling.query.rangeEndAt, firstRolling.at],
            ] as const
            for (const [index, [scope, purpose, windowEndAt, observedAt]] of rows.entries()) {
              yield* sql`INSERT INTO intraday_candidate_observations
                VALUES (${String(index)}, ${scope}, ${observedAt}, ${sql.json({
                  schemaVersion: 'bayn.jev-observation.v1',
                  portfolio: { purpose },
                  manifest: { rangeEndAt: windowEndAt },
                  sourcePadding: 'retained immutable source '.repeat(10_000),
                })})`
            }
            for (const foreign of foreignScopes)
              yield* sql`INSERT INTO intraday_candidate_observations VALUES (${foreign.cycle_id},${foreign.cycle_id},
                '2026-09-04T18:01:00Z',${sql.json({
                  schemaVersion: 'bayn.jev-observation.v1',
                  portfolio: { purpose: JevPurpose.Entry },
                  manifest: { rangeEndAt: '2026-09-04T18:00:00.000Z' },
                })})`
            yield* sql`INSERT INTO intraday_candidate_observations VALUES ('retired',${cycleId},
              '2026-09-04T17:01:00Z',${sql.json({
                schemaVersion: 'bayn.intraday-candidate-observation.v2',
                portfolio: { purpose: JevPurpose.Entry },
                manifest: { rangeEndAt: '2026-09-04T17:00:00.000Z' },
              })})`
            const store = yield* makeCandidateObservationStore
            const readRequests = [
              { cycleId, purpose: JevPurpose.Entry },
              { cycleId, purpose: JevPurpose.Manage },
              { cycleId: otherCycleId, purpose: JevPurpose.Entry },
              { cycleId: '4'.repeat(64), purpose: JevPurpose.Entry },
              { cycleId: 'e'.repeat(64), purpose: JevPurpose.Entry },
              { cycleId: peerCycleId, purpose: JevPurpose.Entry },
              { cycleId: peerCycleId, purpose: JevPurpose.Manage },
              ...foreignScopes.map((scope) => ({ cycleId: scope.cycle_id, purpose: JevPurpose.Entry })),
              ...rolling.map((r) => ({ cycleId: r.scope.cycle_id, purpose: JevPurpose.Entry })),
              ...rolling.slice(1).map((r) => ({ cycleId: r.scope.cycle_id, purpose: JevPurpose.Manage })),
            ]
            const readWindows = Effect.all(readRequests.map((request) => store.latestJevWindowEnd(request)))
            const expected = [
              Option.some('2026-09-04T14:31:00.000Z'),
              Option.some('2026-09-04T15:00:00.000Z'),
              Option.some('2026-09-04T16:00:00.000Z'),
              Option.none(),
              Option.none(),
              Option.some('2026-09-04T14:31:00.000Z'),
              Option.none(),
              ...foreignScopes.map(() => Option.some('2026-09-04T18:00:00.000Z')),
              ...rolling.map((r) => Option.some(r.query.rangeEndAt)),
              ...rolling.slice(1).map(() => Option.none()),
            ]
            const actualWindows = [...(yield* readWindows)]
            expect(actualWindows).toEqual(expected)
            if (formalModelExecutable !== undefined) {
              const byCycle = new Map(cycles.map((scope) => [scope.cycle_id, scope]))
              const source = (cycle: string, purpose: JevPurpose, end: string, jev = true) => ({
                cycle,
                scope: byCycle.get(cycle),
                entry: purpose === JevPurpose.Entry,
                windowEnd: String(Date.parse(end)),
                jev,
              })
              const sources = [
                ...rows.map(([cycle, purpose, end]) => source(cycle, purpose, end)),
                ...foreignScopes.map((scope) => source(scope.cycle_id, JevPurpose.Entry, '2026-09-04T18:00:00.000Z')),
                source(cycleId, JevPurpose.Entry, '2026-09-04T17:00:00.000Z', false),
              ]
              expect(
                runFormalModel(
                  readRequests.map(({ cycleId, purpose }) => ({
                    operation: 'latestCompatibleEntryWindow',
                    targetExists: byCycle.has(cycleId),
                    targetCycle: cycleId,
                    scope: byCycle.get(cycleId) ?? scope,
                    entry: purpose === JevPurpose.Entry,
                    sources,
                  })),
                ),
              ).toEqual(actualWindows.map((at) => Option.getOrNull(Option.map(at, Date.parse))))
            }
            const native = nativeJevFixture(undefined, '2026-09-04T14:31:02.000Z')
            const input = {
              cycleId,
              authorityGenerationHash: native.observation.payload.authorityGenerationHash,
              protocol: native.protocol,
              portfolio: native.portfolio,
            }
            let snapshotReads = 0
            const marker = new Error('Unconsumed source read reached')
            const snapshot = Effect.sync(() => {
              snapshotReads += 1
            }).pipe(Effect.andThen(Effect.fail(marker)))
            const consumed = yield* loadNativeEntryObservation(input, '2026-09-04T14:31:00.000Z', snapshot).pipe(
              Effect.provideService(CandidateObservationStore, store),
              Effect.result,
            )
            expect(consumed).toMatchObject({
              _tag: 'Failure',
              failure: { _tag: 'JevAwaitingFreshWindow', availableAt: '2026-09-04T14:32:02.000Z' },
            })
            expect(snapshotReads).toBe(0)
            const nextWindow = yield* loadNativeEntryObservation(input, '2026-09-04T14:32:00.000Z', snapshot).pipe(
              Effect.provideService(CandidateObservationStore, store),
              Effect.result,
            )
            if (nextWindow._tag !== 'Failure')
              throw new Error('source-read sentinel must stop before observation construction')
            expect(nextWindow.failure).toBe(marker)
            expect(snapshotReads).toBe(1)
            for (const r of rolling.slice(1)) {
              const repeated = yield* loadNativeEntryObservation(
                { ...input, cycleId: r.scope.cycle_id },
                r.query.rangeEndAt,
                snapshot,
              ).pipe(Effect.provideService(CandidateObservationStore, store), Effect.result)
              expect(repeated).toMatchObject({
                _tag: 'Failure',
                failure: { _tag: 'JevAwaitingFreshWindow', availableAt: '2026-09-05T00:00:02.000Z' },
              })
            }
            expect(snapshotReads).toBe(1)
            const original = yield* sql`SELECT * FROM intraday_candidate_observations ORDER BY content_hash`
            yield* observationWindowIndex
            yield* entryWindowIndex
            expect([...(yield* readWindows)]).toEqual(expected)
            expect(yield* sql`SELECT * FROM intraday_candidate_observations ORDER BY content_hash`).toEqual(original)
            yield* sql`ANALYZE intraday_candidate_observations`
            yield* sql`SET LOCAL enable_seqscan=off`
            const plan = yield* sql`EXPLAIN (ANALYZE,FORMAT JSON)
              ${latestJevObservationWindowQuery(sql, { cycleId, purpose: JevPurpose.Entry })}`
            const actual = JSON.stringify(plan)
            expect(actual).toContain('intraday_candidate_observations_jev_entry_window')
            expect(actual).toContain('"Node Type":"Limit"')
            expect(actual).not.toContain('"Node Type":"Sort"')
            expect(actual).toContain('cycle_id = ANY')
          }),
        )
      }),
    )
  })
})
