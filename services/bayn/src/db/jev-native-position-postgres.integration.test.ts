import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Cause, Clock, Effect, Exit, Layer, Logger, Option, References, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { makeSimulatedExecutionClock } from '../intraday-replay/clock'
import { makeReplayAdmissionClock } from '../intraday-replay/admission-clock'
import { currentUtcInstant } from '../time'
import { sourceTimestamp } from '../broker/observations'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { CycleStore } from '../cycle/store/model'
import { Authority } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { JevClient } from '../jev/client'
import { JevPositionStore, JevPurpose } from '../jev/portfolio'
import { IntentStore } from '../execution/intents/domain'
import { WriterFence, WriterFenceError } from '../execution/writer-fence'
import { IntentStoreLive } from '../execution/intents/postgres'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { ExecutionCycleClosureStore } from './execution-cycle-closure'
import type { IntradayMarketDataService } from '../market-data/intraday/model'
import { nativeJevInference } from '../jev/native.test-support'
import { evaluateJevObservation, evaluateJevPositionManagement } from '../jev/runtime'
import { JevExitReason, jevProfitTargetLimitFloors } from '../jev/exit'
import { decodeJevProtocol, jevBehaviorHash, defaultJevProtocolDocument } from '../jev/protocol'
import { makeStrategyProtocolHashResult } from '../contracts'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { verifyJevPortfolioSources } from './jev-position-postgres'
import {
  describeNativeJevPostgres,
  replayAccountId,
  fixture,
  atObservation,
  nativeInput,
  seedManagedPosition,
} from './jev-native-postgres.test-support'

setDefaultTimeout(30_000)

describeNativeJevPostgres((postgres) => {
  test('native broker terms persist only when they match the immutable pre-entry strategy plan', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { portfolio } = yield* seedManagedPosition({ nativeProtection: 'strategy' })
        const sql = yield* PgClient.PgClient
        const [row] = yield* sql<{
          protection: { stopPriceMicros: string; profitLimitPriceMicros: string }
        }>`SELECT protection FROM intents WHERE intent_id = ${portfolio.entryIntentIds[0]}`
        expect(row?.protection.stopPriceMicros).toBe(portfolio.exitPolicy.plans['AAPL']?.levels.stopPriceMicros)
        expect(row?.protection.profitLimitPriceMicros).toBe(
          portfolio.exitPolicy.plans['AAPL']?.levels.profitLimitPriceMicros,
        )
      }),
    )
  })

  test('a one-micro substitution of the strategy stop is rejected at durable intent insertion', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const attempted = yield* seedManagedPosition({ nativeProtection: 'tampered' }).pipe(Effect.exit)
        if (Exit.isSuccess(attempted)) throw new Error('Tampered strategy stop was accepted')
        expect(Cause.pretty(attempted.cause)).toContain(
          'native protection must bind the immutable pre-entry strategy plan',
        )
      }),
    )
  })

  test.each([
    { reason: JevExitReason.ProfitTarget, delayMs: 0, measuredSql: false },
    { reason: JevExitReason.ProtectiveStop, delayMs: 0, measuredSql: false },
    { reason: JevExitReason.ProfitTarget, delayMs: 500, measuredSql: false },
    { reason: JevExitReason.ProfitTarget, delayMs: 15_000, measuredSql: false },
    { reason: JevExitReason.ProfitTarget, delayMs: 50, measuredSql: true },
    { reason: JevExitReason.ProfitTarget, delayMs: 15_000, measuredSql: true },
  ])(
    'protection cancellation retains its original cause through durable recovery: %j',
    async ({ reason, delayMs, measuredSql }) => {
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const { portfolio, managed } = yield* seedManagedPosition({ nativeProtection: 'strategy' })
          const cycle = Option.getOrThrow(yield* (yield* CycleStore).read(nativeInput.cycleId))
          const input = {
            cycle,
            entryDecisionHash: portfolio.entryDecisionHash,
            authorityGenerationHash: nativeInput.authorityGenerationHash,
            protocol: fixture.protocol,
            calendar: managed.snapshot.manifest.calendar,
            brokerState: portfolio.brokerState,
            marketData: {
              check: Effect.void,
              verifyReference: fixtureStreamingReference,
              loadSnapshot: (query: Parameters<IntradayMarketDataService['loadSnapshot']>[0]) =>
                Effect.succeed(
                  streamingFixtureFromRaw(
                    makeIntradayMomentumTestSnapshot(
                      fixture.protocol,
                      { ...query, archiveWatermarks: [] },
                      { AAPL: reason === JevExitReason.ProfitTarget ? 0.08 : -0.02 },
                    ),
                    query,
                  ).snapshot,
                ),
            },
          }
          const management = yield* evaluateJevPositionManagement(input)
          if (management._tag !== 'Exit') throw new Error('Expected verified exit trigger')
          expect(management.target.reason).toBe(reason)
          const intentId = portfolio.entryIntentIds[0]
          const levels = portfolio.exitPolicy.plans['AAPL']?.levels
          if (intentId === undefined || levels === undefined) throw new Error('Expected immutable protection')
          const sql = yield* PgClient.PgClient
          const eventId = '7'.repeat(64)
          const brokerOrderId = 'protective-child'
          const observedAt = management.target.observedAt
          const providerUpdatedAt = Result.getOrThrow(sourceTimestamp(observedAt))
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
          source_event_id,source_sequence,occurred_at,observed_at)
          VALUES(${eventId},'bayn.paper-broker-event.v1',${eventId},'ORDER','ALPACA',${replayAccountId},
            ${`order:${brokerOrderId}:${providerUpdatedAt}`},100,${observedAt},${observedAt})`
              yield* sql`INSERT INTO orders(event_id,account_id,schema_version,broker_order_id,client_order_id,intent_id,
          symbol,side,order_type,time_in_force,quantity_atoms,filled_quantity_atoms,limit_price_micros,stop_price_micros,status,
          broker_updated_at)
          VALUES(${eventId},${replayAccountId},'bayn.order.v3',${brokerOrderId},'protective-child-client',${intentId},
            'AAPL','SELL','STOP_LIMIT','DAY',5000000000,0,${levels.stopLimitPriceMicros},${levels.stopPriceMicros},'NEW',
            ${providerUpdatedAt})`
            }),
          )
          const store = yield* IntentStore
          if (delayMs > 0) {
            const fence = yield* WriterFence
            const simulation = measuredSql
              ? yield* makeSimulatedExecutionClock(
                  'e'.repeat(64),
                  'e'.repeat(64),
                  yield* TestClock.withLive(Clock.clockWith(Effect.succeed)),
                )
              : undefined
            const delayedStore = yield* IntentStore.pipe(
              Effect.provide(
                IntentStoreLive.pipe(
                  Layer.provide(
                    Layer.succeed(WriterFence, {
                      check: fence.check,
                      transaction: (effect, finalize) =>
                        fence.transaction(
                          Effect.gen(function* () {
                            if (measuredSql) {
                              if (delayMs >= fixture.protocol.maximumQuoteAgeMs)
                                yield* sql`UPDATE simulated_execution_clocks
                                SET measured_observed_at=${new Date(Date.parse(management.target.commitDeadlineAt) - 50).toISOString()},
                                  measured_at=clock_timestamp() WHERE account_id=${replayAccountId}`
                              const marketAt = yield* Clock.currentTimeMillis
                              yield* sql`SELECT pg_sleep(${delayMs >= fixture.protocol.maximumQuoteAgeMs ? 0.08 : delayMs / 1000})`
                              expect(yield* Clock.currentTimeMillis).toBe(marketAt)
                            } else {
                              yield* TestClock.adjust(delayMs)
                              yield* sql`UPDATE simulated_execution_clocks
                              SET observed_at=${yield* currentUtcInstant}::timestamptz WHERE account_id=${replayAccountId}`
                            }
                          }).pipe(
                            Effect.mapError(
                              (cause) =>
                                new WriterFenceError({
                                  failure: 'unavailable',
                                  operation: 'transaction',
                                  message: 'Fixture clock preparation failed',
                                  cause,
                                }),
                            ),
                            Effect.andThen(effect),
                          ),
                          finalize,
                        ),
                    }),
                  ),
                  Layer.provide(Layer.succeed(PgClient.PgClient, sql)),
                  Layer.fresh,
                ),
              ),
            )
            const admitted = yield* simulation === undefined
              ? delayedStore.beginProtectionCancel(intentId, brokerOrderId, observedAt, management.target)
              : simulation.measure(
                  Effect.gen(function* () {
                    const replay = yield* makeReplayAdmissionClock(simulation)
                    const admitted = yield* replay
                      .intents(delayedStore)
                      .beginProtectionCancel(intentId, brokerOrderId, observedAt, management.target)
                    if (admitted._tag !== 'New') return admitted
                    const responseAt = yield* currentUtcInstant
                    expect(Date.parse(admitted.command.requestedAt)).toBeGreaterThanOrEqual(Date.parse(observedAt) + 50)
                    expect(Date.parse(responseAt)).toBeGreaterThanOrEqual(Date.parse(admitted.command.requestedAt))
                    expect(
                      yield* sql`SELECT requested_at=${admitted.command.requestedAt}::timestamptz AS exact,
                      requested_at=date_trunc('milliseconds',requested_at) AS milliseconds
                      FROM native_protection_cancel_commands WHERE intent_id=${intentId}`,
                    ).toEqual([{ exact: true, milliseconds: true }])
                    const receipt = {
                      brokerOrderId,
                      requestHash: Result.getOrThrow(
                        canonicalHashV1Result({ operation: MutationOperation.Cancel, brokerOrderId }),
                      ),
                      evidence: {
                        requestId: 'measured-native-protection-cancel',
                        status: 204,
                        contentHash: Result.getOrThrow(canonicalHashV1Result(null)),
                        observedAt: responseAt,
                      },
                    }
                    expect((yield* store.recordProtectionCancelAccepted(admitted.command, receipt))._tag).toBe(
                      'Accepted',
                    )
                    expect((yield* store.recordProtectionCancelAccepted(admitted.command, receipt))._tag).toBe(
                      'Accepted',
                    )
                    return admitted
                  }),
                )
            if (delayMs >= fixture.protocol.maximumQuoteAgeMs) {
              expect(admitted._tag).toBe('NotEligible')
              expect(yield* sql`SELECT count(*)::int AS count FROM native_protection_cancel_commands`).toEqual([
                { count: 0 },
              ])
            } else {
              expect(admitted._tag).toBe('New')
              if (admitted._tag !== 'New') throw new Error('Expected delayed native cancellation admission')
              if (!measuredSql)
                expect(admitted.command.requestedAt).toBe(new Date(Date.parse(observedAt) + delayMs).toISOString())
              expect(
                yield* sql`SELECT exit_target FROM native_protection_cancel_commands WHERE intent_id = ${intentId}`,
              ).toEqual([{ exit_target: management.target }])
              expect(
                (yield* store.beginProtectionCancel(intentId, brokerOrderId, observedAt, management.target))._tag,
              ).toBe(measuredSql ? 'Accepted' : 'PendingUnknown')
              expect(yield* sql`SELECT count(*)::int AS count FROM native_protection_cancel_commands`).toEqual([
                { count: 1 },
              ])
            }
            return
          }
          expect(
            (yield* store.beginProtectionCancel(intentId, brokerOrderId, observedAt, {
              ...management.target,
              entryDecisionHash: '9'.repeat(64),
            }))._tag,
          ).toBe('NotEligible')
          const started = yield* store.beginProtectionCancel(intentId, brokerOrderId, observedAt, management.target)
          expect(started._tag).toBe('New')
          if (started._tag !== 'New') throw new Error('Expected a new native protection cancellation command')
          const pendingBeforeFreshObservation = yield* store.beginProtectionCancel(
            intentId,
            brokerOrderId,
            observedAt,
            management.target,
          )
          expect(pendingBeforeFreshObservation._tag).toBe('PendingUnknown')
          const pendingBeforeFiveSecondWindowExpires = yield* store.beginProtectionCancel(
            intentId,
            brokerOrderId,
            new Date(Date.parse(observedAt) + 1_000).toISOString(),
            management.target,
          )
          expect(pendingBeforeFiveSecondWindowExpires._tag).toBe('PendingUnknown')
          const [{ pendingCommandCount }] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ pendingCommandCount: Schema.Number })]),
          )(
            yield* sql`SELECT count(*)::int AS "pendingCommandCount"
              FROM native_protection_cancel_commands
              WHERE intent_id = ${intentId} AND broker_order_id = ${brokerOrderId}`,
          )
          expect(pendingCommandCount).toBe(1)

          const requestHash = Result.getOrThrow(
            canonicalHashV1Result({ operation: MutationOperation.Cancel, brokerOrderId }),
          )
          const contentHash = Result.getOrThrow(canonicalHashV1Result(null))
          const validReceipt = {
            requestHash,
            brokerOrderId,
            evidence: {
              requestId: 'native-protection-cancel-receipt',
              status: 204,
              contentHash,
              observedAt,
            },
          }
          const invalidReceipts = [
            ['broker order', { ...validReceipt, brokerOrderId: 'different-protective-order' }],
            ['request hash', { ...validReceipt, requestHash: '0'.repeat(64) }],
            ['status', { ...validReceipt, evidence: { ...validReceipt.evidence, status: 200 } }],
            [
              'observed time',
              {
                ...validReceipt,
                evidence: {
                  ...validReceipt.evidence,
                  observedAt: new Date(Date.parse(observedAt) - 1_000).toISOString(),
                },
              },
            ],
          ] as const
          for (const [label, invalidReceipt] of invalidReceipts) {
            const attempted = yield* store
              .recordProtectionCancelAccepted(started.command, invalidReceipt)
              .pipe(Effect.exit)
            if (Exit.isSuccess(attempted)) throw new Error(`Invalid ${label} receipt was accepted`)
            expect(Cause.pretty(attempted.cause)).toContain('native protection cancel')
          }
          const accepted = yield* store.recordProtectionCancelAccepted(started.command, validReceipt)
          expect(accepted._tag).toBe('Accepted')
          const duplicate = yield* store.recordProtectionCancelAccepted(started.command, validReceipt)
          expect(duplicate._tag).toBe('Accepted')
          const conflicting = yield* store
            .recordProtectionCancelAccepted(started.command, {
              ...validReceipt,
              evidence: { ...validReceipt.evidence, requestId: 'conflicting-native-protection-cancel-receipt' },
            })
            .pipe(Effect.exit)
          if (Exit.isSuccess(conflicting)) throw new Error('Conflicting native protection receipt was accepted')
          expect(Cause.pretty(conflicting.cause)).toContain('conflicts')
          expect(
            Result.isFailure(
              yield* sql`UPDATE native_protection_cancel_receipts
                SET request_id = 'mutated-native-protection-cancel-receipt'
                WHERE intent_id = ${intentId} AND broker_order_id = ${brokerOrderId}`.pipe(Effect.result),
            ),
          ).toBe(true)
          expect(
            Result.isFailure(
              yield* sql`DELETE FROM native_protection_cancel_receipts
                WHERE intent_id = ${intentId} AND broker_order_id = ${brokerOrderId}`.pipe(Effect.result),
            ),
          ).toBe(true)
          expect(
            (yield* store.beginProtectionCancel(intentId, brokerOrderId, observedAt, management.target))._tag,
          ).toBe('Accepted')
          const [{ count }] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ count: Schema.Number })]),
          )(
            yield* sql`SELECT count(*)::int AS count FROM native_protection_cancel_commands WHERE exit_target = ${JSON.stringify(management.target)}::jsonb`,
          )
          expect(count).toBe(1)
          const [{ receiptCount }] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ receiptCount: Schema.Number })]),
          )(
            yield* sql`SELECT count(*)::int AS "receiptCount"
              FROM native_protection_cancel_receipts
              WHERE intent_id = ${intentId} AND broker_order_id = ${brokerOrderId}`,
          )
          expect(receiptCount).toBe(1)
          const sameCut = yield* (yield* JevPositionStore).read({
            cycleId: cycle.identity.cycleId,
            entryDecisionHash: portfolio.entryDecisionHash,
            brokerState: portfolio.brokerState,
          })
          const originalPortfolio = management.target.evidence.portfolio
          if (originalPortfolio.purpose !== JevPurpose.Manage) throw new Error('Expected original held-position proof')
          expect(sameCut).toEqual(originalPortfolio)
          expect(sameCut.exitRequestedAt).toBeNull()
          yield* verifyJevPortfolioSources(sql, cycle.identity.cycleId, originalPortfolio)
          const refreshedAt = new Date(Date.parse(observedAt) + 1).toISOString()
          yield* TestClock.setTime(Date.parse(refreshedAt))
          const freshMaterial = {
            ...portfolio.brokerState,
            account: { ...portfolio.brokerState.account, observedAt: refreshedAt },
            positions: portfolio.brokerState.positions.map((position) => ({ ...position, observedAt: refreshedAt })),
            orders: portfolio.brokerState.orders.map((order) => ({ ...order, observedAt: refreshedAt })),
            positionsObservedAt: refreshedAt,
            ordersObservedAt: refreshedAt,
          }
          const freshHash = Result.getOrThrow(reconciledStateHash(freshMaterial))
          const freshReconciliation = {
            ...freshMaterial.reconciliation,
            reconciliationId: '6'.repeat(64),
            expectedHash: freshHash,
            observedHash: freshHash,
            contentHash: Result.getOrThrow(canonicalHashV1Result(freshMaterial)),
            reconciledAt: refreshedAt,
          }
          yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,
          content_hash,status,discrepancies,reconciled_at) VALUES (${freshReconciliation.reconciliationId},
          ${freshReconciliation.schemaVersion},${replayAccountId},${freshHash},${freshHash},
          ${freshReconciliation.contentHash},'EXACT','[]'::jsonb,${refreshedAt})`
          const freshState = { ...freshMaterial, reconciliation: freshReconciliation }
          const recovered = yield* (yield* JevPositionStore).read({
            cycleId: cycle.identity.cycleId,
            entryDecisionHash: portfolio.entryDecisionHash,
            brokerState: freshState,
          })
          expect(recovered.exitRequestedAt).toBe(observedAt)
          expect(recovered.profitExitRequested).toBe(reason === JevExitReason.ProfitTarget)
          const resumed = yield* evaluateJevPositionManagement({ ...input, brokerState: freshState })
          if (resumed._tag !== 'Exit') throw new Error('Expected durable exit recovery')
          expect(resumed.target.reason).toBe(JevExitReason.ProtectionReleased)
          const floors = Result.getOrThrow(
            jevProfitTargetLimitFloors(resumed.target, observedAt, [
              { symbol: 'AAPL', referencePriceMicros: String(BigInt(levels.profitLimitPriceMicros) - 10_000n) },
            ]),
          )
          expect(floors).toEqual(
            reason === JevExitReason.ProfitTarget ? { AAPL: BigInt(levels.profitLimitPriceMicros) } : {},
          )
        }).pipe(atObservation),
      )
    },
  )

  test('close intent classification is restricted to the persisted intent and its owning cycle', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* ExecutionCycleClosureStore
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE intents (intent_id text PRIMARY KEY, cycle_id text NOT NULL) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycle_paper_closures
              (cycle_id text PRIMARY KEY, document jsonb NOT NULL) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycle_paper_close_replans
              (cycle_id text NOT NULL, document jsonb NOT NULL) ON COMMIT DROP`
            yield* sql`INSERT INTO intents (intent_id, cycle_id) VALUES
              ('entry', 'active'), ('close', 'active'), ('replan', 'active'), ('unrelated', 'other')`
            yield* sql`INSERT INTO autonomous_cycle_paper_closures (cycle_id, document) VALUES
              ('active', '{"document":{"orderedIntentIds":["close"]}}'),
              ('retained', '{"document":{"orderedIntentIds":["entry","unrelated","unpersisted"]}}')`
            yield* sql`INSERT INTO autonomous_cycle_paper_close_replans (cycle_id, document) VALUES
              ('active', '{"document":{"orderedIntentIds":["replan"]}}')`

            expect(yield* store.containsIntent('entry')).toBe(false)
            expect(yield* store.containsIntent('close')).toBe(true)
            expect(yield* store.containsIntent('replan')).toBe(true)
            expect(yield* store.containsIntent('unrelated')).toBe(false)
            expect(yield* store.containsIntent('unpersisted')).toBe(false)
          }),
        )
      }),
    )
  })

  test('v3 authority history preserves strategy pairing and append-only constraints', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
        const parameterHash = Result.getOrThrow(canonicalHashV1Result(protocol))
        const strategyProtocolHash = Result.getOrThrow(
          makeStrategyProtocolHashResult({
            name: 'jev',
            behaviorHash: jevBehaviorHash,
            parameterHash,
            parameterSchemaVersion: protocol.schemaVersion,
          }),
        )
        const r = fixture.portfolio.brokerState.reconciliation
        const insert = (
          strategy: string,
          generationHash: string,
          version: number,
          schemaVersion: string = protocol.schemaVersion,
        ) => sql`
        INSERT INTO authority_generations (
          generation_hash, schema_version, activation_schema_version, previous_generation_hash,
          maximum, authority_version, activation_source_revision, activation_image_repository,
          activation_image_digest, strategy_name, strategy_behavior_hash, strategy_parameter_hash,
          strategy_parameter_schema_version, strategy_protocol_hash, account_id,
          broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
          risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
          research_plan_hash, activated_at
        ) VALUES (
          ${generationHash}, 'bayn.authority-generation-history.v1', 'bayn.paper-authority-generation.v3',
          ${nativeInput.authorityGenerationHash}, ${Authority.Execution}, ${version}, ${'3'.repeat(40)}, 'registry.example.test/lab/bayn',
          ${`sha256:${'4'.repeat(64)}`}, ${strategy}, ${jevBehaviorHash}, ${parameterHash},
          ${schemaVersion}, ${strategyProtocolHash}, ${replayAccountId},
          'bayn.broker-identity.v2', ${'8'.repeat(64)}, 'alpaca', 'sandbox', ${'9'.repeat(64)},
          ${'9'.repeat(64)}, ${r.reconciliationId}, ${r.contentHash}, ${'b'.repeat(64)}, ${fixture.observation.payload.observedAt}
        )`
        expect(Result.isFailure(yield* insert('intraday-momentum', '8'.repeat(64), 2).pipe(Effect.result))).toBe(true)
        yield* insert('jev', '9'.repeat(64), 2)
        expect(
          Result.isFailure(yield* insert('jev', '7'.repeat(64), 3, 'bayn.jev.protocol.v24').pipe(Effect.result)),
        ).toBe(true)
        expect(
          yield* sql`SELECT strategy_parameter_schema_version FROM authority_generations WHERE generation_hash = ${'9'.repeat(64)}`,
        ).toEqual([{ strategy_parameter_schema_version: protocol.schemaVersion }])
        expect(
          Result.isFailure(
            yield* sql`UPDATE authority_generations SET strategy_parameter_schema_version = 'bayn.jev.protocol.v1' WHERE generation_hash = ${'9'.repeat(64)}`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(yield* sql`SELECT count(*)::int AS count FROM authority_state`).toEqual([{ count: 0 }])
      }),
    )
  })

  test.each([JevExitReason.MaximumHold, JevExitReason.ProtectiveStop])(
    'deterministic %s exits do not call Jev',
    async (reason) => {
      const diagnostics: Readonly<Record<string, unknown>>[] = []
      const logger = Logger.make(({ fiber }) => {
        const annotations = fiber.getRef(References.CurrentLogAnnotations)
        if (annotations['schemaVersion'] === 'bayn.jev-protective-quote-diagnostics.v1') diagnostics.push(annotations)
      })
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const { portfolio, managed } = yield* seedManagedPosition(
            reason === JevExitReason.MaximumHold ? { heldMinutes: 15 } : {},
          )
          const cycle = Option.getOrThrow(yield* (yield* CycleStore).read(nativeInput.cycleId))
          const target = yield* evaluateJevPositionManagement({
            cycle,
            entryDecisionHash: portfolio.entryDecisionHash,
            authorityGenerationHash: nativeInput.authorityGenerationHash,
            protocol: fixture.protocol,
            calendar: managed.snapshot.manifest.calendar,
            brokerState: portfolio.brokerState,
            marketData: {
              check: Effect.void,
              verifyReference: fixtureStreamingReference,
              loadSnapshot: (query) =>
                reason === JevExitReason.MaximumHold
                  ? Effect.die('Holding limit unexpectedly read market history')
                  : Effect.succeed(
                      streamingFixtureFromRaw(
                        makeIntradayMomentumTestSnapshot(
                          fixture.protocol,
                          { ...query, archiveWatermarks: [] },
                          { AAPL: -0.02 },
                        ),
                        query,
                      ).snapshot,
                    ),
            },
          })
          expect(target).toMatchObject({ _tag: 'Exit', target: { reason } })
        }).pipe(
          Effect.provideService(
            JevClient,
            entryProviderFixture({
              evaluate: () => Effect.die('Deterministic exit unexpectedly called Jev'),
            }),
          ),
          atObservation,
          Effect.provide(Logger.layer([logger])),
        ),
      )
      if (reason === JevExitReason.ProtectiveStop) {
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]).toMatchObject({
          referenceScope: 'IEX_EXCHANGE_ONLY_NOT_NBBO',
          feed: 'iex',
          pairedFeedComparisonAvailable: false,
          entrySpreadLimitBps: fixture.protocol.marketProfiles[0]?.maximumEntrySpreadBps,
        })
        expect(diagnostics[0]).not.toHaveProperty('bidPrice')
        expect(diagnostics[0]).not.toHaveProperty('askPrice')
        expect(diagnostics[0]).not.toHaveProperty('accountId')
      } else expect(diagnostics).toHaveLength(0)
    },
  )

  test('native held-position protection rechecks quotes without model observations', async () => {
    let calls = 0
    let signalReads = 0
    let protectiveReads = 0
    let adverseQuote = false
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { portfolio, managed } = yield* seedManagedPosition()
        const cycle = Option.getOrThrow(yield* (yield* CycleStore).read(nativeInput.cycleId))
        const input = {
          cycle,
          entryDecisionHash: portfolio.entryDecisionHash,
          authorityGenerationHash: nativeInput.authorityGenerationHash,
          protocol: fixture.protocol,
          calendar: managed.snapshot.manifest.calendar,
          brokerState: portfolio.brokerState,
          marketData: {
            check: Effect.void,
            verifyReference: fixtureStreamingReference,
            loadSnapshot: (query: Parameters<IntradayMarketDataService['loadSnapshot']>[0]) =>
              Effect.sync(() => {
                if (query.purpose === undefined) {
                  signalReads += 1
                  return managed.snapshot
                }
                protectiveReads += 1
                return streamingFixtureFromRaw(
                  makeIntradayMomentumTestSnapshot(
                    fixture.protocol,
                    { ...query, archiveWatermarks: [] },
                    { AAPL: adverseQuote ? -0.02 : 0.002 },
                  ),
                  query,
                ).snapshot
              }),
          },
        }
        expect(yield* evaluateJevPositionManagement(input)).toMatchObject({
          _tag: 'Wait',
          details: { waitReason: 'JEV_POSITION_HELD' },
        })
        expect(yield* evaluateJevPositionManagement(input)).toMatchObject({
          _tag: 'Wait',
          details: { waitReason: 'JEV_POSITION_HELD' },
        })
        expect(calls).toBe(0)
        expect(signalReads).toBe(0)
        expect(protectiveReads).toBe(2)
        adverseQuote = true
        expect(yield* evaluateJevPositionManagement(input)).toMatchObject({
          _tag: 'Exit',
          target: { reason: JevExitReason.ProtectiveStop },
        })
        expect(calls).toBe(0)
        expect(signalReads).toBe(0)
        expect(protectiveReads).toBe(3)
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request) =>
              Effect.sync(() => {
                calls += 1
                return nativeJevInference(request, fixture.observation.payload.observedAt, false)
              }),
          }),
        ),
        atObservation,
      ),
    )
  })

  test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'])(
    'loads the exact net %s position only with posted inventory debit evidence',
    async (symbol) => {
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const { portfolio } = yield* seedManagedPosition({ symbol, heldMinutes: 20 })
          const sql = yield* PgClient.PgClient
          const at = portfolio.brokerState.reconciliation.reconciledAt
          const state = {
            ...portfolio.brokerState,
            positions: portfolio.brokerState.positions.map((position) => ({
              ...position,
              quantityAtoms: '4987500000',
              costBasisMicros: '498750000',
            })),
          }
          const hash = Result.getOrThrow(reconciledStateHash(state))
          const r = {
            ...state.reconciliation,
            reconciliationId: '8'.repeat(64),
            expectedHash: hash,
            observedHash: hash,
          }
          yield* sql`INSERT INTO reconciliations (reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
        VALUES (${r.reconciliationId},${r.schemaVersion},${r.accountId},${hash},${hash},${r.contentHash},'EXACT','[]'::jsonb,${at})`
          const brokerState = { ...state, reconciliation: r }
          const store = yield* JevPositionStore
          const input = { cycleId: nativeInput.cycleId, entryDecisionHash: portfolio.entryDecisionHash, brokerState }
          expect(Result.isFailure(yield* store.read(input).pipe(Effect.result))).toBeTrue()
          const fee = {
            accountId: r.accountId,
            activityId: 'native-coin-fee',
            date: at.slice(0, 10),
            netAmountMicros: '0',
            coinDebit: { symbol, quantityAtoms: '12500000', priceAtoms: '100000000000' },
          }
          yield* sql`INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,data,read_evidence,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at,posted_at,coin_cost_basis_micros)
        VALUES (${r.accountId},${fee.activityId},${fee.date},0,${sql.json(fee)},'{}'::jsonb,${'9'.repeat(64)},${'9'.repeat(64)},1,1,${at},${at},1250000)`
          const actual = yield* store.read(input)
          expect(actual.entryFills).toEqual(portfolio.entryFills)
          expect(actual.entryInventoryDebit).toEqual({ quantityAtoms: '12500000', costBasisMicros: '1250000' })
          expect(actual.brokerState.positions[0]?.quantityAtoms).toBe('4987500000')
        }),
      )
    },
  )

  test.each([{ omitReceipt: true }, { receiptAt: '2026-09-04T14:31:00.000Z' }])(
    'rejects management when accounting was incomplete at reconciliation (%j)',
    async (options) => {
      let calls = 0
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const { managed, portfolio } = yield* seedManagedPosition(options)
          const result = yield* (yield* JevPositionStore)
            .read({
              cycleId: nativeInput.cycleId,
              entryDecisionHash: portfolio.entryDecisionHash,
              brokerState: portfolio.brokerState,
            })
            .pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure.cause).toMatchObject({ _tag: 'SchemaError' })
          const evaluation = yield* evaluateJevObservation({
            ...nativeInput,
            portfolio,
            snapshot: managed.snapshot,
          }).pipe(Effect.result)
          expect(Result.isFailure(evaluation)).toBe(true)
          expect(calls).toBe(0)
        }).pipe(
          Effect.provideService(
            JevClient,
            entryProviderFixture({
              evaluate: (request) =>
                Effect.sync(() => {
                  calls += 1
                  return nativeJevInference(request, fixture.observation.payload.observedAt, false)
                }),
            }),
          ),
          atObservation,
        ),
      )
    },
  )

  test('rejects a different entry decision and a fabricated reconciliation identifier', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { portfolio } = yield* seedManagedPosition()
        const store = yield* JevPositionStore
        for (const input of [
          { cycleId: nativeInput.cycleId, entryDecisionHash: '0'.repeat(64), brokerState: portfolio.brokerState },
          {
            cycleId: nativeInput.cycleId,
            entryDecisionHash: portfolio.entryDecisionHash,
            brokerState: {
              ...portfolio.brokerState,
              reconciliation: { ...portfolio.brokerState.reconciliation, reconciliationId: '0'.repeat(64) },
            },
          },
        ])
          expect(Result.isFailure(yield* store.read(input).pipe(Effect.result))).toBe(true)
      }),
    )
  })
})
