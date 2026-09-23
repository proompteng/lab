import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayJevTiming, type ReplayJevCall } from '../intraday-replay/jev-timing'
import { makeSimulatedExecutionClock } from '../intraday-replay/clock'
import { utcInstantFromEpochMillis } from '../time'
import { NodeServices } from '@effect/platform-node'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca'
import { CycleStore, CycleStoreLive } from '../cycle/store'
import { Authority, KillState, OrderSide } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { JevBatchPlanVersion, JevEntryExclusion } from '../jev/batch'
import { decideJevEntry, decideJevManagement, JevManagementAction } from '../jev/decision'
import { JevBatchStore, recoverPendingJevBatches } from '../jev/batch-evaluation'
import { JevClient, JevError } from '../jev/client'
import { JevFailure } from '../jev/contract'
import { decodeJevPortfolio, JevPositionStore, JevPurpose } from '../jev/portfolio'
import { clientOrderIdForIntentId } from '../execution/intents/domain'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { IntentStoreLive } from '../execution/intents'
import { MutationStoreLive } from '../execution/mutations'
import { ensureExecutionCycleClosure } from '../observe-composition/execution-cycle'
import { reconciledStateHash } from '../reconciliation'
import { makeExecutionCycleClosure, ExecutionCycleClosureStore } from './execution-cycle-closure'
import type { IntradayMarketDataService } from '../market-data'
import { ExecutionCycleClosureStoreLive } from './execution-cycle-closure-postgres'
import { nativeJevFixture as fixtureForAccount, nativeJevInference } from '../jev/native.test-support'
import { evaluateJevObservation, evaluateJevPositionManagement } from '../jev/runtime'
import { JevExitReason } from '../jev/exit'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import {
  buildMutationShadowCycleDecision,
  loadExecutionRiskPolicy,
  prepareClosingExecutionCycleDecision,
} from '../observe-composition/decision-builder'
import type { ReconciliationPassResult } from '../reconciler'
import { ExecutionDecisionDocumentSchema, type ExecutionDecisionDocument } from '../shadow-decision-contract'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { JevPositionStoreLive } from './jev-position-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const replayAccountId = `replay-${'e'.repeat(64)}`
const nativeJevFixture = (purpose: JevPurpose = JevPurpose.Entry, observedAt?: string) =>
  fixtureForAccount(purpose, observedAt, replayAccountId)
const fixture = nativeJevFixture()
const observed = Date.parse(fixture.observation.payload.observedAt)
const atObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(observed).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer()))
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(
      CycleStoreLive,
      CandidateObservationStoreLive,
      JevBatchStoreLive,
      JevPositionStoreLive,
      ExecutionCycleClosureStoreLive,
      IntentStoreLive,
      MutationStoreLive,
    ).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(JevEvaluationStoreLive),
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5000,
          postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )
const nativeInput = {
  cycleId: fixture.draft.identity.cycleId,
  authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
  protocol: fixture.protocol,
  portfolio: fixture.portfolio,
  snapshot: fixture.snapshot,
}

const seedManagedPosition = (
  options: {
    readonly omitReceipt?: boolean
    readonly receiptAt?: string
    readonly observedAt?: string
    readonly entryDocument?: ExecutionDecisionDocument
    readonly heldMinutes?: number
  } = {},
) =>
  Effect.gen(function* () {
    const managed = nativeJevFixture(JevPurpose.Manage, options.observedAt)
    let portfolio = managed.portfolio
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected management fixture')
    const heldMinutes = options.heldMinutes
    if (heldMinutes !== undefined)
      portfolio = {
        ...portfolio,
        entryFills: portfolio.entryFills.map((fill) => ({
          ...fill,
          occurredAt: new Date(Date.parse(managed.observation.payload.observedAt) - heldMinutes * 60_000).toISOString(),
        })),
      }
    if (options.entryDocument !== undefined) {
      const entryId = options.entryDocument.orderedIntentIds[0]
      if (entryId === undefined) throw new Error('Expected an entry intent')
      const clientId = clientOrderIdForIntentId(entryId)
      const state = {
        ...portfolio.brokerState,
        orders: portfolio.brokerState.orders.map((order) => ({ ...order, intentId: entryId, clientOrderId: clientId })),
      }
      const hash = Result.getOrThrow(reconciledStateHash(state))
      portfolio = Result.getOrThrow(
        decodeJevPortfolio({
          ...portfolio,
          entryDecisionHash: options.entryDocument.contentHash,
          entryIntentIds: [entryId],
          entryFills: portfolio.entryFills.map((fill) => ({ ...fill, intentId: entryId, clientOrderId: clientId })),
          brokerState: {
            ...state,
            reconciliation: { ...state.reconciliation, expectedHash: hash, observedHash: hash },
          },
        }),
      )
    }
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected management fixture')
    const sql = yield* PgClient.PgClient
    const r = portfolio.brokerState.reconciliation
    const entryAt =
      options.entryDocument?.createdAt ??
      new Date(Date.parse(portfolio.entryFills[0]?.occurredAt ?? '') - 60_000).toISOString()
    const document = options.entryDocument ?? {
      schemaVersion: 'bayn.paper-cycle-decision.v1',
      mode: 'PAPER',
      dispatchable: true,
      contentHash: portfolio.entryDecisionHash,
      createdAt: entryAt,
      bindings: {
        cycleId: nativeInput.cycleId,
        accountId: r.accountId,
        strategyDecisionHash: '2'.repeat(64),
        authorityGenerationHash: nativeInput.authorityGenerationHash,
      },
      strategyDecision: { schemaVersion: 'bayn.jev-entry-target.v1' },
      orderedIntentIds: portfolio.entryIntentIds,
    }
    if (options.entryDocument === undefined) yield* (yield* CycleStore).activate(nativeInput.cycleId, entryAt)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO autonomous_cycle_shadow_decisions (cycle_id, schema_version, document, created_at)
        VALUES (${nativeInput.cycleId}, ${document.schemaVersion}, ${sql.json(document)}, ${entryAt})`
        yield* sql`UPDATE autonomous_cycles SET snapshot_id = ${options.entryDocument?.bindings.snapshotId ?? managed.snapshot.manifest.snapshotId},
        decision_hash = ${portfolio.entryDecisionHash}, state_version = state_version + 1,
        updated_at = ${entryAt} WHERE cycle_id = ${nativeInput.cycleId}`
      }),
    )
    const managedReconciliationId = '1'.repeat(64)
    const brokerState = {
      ...portfolio.brokerState,
      reconciliation: { ...r, reconciliationId: managedReconciliationId },
    }
    yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
      content_hash, status, discrepancies, reconciled_at) VALUES (${managedReconciliationId}, ${r.schemaVersion}, ${r.accountId},
      ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
    for (const intentId of portfolio.entryIntentIds) {
      yield* sql`INSERT INTO intents (intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
        time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at, cycle_id,
        strategy_name, decision_hash, policy_hash, authority_generation_hash)
        VALUES (${intentId}, 'bayn.paper-intent.v3', ${r.accountId}, ${portfolio.entryFills[0]?.clientOrderId ?? 'entry-client'}, 'AAPL', 'BUY', 'LIMIT', 'IOC',
        '10000000', '1000000000', 'PLANNED', ${entryAt}, ${entryAt}, ${nativeInput.cycleId}, 'jev',
        ${document.bindings.strategyDecisionHash}, ${'3'.repeat(64)}, ${nativeInput.authorityGenerationHash})`
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const [index, fill] of portfolio.entryFills.entries()) {
          const eventId = canonicalHashV1({ fillId: fill.fillId })
          const notional = ((BigInt(fill.quantityMicros) * BigInt(fill.priceMicros)) / 1_000_000n).toString()
          yield* sql`INSERT INTO broker_events (event_id, schema_version, content_hash, event_kind, broker, account_id,
        source_event_id, source_sequence, occurred_at, observed_at) VALUES (${eventId}, 'bayn.paper-broker-event.v1',
        ${eventId}, 'FILL', 'ALPACA', ${r.accountId}, ${fill.fillId}, ${index + 1}, ${fill.occurredAt}, ${fill.occurredAt})`
          yield* sql`INSERT INTO fills (event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id,
        intent_id, symbol, side, quantity_micros, price_micros, fee_micros, source_timestamp)
        VALUES (${eventId}, ${r.accountId}, ${fill.schemaVersion}, ${fill.fillId}, ${fill.brokerOrderId},
        ${fill.clientOrderId}, ${fill.intentId ?? null}, ${fill.symbol}, ${fill.side}, ${fill.quantityMicros},
        ${fill.priceMicros}, ${fill.feeMicros}, ${fill.occurredAt.replace('Z', '000000Z')})`
          yield* sql`INSERT INTO accounting_transactions (transaction_id, schema_version, broker_event_id, intent_id, account_id,
        symbol, side, quantity_micros, price_micros, notional_micros, fee_micros, cost_basis_micros, realized_pnl_micros,
        quantity_delta_micros, cost_basis_delta_micros, cash_delta_micros, ledger_plan_hash, content_hash, occurred_at)
        VALUES (${eventId}, 'bayn.paper-accounting-transaction.v1', ${eventId}, ${fill.intentId ?? null}, ${r.accountId},
        ${fill.symbol}, ${fill.side}, ${fill.quantityMicros}, ${fill.priceMicros}, ${notional}, '0', ${notional}, '0',
        ${fill.quantityMicros}, ${notional}, ${'-' + notional}, ${eventId}, ${eventId}, ${fill.occurredAt})`
          if (!options.omitReceipt || index !== 0)
            yield* sql`INSERT INTO accounting_receipts (receipt_id, schema_version, intent_id, broker_event_id,
          tigerbeetle_cluster_id, tigerbeetle_ledger, account_ids, transfer_ids, debit_micros, credit_micros,
          content_hash, recorded_at) VALUES (${eventId}, 'bayn.paper-accounting-receipt.v1', ${fill.intentId ?? null},
          ${eventId}, 1, 1, ARRAY[1,2]::numeric[], ARRAY[${index + 1}]::numeric[], ${notional}, ${notional},
          ${eventId}, ${options.receiptAt ?? fill.occurredAt})`
        }
      }),
    )
    return { managed, portfolio: { ...portfolio, brokerState } }
  })

describePostgres('PostgreSQL native Jev execution decisions', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Native tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* sql`INSERT INTO simulated_execution_clocks (account_id, source_manifest_hash, observed_at)
          VALUES (${replayAccountId}, ${'e'.repeat(64)}, ${fixture.observation.payload.observedAt})`
        yield* (yield* CycleStore).acquire(fixture.draft, fixture.draft.window.executionOpenAt)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
        VALUES (${nativeInput.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${fixture.observation.payload.observedAt})`
        const r = fixture.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
        VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test.each([JevPurpose.Entry, JevPurpose.Manage])(
    'stale benchmark trades wait without consuming the %s window or preventing fresh inference',
    async (purpose) => {
      let calls = 0
      await runtime.runPromise(
        Effect.gen(function* () {
          const atMs = observed + 30_000
          const at = utcInstantFromEpochMillis(atMs)
          yield* TestClock.setTime(atMs)
          const fresh = nativeJevFixture(JevPurpose.Entry, at)
          const selected =
            purpose === JevPurpose.Manage
              ? yield* seedManagedPosition({ observedAt: at })
              : { managed: fresh, portfolio: fresh.portfolio }
          const sql = yield* PgClient.PgClient
          let portfolio = selected.portfolio
          if (purpose === JevPurpose.Entry) {
            const r = { ...portfolio.brokerState.reconciliation, reconciliationId: '9'.repeat(64) }
            portfolio = { ...portfolio, brokerState: { ...portfolio.brokerState, reconciliation: r } }
            yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at) VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId},
              ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
          }
          const query = selected.managed.snapshot.manifest
          const raw = makeIntradayMomentumTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] })
          const snapshot = streamingFixtureFromRaw(
            {
              ...raw,
              trades: raw.trades.map((trade) =>
                trade.symbol === 'SPY' ? { ...trade, eventAt: utcInstantFromEpochMillis(atMs - 10_422) } : trade,
              ),
            },
            query,
          ).snapshot
          const input = { ...nativeInput, portfolio, snapshot }
          const result = yield* evaluateJevObservation(input).pipe(Effect.result)
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'JevAwaitingEvidence', readiness: 'SNAPSHOT_STALE' },
          })
          expect(calls).toBe(0)
          expect(yield* sql`SELECT count(*)::integer AS count FROM intraday_candidate_observations`).toEqual([
            { count: 0 },
          ])
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_plans`).toEqual([{ count: 0 }])
          if (portfolio.purpose === JevPurpose.Manage) {
            const cycle = Option.getOrThrow(yield* (yield* CycleStore).read(nativeInput.cycleId))
            expect(
              yield* evaluateJevPositionManagement({
                cycle,
                entryDecisionHash: portfolio.entryDecisionHash,
                authorityGenerationHash: nativeInput.authorityGenerationHash,
                protocol: fixture.protocol,
                calendar: query.calendar,
                brokerState: portfolio.brokerState,
                marketData: {
                  check: Effect.void,
                  verifyReference: fixtureStreamingReference,
                  loadSnapshot: (pricingQuery) =>
                    Effect.succeed(
                      pricingQuery.purpose === undefined
                        ? snapshot
                        : streamingFixtureFromRaw(
                            makeIntradayMomentumTestSnapshot(
                              fixture.protocol,
                              { ...pricingQuery, archiveWatermarks: [] },
                              { AAPL: 0.02 },
                            ),
                            pricingQuery,
                          ).snapshot,
                    ),
                },
              }),
            ).toMatchObject({ _tag: 'Wait', details: { readiness: { reason: 'SNAPSHOT_STALE' } } })
            expect(calls).toBe(0)
          }
          const recovered = yield* evaluateJevObservation({ ...input, snapshot: selected.managed.snapshot })
          expect(recovered.batchPlan.observedAt).toBe(query.observedAt)
          expect(recovered.batchPlan.schemaVersion).toBe(JevBatchPlanVersion.V2)
          expect(calls).toBe(purpose === JevPurpose.Entry ? 15 : 1)
        }).pipe(
          Effect.provideService(JevClient, {
            evaluate: (request) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  calls += 1
                  return nativeJevInference(
                    request,
                    utcInstantFromEpochMillis(now),
                    purpose === JevPurpose.Entry ? 'enter' : 'hold',
                  )
                }),
              ),
          }),
          atObservation,
        ),
      )
    },
  )

  test('stale source and verified wide entry quotes do not call Jev for those candidates', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const atMs = observed + 30_000
        const at = utcInstantFromEpochMillis(atMs)
        yield* TestClock.setTime(atMs)
        const fresh = nativeJevFixture(JevPurpose.Entry, at)
        const reconciliation = {
          ...fresh.portfolio.brokerState.reconciliation,
          reconciliationId: '9'.repeat(64),
        }
        const portfolio = {
          ...fresh.portfolio,
          brokerState: { ...fresh.portfolio.brokerState, reconciliation },
        }
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at) VALUES (${reconciliation.reconciliationId},
          ${reconciliation.schemaVersion}, ${reconciliation.accountId}, ${reconciliation.expectedHash},
          ${reconciliation.observedHash}, ${reconciliation.contentHash}, ${reconciliation.status}, '[]'::jsonb,
          ${reconciliation.reconciledAt})`
        const query = fresh.snapshot.manifest
        const raw = makeIntradayMomentumTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] })
        const staleAt = utcInstantFromEpochMillis(atMs - fixture.protocol.maximumQuoteAgeMs - 1)
        const staleEvidence = {
          ...raw,
          quotes: raw.quotes.map((quote) =>
            quote.symbol === 'AMD'
              ? { ...quote, eventAt: staleAt, ingestedAt: staleAt }
              : quote.symbol === 'AAPL'
                ? { ...quote, askPrice: quote.bidPrice * 1.01 }
                : quote,
          ),
          trades: raw.trades.map((trade) =>
            trade.symbol === 'AMD' ? { ...trade, eventAt: staleAt, ingestedAt: staleAt } : trade,
          ),
        }
        const snapshot = streamingFixtureFromRaw(staleEvidence, query).snapshot
        expect(snapshot.manifest.candidateExclusions).toContainEqual(
          expect.objectContaining({ symbol: 'AMD', reason: 'freshness' }),
        )
        const result = yield* evaluateJevObservation({ ...nativeInput, portfolio, snapshot })
        expect(result.batchPlan.schemaVersion).toBe(JevBatchPlanVersion.V2)
        expect(result.batchPlan.candidates).toContainEqual(
          expect.objectContaining({ symbol: 'AMD', status: 'EXCLUDED' }),
        )
        expect(result.batchPlan.candidates).toContainEqual(
          expect.objectContaining({ symbol: 'AAPL', status: 'EXCLUDED', reason: JevEntryExclusion.Spread }),
        )
        expect(calls).toBe(fixture.protocol.candidateSymbols.length - 2)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                calls += 1
                return nativeJevInference(request, utcInstantFromEpochMillis(now), 'enter')
              }),
            ),
        }),
        atObservation,
      ),
    )
  })

  test.each([JevExitReason.MaximumHold, JevExitReason.ProtectiveStop])(
    'deterministic %s exits do not call Jev',
    async (reason) => {
      await runtime.runPromise(
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
          Effect.provideService(JevClient, {
            evaluate: () => Effect.die('Deterministic exit unexpectedly called Jev'),
          }),
          atObservation,
        ),
      )
    },
  )

  test('a recorded hold evaluates only once for the same completed signal window', async () => {
    let calls = 0
    let adverseQuote = false
    await runtime.runPromise(
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
              Effect.succeed(
                query.purpose === undefined
                  ? managed.snapshot
                  : streamingFixtureFromRaw(
                      makeIntradayMomentumTestSnapshot(
                        fixture.protocol,
                        { ...query, archiveWatermarks: [] },
                        { AAPL: adverseQuote ? -0.02 : 0.02 },
                      ),
                      query,
                    ).snapshot,
              ),
          },
        }
        expect(yield* evaluateJevPositionManagement(input)).toEqual({
          _tag: 'Wait',
          details: { waitReason: 'JEV_POSITION_HELD' },
        })
        expect(yield* evaluateJevPositionManagement(input)).toMatchObject({
          _tag: 'Wait',
          details: { readiness: { reason: 'SIGNAL_WINDOW_OBSERVED' } },
        })
        expect(calls).toBe(1)
        adverseQuote = true
        expect(yield* evaluateJevPositionManagement(input)).toMatchObject({
          _tag: 'Exit',
          target: { reason: JevExitReason.ProtectiveStop },
        })
        expect(calls).toBe(1)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Effect.sync(() => {
              calls += 1
              return nativeJevInference(request, fixture.observation.payload.observedAt, 'hold')
            }),
        }),
        atObservation,
      ),
    )
  })

  test('loads actual accounted partial fills and commits a held-position observation before inference', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const { managed, portfolio: expected } = yield* seedManagedPosition()
        const portfolio = yield* (yield* JevPositionStore).read({
          cycleId: nativeInput.cycleId,
          entryDecisionHash: expected.entryDecisionHash,
          brokerState: expected.brokerState,
        })
        expect(portfolio).toEqual(expected)
        const evidence = yield* evaluateJevObservation({ ...nativeInput, portfolio, snapshot: managed.snapshot })
        expect(evidence.batchPlan.candidates.map(({ symbol }) => symbol)).toEqual(['AAPL'])
        expect(Result.getOrThrow(decideJevManagement(evidence)).action).toBe(JevManagementAction.Exit)
        expect(calls).toBe(1)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                calls += 1
                return nativeJevInference(request, new Date(now).toISOString(), 'exit')
              }),
            ),
        }),
        atObservation,
      ),
    )
  })

  test.each([{ omitReceipt: true }, { receiptAt: '2026-09-04T14:31:00.000Z' }])(
    'rejects management when accounting was incomplete at reconciliation (%j)',
    async (options) => {
      let calls = 0
      await runtime.runPromise(
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
          Effect.provideService(JevClient, {
            evaluate: (request) =>
              Effect.sync(() => {
                calls += 1
                return nativeJevInference(request, fixture.observation.payload.observedAt, 'exit')
              }),
          }),
          atObservation,
        ),
      )
    },
  )

  test('rejects a different entry decision and a fabricated reconciliation identifier', async () => {
    await runtime.runPromise(
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

  test.each([10, 6000])(
    'native batch uses measured replay inference time and its original deadline (%sms)',
    async (latencyMs) => {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const providerClock = yield* TestClock.make()
            yield* providerClock.setTime(Date.parse('2026-09-21T12:00:00.000Z'))
            const calls: ReplayJevCall[] = []
            const timing = yield* makeReplayJevTiming({
              measureDatabaseTime: (operation) => operation,
              providerClock,
              advanceTo: (atMs) => TestClock.setTime(atMs),
              retain: (call) =>
                Effect.sync(() => {
                  calls.push(call)
                }),
              provider: {
                evaluate: (request) =>
                  Effect.gen(function* () {
                    const started = yield* Clock.currentTimeMillis
                    yield* providerClock.setTime(started + latencyMs)
                    return nativeJevInference(request, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
                  }),
              },
            })
            const result = yield* timing.run(
              evaluateJevObservation(nativeInput).pipe(Effect.provideService(JevClient, timing.client), Effect.result),
            )
            expect(calls.length).toBeGreaterThan(0)
            expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(observed + latencyMs)
            expect(
              calls.every(
                (call) =>
                  call.providerStartedAt.startsWith('2026-09-21') && call.simulatedStartedAt.startsWith('2026-09-04'),
              ),
            ).toBe(true)
            if (latencyMs === 10) {
              expect(Result.isSuccess(result)).toBe(true)
              if (Result.isFailure(result)) throw result.failure
              expect(calls).toHaveLength(15)
              expect(Result.getOrThrow(decideJevEntry(result.success)).selectedSymbols).toEqual(['AAPL'])
              expect(result.success.batchResult.completedAt).toBe(
                utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
              )
            } else {
              expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'JevAwaitingEvidence' } })
              expect(yield* recoverPendingJevBatches(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toBe(
                true,
              )
            }
          }),
        ).pipe(atObservation),
      )
    },
  )

  test('persists the native observation and all fifteen responses before deriving a replayable target', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const evidence = yield* evaluateJevObservation(nativeInput)
        const target = Result.getOrThrow(decideJevEntry(evidence))
        expect(target.selectedSymbols).toEqual(['AAPL'])
        expect(calls).toBe(15)
        const saved = yield* (yield* JevBatchStore).read(evidence.batchPlan.batchId)
        expect(saved).toEqual({ plan: evidence.batchPlan, result: evidence.batchResult })
        expect(yield* (yield* JevBatchStore).pending(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual(
          [],
        )
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                calls += 1
                return nativeJevInference(request, new Date(now).toISOString())
              }),
            ),
        }),
        atObservation,
      ),
    )
  }, 30_000)

  test('entry waits for a new completed window after restart instead of buying another inference batch', async () => {
    let calls = 0
    const observeAt = (elapsedMs: number) =>
      Effect.gen(function* () {
        const at = utcInstantFromEpochMillis(observed + elapsedMs)
        const next = nativeJevFixture(JevPurpose.Entry, at)
        const reconciliation = {
          ...next.portfolio.brokerState.reconciliation,
          reconciliationId: canonicalHashV1({ cadenceReconciliationAt: at }),
        }
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash,
        observed_hash, content_hash, status, discrepancies, reconciled_at)
        VALUES (${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${reconciliation.accountId},
          ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash},
          ${reconciliation.status}, '[]'::jsonb, ${reconciliation.reconciledAt})`
        yield* TestClock.setTime(observed + elapsedMs)
        return yield* evaluateJevObservation({
          ...nativeInput,
          portfolio: { ...next.portfolio, brokerState: { ...next.portfolio.brokerState, reconciliation } },
          snapshot: next.snapshot,
        }).pipe(Effect.result)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                calls += 1
                return nativeJevInference(request, utcInstantFromEpochMillis(now), 'wait')
              }),
            ),
        }),
        Effect.provide(TestClock.layer()),
      )
    const first = await runtime.runPromise(observeAt(0))
    expect(Result.isSuccess(first)).toBe(true)
    if (Result.isSuccess(first)) expect(Result.getOrThrow(decideJevEntry(first.success)).selectedSymbols).toEqual([])
    expect(calls).toBe(15)
    await runtime.dispose()
    runtime = makeRuntime()
    const repeated = await runtime.runPromise(observeAt(1000))
    expect(Result.isFailure(repeated)).toBe(true)
    if (Result.isFailure(repeated))
      expect(repeated.failure).toMatchObject({
        _tag: 'JevAwaitingFreshWindow',
        availableAt: utcInstantFromEpochMillis(observed + 60_000),
      })
    expect(calls).toBe(15)
    const fresh = await runtime.runPromise(observeAt(60_000))
    expect(Result.isSuccess(fresh)).toBe(true)
    expect(calls).toBe(30)
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql`SELECT count(*)::integer AS count FROM jev_batch_plans`
        }),
      ),
    ).toEqual([{ count: 2 }])
  }, 30_000)

  test('rejects unstored reconciliation, a substituted cycle and an uncommitted observation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CandidateObservationStore
        const sql = yield* PgClient.PgClient
        const payload = fixture.observation.payload
        const altered = {
          ...payload,
          portfolio: {
            ...payload.portfolio,
            brokerState: {
              ...payload.portfolio.brokerState,
              reconciliation: { ...payload.portfolio.brokerState.reconciliation, reconciliationId: '0'.repeat(64) },
            },
          },
        }
        expect(
          Result.isFailure(
            yield* store.record({ payload: altered, contentHash: canonicalHashV1(altered) }).pipe(Effect.result),
          ),
        ).toBe(true)
        const wrongCycle = { ...payload, cycleId: '0'.repeat(64) }
        expect(
          Result.isFailure(
            yield* store.record({ payload: wrongCycle, contentHash: canonicalHashV1(wrongCycle) }).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(yield* sql.withTransaction(store.record(fixture.observation)).pipe(Effect.result)),
        ).toBe(true)
        expect(yield* sql`SELECT count(*)::integer AS count FROM intraday_candidate_observations`).toEqual([
          { count: 0 },
        ])
      }),
    )
  })

  test('retains a failed candidate and prevents entry from the other fourteen successful responses', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const result = yield* evaluateJevObservation(nativeInput).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isSuccess(result)) throw new Error('A partial batch authorized a decision')
        expect(result.failure._tag).toBe('JevAwaitingEvidence')
        expect(calls).toBe(15)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 1 }])
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts WHERE payload #>> '{outcome,status}' = 'FAILED'`,
        ).toEqual([{ count: 1 }])
        expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_cycle_shadow_decisions`).toEqual([
          { count: 0 },
        ])
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Effect.gen(function* () {
              calls += 1
              if (calls === 1)
                return yield* new JevError({
                  failure: JevFailure.Status,
                  status: 429,
                  message: 'Fixture provider rejected one request',
                })
              return nativeJevInference(request, new Date(yield* Clock.currentTimeMillis).toISOString())
            }),
        }),
        atObservation,
      ),
    )
  })

  test('discovers an abandoned batch after restart and seals it at expiry without inference', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        const plan = Result.getOrThrow(
          makeJevTradingSignalBatch({
            observation: fixture.observation.payload,
            expiresAt: new Date(observed + 5000).toISOString(),
            planVersion: JevBatchPlanVersion.V1,
          }),
        )
        const store = yield* JevBatchStore
        yield* store.begin(plan)
        expect(yield* store.pending(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual([plan.batchId])
        expect(yield* recoverPendingJevBatches(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toBe(false)
        yield* TestClock.setTime(observed + 5000)
        expect(yield* recoverPendingJevBatches(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toBe(true)
        expect(yield* store.pending(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('interrupting measured work freezes the database clock and retains elapsed market time', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const clock = yield* makeSimulatedExecutionClock('e'.repeat(64), 'e'.repeat(64))
        const entered = yield* Deferred.make<void>()
        const worker = yield* clock
          .measure(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        expect(yield* sql`SELECT measured_at IS NOT NULL AS active FROM simulated_execution_clocks`).toEqual([
          { active: true },
        ])
        yield* sql`SELECT pg_sleep(0.01)`
        yield* Fiber.interrupt(worker)
        expect(yield* sql`SELECT measured_at IS NULL AS stopped FROM simulated_execution_clocks`).toEqual([
          { stopped: true },
        ])
        expect(yield* Clock.currentTimeMillis).toBeGreaterThan(observed)
        const frozen = yield* sql`SELECT execution_account_now(${replayAccountId}) AS now`
        yield* sql`SELECT pg_sleep(0.01)`
        expect(yield* sql`SELECT execution_account_now(${replayAccountId}) AS now`).toEqual(frozen)
      }).pipe(Effect.scoped, atObservation),
    )
  })

  const nativeExitPersistence = async (scenario: string) => {
    const providerClock = await Effect.runPromise(Clock.clockWith(Effect.succeed))
    const state = fixture.portfolio.brokerState
    const at = fixture.observation.payload.observedAt
    let reconciliations = 0
    let calls = 0
    const unused = Effect.die(new Error('Unexpected broker read'))
    const broker: BrokerReadShape = {
      account: unused,
      accountConfiguration: unused,
      positions: unused,
      assetBySymbol: () => unused,
      orders: () => unused,
      orderById: () => unused,
      orderByClientId: () => unused,
      feeActivities: () => unused,
      fillActivities: () => unused,
      marketCalendar: () =>
        Effect.succeed({
          value: fixture.snapshot.manifest.calendar,
          evidence: { requestId: 'calendar-test', status: 200, contentHash: 'f'.repeat(64), observedAt: at },
        }),
    }
    const reconciliation: ReconciliationPassResult = {
      brokerState: state,
      report: {
        reconciliation: state.reconciliation,
        metrics: {
          brokerPollAgeMs: 0,
          oldestUnknownMutationAgeMs: 0,
          cashDifferenceMicros: '0',
          positionDifferenceMicros: '0',
          equityDifferenceMicros: '0',
          accountingExact: true,
          discrepancyCount: 0,
        },
      },
      riskContext: {
        tradingDate: fixture.snapshot.manifest.sessionDate,
        authority: {
          schemaVersion: 'bayn.paper-authority.v1',
          generationHash: nativeInput.authorityGenerationHash,
          maximum: Authority.Execution,
          effective: Authority.Execution,
          kill: KillState.Clear,
          version: 1,
          updatedAt: at,
        },
        authorityObservedAt: at,
        unknownMutationCount: 0,
        dailyTradedNotionalMicros: '0',
        dayStartEquityMicros: state.account.equityMicros,
        peakEquityMicros: state.account.equityMicros,
      },
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const active = yield* (yield* CycleStore).activate(nativeInput.cycleId, at)
        const document = yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: nativeInput.authorityGenerationHash,
          cycle: active.cycle,
          executionModel: fixture.protocol.executionModel,
          policy: yield* loadExecutionRiskPolicy(
            state.account.accountId,
            fixture.protocol.universe,
            fixture.protocol.executionModel,
          ),
          strategy: fixtureRuntime,
          reconcile: Effect.sync(() => {
            reconciliations += 1
            return reconciliation
          }),
          intradayMarketData: {
            check: Effect.void,
            verifyReference: fixtureStreamingReference,
            loadSnapshot: (query) =>
              Effect.sync(() =>
                query.purpose === undefined
                  ? fixture.snapshot
                  : streamingFixtureFromRaw(
                      makeIntradayMomentumTestSnapshot(
                        fixture.protocol,
                        { ...query, archiveWatermarks: [] },
                        { AAPL: 0.02 },
                      ),
                      query,
                    ).snapshot,
              ),
          },
        }).pipe(Effect.tapError((error) => Effect.logError(error)))
        expect(reconciliations).toBe(2)
        expect(document.strategyDecision?.schemaVersion).toBe('bayn.jev-entry-target.v1')
        expect(document.dispatchable).toBe(true)
        expect(document.orderedIntentIds).toHaveLength(1)
        expect(document.createdAt).toBe(new Date(observed + 500).toISOString())
        expect(document.deltaRisk[0]?.evaluation.decision.expiresAt).toBe(new Date(observed + 5000).toISOString())
        expect(
          Result.isSuccess(
            Schema.decodeUnknownResult(ExecutionDecisionDocumentSchema)(JSON.parse(JSON.stringify(document))),
          ),
        ).toBe(true)
        if (document.decisionMarketDataRows === undefined) throw new Error('Missing bound Jev source rows')
        const { contentHash: _documentHash, ...documentMaterial } = document
        const substitutedSource = {
          ...documentMaterial,
          decisionMarketDataRows: { ...document.decisionMarketDataRows, bars: [] },
        }
        expect(
          Result.isFailure(
            Schema.decodeUnknownResult(ExecutionDecisionDocumentSchema)({
              ...substitutedSource,
              contentHash: canonicalHashV1(substitutedSource),
            }),
          ),
        ).toBe(true)
        const { managed, portfolio } = yield* seedManagedPosition({
          entryDocument: document,
          observedAt: '2026-09-04T14:33:03.000Z',
        })
        yield* TestClock.setTime(Date.parse(managed.observation.payload.observedAt))
        const bound = yield* (yield* CycleStore).read(nativeInput.cycleId)
        if (Option.isNone(bound)) throw new Error('Expected bound entry')
        const cycle = bound.value
        const marketData: IntradayMarketDataService = {
          check: Effect.void,
          verifyReference: fixtureStreamingReference,
          loadSnapshot: (query) =>
            Effect.succeed(
              query.purpose === undefined
                ? managed.snapshot
                : streamingFixtureFromRaw(
                    makeIntradayMomentumTestSnapshot(
                      fixture.protocol,
                      { ...query, archiveWatermarks: [] },
                      { AAPL: 0.02 },
                    ),
                    query,
                  ).snapshot,
            ),
        }
        const management = yield* evaluateJevPositionManagement({
          cycle,
          entryDecisionHash: document.contentHash,
          authorityGenerationHash: nativeInput.authorityGenerationHash,
          protocol: fixture.protocol,
          calendar: managed.snapshot.manifest.calendar,
          brokerState: portfolio.brokerState,
          marketData,
        })
        if (management._tag !== 'Exit') throw new Error('Expected native Jev exit')
        const exitTarget = management.target
        expect(exitTarget.reason).toBe(JevExitReason.Model)
        expect(calls).toBe(16)
        if (reconciliation.riskContext.authority === null) throw new Error('Expected execution authority')
        const closeFacts: ReconciliationPassResult = {
          brokerState: portfolio.brokerState,
          report: { ...reconciliation.report, reconciliation: portfolio.brokerState.reconciliation },
          riskContext: {
            ...reconciliation.riskContext,
            authority: reconciliation.riskContext.authority,
            authorityObservedAt: managed.observation.payload.observedAt,
          },
        }
        if (cycle.identity.executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
          throw new Error('Expected v3 execution policy')
        const closeRequest = {
          input: {
            accountId: state.account.accountId,
            authorityGenerationHash: nativeInput.authorityGenerationHash,
            pollIntervalMs: 1000,
            reconciliationIntervalMs: 1000,
            reconciliationPassTimeoutMs: 1000,
            strategy: fixtureRuntime,
            intradayMarketData: marketData,
          },
          preparation: {
            executionModel: fixture.protocol.executionModel,
            executionPolicy: cycle.identity.executionPolicy,
            strategyProtocolHash: cycle.identity.strategyProtocolHash,
          },
          policy: yield* loadExecutionRiskPolicy(
            state.account.accountId,
            fixture.protocol.universe,
            fixture.protocol.executionModel,
          ),
          cycle,
          entryDocument: document,
          reconcile: Effect.succeed(closeFacts),
          initialReconciliation: closeFacts,
          closeExpiresAt: cycle.window.executionCloseAt,
          exitTarget,
        }
        const close = yield* prepareClosingExecutionCycleDecision(closeRequest).pipe(
          Effect.tapError((error) => Effect.logError(error)),
        )
        expect(close.document.dispatchable).toBe(true)
        expect(close.document.strategyDecision).toEqual(exitTarget)
        expect(
          close.document.targetPlan.intentTargets.map(({ side, quantityMicros }) => ({ side, quantityMicros })),
        ).toEqual([{ side: OrderSide.Sell, quantityMicros: '5000000' }])
        const closure = Result.getOrThrow(
          makeExecutionCycleClosure({
            schemaVersion: 'bayn.paper-cycle-closure.v1',
            cycleId: nativeInput.cycleId,
            entryDecisionHash: document.contentHash,
            document: close.document,
            createdAt: close.document.createdAt,
            expiresAt: close.document.expiresAt,
          }),
        )
        const store = yield* ExecutionCycleClosureStore
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${closure.createdAt}
        WHERE account_id = ${replayAccountId}`
        const expired = yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(exitTarget.observedAt) + 5000)
          return yield* store.bind(closure).pipe(Effect.result)
        }).pipe(Effect.provide(TestClock.layer()))
        expect(Result.isFailure(expired)).toBe(true)
        expect(Option.isNone(yield* store.read(nativeInput.cycleId))).toBe(true)
        if (
          scenario === 'measured-expires-during-insert' ||
          scenario === 'measured-expires-before-commit' ||
          scenario === 'measured-on-time'
        ) {
          yield* TestClock.setTime(
            Date.parse(exitTarget.commitDeadlineAt) - (scenario === 'measured-on-time' ? 2000 : 300),
          )
          const clock = yield* makeSimulatedExecutionClock('e'.repeat(64), 'e'.repeat(64))
          const timing = yield* makeReplayJevTiming({
            measureDatabaseTime: clock.measure,
            providerClock,
            provider: { evaluate: () => Effect.die('Exit persistence must use its recorded evidence') },
            advanceTo: (atMs) =>
              clock
                .advanceTo(utcInstantFromEpochMillis(atMs))
                .pipe(Effect.andThen(TestClock.setTime(atMs)), Effect.orDie),
            retain: () => Effect.die('Exit persistence must not infer'),
          })
          if (scenario === 'measured-expires-during-insert') {
            yield* sql`CREATE FUNCTION delay_test_exit_insert() RETURNS trigger LANGUAGE plpgsql AS $function$
              BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END
            $function$`
            yield* sql`CREATE TRIGGER delay_test_exit_insert BEFORE INSERT ON autonomous_cycle_paper_closures
              FOR EACH ROW EXECUTE FUNCTION delay_test_exit_insert()`
          }
          const attempted = yield* timing
            .run(
              Effect.gen(function* () {
                yield* timing.currentUtcInstant
                return yield* (yield* WriterFence).transaction(
                  Effect.gen(function* () {
                    yield* store.bind(closure)
                    if (scenario === 'measured-expires-before-commit') yield* sql`SELECT pg_sleep(0.5)`
                  }),
                )
              }),
            )
            .pipe(Effect.exit)
          if (scenario === 'measured-on-time') {
            expect(Exit.isSuccess(attempted)).toBe(true)
            expect(Option.getOrThrow(yield* store.read(nativeInput.cycleId))).toEqual(closure)
          } else {
            expect(Exit.isFailure(attempted)).toBe(true)
            if (Exit.isFailure(attempted))
              expect(Cause.pretty(attempted.cause)).toContain(
                'initial Jev exit evidence expired before transaction commitment',
              )
            expect(Option.isNone(yield* store.read(nativeInput.cycleId))).toBe(true)
          }
          expect(
            yield* sql`SELECT measured_at IS NULL AS stopped FROM simulated_execution_clocks WHERE account_id = ${replayAccountId}`,
          ).toEqual([{ stopped: true }])
          return
        }
        if (scenario !== 'recovery') {
          if (scenario === 'expires-during-insert') {
            yield* sql`CREATE FUNCTION advance_test_exit_clock() RETURNS trigger LANGUAGE plpgsql AS $function$
            BEGIN
              UPDATE simulated_execution_clocks
              SET observed_at = (NEW.document #>> '{document,strategyDecision,commitDeadlineAt}')::timestamptz
              WHERE account_id = NEW.document #>> '{document,bindings,accountId}';
              RETURN NEW;
            END
          $function$`
            yield* sql`CREATE TRIGGER advance_test_exit_clock BEFORE INSERT ON autonomous_cycle_paper_closures
            FOR EACH ROW EXECUTE FUNCTION advance_test_exit_clock()`
          }
          const attempted = yield* (yield* WriterFence)
            .transaction(
              Effect.gen(function* () {
                yield* store.bind(closure)
                if (scenario === 'expires-before-commit')
                  yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${exitTarget.commitDeadlineAt}
                WHERE account_id = ${replayAccountId}`
              }),
            )
            .pipe(Effect.result)
          expect(Result.isFailure(attempted)).toBe(true)
          expect(Option.isNone(yield* store.read(nativeInput.cycleId))).toBe(true)
          return
        }
        const saved = yield* store.bind(closure)
        expect(saved).toEqual(closure)
        yield* TestClock.setTime(Date.parse(exitTarget.observedAt) + 60_000)
        expect(yield* store.bind(closure)).toEqual(saved)
        expect(Option.getOrThrow(yield* store.read(nativeInput.cycleId))).toEqual(saved)
        expect(calls).toBe(16)
        const closeWindow = {
          startAt: new Date(Date.parse(cycle.window.executionCloseAt) - 300_000).toISOString(),
          submitCutoffAt: cycle.window.executionCloseAt,
          expiresAt: cycle.window.executionCloseAt,
        }
        const recovered = yield* ensureExecutionCycleClosure(
          { ...closeRequest.input, executionCycleClosureStore: store },
          closeRequest.preparation,
          closeRequest.policy,
          cycle,
          document,
          closeWindow,
          Effect.die('Existing unsubmitted close unexpectedly reconciled'),
        )
        expect(recovered).toEqual({ _tag: 'Close', document: close.document })
        const remainingAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const remainingMaterial = {
          ...portfolio.brokerState,
          account: { ...portfolio.brokerState.account, observedAt: remainingAt },
          positions: portfolio.brokerState.positions.map((position) => ({
            ...position,
            quantityMicros: '3000000',
            costBasisMicros: '300000000',
            marketValueMicros: '306000000',
            unrealizedPnlMicros: '6000000',
            observedAt: remainingAt,
          })),
          orders: portfolio.brokerState.orders.map((order) => ({ ...order, observedAt: remainingAt })),
          positionsObservedAt: remainingAt,
          ordersObservedAt: remainingAt,
        }
        const remainingHash = Result.getOrThrow(reconciledStateHash(remainingMaterial))
        const remainingReconciliation = {
          ...portfolio.brokerState.reconciliation,
          reconciliationId: '5'.repeat(64),
          expectedHash: remainingHash,
          observedHash: remainingHash,
          reconciledAt: remainingAt,
          contentHash: canonicalHashV1(remainingMaterial),
        }
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
        content_hash, status, discrepancies, reconciled_at) VALUES (${remainingReconciliation.reconciliationId},
        ${remainingReconciliation.schemaVersion}, ${state.account.accountId}, ${remainingHash}, ${remainingHash},
        ${remainingReconciliation.contentHash}, 'EXACT', '[]'::jsonb, ${remainingAt})`
        const remainingFacts: ReconciliationPassResult = {
          ...closeFacts,
          brokerState: { ...remainingMaterial, reconciliation: remainingReconciliation },
          report: { ...closeFacts.report, reconciliation: remainingReconciliation },
        }
        const residual = yield* prepareClosingExecutionCycleDecision({
          ...closeRequest,
          initialReconciliation: remainingFacts,
          reconcile: Effect.succeed(remainingFacts),
          replanGenerationHash: saved.contentHash,
        })
        expect(residual.document.targetPlan.intentTargets.map(({ quantityMicros }) => quantityMicros)).toEqual([
          '3000000',
        ])
        expect(residual.document.strategyDecision).toEqual(exitTarget)
        const replan = Result.getOrThrow(
          makeExecutionCycleClosure({
            schemaVersion: 'bayn.paper-cycle-closure.v1',
            cycleId: nativeInput.cycleId,
            entryDecisionHash: document.contentHash,
            document: residual.document,
            createdAt: residual.document.createdAt,
            expiresAt: residual.document.expiresAt,
          }),
        )
        expect(yield* store.bindReplan(replan)).toEqual(replan)
        expect(yield* store.bindReplan(replan)).toEqual(replan)
        expect(Option.getOrThrow(yield* store.readLatestReplan(nativeInput.cycleId))).toEqual(replan)
        const recoveredReplan = yield* ensureExecutionCycleClosure(
          { ...closeRequest.input, executionCycleClosureStore: store },
          closeRequest.preparation,
          closeRequest.policy,
          cycle,
          document,
          closeWindow,
          Effect.die('Existing unsubmitted residual close unexpectedly reconciled'),
        )
        expect(recoveredReplan).toEqual({ _tag: 'Close', document: residual.document })
        expect(calls).toBe(16)
      }).pipe(
        Effect.provideService(BrokerRead, broker),
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Effect.gen(function* () {
              calls += 1
              if (calls === 15) yield* TestClock.setTime(observed + 500)
              return nativeJevInference(
                request,
                new Date(yield* Clock.currentTimeMillis).toISOString(),
                calls > 15 ? 'exit' : 'enter',
              )
            }),
        }),
        atObservation,
      ),
    )
  }
  test.each([
    'recovery',
    'expires-during-insert',
    'expires-before-commit',
    'measured-expires-during-insert',
    'measured-expires-before-commit',
    'measured-on-time',
  ])('native exit persistence: %s', nativeExitPersistence, 30_000)
})
